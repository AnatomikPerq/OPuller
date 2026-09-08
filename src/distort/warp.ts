/**
 * Warp styles (Illustrator's 15 warp presets) as point maps over a frame.
 * Pure maths: (u, v) in 0..1 of the frame → displaced point.
 */
import type { Rect, Vec, WarpEffect, WarpStyle } from '@/model/types';
import { toUnit, fromUnit, mapSubPaths, type PointMap } from './map';
import type { SubPath } from '@/model/types';

export const WARP_STYLES: Array<{ id: WarpStyle; label: string }> = [
  { id: 'arc', label: 'Arc' },
  { id: 'arcLower', label: 'Arc Lower' },
  { id: 'arcUpper', label: 'Arc Upper' },
  { id: 'arch', label: 'Arch' },
  { id: 'bulge', label: 'Bulge' },
  { id: 'shellLower', label: 'Shell Lower' },
  { id: 'shellUpper', label: 'Shell Upper' },
  { id: 'flag', label: 'Flag' },
  { id: 'wave', label: 'Wave' },
  { id: 'fish', label: 'Fish' },
  { id: 'rise', label: 'Rise' },
  { id: 'fisheye', label: 'Fisheye' },
  { id: 'inflate', label: 'Inflate' },
  { id: 'squeeze', label: 'Squeeze' },
  { id: 'twist', label: 'Twist' },
];

/**
 * Warp a normalised point. x, y are centred (−0.5..0.5); W/H are the frame
 * size (used to keep the bend proportional to the object). Returns the
 * displaced point in frame units (px offsets from the frame origin).
 */
export function warpUnit(style: WarpStyle, bend: number, u: number, v: number, W: number, H: number): Vec {
  const b = Math.max(-1, Math.min(1, bend / 100));
  const x = u - 0.5;
  const y = v - 0.5;
  let px = x * W;
  let py = y * H;
  const hump = 1 - 4 * x * x; // 1 at the centre, 0 at the sides
  switch (style) {
    case 'arc': {
      if (Math.abs(b) < 1e-4) break;
      // bend the whole box along a circular arc: the horizontal axis becomes an arc of radius R
      const R = W / (Math.PI * b);
      const theta = (x * W) / R;
      const rho = R - y * H;
      px = rho * Math.sin(theta);
      py = R - rho * Math.cos(theta);
      break;
    }
    case 'arcLower':
      py = y * H + b * H * 0.5 * hump * (v);
      break;
    case 'arcUpper':
      py = y * H - b * H * 0.5 * hump * (1 - v);
      break;
    case 'arch':
      py = y * H - b * H * 0.5 * hump;
      break;
    case 'bulge':
      py = y * H + b * H * hump * y;
      break;
    case 'shellLower':
      py = y * H + b * H * 0.5 * hump * v;
      break;
    case 'shellUpper':
      py = y * H - b * H * 0.5 * hump * (1 - v);
      break;
    case 'flag':
      py = y * H - b * H * 0.5 * Math.sin(2 * Math.PI * x);
      break;
    case 'wave':
      py = y * H - b * H * 0.5 * Math.sin(3 * Math.PI * x) * (1 - 0.5 * Math.abs(y * 2) * 0);
      break;
    case 'fish': {
      // pointed ends, fat middle: vertical scale follows the hump, ends pinch
      py = y * H * (1 + b * hump * 0.9) - b * H * 0.15 * Math.sin(2 * Math.PI * x);
      px = x * W * (1 - b * 0.15 * (1 - Math.abs(2 * x)));
      break;
    }
    case 'rise': {
      const t = (1 - Math.cos(Math.PI * u)) / 2;
      py = y * H - b * H * 0.5 * (t - 0.5) * 2;
      break;
    }
    case 'fisheye': {
      const r = Math.min(1, Math.hypot(2 * x, 2 * y));
      const k = 1 + b * (1 - r * r) * 0.9;
      px = x * W * k;
      py = y * H * k;
      break;
    }
    case 'inflate': {
      const r = Math.min(1, Math.hypot(2 * x, 2 * y));
      const k = 1 + b * (1 - r) * 0.9;
      px = x * W * k;
      py = y * H * k;
      break;
    }
    case 'squeeze': {
      const hy = 1 - 4 * y * y;
      px = x * W * (1 - b * 0.6 * hy);
      py = y * H * (1 + b * 0.35 * (1 - hy) * 0);
      break;
    }
    case 'twist': {
      const r = Math.min(1, Math.hypot(2 * x, 2 * y));
      const ang = b * Math.PI * (1 - r);
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      px = (x * cos - y * sin) * W;
      py = (x * sin + y * cos) * H;
      break;
    }
  }
  return { x: px + W / 2, y: py + H / 2 };
}

/** Point map of a warp effect over a frame (handles axis and h/v distortion). */
export function warpMap(effect: WarpEffect, frame: Rect): PointMap {
  const W = Math.max(frame.width, 1e-6);
  const H = Math.max(frame.height, 1e-6);
  const h = Math.max(-1, Math.min(1, effect.hDistort / 100));
  const vd = Math.max(-1, Math.min(1, effect.vDistort / 100));
  return (p: Vec) => {
    let u = toUnit(frame, p);
    // horizontal/vertical distortion: perspective-like scaling towards one side
    let x = u.x - 0.5;
    let y = u.y - 0.5;
    if (h) x *= 1 + h * y * 2;
    if (vd) y *= 1 + vd * x * 2;
    u = { x: x + 0.5, y: y + 0.5 };
    let out: Vec;
    if (effect.horizontal) out = warpUnit(effect.style, effect.bend, u.x, u.y, W, H);
    else {
      // vertical axis: transpose, warp, transpose back
      const t = warpUnit(effect.style, effect.bend, u.y, u.x, H, W);
      out = { x: t.y, y: t.x };
    }
    return { x: frame.x + out.x, y: frame.y + out.y };
  };
}

export function warpSubPaths(sps: SubPath[], effect: WarpEffect, frame: Rect): SubPath[] {
  if (Math.abs(effect.bend) < 1e-6 && !effect.hDistort && !effect.vDistort) return sps;
  return mapSubPaths(sps, warpMap(effect, frame), frame);
}

export { fromUnit };
