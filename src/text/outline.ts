/**
 * Create Outlines: converts a text node into filled paths (one compound path per
 * glyph, even-odd fill) using opentype.js glyph outlines placed at the positions
 * produced by the layout engine (so outlines match what the SVG renderer shows).
 * Also hosts the text-on-path geometry helpers (glyph placement along a path)
 * shared with the Type tool.
 */
import type { Document, TextNode, PathNode, SubPath, Vec, TextStyle, Matrix } from '@/model/types';
import { layoutText, measure, type TextLayout, type LaidRun } from './layout';
import { getOpentypeFont, isOutlineCapable, uploadedFonts, sameFamily, type OutlineFont } from './fonts';
import { parseSvgPathData, transformSubPaths, subpathToCubics, subpathLength } from '@/geometry/path';
import { cubicLength, cubicPoint, cubicDerivative, cubicSplit, type Cubic } from '@/geometry/bezier';
import { multiply, invert, identity } from '@/geometry/matrix';
import { normalize } from '@/geometry/vec';
import { makePath, clonePaint, cloneStroke } from '@/model/nodes';

// ---------------------------------------------------------------------------
// Glyph positions from the layout
// ---------------------------------------------------------------------------

export interface GlyphPos {
  ch: string;
  /** character index in the text */
  index: number;
  style: TextStyle;
  /** glyph origin (baseline start) in local coordinates, baseline shift applied */
  x: number;
  y: number;
  /** advance of the glyph itself (without letter spacing) */
  advance: number;
  /** advance including letter spacing (as laid out) */
  step: number;
  line: number;
  run: LaidRun;
}

/** Per-character origins for a laid-out text (point/area text semantics). */
export function glyphPositions(layout: TextLayout): GlyphPos[] {
  const out: GlyphPos[] = [];
  layout.lines.forEach((line, li) => {
    for (const run of line.runs) {
      const st = run.style;
      const chars = Array.from(run.text);
      let off = 0;
      for (let k = 0; k < chars.length; k++) {
        const ch = chars[k];
        const x0 = run.text === '\t' ? line.x + run.x : line.x + run.x + measure(run.text.slice(0, off), st).width;
        const next = run.text === '\t' ? line.x + run.x + run.width : line.x + run.x + measure(run.text.slice(0, off + ch.length), st).width;
        const advance = run.text === '\t' ? run.width : measure(ch, { ...st, letterSpacing: 0 }).width;
        out.push({ ch, index: run.start + off, style: st, x: x0, y: line.y - st.baselineShift, advance, step: next - x0, line: li, run });
        off += ch.length;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Text on a path
// ---------------------------------------------------------------------------

/** Arc-length sampler for a subpath (cached cubic lengths, bisection per query). */
export class PathSampler {
  readonly cubics: Cubic[];
  readonly lengths: number[];
  readonly total: number;
  constructor(readonly subpath: SubPath) {
    this.cubics = subpathToCubics(subpath);
    this.lengths = this.cubics.map((c) => cubicLength(c));
    this.total = this.lengths.reduce((a, b) => a + b, 0);
  }

  /** Point and unit tangent at an arc length (clamped to the path). */
  at(len: number): { point: Vec; tangent: Vec } {
    if (!this.cubics.length) {
      const p = this.subpath.anchors[0]?.point ?? { x: 0, y: 0 };
      return { point: p, tangent: { x: 1, y: 0 } };
    }
    let target = Math.max(0, Math.min(this.total, len));
    for (let i = 0; i < this.cubics.length; i++) {
      const L = this.lengths[i];
      if (target <= L || i === this.cubics.length - 1) {
        const c = this.cubics[i];
        if (L <= 1e-9) return { point: c.p0, tangent: normalize(cubicDerivative(c, 0.5)) };
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) / 2;
          const [left] = cubicSplit(c, mid);
          if (cubicLength(left) < target) lo = mid;
          else hi = mid;
        }
        const t = (lo + hi) / 2;
        const tangent = normalize(cubicDerivative(c, t));
        return { point: cubicPoint(c, t), tangent: tangent.x === 0 && tangent.y === 0 ? { x: 1, y: 0 } : tangent };
      }
      target -= L;
    }
    const last = this.cubics[this.cubics.length - 1];
    return { point: last.p3, tangent: normalize(cubicDerivative(last, 1)) };
  }

  /** Arc length at a (segment, t) location. */
  lengthAt(segment: number, t: number): number {
    let l = 0;
    for (let i = 0; i < Math.min(segment, this.cubics.length); i++) l += this.lengths[i];
    const c = this.cubics[segment];
    if (c) l += cubicLength(cubicSplit(c, Math.max(0, Math.min(1, t)))[0]);
    return l;
  }
}

const samplerCache = new WeakMap<PathNode, { key: string; sampler: PathSampler }>();

/** The path a text node flows along, expressed in the text node's local space. */
export function pathTextSampler(doc: Document, node: TextNode): PathSampler | null {
  if (node.kind !== 'path' || !node.pathId) return null;
  const p = doc.nodes[node.pathId];
  if (!p || p.type !== 'path' || !p.subpaths.length) return null;
  const rel = multiply(invert(node.transform), p.transform);
  const key = JSON.stringify(rel);
  const cached = samplerCache.get(p);
  if (cached && cached.key === key) return cached.sampler;
  const sps = transformSubPaths(p.subpaths, rel);
  const sp = sps.find((s) => s.anchors.length >= 2) ?? sps[0];
  const sampler = new PathSampler(sp);
  samplerCache.set(p, { key, sampler });
  return sampler;
}

const pathLayoutNodes = new WeakMap<TextNode, TextNode>();

/**
 * Path text is rendered as a single line (newlines become spaces, exactly like the
 * renderer does). This returns a stable proxy node used for laying it out.
 */
export function pathTextLayoutNode(node: TextNode): TextNode {
  if (node.kind !== 'path') return node;
  const cached = pathLayoutNodes.get(node);
  if (cached) return cached;
  const proxy: TextNode = {
    ...node,
    kind: 'point',
    text: node.text.replace(/\n/g, ' '),
    runs: (node.runs && node.runs.length ? node.runs : [{ text: node.text }]).map((r) => ({ ...r, text: r.text.replace(/\n/g, ' ') })),
    style: { ...node.style, textAlign: 'left' },
  };
  pathLayoutNodes.set(node, proxy);
  return proxy;
}

/** Layout used for a text node (handles the single-line path text case). */
export function layoutFor(node: TextNode): TextLayout {
  return layoutText(pathTextLayoutNode(node));
}

/** Arc length where the text starts on the path (text-anchor semantics of SVG textPath). */
export function pathTextStart(node: TextNode, layout: TextLayout, total: number): number {
  const off = (node.pathOffset ?? 0) * total;
  const width = layout.lines[0]?.width ?? 0;
  if (node.style.textAlign === 'center') return off - width / 2;
  if (node.style.textAlign === 'right') return off - width;
  return off;
}

/** Up direction (glyph vertical axis) for a tangent, screen coordinates (y down). */
export function upVector(t: Vec): Vec {
  return { x: t.y, y: -t.x };
}

export interface PathGlyphPos extends GlyphPos {
  /** midpoint of the glyph advance on the path (arc length) */
  len: number;
  point: Vec;
  tangent: Vec;
  /** rotation in degrees */
  angle: number;
  /** whether the glyph lies on the path (SVG hides glyphs whose midpoint falls off the path) */
  visible: boolean;
}

/** Glyph placements along the path for a text-on-path node. */
export function pathGlyphPositions(doc: Document, node: TextNode): { sampler: PathSampler; start: number; glyphs: PathGlyphPos[]; layout: TextLayout } | null {
  const sampler = pathTextSampler(doc, node);
  if (!sampler) return null;
  const layout = layoutFor(node);
  const start = pathTextStart(node, layout, sampler.total);
  const glyphs: PathGlyphPos[] = glyphPositions(layout).map((g) => {
    const len = start + g.x + g.advance / 2;
    const { point, tangent } = sampler.at(len);
    return { ...g, len, point, tangent, angle: (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI, visible: len >= -1e-6 && len <= sampler.total + 1e-6 };
  });
  return { sampler, start, glyphs, layout };
}

/** Local matrix placing a glyph (origin at its baseline start) on the path. */
export function pathGlyphMatrix(g: PathGlyphPos): Matrix {
  const cos = g.tangent.x;
  const sin = g.tangent.y;
  const shift = g.style.baselineShift;
  // translate(point) · rotate(angle) · translate(-advance/2, -shift)
  const tx = -g.advance / 2;
  const ty = -shift;
  return { a: cos, b: sin, c: -sin, d: cos, e: g.point.x + cos * tx - sin * ty, f: g.point.y + sin * tx + cos * ty };
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

export interface OutlineOptions {
  /** add underline / strike-through rectangles */
  decorations?: boolean;
}

export class OutlineError extends Error {}

async function fontFor(cache: Map<string, Promise<OutlineFont | null>>, st: TextStyle, text: string): Promise<OutlineFont> {
  const key = `${st.fontFamily.toLowerCase()}|${st.fontWeight}|${st.fontStyle}`;
  let p = cache.get(key);
  if (!p) {
    p = getOpentypeFont(st.fontFamily, st.fontWeight, st.fontStyle, text);
    cache.set(key, p);
  }
  const f = await p;
  if (!f) {
    const woff2Upload = uploadedFonts().some((u) => sameFamily(u.family, st.fontFamily) && !u.parsable);
    const hint = woff2Upload
      ? ' It was uploaded as WOFF2, which cannot be outlined — upload a TTF, OTF or WOFF version of the font.'
      : isOutlineCapable(st.fontFamily)
        ? ''
        : ' It is a system font — outlines are available for bundled fonts and fonts added with Type › Upload Font.';
    throw new OutlineError(`No font file is available for "${st.fontFamily}".${hint}`);
  }
  return f;
}

function glyphSubPaths(font: OutlineFont, ch: string, size: number, m: Matrix): SubPath[] {
  const g = font.glyphFor(ch);
  if (!g) return [];
  let d = '';
  try {
    d = g.glyph.getPath(0, 0, size).toPathData(4);
  } catch {
    return [];
  }
  if (!d) return [];
  const sps = parseSvgPathData(d).filter((sp) => sp.anchors.length >= 2);
  return transformSubPaths(sps, m);
}

function decorationRect(x1: number, x2: number, y: number, thickness: number): SubPath {
  const t = Math.max(0.25, thickness);
  return {
    closed: true,
    anchors: [
      { point: { x: x1, y: y }, handleIn: null, handleOut: null, kind: 'corner' },
      { point: { x: x2, y: y }, handleIn: null, handleOut: null, kind: 'corner' },
      { point: { x: x2, y: y + t }, handleIn: null, handleOut: null, kind: 'corner' },
      { point: { x: x1, y: y + t }, handleIn: null, handleOut: null, kind: 'corner' },
    ],
  };
}

function decorationMetrics(font: OutlineFont, st: TextStyle): { underlineY: number; underlineT: number; strikeY: number; strikeT: number } {
  const f = font.subsets[0]?.font;
  const upm = f?.unitsPerEm || 1000;
  const k = st.fontSize / upm;
  const post = (f?.tables as any)?.post;
  const os2 = (f?.tables as any)?.os2;
  const underlineY = post && typeof post.underlinePosition === 'number' ? -post.underlinePosition * k : st.fontSize * 0.1;
  const underlineT = post && typeof post.underlineThickness === 'number' && post.underlineThickness > 0 ? post.underlineThickness * k : st.fontSize * 0.06;
  const strikeY = os2 && typeof os2.yStrikeoutPosition === 'number' ? -os2.yStrikeoutPosition * k : -st.fontSize * 0.3;
  const strikeT = os2 && typeof os2.yStrikeoutSize === 'number' && os2.yStrikeoutSize > 0 ? os2.yStrikeoutSize * k : st.fontSize * 0.06;
  return { underlineY, underlineT, strikeY, strikeT };
}

/**
 * Convert a text node into path nodes (in the text node's local coordinates).
 * Throws OutlineError when a font is not available.
 */
export async function textToOutlinePaths(doc: Document, node: TextNode, opts: OutlineOptions = {}): Promise<PathNode[]> {
  const fonts = new Map<string, Promise<OutlineFont | null>>();
  const paths: PathNode[] = [];
  const mkPath = (sps: SubPath[], name: string) => {
    const p = makePath(sps, { fill: clonePaint(node.fill), stroke: cloneStroke(node.stroke), fillRule: 'evenodd', name });
    paths.push(p);
  };
  const decorations = opts.decorations ?? true;

  if (node.kind === 'path' && node.pathId) {
    const placed = pathGlyphPositions(doc, node);
    if (!placed) return [];
    for (const g of placed.glyphs) {
      if (!g.visible || /\s/.test(g.ch)) continue;
      const font = await fontFor(fonts, g.style, g.ch);
      const sps = glyphSubPaths(font, g.ch, g.style.fontSize, pathGlyphMatrix(g));
      if (sps.length) mkPath(sps, g.ch);
    }
    return paths;
  }

  const layout = layoutText(node);
  const glyphs = glyphPositions(layout);
  for (const g of glyphs) {
    if (/\s/.test(g.ch)) continue;
    const font = await fontFor(fonts, g.style, g.ch);
    const m: Matrix = { ...identity(), e: g.x, f: g.y };
    const sps = glyphSubPaths(font, g.ch, g.style.fontSize, m);
    if (sps.length) mkPath(sps, g.ch);
  }
  if (decorations) {
    for (const line of layout.lines) {
      for (const run of line.runs) {
        const st = run.style;
        if (st.textDecoration === 'none' || !run.text.trim()) continue;
        const font = await fontFor(fonts, st, run.text);
        const dm = decorationMetrics(font, st);
        const x1 = line.x + run.x;
        const x2 = x1 + run.width;
        const y = line.y - st.baselineShift;
        if (st.textDecoration === 'underline') mkPath([decorationRect(x1, x2, y + dm.underlineY, dm.underlineT)], 'underline');
        else mkPath([decorationRect(x1, x2, y + dm.strikeY, dm.strikeT)], 'strikethrough');
      }
    }
  }
  return paths;
}

/** Total length helper for external callers. */
export function subpathTotalLength(sp: SubPath): number {
  return subpathLength(sp);
}
