/**
 * Brush stroke geometry: turns a path + brush definition into the list of
 * filled/stroked shapes ("items") that replace the plain stroke. Pure (no
 * paper.js) so it can be unit-tested and reused by Expand Appearance.
 */
import type { BrushDef, BrushArtwork, BrushColorization, StrokeStyle, SubPath, Paint, Vec, Rect, Node, PathNode, FillRule, HexColor, CalligraphicBrush, Matrix } from '@/model/types';
import { isContainer } from '@/model/types';
import { transformSubPaths, pathBounds, polylineSubPath, cloneSubPaths } from '@/geometry/path';
import { multiply, translate, rotate, scale as scaleM, compose, identity } from '@/geometry/matrix';
import { rectUnion } from '@/geometry/vec';
import { outlineRing } from '@/tools/freehand/sampling';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, mixHex } from '@/util/color';
import { Spine, bendSubPaths, seeded } from './spine';

export interface BrushItem {
  subpaths: SubPath[];
  fill: Paint;
  stroke: StrokeStyle | null;
  fillRule: FillRule;
  opacity: number;
}

/** Flattened artwork: every path of the brush artwork with its transform baked into brush space. */
export interface FlatArt {
  paths: Array<{ subpaths: SubPath[]; fill: Paint; stroke: StrokeStyle | null; fillRule: FillRule; opacity: number }>;
  bounds: Rect;
}

const flatCache = new WeakMap<BrushArtwork, FlatArt | null>();

export function flattenArtwork(art: BrushArtwork): FlatArt | null {
  const cached = flatCache.get(art);
  if (cached !== undefined) return cached;
  const paths: FlatArt['paths'] = [];
  let bounds: Rect | null = null;
  const visit = (id: string, m: Matrix, opacity: number) => {
    const n: Node | undefined = art.nodes[id];
    if (!n || !n.visible) return;
    const wm = multiply(m, n.transform);
    const op = opacity * n.opacity;
    if (isContainer(n)) {
      for (const c of n.children) visit(c, wm, op);
      return;
    }
    if (n.type !== 'path') return;
    const sps = transformSubPaths(n.subpaths, wm);
    const b = pathBounds(sps);
    if (!b) return;
    const sw = n.stroke.paint.type !== 'none' && n.stroke.width > 0 ? { ...n.stroke, width: n.stroke.width * Math.hypot(wm.a, wm.b) } : null;
    const pad = sw ? sw.width / 2 : 0;
    bounds = rectUnion(bounds, { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 });
    paths.push({ subpaths: sps, fill: n.fill, stroke: sw, fillRule: n.fillRule, opacity: op });
  };
  visit(art.root, identity(), 1);
  const out = bounds && paths.length ? { paths, bounds } : null;
  flatCache.set(art, out);
  return out;
}

// ---------------------------------------------------------------------------
// Colorization
// ---------------------------------------------------------------------------

function luminance01(hex: HexColor): number {
  const c = hexToRgb(hex);
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

export function colorizeHex(hex: HexColor, key: HexColor, mode: BrushColorization): HexColor {
  switch (mode) {
    case 'tints': {
      // black → key colour, white → white
      return mixHex(key, '#ffffff', luminance01(hex));
    }
    case 'tintsShades': {
      const l = luminance01(hex);
      return l < 0.5 ? mixHex('#000000', key, l * 2) : mixHex(key, '#ffffff', (l - 0.5) * 2);
    }
    case 'hue': {
      const src = rgbToHsb(hexToRgb(hex));
      const k = rgbToHsb(hexToRgb(key));
      if (src.s < 1e-6) return hex;
      return rgbToHex(hsbToRgb({ h: k.h, s: src.s, b: src.b }));
    }
    default:
      return hex;
  }
}

function colorizePaint(p: Paint, key: HexColor, mode: BrushColorization): Paint {
  if (mode === 'none') return p;
  if (p.type === 'solid') return { type: 'solid', color: colorizeHex(p.color, key, mode), opacity: p.opacity };
  if (p.type === 'linear' || p.type === 'radial') return { ...p, stops: p.stops.map((s) => ({ ...s, color: colorizeHex(s.color, key, mode) })) };
  return p;
}

function keyColor(stroke: StrokeStyle): HexColor {
  const p = stroke.paint;
  if (p.type === 'solid') return p.color;
  if (p.type === 'linear' || p.type === 'radial') return p.stops[0]?.color ?? '#000000';
  return '#000000';
}

function colorized(item: FlatArt['paths'][number], stroke: StrokeStyle, mode: BrushColorization): { fill: Paint; stroke: StrokeStyle | null } {
  const key = keyColor(stroke);
  return {
    fill: colorizePaint(item.fill, key, mode),
    stroke: item.stroke ? { ...item.stroke, paint: colorizePaint(item.stroke.paint, key, mode) } : null,
  };
}

// ---------------------------------------------------------------------------
// Calligraphic
// ---------------------------------------------------------------------------

function calligraphicHalfWidth(def: CalligraphicBrush, tangent: Vec, k: number, rnd: (() => number) | null): number {
  const size = def.size * k * (rnd && def.sizeVariation ? 1 + ((rnd() * 2 - 1) * def.sizeVariation) / def.size : 1);
  const round = Math.max(0, Math.min(100, def.roundness + (rnd && def.roundnessVariation ? (rnd() * 2 - 1) * def.roundnessVariation : 0))) / 100;
  const angle = ((def.angle + (rnd && def.angleVariation ? (rnd() * 2 - 1) * def.angleVariation : 0)) * Math.PI) / 180;
  // ellipse semi-axes: a along the brush angle (screen y is down → negate the angle)
  const a = size / 2;
  const b = a * round;
  const nx = -tangent.y;
  const ny = tangent.x;
  const phi = Math.atan2(ny, nx) + angle;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  return Math.sqrt(a * a * cos * cos + b * b * sin * sin);
}

function calligraphicItems(def: CalligraphicBrush, sps: SubPath[], stroke: StrokeStyle, k: number, seed: string): BrushItem[] {
  const out: BrushItem[] = [];
  const rnd = def.sizeVariation || def.roundnessVariation || def.angleVariation ? seeded(seed) : null;
  for (const sp of sps) {
    if (sp.anchors.length < 2) continue;
    const spine = new Spine(sp, 2);
    const pts = spine.pts;
    const hws = pts.map((_, i) => calligraphicHalfWidth(def, spine.at(spine.cum[i]).tangent, k, rnd));
    if (sp.closed) {
      // annulus: outer/inner offsets as two rings
      const left: Vec[] = [];
      const right: Vec[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const sp2 = spine.at(spine.cum[i]);
        left.push({ x: pts[i].x + sp2.normal.x * hws[i], y: pts[i].y + sp2.normal.y * hws[i] });
        right.push({ x: pts[i].x - sp2.normal.x * hws[i], y: pts[i].y - sp2.normal.y * hws[i] });
      }
      out.push({ subpaths: [polylineSubPath(left, true), polylineSubPath(right.reverse(), true)], fill: stroke.paint, stroke: null, fillRule: 'nonzero', opacity: 1 });
    } else {
      const ring = outlineRing(pts, hws, 10);
      out.push({ subpaths: [polylineSubPath(ring, true)], fill: stroke.paint, stroke: null, fillRule: 'nonzero', opacity: 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

function scatterItems(def: Extract<BrushDef, { kind: 'scatter' }>, sps: SubPath[], stroke: StrokeStyle, k: number, mode: BrushColorization, seed: string): BrushItem[] {
  const art = flattenArtwork(def.art);
  if (!art) return [];
  const out: BrushItem[] = [];
  const rnd = seeded(seed);
  const rangeOf = (r: [number, number]) => r[0] + (r[1] - r[0]) * rnd();
  const cx = art.bounds.x + art.bounds.width / 2;
  const cy = art.bounds.y + art.bounds.height / 2;
  const w = Math.max(art.bounds.width, 1e-6);
  for (const sp of sps) {
    const spine = new Spine(sp, 3);
    let s = 0;
    let guard = 0;
    while (s <= spine.length + 1e-6 && guard++ < 5000) {
      const size = (rangeOf(def.size) / 100) * k;
      const rot = rangeOf(def.rotation);
      const scatter = (rangeOf(def.scatter) / 100) * w * k;
      const at = spine.at(Math.min(s, spine.length));
      const angle = def.rotationRelativeTo === 'path' ? (Math.atan2(at.tangent.y, at.tangent.x) * 180) / Math.PI + rot : rot;
      const pos = { x: at.point.x + at.normal.x * scatter, y: at.point.y + at.normal.y * scatter };
      const m = compose(translate(pos.x, pos.y), rotate(angle), scaleM(size, size), translate(-cx, -cy));
      for (const p of art.paths) {
        const c = colorized(p, stroke, mode);
        out.push({ subpaths: transformSubPaths(p.subpaths, m), fill: c.fill, stroke: c.stroke ? { ...c.stroke, width: c.stroke.width * size } : null, fillRule: p.fillRule, opacity: p.opacity });
      }
      const spacing = Math.max(0.5, (rangeOf(def.spacing) / 100) * w * k);
      s += spacing;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------

function artItems(def: Extract<BrushDef, { kind: 'art' }>, sps: SubPath[], stroke: StrokeStyle, k: number, mode: BrushColorization, flipAlong: boolean, flipAcross: boolean): BrushItem[] {
  const art = flattenArtwork(def.art);
  if (!art) return [];
  const out: BrushItem[] = [];
  for (const sp of sps) {
    if (sp.anchors.length < 2) continue;
    const spine = new Spine(sp, 2);
    let widthScale = (def.width / 100) * k;
    if (def.stretch === 'proportional') widthScale = (spine.length / Math.max(art.bounds.width, 1e-6)) * (def.width / 100);
    const o = { box: art.bounds, s0: 0, s1: spine.length, widthScale, flipAlong, flipAcross };
    for (const p of art.paths) {
      const c = colorized(p, stroke, mode);
      out.push({ subpaths: bendSubPaths(spine, p.subpaths, o), fill: c.fill, stroke: c.stroke ? { ...c.stroke, width: c.stroke.width * widthScale } : null, fillRule: p.fillRule, opacity: p.opacity });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

function patternItems(def: Extract<BrushDef, { kind: 'pattern' }>, sps: SubPath[], stroke: StrokeStyle, k: number, mode: BrushColorization, flipAlong: boolean, flipAcross: boolean): BrushItem[] {
  const side = flattenArtwork(def.side);
  if (!side) return [];
  const start = def.start ? flattenArtwork(def.start) : null;
  const end = def.end ? flattenArtwork(def.end) : null;
  const out: BrushItem[] = [];
  const scale = (def.scale / 100) * k;
  const push = (art: FlatArt, spine: Spine, s0: number, s1: number, stretch: number) => {
    const o = { box: art.bounds, s0, s1, widthScale: scale * stretch, flipAlong, flipAcross };
    for (const p of art.paths) {
      const c = colorized(p, stroke, mode);
      out.push({ subpaths: bendSubPaths(spine, p.subpaths, o), fill: c.fill, stroke: c.stroke ? { ...c.stroke, width: c.stroke.width * scale } : null, fillRule: p.fillRule, opacity: p.opacity });
    }
  };
  for (const sp of sps) {
    if (sp.anchors.length < 2) continue;
    const spine = new Spine(sp, 2);
    const tileW = Math.max(side.bounds.width, 1e-6) * scale;
    const gap = (def.spacing / 100) * tileW;
    let s0 = 0;
    let s1 = spine.length;
    if (!sp.closed && start) {
      const w = start.bounds.width * scale;
      push(start, spine, 0, Math.min(w, spine.length), 1);
      s0 = w;
    }
    if (!sp.closed && end) {
      const w = end.bounds.width * scale;
      push(end, spine, Math.max(s0, spine.length - w), spine.length, 1);
      s1 = spine.length - w;
    }
    const avail = s1 - s0;
    if (avail <= 1e-6) continue;
    const pitch = tileW + gap;
    let n = Math.max(1, Math.round(avail / pitch));
    if (def.fit === 'space') n = Math.max(1, Math.floor(avail / pitch));
    const stretch = def.fit === 'stretch' ? avail / (n * tileW + (n - 1) * gap) : 1;
    const step = def.fit === 'space' ? avail / n : (tileW + gap) * stretch;
    for (let i = 0; i < n; i++) {
      const a = s0 + i * step + (def.fit === 'space' ? (step - tileW) / 2 : 0);
      const b = a + tileW * stretch;
      push(side, spine, a, b, 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Effective scale of a brush stroke: stroke weight × per-stroke scale. */
export function brushScale(stroke: StrokeStyle): number {
  return Math.max(0.01, (stroke.width > 0 ? stroke.width : 1) * (stroke.brush?.scale ?? 1));
}

/** Items of a brush stroke in the path's local space. */
export function brushItems(def: BrushDef, subpaths: SubPath[], stroke: StrokeStyle, seed = 'brush'): BrushItem[] {
  if (stroke.paint.type === 'none' && def.kind === 'calligraphic') return [];
  const k = brushScale(stroke);
  const mode = stroke.brush?.colorization ?? (def.kind === 'calligraphic' ? 'none' : def.colorization);
  const flipAlong = stroke.brush?.flipAlong ?? (def.kind === 'art' || def.kind === 'pattern' ? !!def.flipAlong : false);
  const flipAcross = stroke.brush?.flipAcross ?? (def.kind === 'art' || def.kind === 'pattern' ? !!def.flipAcross : false);
  switch (def.kind) {
    case 'calligraphic':
      return calligraphicItems(def, subpaths, stroke, k, seed);
    case 'scatter':
      return scatterItems(def, subpaths, stroke, k, mode, seed);
    case 'art':
      return artItems(def, subpaths, stroke, k, mode, flipAlong, flipAcross);
    case 'pattern':
      return patternItems(def, subpaths, stroke, k, mode, flipAlong, flipAcross);
  }
}

/** Approximate half extent of the brush around the spine (for visual bounds). */
export function brushPad(def: BrushDef, stroke: StrokeStyle): number {
  const k = brushScale(stroke);
  switch (def.kind) {
    case 'calligraphic':
      return (def.size * k) / 2 + (def.sizeVariation ?? 0);
    case 'scatter': {
      const art = flattenArtwork(def.art);
      if (!art) return 0;
      const size = Math.max(def.size[0], def.size[1]) / 100;
      const scatter = (Math.max(Math.abs(def.scatter[0]), Math.abs(def.scatter[1])) / 100) * art.bounds.width;
      return (Math.hypot(art.bounds.width, art.bounds.height) / 2) * size * k + scatter * k;
    }
    case 'art': {
      const art = flattenArtwork(def.art);
      return art ? ((art.bounds.height / 2) * def.width) / 100 * k * (def.stretch === 'proportional' ? 4 : 1) : 0;
    }
    case 'pattern': {
      const art = flattenArtwork(def.side);
      return art ? ((art.bounds.height / 2) * def.scale) / 100 * k : 0;
    }
  }
}

/** Bounds of brush items (local space). */
export function itemsBounds(items: BrushItem[]): Rect | null {
  let r: Rect | null = null;
  for (const it of items) r = rectUnion(r, pathBounds(it.subpaths));
  return r;
}

/** A sample S-curve used for previews (0..w × 0..h). */
export function sampleSpine(w: number, h: number): SubPath {
  return {
    closed: false,
    anchors: [
      { point: { x: w * 0.06, y: h * 0.62 }, handleIn: null, handleOut: { x: w * 0.25, y: -h * 0.6 }, kind: 'smooth' },
      { point: { x: w * 0.94, y: h * 0.4 }, handleIn: { x: -w * 0.25, y: h * 0.6 }, handleOut: null, kind: 'smooth' },
    ],
  };
}

export type { PathNode };
export { cloneSubPaths };
