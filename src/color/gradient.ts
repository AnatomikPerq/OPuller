/**
 * Gradient maths in object-bounding-box units: stops, angles, reversing,
 * type conversion, presets and colour sampling.
 */
import type { Paint, GradientPaint, GradientStop, LinearGradientPaint, RadialGradientPaint, HexColor } from '@/model/types';
import { hexToRgb, rgbToHex } from '@/util/color';
import { activeSolid, isGradient } from './paint';

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export function sortedStops(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.offset - b.offset);
}

/** Interpolated colour/opacity along the stops at offset t (0..1). */
export function colorAtOffset(stops: GradientStop[], t: number): { color: HexColor; opacity: number } {
  if (!stops.length) return { color: '#000000', opacity: 1 };
  const s = sortedStops(stops);
  if (t <= s[0].offset) return { color: s[0].color, opacity: s[0].opacity };
  const last = s[s.length - 1];
  if (t >= last.offset) return { color: last.color, opacity: last.opacity };
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (t >= a.offset && t <= b.offset) {
      const f = b.offset === a.offset ? 0 : (t - a.offset) / (b.offset - a.offset);
      const ca = hexToRgb(a.color);
      const cb = hexToRgb(b.color);
      return {
        color: rgbToHex({ r: ca.r + (cb.r - ca.r) * f, g: ca.g + (cb.g - ca.g) * f, b: ca.b + (cb.b - ca.b) * f }),
        opacity: a.opacity + (b.opacity - a.opacity) * f,
      };
    }
  }
  return { color: last.color, opacity: last.opacity };
}

/** Add a stop at t with the interpolated colour. Returns the new paint and stop index. */
export function addStopAt<T extends GradientPaint>(g: T, t: number): { paint: T; index: number } {
  const tt = clamp01(t);
  const c = colorAtOffset(g.stops, tt);
  const stops = [...g.stops, { offset: tt, color: c.color, opacity: c.opacity }];
  return { paint: { ...g, stops }, index: stops.length - 1 };
}

export function removeStop<T extends GradientPaint>(g: T, index: number): T {
  if (g.stops.length <= 2) return g;
  return { ...g, stops: g.stops.filter((_, i) => i !== index) };
}

export function updateStop<T extends GradientPaint>(g: T, index: number, patch: Partial<GradientStop>): T {
  return { ...g, stops: g.stops.map((s, i) => (i === index ? { ...s, ...patch, offset: patch.offset !== undefined ? clamp01(patch.offset) : s.offset } : s)) };
}

/** Reverse the stop order (mirror offsets). */
export function reverseGradient<T extends GradientPaint>(g: T): T {
  return { ...g, stops: g.stops.map((s) => ({ ...s, offset: 1 - s.offset })).reverse() };
}

/** CSS preview of the stops from left to right (used by the panel bar). */
export function stopsCss(stops: GradientStop[], withAlpha = true): string {
  const s = sortedStops(stops);
  if (!s.length) return 'transparent';
  const parts = s.map((st) => {
    const c = hexToRgb(st.color);
    const col = withAlpha ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${st.opacity})` : st.color;
    return `${col} ${(st.offset * 100).toFixed(2)}%`;
  });
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Linear angle (Illustrator convention: degrees counter-clockwise, 0 = left to right)
// ---------------------------------------------------------------------------

/**
 * Visual angle of a linear gradient. `aspect` = object width / height so the
 * angle is measured in object space rather than in normalized bbox units.
 */
export function linearAngle(g: LinearGradientPaint, aspect = 1): number {
  const dx = (g.x2 - g.x1) * (aspect || 1);
  const dy = g.y2 - g.y1;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return 0;
  let deg = (-Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  return deg === 0 ? 0 : deg; // normalise -0
}

/** Rotate the gradient to `deg`, keeping its centre and visual length. */
export function withLinearAngle(g: LinearGradientPaint, deg: number, aspect = 1): LinearGradientPaint {
  const a = aspect || 1;
  const cx = (g.x1 + g.x2) / 2;
  const cy = (g.y1 + g.y2) / 2;
  const dx = (g.x2 - g.x1) * a;
  const dy = g.y2 - g.y1;
  let len = Math.hypot(dx, dy);
  if (len < 1e-9) len = a; // full width by default
  const rad = (-deg * Math.PI) / 180;
  const ndx = (Math.cos(rad) * len) / a;
  const ndy = Math.sin(rad) * len;
  return { ...g, x1: cx - ndx / 2, y1: cy - ndy / 2, x2: cx + ndx / 2, y2: cy + ndy / 2 };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function defaultStops(color: HexColor, opacity = 1): GradientStop[] {
  return [
    { offset: 0, color, opacity },
    { offset: 1, color: '#ffffff', opacity: 1 },
  ];
}

/** Convert any paint into a gradient; a solid becomes the first stop. */
export function toGradient(paint: Paint, type: 'linear' | 'radial', stopIndex = 0): GradientPaint {
  if (isGradient(paint)) return paint.type === type ? paint : convertGradientType(paint, type);
  const s = activeSolid(paint, stopIndex);
  const stops = paint.type === 'none' ? defaultStops('#000000') : defaultStops(s.color, s.opacity);
  return type === 'linear' ? { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops, spread: 'pad' } : { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops, spread: 'pad' };
}

export function convertGradientType(g: GradientPaint, type: 'linear' | 'radial'): GradientPaint {
  if (g.type === type) return g;
  if (type === 'radial') {
    const l = g as LinearGradientPaint;
    const cx = (l.x1 + l.x2) / 2;
    const cy = (l.y1 + l.y2) / 2;
    const r = Math.max(0.05, Math.hypot(l.x2 - l.x1, l.y2 - l.y1) / 2);
    return { type: 'radial', cx, cy, r, stops: g.stops.map((s) => ({ ...s })), spread: g.spread };
  }
  const rd = g as RadialGradientPaint;
  const r = Math.max(0.05, rd.r);
  return { type: 'linear', x1: rd.cx - r, y1: rd.cy, x2: rd.cx + r, y2: rd.cy, stops: g.stops.map((s) => ({ ...s })), spread: g.spread };
}

/** Colour of a gradient at a point in bbox units (used by the eyedropper). */
export function gradientColorAt(g: GradientPaint, u: number, v: number): { color: HexColor; opacity: number } {
  let t: number;
  if (g.type === 'linear') {
    const dx = g.x2 - g.x1;
    const dy = g.y2 - g.y1;
    const l2 = dx * dx + dy * dy;
    t = l2 < 1e-12 ? 0 : ((u - g.x1) * dx + (v - g.y1) * dy) / l2;
  } else {
    // the radial ellipse has semi-axes r in both bbox directions
    t = g.r < 1e-9 ? 1 : Math.hypot(u - g.cx, v - g.cy) / g.r;
  }
  t = applySpread(t, g.spread);
  return colorAtOffset(g.stops, t);
}

export function applySpread(t: number, spread: GradientPaint['spread']): number {
  if (spread === 'pad') return clamp01(t);
  if (spread === 'repeat') return t - Math.floor(t);
  const m = Math.abs(t) % 2;
  return m > 1 ? 2 - m : m;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function lin(name: string, stops: Array<[number, HexColor, number?]>, x1 = 0, y1 = 0.5, x2 = 1, y2 = 0.5): { name: string; paint: GradientPaint } {
  return { name, paint: { type: 'linear', x1, y1, x2, y2, spread: 'pad', stops: stops.map(([offset, color, opacity]) => ({ offset, color, opacity: opacity ?? 1 })) } };
}
function rad(name: string, stops: Array<[number, HexColor, number?]>, cx = 0.5, cy = 0.5, r = 0.5): { name: string; paint: GradientPaint } {
  return { name, paint: { type: 'radial', cx, cy, r, spread: 'pad', stops: stops.map(([offset, color, opacity]) => ({ offset, color, opacity: opacity ?? 1 })) } };
}

export const GRADIENT_PRESETS: Array<{ name: string; paint: GradientPaint }> = [
  lin('White to black', [[0, '#ffffff'], [1, '#000000']]),
  lin('Fade to transparent', [[0, '#000000'], [1, '#000000', 0]]),
  lin('Burgundy', [[0, '#a33660'], [1, '#4a0f22']], 0, 0, 1, 1),
  lin('Burgundy velvet', [[0, '#5c1430'], [0.5, '#9b2a4f'], [1, '#2b0713']], 0, 0, 0, 1),
  rad('Burgundy glow', [[0, '#d0557f'], [1, '#4a0f22']]),
  lin('Rose', [[0, '#f7c6d4'], [1, '#a33660']]),
  lin('Sunset', [[0, '#ff9500'], [0.55, '#ff2d55'], [1, '#5856d6']], 0, 0, 1, 1),
  lin('Ocean', [[0, '#7fd0ff'], [1, '#0b3d91']], 0, 0, 0, 1),
  lin('Forest', [[0, '#a4e400'], [1, '#0f5132']], 0, 1, 1, 0),
  lin('Gold', [[0, '#fff2a8'], [0.5, '#ffcc00'], [1, '#b8860b']], 0, 0, 1, 1),
  lin('Steel', [[0, '#f2f2f7'], [0.5, '#8e8e93'], [1, '#48484a']], 0, 0, 1, 1),
  lin('Violet dusk', [[0, '#af52de'], [1, '#1c1c1e']], 0, 0, 1, 1),
  rad('Spotlight', [[0, '#ffffff'], [1, '#1c1c1e']], 0.5, 0.35, 0.6),
  rad('Warm glow', [[0, '#ffffff'], [0.6, '#ff9500'], [1, '#c8102e']]),
];
