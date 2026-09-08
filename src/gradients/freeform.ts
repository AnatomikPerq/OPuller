/**
 * Freeform gradient maths (pure): colour blending between points / lines and
 * point management.
 */
import type { FreeformGradientPaint, FreeformPoint, Paint, Vec, HexColor } from '@/model/types';
import { hexToRgb, mixHex } from '@/util/color';
import { baseColorOf } from './mesh';

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function rgba(color: HexColor, opacity: number): RGBA {
  const c = hexToRgb(color);
  return { r: c.r, g: c.g, b: c.b, a: opacity };
}

/** Nearest point on segment a-b and the parameter along it. */
function nearestOnSegment(a: Vec, b: Vec, p: Vec): { t: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** Effective colour sources for a paint: standalone points plus lines (each yields its nearest colour). */
export function freeformSources(paint: FreeformGradientPaint): Array<{ kind: 'point'; p: FreeformPoint } | { kind: 'line'; pts: FreeformPoint[] }> {
  if (paint.mode !== 'lines' || !paint.lines?.length) return paint.points.map((p) => ({ kind: 'point' as const, p }));
  const inLine = new Set<number>();
  const out: Array<{ kind: 'point'; p: FreeformPoint } | { kind: 'line'; pts: FreeformPoint[] }> = [];
  for (const line of paint.lines) {
    const pts = line.map((i) => paint.points[i]).filter(Boolean);
    if (pts.length >= 2) {
      out.push({ kind: 'line', pts });
      for (const i of line) inLine.add(i);
    } else for (const i of line) if (paint.points[i]) out.push({ kind: 'point', p: paint.points[i] });
  }
  paint.points.forEach((p, i) => {
    if (!inLine.has(i)) out.push({ kind: 'point', p });
  });
  return out;
}

/**
 * Colour at (u, v): inverse-distance weighting of every source, attenuated by
 * each point's spread (Gaussian falloff) so points keep a soft "radius" while
 * still covering the whole object.
 */
export function freeformColorAt(paint: FreeformGradientPaint, u: number, v: number, sources = freeformSources(paint)): RGBA {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let wsum = 0;
  for (const src of sources) {
    let color: RGBA;
    let d: number;
    let spread: number;
    if (src.kind === 'point') {
      color = rgba(src.p.color, src.p.opacity);
      d = Math.hypot(u - src.p.x, v - src.p.y);
      spread = src.p.spread;
    } else {
      // nearest point along the polyline with interpolated colour
      let best = { d: Infinity, color: rgba(src.pts[0].color, src.pts[0].opacity), spread: src.pts[0].spread };
      for (let i = 0; i < src.pts.length - 1; i++) {
        const A = src.pts[i];
        const B = src.pts[i + 1];
        const n = nearestOnSegment(A, B, { x: u, y: v });
        if (n.d < best.d) {
          const ca = hexToRgb(A.color);
          const cb = hexToRgb(B.color);
          best = { d: n.d, color: { r: ca.r + (cb.r - ca.r) * n.t, g: ca.g + (cb.g - ca.g) * n.t, b: ca.b + (cb.b - ca.b) * n.t, a: A.opacity + (B.opacity - A.opacity) * n.t }, spread: A.spread + (B.spread - A.spread) * n.t };
        }
      }
      color = best.color;
      d = best.d;
      spread = best.spread;
    }
    const s = Math.max(0.02, spread);
    const falloff = Math.exp(-(d * d) / (2 * s * s));
    // inverse-distance base keeps every pixel covered; the falloff sharpens the point's own zone
    const w = (1 / (d * d + 1e-4)) * (0.15 + falloff);
    r += color.r * w;
    g += color.g * w;
    b += color.b * w;
    a += color.a * w;
    wsum += w;
  }
  if (wsum <= 0) return { r: 128, g: 128, b: 128, a: 1 };
  return { r: r / wsum, g: g / wsum, b: b / wsum, a: a / wsum };
}

/** A default freeform gradient derived from a paint: three points around the object. */
export function defaultFreeform(paint: Paint): FreeformGradientPaint {
  const base = baseColorOf(paint);
  const c = base.color;
  const light = mixHex(c, '#ffffff', 0.55);
  const dark = mixHex(c, '#000000', 0.35);
  const second = paint.type === 'linear' || paint.type === 'radial' ? paint.stops[paint.stops.length - 1]?.color ?? light : light;
  return {
    type: 'freeform',
    mode: 'points',
    points: [
      { x: 0.25, y: 0.25, color: c, opacity: base.opacity, spread: 0.55 },
      { x: 0.8, y: 0.3, color: second, opacity: 1, spread: 0.5 },
      { x: 0.5, y: 0.85, color: dark, opacity: 1, spread: 0.5 },
    ],
  };
}

export function addFreeformPoint(paint: FreeformGradientPaint, at: Vec, color?: HexColor): { paint: FreeformGradientPaint; index: number } {
  const c = color ?? rgbaToHex(freeformColorAt(paint, at.x, at.y));
  const pt: FreeformPoint = { x: at.x, y: at.y, color: c, opacity: 1, spread: 0.45 };
  const points = [...paint.points, pt];
  let lines = paint.lines;
  if (paint.mode === 'lines') {
    // extend the last line (or start one)
    lines = lines && lines.length ? lines.map((l, i) => (i === lines!.length - 1 ? [...l, points.length - 1] : l)) : [[points.length - 1]];
  }
  return { paint: { ...paint, points, lines }, index: points.length - 1 };
}

export function removeFreeformPoint(paint: FreeformGradientPaint, index: number): FreeformGradientPaint {
  if (paint.points.length <= 1) return paint;
  const points = paint.points.filter((_, i) => i !== index);
  const lines = paint.lines?.map((l) => l.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i))).filter((l) => l.length > 0);
  return { ...paint, points, lines };
}

export function moveFreeformPoint(paint: FreeformGradientPaint, index: number, to: Vec): FreeformGradientPaint {
  return { ...paint, points: paint.points.map((p, i) => (i === index ? { ...p, x: to.x, y: to.y } : p)) };
}

export function updateFreeformPoint(paint: FreeformGradientPaint, index: number, patch: Partial<FreeformPoint>): FreeformGradientPaint {
  return { ...paint, points: paint.points.map((p, i) => (i === index ? { ...p, ...patch } : p)) };
}

/** Switch between points and lines mode (lines: all points in one polyline). */
export function setFreeformMode(paint: FreeformGradientPaint, mode: 'points' | 'lines'): FreeformGradientPaint {
  if (mode === paint.mode) return paint;
  if (mode === 'lines') return { ...paint, mode, lines: [paint.points.map((_, i) => i)] };
  return { ...paint, mode, lines: undefined };
}

/** Start a new line with the next added points (lines mode). */
export function startNewLine(paint: FreeformGradientPaint): FreeformGradientPaint {
  if (paint.mode !== 'lines') return paint;
  const lines = [...(paint.lines ?? [])];
  if (lines.length && lines[lines.length - 1].length === 0) return paint;
  lines.push([]);
  return { ...paint, lines };
}

export function rgbaToHex(c: RGBA): HexColor {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Index of the point nearest to a bbox point. */
export function nearestFreeformPoint(paint: FreeformGradientPaint, p: Vec): { index: number; distance: number } {
  let index = 0;
  let distance = Infinity;
  paint.points.forEach((pt, i) => {
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < distance) {
      distance = d;
      index = i;
    }
  });
  return { index, distance };
}
