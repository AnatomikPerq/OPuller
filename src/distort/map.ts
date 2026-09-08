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

/** Map a subpath through `fn`, subdividing segments longer than `step`. */
export function mapSubPath(sp: SubPath, fn: PointMap, step: number): SubPath {
  const cubics = subdivide(subpathToCubics(sp), step);
  if (!cubics.length) return { anchors: sp.anchors.map((a) => ({ point: fn(a.point), handleIn: null, handleOut: null, kind: 'corner' as const })), closed: sp.closed };
  const mapped = cubics.map((c) => ({ p0: fn(c.p0), p1: fn(c.p1), p2: fn(c.p2), p3: fn(c.p3) }));
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
    if (!a.handleIn || !a.handleOut) a.kind = 'corner';
  }
  return { anchors, closed: sp.closed };
}

/** Map subpaths through `fn`; the subdivision step is derived from the frame diagonal. */
export function mapSubPaths(sps: SubPath[], fn: PointMap, frame: Rect, divisions = 24): SubPath[] {
  const step = Math.max(0.5, Math.hypot(frame.width, frame.height) / divisions);
  return sps.map((sp) => mapSubPath(sp, fn, step));
}

/** Normalised coordinates of a point inside the frame (0..1). */
export function toUnit(frame: Rect, p: Vec): Vec {
  return { x: frame.width > 1e-9 ? (p.x - frame.x) / frame.width : 0.5, y: frame.height > 1e-9 ? (p.y - frame.y) / frame.height : 0.5 };
}

export function fromUnit(frame: Rect, u: Vec): Vec {
  return { x: frame.x + u.x * frame.width, y: frame.y + u.y * frame.height };
}
