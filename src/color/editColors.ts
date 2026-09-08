/**
 * Edit > Edit Colors: pure colour transformations over the paints of a set of
 * nodes (fills, strokes and gradient stops), plus colour statistics used by
 * Recolor Artwork.
 */
import type { Document, ID, Paint, HexColor, GradientStop, Node } from '@/model/types';
import { descendants, sortByPaintOrder, worldBounds } from '@/model/document';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, mixHex, type RGB, type HSB } from '@/util/color';
import { rgbToCmyk, cmykToRgb } from './models';

export type ColorSlot = 'fill' | 'stroke' | 'stop';
export type ColorMapper = (hex: HexColor, slot: ColorSlot) => HexColor;

export interface ColorTargets {
  fills?: boolean;
  strokes?: boolean;
  gradients?: boolean;
}

const ALL: Required<ColorTargets> = { fills: true, strokes: true, gradients: true };

/** Leaf ids (path/text) under the given ids. */
export function colorLeaves(doc: Document, ids: ID[]): ID[] {
  const out: ID[] = [];
  for (const id of ids) for (const d of descendants(doc, id, true)) {
    const n = doc.nodes[d];
    if (n && (n.type === 'path' || n.type === 'text')) out.push(d);
  }
  return Array.from(new Set(out));
}

function mapPaint(p: Paint, slot: 'fill' | 'stroke', fn: ColorMapper, t: Required<ColorTargets>): Paint {
  if (p.type === 'solid') {
    if (slot === 'fill' && !t.fills) return p;
    if (slot === 'stroke' && !t.strokes) return p;
    const color = fn(p.color, slot);
    if (color === p.color) return p;
    // an explicit colour edit breaks the link to a global swatch
    const { swatchId: _s, tint: _t, ...rest } = p;
    return { ...rest, color };
  }
  if ((p.type === 'linear' || p.type === 'radial') && t.gradients) {
    let changed = false;
    const stops: GradientStop[] = p.stops.map((s) => {
      const color = fn(s.color, 'stop');
      if (color === s.color) return s;
      changed = true;
      return { offset: s.offset, color, opacity: s.opacity };
    });
    return changed ? { ...p, stops } : p;
  }
  return p;
}

/** Apply a colour mapper to the paints of the nodes (mutates a draft). Returns the number of changed paints. */
export function mapColors(doc: Document, ids: ID[], fn: ColorMapper, targets: ColorTargets = ALL): number {
  const t = { ...ALL, ...targets };
  let count = 0;
  for (const id of colorLeaves(doc, ids)) {
    const n = doc.nodes[id];
    if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
    const f = mapPaint(n.fill, 'fill', fn, t);
    if (f !== n.fill) {
      n.fill = f;
      count++;
    }
    const sp = mapPaint(n.stroke.paint, 'stroke', fn, t);
    if (sp !== n.stroke.paint) {
      n.stroke = { ...n.stroke, paint: sp };
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface ColorUse {
  color: HexColor;
  /** how many paints use it */
  count: number;
  slots: Set<ColorSlot>;
}

/** Distinct colours used by the nodes, most used first. */
export function collectColors(doc: Document, ids: ID[], targets: ColorTargets = ALL): ColorUse[] {
  const t = { ...ALL, ...targets };
  const map = new Map<HexColor, ColorUse>();
  const add = (hex: HexColor, slot: ColorSlot) => {
    let u = map.get(hex);
    if (!u) {
      u = { color: hex, count: 0, slots: new Set() };
      map.set(hex, u);
    }
    u.count++;
    u.slots.add(slot);
  };
  const visit = (p: Paint, slot: 'fill' | 'stroke') => {
    if (p.type === 'solid') {
      if ((slot === 'fill' && t.fills) || (slot === 'stroke' && t.strokes)) add(p.color, slot);
    } else if ((p.type === 'linear' || p.type === 'radial') && t.gradients) for (const s of p.stops) add(s.color, 'stop');
  };
  for (const id of colorLeaves(doc, ids)) {
    const n = doc.nodes[id];
    if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
    visit(n.fill, 'fill');
    visit(n.stroke.paint, 'stroke');
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || a.color.localeCompare(b.color));
}

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

export function invertColor(hex: HexColor): HexColor {
  const c = hexToRgb(hex);
  return rgbToHex({ r: 255 - c.r, g: 255 - c.g, b: 255 - c.b });
}

export function grayscaleColor(hex: HexColor): HexColor {
  const c = hexToRgb(hex);
  const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return rgbToHex({ r: l, g: l, b: l });
}

/** Saturate (+) or desaturate (−) by amount −1..1 (Illustrator: −100 %..100 %). */
export function saturateColor(hex: HexColor, amount: number): HexColor {
  const h = rgbToHsb(hexToRgb(hex));
  if (h.s < 1e-6) return hex; // neutral colours have no hue to saturate
  const s = amount >= 0 ? h.s + (100 - h.s) * amount : h.s * (1 + amount);
  return rgbToHex(hsbToRgb({ ...h, s: Math.max(0, Math.min(100, s)) }));
}

export interface HsbShift {
  /** degrees */
  hue: number;
  /** −1..1 relative */
  saturation: number;
  /** −1..1 relative */
  brightness: number;
}

export function shiftHsb(hex: HexColor, d: HsbShift): HexColor {
  const h = rgbToHsb(hexToRgb(hex));
  const neutral = h.s < 1e-6;
  const s = neutral ? 0 : d.saturation >= 0 ? h.s + (100 - h.s) * d.saturation : h.s * (1 + d.saturation);
  const b = d.brightness >= 0 ? h.b + (100 - h.b) * d.brightness : h.b * (1 + d.brightness);
  return rgbToHex(hsbToRgb({ h: (((h.h + d.hue) % 360) + 360) % 360, s: Math.max(0, Math.min(100, s)), b: Math.max(0, Math.min(100, b)) }));
}

export interface ColorBalance {
  /** RGB deltas in −100..100 (percent of 255) */
  r: number;
  g: number;
  b: number;
  /** CMYK deltas in −100..100 (ink percent) */
  c: number;
  m: number;
  y: number;
  k: number;
  mode: 'rgb' | 'cmyk';
}

export function balanceColor(hex: HexColor, d: ColorBalance): HexColor {
  const c = hexToRgb(hex);
  if (d.mode === 'rgb') {
    return rgbToHex({ r: clamp255(c.r + (d.r / 100) * 255), g: clamp255(c.g + (d.g / 100) * 255), b: clamp255(c.b + (d.b / 100) * 255) });
  }
  const k = rgbToCmyk(c);
  return rgbToHex(cmykToRgb({ c: clamp100(k.c + d.c), m: clamp100(k.m + d.m), y: clamp100(k.y + d.y), k: clamp100(k.k + d.k) }));
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

/** True for pure white / black / neutral greys (used by "preserve" options). */
export function isWhite(hex: HexColor): boolean {
  return hex === '#ffffff';
}
export function isBlack(hex: HexColor): boolean {
  return hex === '#000000';
}
export function isGray(hex: HexColor, tolerance = 6): boolean {
  const c = hexToRgb(hex);
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= tolerance;
}

// ---------------------------------------------------------------------------
// Blend Front to Back / Horizontally / Vertically
// ---------------------------------------------------------------------------

export type BlendAxis = 'stack' | 'x' | 'y';

/**
 * Interpolate the fill colours of the selected objects from the first to the
 * last (by stacking order or position). Objects without a solid fill are
 * skipped. Returns the number of changed objects.
 */
export function blendColors(doc: Document, ids: ID[], axis: BlendAxis): number {
  let list = colorLeaves(doc, ids).filter((id) => {
    const n = doc.nodes[id];
    return n && (n.type === 'path' || n.type === 'text') && n.fill.type === 'solid';
  });
  if (axis === 'stack') list = sortByPaintOrder(doc, list).reverse(); // front first
  else {
    const centers = new Map<ID, number>();
    for (const id of list) {
      const b = worldBounds(doc, id);
      centers.set(id, b ? (axis === 'x' ? b.x + b.width / 2 : b.y + b.height / 2) : 0);
    }
    list.sort((a, b) => (centers.get(a) ?? 0) - (centers.get(b) ?? 0));
  }
  if (list.length < 3) return 0;
  const first = (doc.nodes[list[0]] as Node & { fill: Paint }).fill as { type: 'solid'; color: HexColor };
  const last = (doc.nodes[list[list.length - 1]] as Node & { fill: Paint }).fill as { type: 'solid'; color: HexColor };
  let count = 0;
  for (let i = 1; i < list.length - 1; i++) {
    const n = doc.nodes[list[i]];
    if (!n || (n.type !== 'path' && n.type !== 'text') || n.fill.type !== 'solid') continue;
    const t = i / (list.length - 1);
    n.fill = { type: 'solid', color: mixHex(first.color, last.color, t), opacity: n.fill.opacity };
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Palettes: harmonies, reduction, nearest colours
// ---------------------------------------------------------------------------

export type Harmony = 'complementary' | 'analogous' | 'triad' | 'split' | 'tetrad' | 'monochromatic' | 'shades' | 'compound';

export const HARMONIES: Array<{ id: Harmony; label: string }> = [
  { id: 'complementary', label: 'Complementary' },
  { id: 'analogous', label: 'Analogous' },
  { id: 'triad', label: 'Triad' },
  { id: 'split', label: 'Split complementary' },
  { id: 'tetrad', label: 'Tetrad' },
  { id: 'monochromatic', label: 'Monochromatic' },
  { id: 'shades', label: 'Shades' },
  { id: 'compound', label: 'Compound' },
];

function hsb(hex: HexColor): HSB {
  return rgbToHsb(hexToRgb(hex));
}
function fromHsb(h: HSB): HexColor {
  return rgbToHex(hsbToRgb({ h: ((h.h % 360) + 360) % 360, s: Math.max(0, Math.min(100, h.s)), b: Math.max(0, Math.min(100, h.b)) }));
}

/** Palette of `count` colours derived from a base colour with a harmony rule. */
export function harmonyPalette(base: HexColor, harmony: Harmony, count: number): HexColor[] {
  const b = hsb(base);
  const hues: number[] = (() => {
    switch (harmony) {
      case 'complementary':
        return [0, 180];
      case 'analogous':
        return [0, 30, -30, 60, -60];
      case 'triad':
        return [0, 120, 240];
      case 'split':
        return [0, 150, 210];
      case 'tetrad':
        return [0, 90, 180, 270];
      case 'compound':
        return [0, 30, 180, 210];
      case 'monochromatic':
      case 'shades':
        return [0];
    }
  })();
  const out: HexColor[] = [];
  for (let i = 0; i < count; i++) {
    if (harmony === 'monochromatic') {
      const k = i / Math.max(1, count - 1);
      out.push(fromHsb({ h: b.h, s: Math.max(15, b.s * (1 - 0.6 * k)), b: Math.min(100, b.b * (0.55 + 0.45 * (1 - k)) + 30 * k) }));
    } else if (harmony === 'shades') {
      const k = i / Math.max(1, count - 1);
      out.push(fromHsb({ h: b.h, s: b.s, b: Math.max(8, b.b * (1 - 0.85 * k)) }));
    } else {
      const hue = hues[i % hues.length];
      const round = Math.floor(i / hues.length);
      out.push(fromHsb({ h: b.h + hue, s: Math.max(10, b.s - round * 18), b: Math.min(100, b.b + round * 10) }));
    }
  }
  return out;
}

/** Perceptual-ish distance in RGB (weighted). */
export function colorDistance(a: HexColor, b: HexColor): number {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const rmean = (ca.r + cb.r) / 2;
  const dr = ca.r - cb.r;
  const dg = ca.g - cb.g;
  const db = ca.b - cb.b;
  return Math.sqrt((2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db);
}

export function nearestColor(hex: HexColor, palette: HexColor[]): HexColor {
  let best = palette[0] ?? hex;
  let bd = Infinity;
  for (const p of palette) {
    const d = colorDistance(hex, p);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/**
 * Reduce a list of (weighted) colours to `k` representative colours with
 * k-means in RGB. Returns the palette (most used cluster first).
 */
export function reduceColors(colors: Array<{ color: HexColor; count: number }>, k: number, iterations = 12): HexColor[] {
  if (!colors.length) return [];
  if (colors.length <= k) return colors.map((c) => c.color);
  const pts = colors.map((c) => ({ p: hexToRgb(c.color), w: c.count }));
  // init: most used colours that are far apart
  const centers: RGB[] = [];
  for (const c of [...colors].sort((a, b) => b.count - a.count)) {
    if (centers.length >= k) break;
    const rgb = hexToRgb(c.color);
    if (centers.every((ce) => colorDistance(rgbToHex(ce), c.color) > 40)) centers.push(rgb);
  }
  for (const c of colors) {
    if (centers.length >= k) break;
    centers.push(hexToRgb(c.color));
  }
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
    for (const pt of pts) {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((c, i) => {
        const d = (c.r - pt.p.r) ** 2 + (c.g - pt.p.g) ** 2 + (c.b - pt.p.b) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      sums[bi].r += pt.p.r * pt.w;
      sums[bi].g += pt.p.g * pt.w;
      sums[bi].b += pt.p.b * pt.w;
      sums[bi].w += pt.w;
    }
    sums.forEach((s, i) => {
      if (s.w > 0) centers[i] = { r: s.r / s.w, g: s.g / s.w, b: s.b / s.w };
    });
  }
  const weights = centers.map(() => 0);
  for (const pt of pts) {
    let bi = 0;
    let bd = Infinity;
    centers.forEach((c, i) => {
      const d = (c.r - pt.p.r) ** 2 + (c.g - pt.p.g) ** 2 + (c.b - pt.p.b) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    weights[bi] += pt.w;
  }
  return centers
    .map((c, i) => ({ hex: rgbToHex(c), w: weights[i] }))
    .sort((a, b) => b.w - a.w)
    .map((c) => c.hex);
}

/** Deterministic pseudo random generator for "random" recolor options. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export { hsb as toHsb, fromHsb };
