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

/** The cubic through four points at parameters 0, 1/3, 2/3, 1 (4-point interpolation). */
function cubicThrough(p0: Vec, m1: Vec, m2: Vec, p3: Vec): Cubic {
  // B(1/3) = (8 p0 + 12 p1 + 6 p2 + p3) / 27, B(2/3) = (p0 + 6 p1 + 12 p2 + 8 p3) / 27
  const r1 = { x: 27 * m1.x - 8 * p0.x - p3.x, y: 27 * m1.y - 8 * p0.y - p3.y };
  const r2 = { x: 27 * m2.x - p0.x - 8 * p3.x, y: 27 * m2.y - p0.y - 8 * p3.y };
  return { p0, p1: { x: (2 * r1.x - r2.x) / 18, y: (2 * r1.y - r2.y) / 18 }, p2: { x: (2 * r2.x - r1.x) / 18, y: (2 * r2.y - r1.y) / 18 }, p3 };
}

function bezierAt(c: Cubic, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
}

/**
 * Image of one segment as Illustrator's Warp writes it: the cubic through the images of the
 * points at 0, 1/3, 2/3, 1 of the segment (a straight segment is walked linearly, a curve by
 * its parameter); when that cubic misses the true image at the quarter points by more than
 * `tolerance`, the segment is halved and each half fitted on its own (measured on Illustrator
 * 2026: 0.2 px reproduces its splits in 94 % of the sampled segments, the rest are borderline).
 */
export function fitSegment(c: Cubic, fn: PointMap, tolerance = 0.2, maxDepth = 5): Cubic[] {
  const straight = Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y) < 1e-9 && Math.hypot(c.p3.x - c.p2.x, c.p3.y - c.p2.y) < 1e-9;
  const at = straight ? (t: number) => ({ x: c.p0.x + (c.p3.x - c.p0.x) * t, y: c.p0.y + (c.p3.y - c.p0.y) * t }) : (t: number) => bezierAt(c, t);
  const image = (t: number) => fn(at(t));
  const fit = (t0: number, t1: number, depth: number): Cubic[] => {
    const span = t1 - t0;
    const cub = cubicThrough(image(t0), image(t0 + span / 3), image(t0 + (2 * span) / 3), image(t1));
    if (depth < maxDepth) {
      let err = 0;
      for (const q of [0.25, 0.5, 0.75]) {
        const a = bezierAt(cub, q);
        const b = image(t0 + span * q);
        err = Math.max(err, Math.hypot(a.x - b.x, a.y - b.y));
      }
      if (err > tolerance) return [...fit(t0, t0 + span / 2, depth + 1), ...fit(t0 + span / 2, t1, depth + 1)];
    }
    return [cub];
  };
  return fit(0, 1, 0);
}

/**
 * Map a subpath through `fn` with `fitSegment` (one cubic per segment where a cubic suffices,
 * halves otherwise); `exact` still short-circuits segments whose image is known precisely.
 */
export function fitSubPath(sp: SubPath, fn: PointMap, exact?: ExactSegment, tolerance = 0.2): SubPath {
  const source = subpathToCubics(sp);
  if (!source.length) return { anchors: sp.anchors.map((a) => ({ point: fn(a.point), handleIn: null, handleOut: null, kind: 'corner' as const })), closed: sp.closed };
  const mapped: Cubic[] = [];
  for (const c of source) {
    const direct = exact?.(c);
    if (direct) mapped.push(direct);
    else mapped.push(...fitSegment(c, fn, tolerance));
  }
  return chainCubics(mapped, sp.closed);
}

export function fitSubPaths(sps: SubPath[], fn: PointMap, exact?: ExactSegment, tolerance = 0.2): SubPath[] {
  return sps.map((sp) => fitSubPath(sp, fn, exact, tolerance));
}

/** Anchors of consecutive cubics; smooth where the handles continue each other, corners elsewhere. */
function chainCubics(mapped: Cubic[], closed: boolean): SubPath {
  const anchors: Anchor[] = [];
  mapped.forEach((c, i) => {
    const prev = mapped[i - 1];
    anchors.push({ point: c.p0, handleIn: prev ? { x: prev.p2.x - c.p0.x, y: prev.p2.y - c.p0.y } : null, handleOut: { x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y }, kind: 'smooth' });
  });
  const last = mapped[mapped.length - 1];
  if (closed) anchors[0].handleIn = { x: last.p2.x - anchors[0].point.x, y: last.p2.y - anchors[0].point.y };
  else anchors.push({ point: last.p3, handleIn: { x: last.p2.x - last.p3.x, y: last.p2.y - last.p3.y }, handleOut: null, kind: 'smooth' });
  for (const a of anchors) {
    if (a.handleIn && Math.hypot(a.handleIn.x, a.handleIn.y) < 1e-6) a.handleIn = null;
    if (a.handleOut && Math.hypot(a.handleOut.x, a.handleOut.y) < 1e-6) a.handleOut = null;
    if (!a.handleIn || !a.handleOut) a.kind = 'corner';
    else {
      const cross = a.handleIn.x * a.handleOut.y - a.handleIn.y * a.handleOut.x;
      const dot = a.handleIn.x * a.handleOut.x + a.handleIn.y * a.handleOut.y;
      if (dot > 0 || Math.abs(cross) > 1e-3 * Math.hypot(a.handleIn.x, a.handleIn.y) * Math.hypot(a.handleOut.x, a.handleOut.y)) a.kind = 'corner';
    }
  }
  return { anchors, closed };
}

/** Normalised coordinates of a point inside the frame (0..1). */
export function toUnit(frame: Rect, p: Vec): Vec {
  return { x: frame.width > 1e-9 ? (p.x - frame.x) / frame.width : 0.5, y: frame.height > 1e-9 ? (p.y - frame.y) / frame.height : 0.5 };
}

export function fromUnit(frame: Rect, u: Vec): Vec {
  return { x: frame.x + u.x * frame.width, y: frame.y + u.y * frame.height };
}
