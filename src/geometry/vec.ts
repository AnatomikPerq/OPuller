import type { Vec, Rect } from '@/model/types';

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const eq = (a: Vec, b: Vec, eps = 1e-9): boolean => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
export const clone = (a: Vec): Vec => ({ x: a.x, y: a.y });
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);
export const fromAngle = (rad: number, length = 1): Vec => ({ x: Math.cos(rad) * length, y: Math.sin(rad) * length });

export function normalize(a: Vec): Vec {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function withLength(a: Vec, length: number): Vec {
  return mul(normalize(a), length);
}

export function rotateVec(a: Vec, rad: number): Vec {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function rotateAround(p: Vec, center: Vec, rad: number): Vec {
  return add(center, rotateVec(sub(p, center), rad));
}

export function midpoint(a: Vec, b: Vec): Vec {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function round(a: Vec, decimals = 0): Vec {
  const f = 10 ** decimals;
  return { x: Math.round(a.x * f) / f, y: Math.round(a.y * f) / f };
}

/** Constrain the vector from origin to the nearest multiple of `stepDeg` degrees. */
export function constrainAngle(a: Vec, stepDeg = 45): Vec {
  const l = len(a);
  if (l < 1e-9) return { x: 0, y: 0 };
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.round(angleOf(a) / step) * step;
  return fromAngle(ang, l);
}

// ---------------------------------------------------------------------------
// Rect helpers
// ---------------------------------------------------------------------------

export function rectFromPoints(a: Vec, b: Vec): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function rectCenter(r: Rect): Vec {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.width, b.x + b.width);
  const bt = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: r - x, height: bt - y };
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function rectContainsPoint(r: Rect, p: Vec, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

export function rectExpand(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

export function rectIsEmpty(r: Rect | null | undefined): boolean {
  return !r || !(r.width > 0 || r.height > 0);
}

export function rectFromPointList(pts: Vec[]): Rect | null {
  if (!pts.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;
export const nearlyEqual = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;
