/**
 * Smooth mapping of Bézier geometry through an arbitrary point function:
 * segments are subdivided (relative to the frame size) before their control
 * points are mapped so nonlinear warps stay smooth.
 */
import type { SubPath, Vec, Rect, Anchor } from '@/model/types';
import { subpathToCubics } from '@/geometry/path';
import { cubicSplit, cubicLength, type Cubic } from '@/geometry/bezier';

export type PointMap = (p: Vec) => Vec;

function subdivide(cubics: Cubic[], step: number): Cubic[] {
  const out: Cubic[] = [];
  for (const c of cubics) {
    const len = cubicLength(c, 0.5);
    const pieces = Math.max(1, Math.min(48, Math.ceil(len / step)));
    if (pieces === 1) {
      out.push(c);
      continue;
    }
    let rest = c;
    for (let i = 0; i < pieces - 1; i++) {
      const [l, r] = cubicSplit(rest, 1 / (pieces - i));
      out.push(l);
      rest = r;
    }
    out.push(rest);
  }
  return out;
}

/** Optional exact image of a whole segment; returning null falls back to subdivision. */
export type ExactSegment = (c: Cubic) => Cubic | null;

/**
 * Map a subpath through `fn`, subdividing segments longer than `step`. Segments for which
 * `exact` knows the precise image (e.g. straight edges along a warp's axes) are kept as one cubic.
 */
export function mapSubPath(sp: SubPath, fn: PointMap, step: number, exact?: ExactSegment): SubPath {
  const source = subpathToCubics(sp);
  if (!source.length) return { anchors: sp.anchors.map((a) => ({ point: fn(a.point), handleIn: null, handleOut: null, kind: 'corner' as const })), closed: sp.closed };
  const mapped: Cubic[] = [];
  for (const c of source) {
    const direct = exact?.(c);
    if (direct) mapped.push(direct);
    else for (const piece of subdivide([c], step)) mapped.push({ p0: fn(piece.p0), p1: fn(piece.p1), p2: fn(piece.p2), p3: fn(piece.p3) });
  }
  const anchors: Anchor[] = [];
  mapped.forEach((c, i) => {
    const prev = mapped[i - 1];
    anchors.push({ point: c.p0, handleIn: prev ? { x: prev.p2.x - c.p0.x, y: prev.p2.y - c.p0.y } : null, handleOut: { x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y }, kind: 'smooth' });
  });
  const last = mapped[mapped.length - 1];
  if (sp.closed) anchors[0].handleIn = { x: last.p2.x - anchors[0].point.x, y: last.p2.y - anchors[0].point.y };
  else anchors.push({ point: last.p3, handleIn: { x: last.p2.x - last.p3.x, y: last.p2.y - last.p3.y }, handleOut: null, kind: 'smooth' });
  for (const a of anchors) {
    if (a.handleIn && Math.hypot(a.handleIn.x, a.handleIn.y) < 1e-6) a.handleIn = null;
    if (a.handleOut && Math.hypot(a.handleOut.x, a.handleOut.y) < 1e-6) a.handleOut = null;
    // smooth only where the handles continue each other (a mapped corner keeps its kink)
    if (!a.handleIn || !a.handleOut) a.kind = 'corner';
    else {
      const cross = a.handleIn.x * a.handleOut.y - a.handleIn.y * a.handleOut.x;
      const dot = a.handleIn.x * a.handleOut.x + a.handleIn.y * a.handleOut.y;
      if (dot > 0 || Math.abs(cross) > 1e-3 * Math.hypot(a.handleIn.x, a.handleIn.y) * Math.hypot(a.handleOut.x, a.handleOut.y)) a.kind = 'corner';
    }
  }
  return { anchors, closed: sp.closed };
}

/** Map subpaths through `fn`; the subdivision step is derived from the frame diagonal. */
export function mapSubPaths(sps: SubPath[], fn: PointMap, frame: Rect, divisions = 24, exact?: ExactSegment): SubPath[] {
  const step = Math.max(0.5, Math.hypot(frame.width, frame.height) / divisions);
  return sps.map((sp) => mapSubPath(sp, fn, step, exact));
}

/** Normalised coordinates of a point inside the frame (0..1). */
export function toUnit(frame: Rect, p: Vec): Vec {
  return { x: frame.width > 1e-9 ? (p.x - frame.x) / frame.width : 0.5, y: frame.height > 1e-9 ? (p.y - frame.y) / frame.height : 0.5 };
}

export function fromUnit(frame: Rect, u: Vec): Vec {
  return { x: frame.x + u.x * frame.width, y: frame.y + u.y * frame.height };
}
