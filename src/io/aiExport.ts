/**
 * Adobe Illustrator native export — the classic AI 3–8 "PostScript" format
 * documented in the Adobe Illustrator File Format Specification 7.0 (the last
 * public specification of the format; Illustrator 9+ files are PDFs with an
 * undocumented private data block). Illustrator, CorelDRAW, Affinity and
 * others open this format with editable layers, groups, compound paths, text,
 * gradients and named spot colours.
 *
 * What is written: layers (Lb / Ln / LB), groups (u / U), compound paths
 * (*u / *U), clipping groups (q / W / Q), locked objects (A), paths with solid
 * / spot / gradient fills and solid strokes (dashes, caps, joins, miter limit,
 * fill rule XR), point and area text (To / Tp / Tf / Tx / TO) and embedded RGB
 * images (XI). Colours are CMYK (k / K) or RGB (Xa / XA); spot swatches become
 * custom colours (x / X) listed in the header.
 *
 * Coordinates are points, y up, with the origin at the bottom-left corner of
 * the exported artboard (%AI5_ArtSize plus a degenerate %AI3_TemplateBox put
 * Illustrator's ruler origin there). The format has no opacity, blend modes,
 * raster effects, gradient strokes or gradient opacity: they are dropped and
 * reported in `warnings`. Callers should run prepareDocumentForAi first (it
 * expands brushes / patterns / effects, converts unrepresentable text to
 * outlines and decodes images); this module stays free of React and paper.js
 * so unit tests can cover it.
 */
import type { Document, ID, Node, PathNode, TextNode, ImageNode, Paint, SolidPaint, GradientPaint, Rect, SubPath, StrokeStyle, TextStyle, Matrix, Swatch, LayerNode } from '@/model/types';
import { isContainer } from '@/model/types';
import { worldMatrix, localBounds } from '@/model/document';
import { transformSubPaths, pathBounds, subpathToCubics } from '@/geometry/path';
import { multiply, applyToPoint } from '@/geometry/matrix';
import { effectiveSubPaths } from '@/canvas/effectiveGeometry';
import { hexToRgb } from '@/util/color';
import { rgbToCmyk } from '@/color/models';
import { exportRegions, safeFileName, type SvgExportOptions, type ExportRegion } from './regions';
import { preparedRaster } from './rasterHex';

export interface AiOptions extends SvgExportOptions {
  /** write process colours as CMYK inks (k / K) instead of RGB (Xa / XA); defaults to the document colour mode */
  cmyk?: boolean;
  /** %%Creator line (readers key on the "Adobe Illustrator" prefix to pick the AI parser) */
  creator?: string;
  /**
   * How non-ASCII characters in text bodies are encoded: 'latin1' writes ISO Latin-1
   * bytes, 'cp1251' additionally maps Cyrillic to Windows-1251 (matches Illustrator
   * on Russian Windows). Characters outside the chosen encoding become '?'.
   * prepareDocumentForAi outlines such text beforehand in 'auto' text mode.
   */
  encoding?: 'latin1' | 'cp1251';
}

export interface AiExportResult {
  ai: string;
  name: string;
  /** exported artboard size in px */
  width: number;
  height: number;
  artboardId?: ID;
  warnings: string[];
}

export const AI_CREATOR = 'Adobe Illustrator(r) 7.0';
const PT = 72 / 96;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function n(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = (+v.toFixed(4)).toString();
  return s === '-0' ? '0' : s;
}

function int(v: number): string {
  return String(Math.round(v));
}

/** Windows-1251 code points for the Cyrillic block used by Russian / Ukrainian / Belarusian. */
const CP1251: Record<number, number> = { 0x0401: 0xa8, 0x0451: 0xb8, 0x0404: 0xaa, 0x0454: 0xba, 0x0406: 0xb2, 0x0456: 0xb3, 0x0407: 0xaf, 0x0457: 0xbf, 0x0490: 0xa5, 0x0491: 0xb4, 0x040e: 0xa1, 0x045e: 0xa2, 0x0408: 0xa3, 0x0458: 0xbc, 0x0402: 0x80, 0x0452: 0x90, 0x0403: 0x81, 0x0453: 0x83, 0x2116: 0xb9, 0x20ac: 0x88 };
/** Typographic punctuation shared by Windows-1252 and Windows-1251 (Illustrator's Windows text encoding). */
const WIN_PUNCT: Record<number, number> = { 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 };
const CP1252_EXTRA: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x201e: 0x84, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

/** Latin-1 code points that keep their byte in Windows-1251 (the rest of 0xa0–0xff is Cyrillic there). */
const CP1251_LATIN = new Set<number>([0xa0, 0xa4, 0xa6, 0xa7, 0xa9, 0xab, 0xac, 0xad, 0xae, 0xb0, 0xb1, 0xb5, 0xb6, 0xb7, 0xbb]);

/** Byte for a non-ASCII character in the given encoding, or -1 when it has none. */
function encodeChar(cp: number, encoding: 'latin1' | 'cp1251'): number {
  if (WIN_PUNCT[cp] !== undefined) return WIN_PUNCT[cp];
  if (encoding === 'cp1251') {
    if (cp >= 0xa0 && cp <= 0xff) return CP1251_LATIN.has(cp) ? cp : -1;
    if (cp >= 0x0410 && cp <= 0x044f) return 0xc0 + (cp - 0x0410);
    if (CP1251[cp] !== undefined) return CP1251[cp];
    return -1;
  }
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return CP1252_EXTRA[cp] ?? -1;
}

/** Whether every character of the text can be written with the given encoding. */
export function isEncodable(text: string, encoding: 'ascii' | 'latin1' | 'cp1251'): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x09) continue;
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (encoding === 'ascii') return false;
    if (encodeChar(cp, encoding) < 0) return false;
  }
  return true;
}

/** The text encoding that keeps the most text objects editable (ties → Latin-1). */
export function chooseAiEncoding(texts: Array<{ text: string }>): 'latin1' | 'cp1251' {
  let latin = 0;
  let cyrillic = 0;
  for (const t of texts) {
    if (isEncodable(t.text, 'latin1')) latin++;
    if (isEncodable(t.text, 'cp1251')) cyrillic++;
  }
  return cyrillic > latin ? 'cp1251' : 'latin1';
}

/** Encode a JS string as PostScript string bytes (escaped), newlines as \r paragraphs. */
export function psString(text: string, encoding: 'latin1' | 'cp1251' = 'latin1'): string {
  let out = '(';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let byte: number;
    if (cp === 0x0a) byte = 0x0d;
    else if (cp === 0x09) byte = 0x09;
    else if (cp < 0x20) continue;
    else if (cp <= 0x7e) byte = cp;
    else {
      const enc = encodeChar(cp, encoding);
      byte = enc < 0 ? 0x3f : enc; // '?' for characters outside the encoding
    }
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\' + String.fromCharCode(byte);
    else if (byte < 0x20 || byte > 0x7e) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return out + ')';
}

function psName(s: string): string {
  // PostScript names cannot contain delimiters or spaces
  const clean = s.replace(/[\s()<>[\]{}/%]+/g, '');
  return clean || 'Untitled';
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

interface CustomColor {
  name: string;
  cmyk: [number, number, number, number];
}

interface Ctx {
  doc: Document;
  cmyk: boolean;
  encoding: 'latin1' | 'cp1251';
  /** world → AI points */
  base: Matrix;
  warnings: Set<string>;
  customColors: Map<string, CustomColor>;
  gradients: Map<string, { name: string; paint: GradientPaint }>;
  fonts: Set<string>;
  lines: string[];
  /** modal paint / attribute state of the stream */
  state: { fill: string; stroke: string; w: string; J: number; j: number; M: string; d: string; XR: number; A: number };
  dropped: { opacity: number; blend: number; effects: number; gradientStroke: number; markers: number; other: number };
}

function cmykOf(hex: string): [number, number, number, number] {
  const k = rgbToCmyk(hexToRgb(hex));
  return [k.c / 100, k.m / 100, k.y / 100, k.k / 100];
}

function spotSwatch(ctx: Ctx, p: SolidPaint): Swatch | undefined {
  if (!p.swatchId) return undefined;
  const sw = ctx.doc.swatches.find((s) => s.id === p.swatchId);
  return sw && sw.kind === 'spot' && sw.paint.type === 'solid' ? sw : undefined;
}

/** Fill (`stroke` = false) or stroke colour operator for a solid paint. */
function colorOp(ctx: Ctx, p: SolidPaint, stroke: boolean): string {
  const sw = spotSwatch(ctx, p);
  if (sw && sw.paint.type === 'solid') {
    const name = sw.name.trim() || 'Spot';
    let cc = ctx.customColors.get(name);
    if (!cc) {
      cc = { name, cmyk: sw.cmyk ? [sw.cmyk.c / 100, sw.cmyk.m / 100, sw.cmyk.y / 100, sw.cmyk.k / 100] : cmykOf(sw.paint.color) };
      ctx.customColors.set(name, cc);
    }
    const tint = Math.max(0, Math.min(100, p.tint ?? 100));
    // the file stores 1 − tint (0 = full ink), see spec 5.4.1
    return `${cc.cmyk.map(n).join(' ')} ${psString(name)} ${n(1 - tint / 100)} ${stroke ? 'X' : 'x'}`;
  }
  if (ctx.cmyk) return `${cmykOf(p.color).map(n).join(' ')} ${stroke ? 'K' : 'k'}`;
  const c = hexToRgb(p.color);
  return `${n(c.r / 255)} ${n(c.g / 255)} ${n(c.b / 255)} ${stroke ? 'XA' : 'Xa'}`;
}

/** A representative solid colour for paints the format cannot express. */
function fallbackSolid(p: Paint): SolidPaint {
  if (p.type === 'solid') return p;
  if (p.type === 'linear' || p.type === 'radial') {
    const stops = [...p.stops].sort((a, b) => a.offset - b.offset);
    return { type: 'solid', color: stops[0]?.color ?? '#000000', opacity: 1 };
  }
  if (p.type === 'freeform') return { type: 'solid', color: p.points[0]?.color ?? '#bfbfbf', opacity: 1 };
  if (p.type === 'mesh') return { type: 'solid', color: p.nodes[0]?.color ?? '#bfbfbf', opacity: 1 };
  return { type: 'solid', color: '#bfbfbf', opacity: 1 };
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

function gradientKey(p: GradientPaint): string {
  const stops = p.stops.map((s) => `${s.offset.toFixed(4)}:${s.color}`).join(',');
  return `${p.type}|${stops}`;
}

/** Register a gradient definition (deduplicated by type + stops) and return its name. */
function gradientName(ctx: Ctx, p: GradientPaint): string {
  const key = gradientKey(p);
  const known = ctx.gradients.get(key);
  if (known) return known.name;
  // reuse the swatch name when the document has a matching gradient swatch
  const sw = ctx.doc.swatches.find((s) => (s.paint.type === 'linear' || s.paint.type === 'radial') && gradientKey(s.paint) === key);
  const used = new Set(Array.from(ctx.gradients.values()).map((g) => g.name));
  let name = (sw?.name.trim() || `Gradient ${ctx.gradients.size + 1}`).replace(/[()\\]/g, '');
  let i = 2;
  while (used.has(name)) name = `${sw?.name.trim() || 'Gradient'} ${i++}`;
  ctx.gradients.set(key, { name, paint: p });
  return name;
}

function gradientDefinition(ctx: Ctx, name: string, p: GradientPaint): string[] {
  const stops = [...p.stops].sort((a, b) => a.offset - b.offset);
  // ramp points must be distinct: nudge hard stops apart (percent)
  const ramps: number[] = [];
  for (const s of stops) {
    let r = Math.max(0, Math.min(100, s.offset * 100));
    if (ramps.length && r <= ramps[ramps.length - 1]) r = Math.min(100, ramps[ramps.length - 1] + 0.01);
    ramps.push(r);
  }
  const out: string[] = [`%AI5_BeginGradient: ${psString(name)}`, `${psString(name)} ${p.type === 'radial' ? 1 : 0} ${stops.length} Bd`, '['];
  // Illustrator lists colour stops from the end of the ramp (100) to its start (0)
  for (let i = stops.length - 1; i >= 0; i--) {
    const s = stops[i];
    const cm = cmykOf(s.color).map(n).join(' ');
    if (ctx.cmyk) out.push(`${cm} 1 50 ${n(ramps[i])} %_Bs`);
    else {
      const c = hexToRgb(s.color);
      out.push(`${cm} ${n(c.r / 255)} ${n(c.g / 255)} ${n(c.b / 255)} 2 50 ${n(ramps[i])} %_Bs`);
    }
    if (s.opacity < 1) ctx.warnings.add('Gradient stop opacity is not supported by the AI format (stops were made opaque)');
  }
  out.push('BD', '%AI5_EndGradient');
  return out;
}

/** The scale factor of an affine matrix (geometric mean of its singular values). */
function meanScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}

/**
 * Gradient instance lines (Bb … Bg) for a path filled with a gradient. `geo` are the
 * local subpaths whose bounds define the gradient units, `m` maps local → AI space.
 */
function gradientInstance(ctx: Ctx, p: GradientPaint, geo: SubPath[], m: Matrix): string[] {
  const name = gradientName(ctx, p);
  const b = pathBounds(geo) ?? { x: 0, y: 0, width: 1, height: 1 };
  const bw = b.width || 1;
  const bh = b.height || 1;
  const out = ['Bb'];
  if (p.type === 'linear') {
    const a = applyToPoint(m, { x: b.x + p.x1 * bw, y: b.y + p.y1 * bh });
    const c = applyToPoint(m, { x: b.x + p.x2 * bw, y: b.y + p.y2 * bh });
    const angle = (Math.atan2(c.y - a.y, c.x - a.x) * 180) / Math.PI;
    const length = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    out.push(`1 ${psString(name)} ${n(a.x)} ${n(a.y)} ${n(angle)} ${n(length)} 1 0 0 1 0 0 Bg`);
  } else {
    const c = applyToPoint(m, { x: b.x + p.cx * bw, y: b.y + p.cy * bh });
    const radius = Math.max(1e-3, p.r * Math.max(bw, bh) * meanScale(m));
    let hi = '0 0 0 0 Bh';
    if (p.fx !== undefined && p.fy !== undefined) {
      const f = applyToPoint(m, { x: b.x + p.fx * bw, y: b.y + p.fy * bh });
      const dx = f.x - c.x;
      const dy = f.y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) hi = `${n(dx)} ${n(dy)} ${n((Math.atan2(dy, dx) * 180) / Math.PI)} ${n(Math.min(0.99, dist / radius))} Bh`;
    }
    out.push(hi, `1 ${psString(name)} ${n(c.x)} ${n(c.y)} 0 ${n(radius)} 1 0 0 1 0 0 Bg`);
  }
  if (p.spread !== 'pad') ctx.warnings.add('Reflected / repeated gradients are exported as padded gradients');
  return out;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Path construction operators for one subpath already in AI space. */
function subpathOps(sp: SubPath): string[] {
  if (!sp.anchors.length) return [];
  const out: string[] = [];
  const first = sp.anchors[0];
  out.push(`${n(first.point.x)} ${n(first.point.y)} m`);
  const cubics = subpathToCubics(sp);
  cubics.forEach((c, i) => {
    // the anchor reached by this segment decides smooth (lower case) vs corner (upper case)
    const target = sp.anchors[(i + 1) % sp.anchors.length];
    const smooth = target.kind === 'smooth';
    const line = Math.abs(c.p1.x - c.p0.x) < 1e-9 && Math.abs(c.p1.y - c.p0.y) < 1e-9 && Math.abs(c.p2.x - c.p3.x) < 1e-9 && Math.abs(c.p2.y - c.p3.y) < 1e-9;
    if (line) out.push(`${n(c.p3.x)} ${n(c.p3.y)} ${smooth ? 'l' : 'L'}`);
    else out.push(`${n(c.p1.x)} ${n(c.p1.y)} ${n(c.p2.x)} ${n(c.p2.y)} ${n(c.p3.x)} ${n(c.p3.y)} ${smooth ? 'c' : 'C'}`);
  });
  return out;
}

function emit(ctx: Ctx, ...lines: string[]): void {
  for (const l of lines) ctx.lines.push(l);
}

/** `emit` for arrays of any size: never spread lines into call arguments (a raster or a huge subpath overflows the stack). */
function emitAll(ctx: Ctx, lines: string[]): void {
  for (const l of lines) ctx.lines.push(l);
}

/** Write the modal paint attributes that changed. */
function setPaint(ctx: Ctx, fill: string | null, stroke: string | null, st: StrokeStyle | null, wm: Matrix, fillRule: 'nonzero' | 'evenodd'): void {
  const s = ctx.state;
  if (fill && fill !== s.fill) {
    emit(ctx, fill);
    s.fill = fill;
  }
  if (stroke && stroke !== s.stroke) {
    emit(ctx, stroke);
    s.stroke = stroke;
  }
  if (st) {
    // stroke widths and dashes are in the node's local px: scale by the world matrix and px → pt
    const k = meanScale(wm) * PT;
    const w = n(Math.max(0, st.width * k));
    const J = st.cap === 'round' ? 1 : st.cap === 'square' ? 2 : 0;
    const j = st.join === 'round' ? 1 : st.join === 'bevel' ? 2 : 0;
    const M = n(Math.max(1, st.miterLimit || 4));
    const d = st.dash.length ? `[${st.dash.map((v) => n(Math.max(0, v * k))).join(' ')}] ${n(st.dashOffset * k)} d` : '[] 0 d';
    const parts: string[] = [];
    if (J !== s.J) parts.push(`${J} J`);
    if (j !== s.j) parts.push(`${j} j`);
    if (w !== s.w) parts.push(`${w} w`);
    if (M !== s.M) parts.push(`${M} M`);
    if (d !== s.d) parts.push(d);
    if (parts.length) emit(ctx, parts.join(' '));
    s.J = J;
    s.j = j;
    s.w = w;
    s.M = M;
    s.d = d;
  }
  const xr = fillRule === 'evenodd' ? 1 : 0;
  if (xr !== s.XR) {
    emit(ctx, `${xr} XR`);
    s.XR = xr;
  }
}

function setLocked(ctx: Ctx, locked: boolean): void {
  const a = locked ? 1 : 0;
  if (a !== ctx.state.A) {
    emit(ctx, `${a} A`);
    ctx.state.A = a;
  }
}

function noteDropped(ctx: Ctx, node: Node): void {
  const paintOpacity = (p: Paint | undefined) => (p && p.type === 'solid' ? p.opacity : 1);
  const translucent = node.opacity < 1 || (node.type === 'path' || node.type === 'text' ? paintOpacity(node.fill) < 1 || paintOpacity(node.stroke.paint) < 1 : false);
  if (translucent) ctx.dropped.opacity++;
  if (node.blendMode !== 'normal') ctx.dropped.blend++;
  if (node.effects.some((e) => e.enabled)) ctx.dropped.effects++;
}

function writePath(ctx: Ctx, node: PathNode): void {
  const wm = worldMatrix(ctx.doc, node.id);
  const m = multiply(ctx.base, wm);
  // single-anchor subpaths (stray movetos from SVG arc syntax etc.) paint nothing and only confuse readers
  const geo = effectiveSubPaths(node).filter((sp) => sp.anchors.length > 1);
  if (!geo.length) return;
  const sps = transformSubPaths(geo, m);
  noteDropped(ctx, node);
  setLocked(ctx, node.locked);
  const fill = node.fill;
  const stroke = node.stroke;
  const hasStroke = stroke.paint.type !== 'none' && stroke.width > 0;
  const hasFill = fill.type !== 'none';
  if (hasStroke && stroke.paint.type !== 'solid') ctx.dropped.gradientStroke++;
  if (hasStroke && (stroke.markerStart !== 'none' || stroke.markerEnd !== 'none')) ctx.dropped.markers++;
  if (hasStroke && stroke.align !== 'center') ctx.warnings.add('Inside / outside stroke alignment is not supported by the AI format (strokes are centred)');
  if (fill.type === 'pattern' || fill.type === 'freeform' || fill.type === 'mesh') ctx.dropped.other++;
  const gradient = fill.type === 'linear' || fill.type === 'radial' ? fill : null;
  const fillOp = hasFill ? colorOp(ctx, fallbackSolid(fill), false) : null;
  const strokeOp = hasStroke ? colorOp(ctx, fallbackSolid(stroke.paint), true) : null;
  setPaint(ctx, fillOp, strokeOp, hasStroke ? stroke : null, wm, node.fillRule);
  const render = (closed: boolean) => {
    if (hasFill && hasStroke) return closed ? 'b' : 'B';
    if (hasFill) return closed ? 'f' : 'F';
    if (hasStroke) return closed ? 's' : 'S';
    return closed ? 'n' : 'N';
  };
  const one = (sp: SubPath) => {
    emitAll(ctx, subpathOps(sp));
    if (gradient) {
      emitAll(ctx, gradientInstance(ctx, gradient, geo, m));
      emit(ctx, sp.closed ? 'f' : 'F');
      emit(ctx, `${hasStroke ? (sp.closed ? 2 : 1) : 0} BB`);
    } else emit(ctx, render(sp.closed));
  };
  if (sps.length === 1) one(sps[0]);
  else {
    emit(ctx, '*u');
    for (const sp of sps) one(sp);
    emit(ctx, '*U');
  }
}

function writeClipPath(ctx: Ctx, clip: PathNode): boolean {
  const m = multiply(ctx.base, worldMatrix(ctx.doc, clip.id));
  const sps = transformSubPaths(effectiveSubPaths(clip), m).filter((sp) => sp.anchors.length > 1);
  if (!sps.length) return false;
  const xr = clip.fillRule === 'evenodd' ? 1 : 0;
  if (xr !== ctx.state.XR) {
    emit(ctx, `${xr} XR`);
    ctx.state.XR = xr;
  }
  const mask = (sp: SubPath) => {
    emitAll(ctx, subpathOps(sp));
    emit(ctx, 'h', 'W', 'n');
  };
  if (sps.length === 1) mask(sps[0]);
  else {
    emit(ctx, '*u');
    for (const sp of sps) mask(sp);
    emit(ctx, '*U');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

/** PostScript font name for a family / weight / style (Illustrator substitutes unknown names but keeps them). */
export function postScriptFontName(family: string, weight: number, italic: boolean): string {
  const bold = weight >= 600;
  const fam = family.trim();
  const key = fam.toLowerCase();
  const std: Record<string, [string, string, string, string]> = {
    helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
    arial: ['ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT', 'Arial-BoldItalicMT'],
    'times new roman': ['TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', 'TimesNewRomanPS-ItalicMT', 'TimesNewRomanPS-BoldItalicMT'],
    times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
    'courier new': ['CourierNewPSMT', 'CourierNewPS-BoldMT', 'CourierNewPS-ItalicMT', 'CourierNewPS-BoldItalicMT'],
    courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
    georgia: ['Georgia', 'Georgia-Bold', 'Georgia-Italic', 'Georgia-BoldItalic'],
    verdana: ['Verdana', 'Verdana-Bold', 'Verdana-Italic', 'Verdana-BoldItalic'],
    tahoma: ['Tahoma', 'Tahoma-Bold', 'Tahoma', 'Tahoma-Bold'],
    'trebuchet ms': ['TrebuchetMS', 'TrebuchetMS-Bold', 'TrebuchetMS-Italic', 'Trebuchet-BoldItalic'],
    'segoe ui': ['SegoeUI', 'SegoeUI-Bold', 'SegoeUI-Italic', 'SegoeUI-BoldItalic'],
  };
  const s = std[key];
  if (s) return s[(bold ? 1 : 0) + (italic ? 2 : 0)];
  const w = WEIGHT_NAMES[Math.round(weight / 100) * 100] ?? 'Regular';
  const style = italic ? (w === 'Regular' ? 'Italic' : `${w}Italic`) : w;
  return `${psName(fam.replace(/\s+/g, ''))}-${style}`;
}

interface TextFrame {
  /** unit-scale rotation + translation matrix (AI space) */
  tp: Matrix;
  /** scale along the baseline and perpendicular to it (points per px) */
  sx: number;
  sy: number;
}

/** Split the text node's AI matrix into a rigid Tp matrix and the scale that goes into the font size. */
function textFrame(m: Matrix): TextFrame {
  // AI text space is y up while the node's local space is y down: flip before decomposing
  const t = multiply(m, { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 });
  const sx = Math.hypot(t.a, t.b) || 1e-6;
  const det = t.a * t.d - t.b * t.c;
  const sy = Math.abs(det / sx) || 1e-6;
  const cos = t.a / sx;
  const sin = t.b / sx;
  return { tp: { a: cos, b: sin, c: -sin, d: cos, e: t.e, f: t.f }, sx, sy };
}

function textTransformApply(text: string, mode: TextStyle['textTransform']): string {
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'lowercase') return text.toLowerCase();
  if (mode === 'capitalize') return text.replace(/(^|\s)(\S)/g, (_, a: string, b: string) => a + b.toUpperCase());
  return text;
}

function writeText(ctx: Ctx, node: TextNode): void {
  if (!node.text.trim()) return;
  const wm = worldMatrix(ctx.doc, node.id);
  const m = multiply(ctx.base, wm);
  noteDropped(ctx, node);
  setLocked(ctx, node.locked);
  const frame = textFrame(m);
  const area = node.kind === 'area' && node.box;
  const fill = node.fill;
  const stroke = node.stroke;
  const hasStroke = stroke.paint.type !== 'none' && stroke.width > 0;
  const hasFill = fill.type !== 'none';
  if (fill.type !== 'none' && fill.type !== 'solid') ctx.dropped.other++;
  emit(ctx, `${area ? 1 : 0} To`);
  if (area) {
    // area text: identity matrix, the box as a path in page coordinates, Illustrator reflows the text
    emit(ctx, '1 0 0 1 0 0 0 Tp');
    const box = node.box!;
    const corners = [
      { x: 0, y: 0 },
      { x: box.width, y: 0 },
      { x: box.width, y: box.height },
      { x: 0, y: box.height },
    ].map((p) => applyToPoint(m, p));
    emit(ctx, `${n(corners[0].x)} ${n(corners[0].y)} m`);
    for (let i = 1; i < 4; i++) emit(ctx, `${n(corners[i].x)} ${n(corners[i].y)} L`);
    emit(ctx, `${n(corners[0].x)} ${n(corners[0].y)} L`, 'n', 'TP');
  } else {
    const t = frame.tp;
    emit(ctx, `${n(t.a)} ${n(t.b)} ${n(t.c)} ${n(t.d)} ${n(t.e)} ${n(t.f)} 0 Tp`, 'TP');
  }
  emit(ctx, `${hasFill && hasStroke ? 2 : hasFill ? 0 : hasStroke ? 1 : 3} Tr`);
  const fillOp = hasFill ? colorOp(ctx, fallbackSolid(fill), false) : null;
  const strokeOp = hasStroke ? colorOp(ctx, fallbackSolid(stroke.paint), true) : null;
  setPaint(ctx, fillOp, strokeOp, hasStroke ? stroke : null, wm, 'nonzero');
  const base = node.style;
  const k = area ? frame.sy : frame.sy; // points per local px
  const align = base.textAlign === 'center' ? 1 : base.textAlign === 'right' ? 2 : base.textAlign === 'justify' ? 3 : 0;
  emit(ctx, `${n((frame.sx / frame.sy) * 100)} 100 Tz`, '1 TA', '0 0 5 TC', '100 100 200 TW', '0 0 0 Ti', `${align} Ta`, '0 Tq');
  let lastFont = '';
  let lastLead = '';
  let lastTrack = '';
  let lastRise = '';
  let paragraphStart = true;
  for (const run of node.runs) {
    if (!run.text) continue;
    const st: TextStyle = { ...base, ...(run.style ?? {}) };
    const size = st.fontSize * k;
    const font = `/_${postScriptFontName(st.fontFamily, st.fontWeight, st.fontStyle === 'italic')} ${n(size)} Tf`;
    if (font !== lastFont) {
      emit(ctx, font);
      ctx.fonts.add(postScriptFontName(st.fontFamily, st.fontWeight, st.fontStyle === 'italic'));
      lastFont = font;
    }
    const rise = `${n(-st.baselineShift * k)} Ts`;
    if (rise !== lastRise) {
      emit(ctx, rise);
      lastRise = rise;
    }
    const track = `${int(st.fontSize ? (st.letterSpacing / st.fontSize) * 1000 : 0)} Tt`;
    if (track !== lastTrack) {
      emit(ctx, track);
      lastTrack = track;
    }
    const lead = `${n(st.lineHeight * size)} ${n(st.paragraphSpacing * k)} Tl`;
    if (lead !== lastLead) {
      emit(ctx, lead);
      lastLead = lead;
    }
    if (st.textDecoration !== 'none') ctx.warnings.add('Underline / strike-through are not supported by the AI format');
    const text = textTransformApply(run.text, st.textTransform);
    emit(ctx, `${psString(text, ctx.encoding)} ${align === 3 ? 'Tj' : 'Tx'} 1 0 Tk`);
    paragraphStart = text.endsWith('\n');
  }
  void paragraphStart;
  emit(ctx, 'TO');
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function writeImage(ctx: Ctx, node: ImageNode): void {
  const img = preparedRaster(node.src);
  if (!img) {
    ctx.warnings.add('An image could not be decoded and was skipped');
    return;
  }
  noteDropped(ctx, node);
  setLocked(ctx, node.locked);
  const wm = worldMatrix(ctx.doc, node.id);
  // pixel space (y down, row 0 on top) → node local → AI page
  const m = multiply(multiply(ctx.base, wm), { a: node.width / img.width, b: 0, c: 0, d: node.height / img.height, e: 0, f: 0 });
  emit(ctx, '%AI5_File:', '%AI5_BeginRaster');
  emit(ctx, `[${n(m.a)} ${n(m.b)} ${n(m.c)} ${n(m.d)} ${n(m.e)} ${n(m.f)}] 0 0 ${img.width} ${img.height} ${img.width} ${img.height} 8 3 0 0 0 0 XI`);
  for (const line of img.hex.split('\n')) emit(ctx, '%' + line);
  emit(ctx, '%AI5_EndRaster');
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

function writeNode(ctx: Ctx, id: ID, includeHidden: boolean): void {
  const node = ctx.doc.nodes[id];
  if (!node) return;
  if (!node.visible && !includeHidden) return;
  if (node.type === 'path') return writePath(ctx, node);
  if (node.type === 'text') return writeText(ctx, node);
  if (node.type === 'image') return writeImage(ctx, node);
  if (!isContainer(node)) return;
  noteDropped(ctx, node);
  const clipId = node.type === 'group' ? node.clipId : null;
  const clip = clipId ? ctx.doc.nodes[clipId] : undefined;
  const children = node.children.filter((c) => c !== clipId);
  if (clip && clip.type === 'path') {
    setLocked(ctx, node.locked);
    emit(ctx, 'q');
    writeClipPath(ctx, clip);
    for (const c of children) writeNode(ctx, c, includeHidden);
    emit(ctx, 'Q');
    return;
  }
  if (clip) ctx.warnings.add('Clipping masks made of text or images are not supported (the group was exported unclipped)');
  if (!children.length) return;
  setLocked(ctx, node.locked);
  emit(ctx, 'u');
  for (const c of children) writeNode(ctx, c, includeHidden);
  emit(ctx, 'U');
}

function contentBounds(ctx: Ctx, roots: ID[], includeHidden: boolean): Rect | null {
  let r: Rect | null = null;
  const visit = (id: ID) => {
    const node = ctx.doc.nodes[id];
    if (!node || (!node.visible && !includeHidden)) return;
    if (isContainer(node)) {
      for (const c of node.children) visit(c);
      return;
    }
    const lb = localBounds(ctx.doc, id);
    if (!lb) return;
    const m = multiply(ctx.base, worldMatrix(ctx.doc, id));
    const pts = [
      { x: lb.x, y: lb.y },
      { x: lb.x + lb.width, y: lb.y },
      { x: lb.x, y: lb.y + lb.height },
      { x: lb.x + lb.width, y: lb.y + lb.height },
    ].map((p) => applyToPoint(m, p));
    const pad = node.type === 'path' ? (node.stroke.paint.type !== 'none' ? (node.stroke.width * meanScale(m)) / 2 : 0) : 0;
    const x0 = Math.min(...pts.map((p) => p.x)) - pad;
    const x1 = Math.max(...pts.map((p) => p.x)) + pad;
    const y0 = Math.min(...pts.map((p) => p.y)) - pad;
    const y1 = Math.max(...pts.map((p) => p.y)) + pad;
    r = r ? { x: Math.min(r.x, x0), y: Math.min(r.y, y0), width: Math.max(r.x + r.width, x1) - Math.min(r.x, x0), height: Math.max(r.y + r.height, y1) - Math.min(r.y, y0) } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  for (const id of roots) visit(id);
  return r;
}

const LAYER_COLOR_INDEX: Array<[string, number]> = [
  ['#4fa0ff', 0],
  ['#ff4040', 1],
  ['#40c040', 2],
  ['#4040ff', 3],
  ['#ffe040', 4],
  ['#ff40ff', 5],
  ['#40ffff', 6],
];

function layerColorIndex(hex: string): number {
  const c = hexToRgb(hex);
  let best = -1;
  let bestD = 60 * 60;
  for (const [h, i] of LAYER_COLOR_INDEX) {
    const k = hexToRgb(h);
    const d = Math.hypot(c.r - k.r, c.g - k.g, c.b - k.b);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

interface LayerSpec {
  name: string;
  visible: boolean;
  locked: boolean;
  color: string;
  children: ID[];
}

function layersFor(ctx: Ctx, region: ExportRegion, includeHidden: boolean): LayerSpec[] {
  const doc = ctx.doc;
  if (region.ids) {
    return [{ name: safeFileName(doc.name), visible: true, locked: false, color: '#4fa0ff', children: region.ids }];
  }
  const out: LayerSpec[] = [];
  for (const lid of doc.layers) {
    const l = doc.nodes[lid] as LayerNode | undefined;
    if (!l || l.type !== 'layer') continue;
    if (!l.visible && !includeHidden) continue;
    out.push({ name: l.name, visible: l.visible, locked: l.locked, color: l.color, children: l.children });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function rulerUnits(units: Document['units']): number {
  switch (units) {
    case 'in':
      return 0;
    case 'mm':
      return 1;
    case 'cm':
      return 4;
    default:
      return 2;
  }
}

/** Export one region (the artboard is region.trim or region.rect) as Illustrator text. */
export function exportAiRegion(doc: Document, region: ExportRegion, opts: AiOptions = {}): AiExportResult {
  const rect = region.trim ?? region.rect;
  const includeHidden = !!opts.includeHidden;
  const ctx: Ctx = {
    doc,
    cmyk: opts.cmyk ?? doc.colorMode === 'cmyk',
    encoding: opts.encoding ?? 'latin1',
    base: { a: PT, b: 0, c: 0, d: -PT, e: -rect.x * PT, f: (rect.y + rect.height) * PT },
    warnings: new Set(),
    customColors: new Map(),
    gradients: new Map(),
    fonts: new Set(),
    lines: [],
    state: { fill: '', stroke: '', w: '1', J: 0, j: 0, M: '4', d: '[] 0 d', XR: 0, A: 0 },
    dropped: { opacity: 0, blend: 0, effects: 0, gradientStroke: 0, markers: 0, other: 0 },
  };
  const wPt = rect.width * PT;
  const hPt = rect.height * PT;
  const layers = layersFor(ctx, region, includeHidden);
  // body first: it collects gradients, custom colours and fonts for the header
  const bg = opts.backgroundColor !== undefined ? opts.backgroundColor : (opts.background ?? true) ? region.background : null;
  const body: string[] = [];
  const bgRect = bg && bg.toLowerCase() !== '#ffffff' ? bg : null;
  layers.forEach((layer, i) => {
    ctx.lines = [];
    emit(ctx, '%AI5_BeginLayer');
    const c = hexToRgb(layer.color);
    emit(ctx, `${layer.visible ? 1 : 0} 1 ${layer.locked ? 0 : 1} 1 0 0 ${layerColorIndex(layer.color)} ${int(c.r)} ${int(c.g)} ${int(c.b)} Lb`);
    emit(ctx, `${psString(layer.name, ctx.encoding)} Ln`);
    // the modal state restarts in every layer: write the defaults once
    ctx.state = { fill: '', stroke: '', w: '1', J: 0, j: 0, M: '4', d: '[] 0 d', XR: 0, A: 0 };
    emit(ctx, '0 A', '0 O', '0 R', '0 J 0 j 1 w 4 M []0 d', '0 XR');
    if (i === 0 && bgRect) {
      emit(ctx, colorOp(ctx, { type: 'solid', color: bgRect, opacity: 1 }, false));
      ctx.state.fill = colorOp(ctx, { type: 'solid', color: bgRect, opacity: 1 }, false);
      emit(ctx, `0 0 m ${n(wPt)} 0 L ${n(wPt)} ${n(hPt)} L 0 ${n(hPt)} L 0 0 L`, 'f');
    }
    for (const id of layer.children) writeNode(ctx, id, includeHidden);
    emit(ctx, 'LB', '%AI5_EndLayer--');
    // one hex row per line for every raster: tens of thousands of entries per image — never spread
    for (const l of ctx.lines) body.push(l);
  });
  if (!layers.length) body.push('%AI5_BeginLayer', '1 1 1 1 0 0 0 79 128 255 Lb', '(Layer 1) Ln', 'LB', '%AI5_EndLayer--');
  const roots = layers.flatMap((l) => l.children);
  const cb = contentBounds(ctx, roots, includeHidden) ?? { x: 0, y: 0, width: wPt, height: hPt };
  const bbox = { x0: Math.min(cb.x, 0), y0: Math.min(cb.y, 0), x1: Math.max(cb.x + cb.width, wPt), y1: Math.max(cb.y + cb.height, hPt) };
  const now = new Date();
  const title = `${region.name}.ai`;
  const head: string[] = [];
  head.push('%!PS-Adobe-3.0');
  head.push(`%%Creator: ${opts.creator ?? AI_CREATOR}`);
  head.push('%%For: (OPuller) (OPuller)');
  head.push(`%%Title: ${psString(title, ctx.encoding)}`);
  head.push(`%%CreationDate: (${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}) (${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() < 12 ? 'AM' : 'PM'})`);
  head.push(`%%BoundingBox: ${int(Math.floor(bbox.x0))} ${int(Math.floor(bbox.y0))} ${int(Math.ceil(bbox.x1))} ${int(Math.ceil(bbox.y1))}`);
  head.push(`%%HiResBoundingBox: ${n(bbox.x0)} ${n(bbox.y0)} ${n(bbox.x1)} ${n(bbox.y1)}`);
  head.push('%%DocumentProcessColors: Cyan Magenta Yellow Black');
  const customs = Array.from(ctx.customColors.values());
  if (customs.length) {
    head.push(`%%DocumentCustomColors: ${psString(customs[0].name)}`);
    for (const cc of customs.slice(1)) head.push(`%%+ ${psString(cc.name)}`);
    head.push(`%%CMYKCustomColor: ${customs[0].cmyk.map(n).join(' ')} ${psString(customs[0].name)}`);
    for (const cc of customs.slice(1)) head.push(`%%+ ${cc.cmyk.map(n).join(' ')} ${psString(cc.name)}`);
  }
  const fonts = Array.from(ctx.fonts);
  if (fonts.length) {
    head.push(`%%DocumentFonts: ${fonts[0]}`);
    for (const f of fonts.slice(1)) head.push(`%%+ ${f}`);
  }
  head.push('%%DocumentNeededResources: procset Adobe_level2_AI5 1.2 0');
  head.push('%%+ procset Adobe_ColorImage_AI6 1.3 0');
  head.push('%%+ procset Adobe_Illustrator_AI5 1.3 0');
  if (fonts.length) head.push('%%+ procset Adobe_cshow 2.0 8');
  head.push('%AI5_FileFormat 3');
  head.push('%AI3_ColorUsage: Color');
  head.push(`%AI5_ArtSize: ${n(wPt)} ${n(hPt)}`);
  head.push(`%AI5_RulerUnits: ${rulerUnits(doc.units)}`);
  head.push('%AI5_ArtFlags: 1 0 0 1 0 0 1 1 0');
  head.push('%AI5_TargetResolution: 800');
  head.push(`%AI5_NumLayers: ${Math.max(1, layers.length)}`);
  head.push(`%AI5_OpenToView: ${int(-Math.max(50, wPt * 0.1))} ${int(hPt + Math.max(50, hPt * 0.1))} 1 ${int(Math.max(400, wPt * 1.2))} ${int(Math.max(300, hPt * 1.2))} 26 1 0 12 130 0 0`);
  head.push(`%AI5_OpenViewLayers: ${'7'.repeat(Math.max(1, layers.length))}`);
  head.push(`%AI3_TemplateBox: ${n(wPt / 2)} ${n(hPt / 2)} ${n(wPt / 2)} ${n(hPt / 2)}`);
  head.push(`%AI3_TileBox: 0 0 ${n(wPt)} ${n(hPt)}`);
  head.push('%AI3_DocumentPreview: None');
  head.push('%AI7_ImageSettings: 1');
  // non-standard hint for OPuller's own reader (Illustrator ignores unknown comments): how bytes ≥ 0x80 in strings are encoded
  head.push(`%AI_OPuller_TextEncoding: ${ctx.encoding === 'cp1251' ? 'cp1251' : 'cp1252'}`);
  head.push('%%EndComments');
  head.push('%%BeginProlog');
  head.push('%%IncludeResource: procset Adobe_level2_AI5 1.2 0');
  head.push('%%IncludeResource: procset Adobe_ColorImage_AI6 1.3 0');
  head.push('%%IncludeResource: procset Adobe_Illustrator_AI5 1.3 0');
  if (fonts.length) head.push('%%IncludeResource: procset Adobe_cshow 2.0 8');
  head.push('%%EndProlog');
  head.push('%%BeginSetup');
  for (const f of fonts) head.push(`%%IncludeFont: ${f}`);
  head.push('Adobe_level2_AI5 /initialize get exec');
  head.push('Adobe_ColorImage_AI6 /initialize get exec');
  head.push('Adobe_Illustrator_AI5 /initialize get exec');
  if (fonts.length) head.push('Adobe_cshow /initialize get exec');
  for (const f of fonts) {
    head.push(`%AI3_BeginEncoding: _${f} ${f}`);
    head.push(`[/_${f}/${f} 0 0 1 TZ`);
    head.push('%AI3_EndEncoding AdobeType');
  }
  const grads = Array.from(ctx.gradients.values());
  if (grads.length) {
    head.push(`${grads.length} Bn`);
    for (const g of grads) head.push(...gradientDefinition(ctx, g.name, g.paint));
  }
  head.push('%%EndSetup');
  const tail = ['%%PageTrailer', 'gsave annotatepage grestore showpage', '%%Trailer'];
  if (fonts.length) tail.push('Adobe_cshow /terminate get exec');
  tail.push('Adobe_Illustrator_AI5 /terminate get exec', 'Adobe_ColorImage_AI6 /terminate get exec', 'Adobe_level2_AI5 /terminate get exec', '%%EOF');
  const d = ctx.dropped;
  const plural = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
  if (d.opacity) ctx.warnings.add(`Opacity is not supported by the AI format: ${plural(d.opacity, 'object')} exported opaque`);
  if (d.blend) ctx.warnings.add(`Blend modes are not supported by the AI format (${plural(d.blend, 'object')})`);
  if (d.effects) ctx.warnings.add(`Live effects (shadows, blur, glow…) are not supported by the AI format (${plural(d.effects, 'object')}); expand them before exporting`);
  if (d.gradientStroke) ctx.warnings.add(`Gradient strokes were exported as solid strokes (${plural(d.gradientStroke, 'object')})`);
  if (d.markers) ctx.warnings.add(`Arrowheads are not supported by the AI format (${plural(d.markers, 'object')})`);
  if (d.other) ctx.warnings.add(`Pattern, freeform and mesh fills were exported as solid colours (${plural(d.other, 'object')}); expand them before exporting`);
  return { ai: [...head, ...body, ...tail].join('\n') + '\n', name: region.name, width: rect.width, height: rect.height, artboardId: region.artboardId, warnings: Array.from(ctx.warnings) };
}

/** Export every region of the scope (one file per artboard for scope 'artboards'). */
export function exportAiAll(doc: Document, opts: AiOptions = {}): AiExportResult[] {
  // bleed / marks are not part of the format: export the trim box
  return exportRegions(doc, { ...opts, bleed: undefined, marks: undefined }).map((r) => exportAiRegion(doc, r, opts));
}

/** Export the first region of a scope. */
export function exportAi(doc: Document, opts: AiOptions = {}): AiExportResult {
  const list = exportAiAll(doc, opts);
  if (!list.length) throw new Error(opts.scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
  return list[0];
}
