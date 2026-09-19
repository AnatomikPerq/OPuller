/**
 * One-sided offset of a cubic Bézier as a chain of cubics. Each piece keeps the exact offset
 * points and tangents at its ends and passes through the exact offset of its midpoint; a piece
 * is split in half until the offset is within `tolerance` at the quarter points (or the
 * curvature is too tight for a single cubic). Pure geometry — no paper.js — so vitest covers
 * it; paperBridge assembles outlines from it.
 */
import type { Vec } from '@/model/types';
import { cubicPoint, cubicDerivative, cubicSplit, isLine, type Cubic } from './bezier';

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec) => Math.hypot(a.x, a.y);
const unit = (a: Vec): Vec => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

/** Unit tangent at t; a handle lying on its anchor falls back to the next control point, a fully degenerate curve to its chord. */
export function cubicTangent(c: Cubic, t: number): Vec {
  let d = cubicDerivative(c, t);
  if (len(d) < 1e-9) {
    if (t <= 0.5) d = len({ x: c.p2.x - c.p0.x, y: c.p2.y - c.p0.y }) > 1e-9 ? { x: c.p2.x - c.p0.x, y: c.p2.y - c.p0.y } : { x: c.p3.x - c.p0.x, y: c.p3.y - c.p0.y };
    else d = len({ x: c.p3.x - c.p1.x, y: c.p3.y - c.p1.y }) > 1e-9 ? { x: c.p3.x - c.p1.x, y: c.p3.y - c.p1.y } : { x: c.p3.x - c.p0.x, y: c.p3.y - c.p0.y };
  }
  return unit(d);
}

/** Left normal (screen coordinates, y down: the side a positive stroke offset goes to in Illustrator). */
export const leftNormal = (t: Vec): Vec => ({ x: -t.y, y: t.x });

/** Exact offset of the point at t. */
function offsetPointAt(c: Cubic, t: number, d: number): Vec {
  return add(cubicPoint(c, t), scale(leftNormal(cubicTangent(c, t)), d));
}

/**
 * Offset `c` by `d` along its left normal. Returns one or more cubics joined end to end;
 * the first starts at the exact offset of p0 and the last ends at the exact offset of p3.
 */
export function offsetCubic(c: Cubic, d: number, tolerance = 0.05, depth = 0): Cubic[] {
  if (isLine(c)) {
    const n = scale(leftNormal(cubicTangent(c, 0.5)), d);
    return [{ p0: add(c.p0, n), p1: add(c.p1, n), p2: add(c.p2, n), p3: add(c.p3, n) }];
  }
  const t0 = cubicTangent(c, 0);
  const t1 = cubicTangent(c, 1);
  const P0 = add(c.p0, scale(leftNormal(t0), d));
  const P3 = add(c.p3, scale(leftNormal(t1), d));
  const M = offsetPointAt(c, 0.5, d);
  // B(0.5) = (P0 + 3 P1 + 3 P2 + P3) / 8 with P1 = P0 + a t0, P2 = P3 − b t1
  const rx = 8 * M.x - 4 * P0.x - 4 * P3.x;
  const ry = 8 * M.y - 4 * P0.y - 4 * P3.y;
  const det = 3 * t0.x * -3 * t1.y - 3 * t0.y * -3 * t1.x;
  let fit: Cubic | null = null;
  if (Math.abs(det) > 1e-9) {
    const a = (rx * -3 * t1.y - ry * -3 * t1.x) / det;
    const b = (3 * t0.x * ry - 3 * t0.y * rx) / det;
    if (a >= 0 && b >= 0) fit = { p0: P0, p1: add(P0, scale(t0, a)), p2: add(P3, scale(t1, -b)), p3: P3 };
  } else {
    // parallel end tangents (an S-curve split at its inflection, or nearly straight): scale the handles by the offset ratio at the ends
    const h0 = len({ x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y });
    const h1 = len({ x: c.p3.x - c.p2.x, y: c.p3.y - c.p2.y });
    fit = { p0: P0, p1: add(P0, scale(t0, h0)), p2: add(P3, scale(t1, -h1)), p3: P3 };
  }
  if (depth >= 8) return [fit ?? { p0: P0, p1: P0, p2: P3, p3: P3 }]; // a cusp of the inner offset: give up with the chord
  if (fit) {
    // the parameterisations differ, so measure against the exact offset sampled as a polyline
    const exact: Vec[] = [];
    for (let k = 0; k <= 16; k++) exact.push(offsetPointAt(c, k / 16, d));
    let err = 0;
    for (const t of [0.2, 0.35, 0.65, 0.8]) {
      const q = cubicPoint(fit, t);
      let best = Infinity;
      for (let k = 1; k < exact.length; k++) {
        const a = exact[k - 1];
        const b = exact[k];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(q.x - a.x - dx * u, q.y - a.y - dy * u));
      }
      err = Math.max(err, best);
    }
    if (err <= tolerance) return [fit];
  }
  const [l, r] = cubicSplit(c, 0.5);
  return [...offsetCubic(l, d, tolerance, depth + 1), ...offsetCubic(r, d, tolerance, depth + 1)];
}
