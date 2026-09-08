/**
 * Curve fitting and outline building for the freehand tools. This file is the
 * only place in the module that talks to paper.js (through geometry/paperBridge)
 * so the pure logic in cut.ts / sampling.ts stays unit-testable.
 */
import type { SubPath, Vec, Anchor } from '@/model/types';
import { fitPoints, outlineStroke, ensurePaper, subpathsToPaper, paperToSubPaths } from '@/geometry/paperBridge';
import { polylineSubPath, subpathToCubics, cloneAnchor, cloneSubPath, inferAnchorKind, segmentCount, flattenSubPath } from '@/geometry/path';
import { cubicPoint, cubicLength, cubicFlatten } from '@/geometry/bezier';
import { ellipseSubPath } from '@/geometry/shapes';
import { outlineRing, polylineLength, resampleByDistance, smoothSamples, type StrokeRun } from './sampling';

/** Drop consecutive duplicates. */
function dedupe(points: Vec[], eps = 1e-6): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    const l = out[out.length - 1];
    if (!l || Math.abs(l.x - p.x) > eps || Math.abs(l.y - p.y) > eps) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * paper.js' PathFitter compares *squared* distances against its tolerance, so a
 * tolerance given in px must be squared to mean "maximum deviation in px".
 */
export function paperTolerance(px: number): number {
  const t = Math.max(0.05, px);
  return t * t;
}

/** Fit a freehand polyline to a Bézier subpath (paper.js simplify); `tolerance` is the max deviation in px. */
export function fitPolyline(points: Vec[], tolerance: number, closed: boolean): SubPath | null {
  const pts = dedupe(points);
  if (closed && pts.length > 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) pts.pop();
  }
  if (pts.length < 2) return null;
  if (pts.length === 2) return polylineSubPath(pts, closed);
  if (closed && pts.length === 3) return polylineSubPath(pts, true);
  const fitted = fitPoints(pts, paperTolerance(tolerance), closed);
  if (!fitted || fitted.anchors.length < 2) return polylineSubPath(pts, closed);
  return fitted;
}

/**
 * Fit a stroke made of freehand and straight runs (Alt in the pencil tool).
 * Runs share their end points; junctions become corner anchors.
 */
export function fitRuns(runs: StrokeRun[], tolerance: number, closed: boolean): SubPath | null {
  const usable = runs.filter((r) => r.points.length >= 2);
  if (!usable.length) return null;
  if (usable.length === 1 && !usable[0].straight) return fitPolyline(usable[0].points, tolerance, closed);
  const pieces: SubPath[] = [];
  for (const run of usable) {
    const sp = run.straight ? polylineSubPath([run.points[0], run.points[run.points.length - 1]]) : fitPolyline(run.points, tolerance, false);
    if (sp && sp.anchors.length >= 2) pieces.push(sp);
  }
  if (!pieces.length) return null;
  const anchors: Anchor[] = pieces[0].anchors.map(cloneAnchor);
  for (let i = 1; i < pieces.length; i++) {
    const next = pieces[i].anchors;
    const junction = anchors[anchors.length - 1];
    junction.handleOut = next[0].handleOut ? { ...next[0].handleOut } : null;
    inferAnchorKind(junction);
    for (let k = 1; k < next.length; k++) anchors.push(cloneAnchor(next[k]));
  }
  const sp: SubPath = { anchors, closed: false };
  if (closed && anchors.length > 2) {
    const last = anchors.pop()!;
    anchors[0].handleIn = last.handleIn ? { ...last.handleIn } : null;
    inferAnchorKind(anchors[0]);
    sp.closed = true;
  }
  return sp;
}

/** Resolve self-intersections of a filled outline (paper.js resolveCrossings). */
export function cleanOutline(subpaths: SubPath[]): SubPath[] {
  if (!subpaths.length) return subpaths;
  ensurePaper();
  const item = subpathsToPaper(subpaths, 'nonzero');
  try {
    const res = (item as any).resolveCrossings();
    const out = paperToSubPaths(res);
    if (res !== item) res.remove();
    item.remove();
    return out.length ? out : subpaths;
  } catch {
    item.remove();
    return subpaths;
  }
}

/**
 * Filled outline of a centerline with a width that varies along it
 * (`widthAt(t)` with t = 0..1 by arc length). Round caps.
 */
export function variableOutline(center: SubPath, widthAt: (t01: number) => number, fitTolerance = 0.35): SubPath[] {
  const cubics = subpathToCubics(center);
  if (!cubics.length) {
    const p = center.anchors[0]?.point ?? { x: 0, y: 0 };
    const r = widthAt(0) / 2;
    return r > 0 ? [ellipseSubPath(r, r, p.x, p.y)] : [];
  }
  const lengths = cubics.map((c) => cubicLength(c));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total < 1e-6) {
    const p = cubics[0].p0;
    const r = widthAt(0) / 2;
    return r > 0 ? [ellipseSubPath(r, r, p.x, p.y)] : [];
  }
  const step = Math.max(1.5, total / 4000);
  const pts: Vec[] = [];
  const hw: number[] = [];
  let acc = 0;
  cubics.forEach((c, i) => {
    const m = Math.max(3, Math.ceil(lengths[i] / step));
    for (let k = i === 0 ? 0 : 1; k <= m; k++) {
      const t = k / m;
      pts.push(cubicPoint(c, t));
      hw.push(Math.max(0, widthAt((acc + lengths[i] * t) / total) / 2));
    }
    acc += lengths[i];
  });
  const ring = outlineRing(pts, hw);
  const fitted = fitPolyline(ring, fitTolerance, true) ?? polylineSubPath(ring, true);
  return cleanOutline([fitted]);
}

/** Round-capped stroke area of a freehand polyline (eraser / blob brush). */
export function strokeArea(points: Vec[], diameter: number, fitTolerance = 1): SubPath[] {
  const r = diameter / 2;
  if (points.length < 2 || polylineLength(points) < 0.5) {
    const p = points[0] ?? { x: 0, y: 0 };
    return [ellipseSubPath(r, r, p.x, p.y)];
  }
  const center = fitPolyline(points, fitTolerance, false);
  if (!center) return [ellipseSubPath(r, r, points[0].x, points[0].y)];
  let out: SubPath[] = [];
  try {
    out = outlineStroke([center], diameter, { cap: 'round', join: 'round' });
  } catch {
    out = [];
  }
  if (!out.length || out.every((sp) => sp.anchors.length < 3)) out = variableOutline(center, () => diameter, 0.3);
  return out;
}

/** Points of the segments [i, j) of a subpath (for re-fitting a portion). */
function portionPoints(sp: SubPath, i: number, j: number, tolerance = 0.1): Vec[] {
  const cubics = subpathToCubics(sp);
  const pts: Vec[] = [];
  if (!cubics.length) return pts;
  pts.push({ ...sp.anchors[i].point });
  const n = cubics.length;
  const count = Math.max(0, Math.min(n, j - i));
  for (let k = 0; k < count; k++) cubicFlatten(cubics[(i + k) % n], tolerance, pts);
  return pts;
}

/** Even resampling + moving-average smoothing of a polyline before re-fitting. */
function conditionPoints(pts: Vec[], tolerance: number, passes: number, closed: boolean): Vec[] {
  if (pts.length < 3) return pts;
  const spacing = Math.max(1, tolerance / 2);
  let samples = resampleByDistance(
    pts.map((p) => ({ x: p.x, y: p.y, pressure: 1 })),
    spacing,
  );
  if (passes > 0) {
    if (closed && samples.length > 4) {
      // smooth across the seam by wrapping the ends
      const k = Math.min(4, samples.length - 1);
      const wrapped = samples.slice(-k).concat(samples, samples.slice(0, k));
      samples = smoothSamples(wrapped, passes).slice(k, k + samples.length);
    } else samples = smoothSamples(samples, passes);
  }
  return samples;
}

/**
 * Re-fit the anchors [i..j] of a subpath through a tolerance (smooth tool).
 * `whole` re-fits the entire subpath. Closed ranges may wrap (j < i).
 * `passes` pre-smooths the portion (0 = keep the exact shape within tolerance).
 */
export function refitRange(sp: SubPath, range: { i: number; j: number; whole: boolean }, tolerance: number, passes = 0): SubPath {
  const n = segmentCount(sp);
  if (n === 0) return cloneSubPath(sp);
  if (range.whole) {
    const pts = conditionPoints(flattenSubPath(sp, 0.1), tolerance, passes, sp.closed);
    const fitted = fitPolyline(pts, tolerance, sp.closed);
    return fitted ?? cloneSubPath(sp);
  }
  let src = sp;
  let i = range.i;
  let j = range.j;
  if (sp.closed && j <= i) {
    // rotate so the range does not wrap
    const N = sp.anchors.length;
    const anchors: Anchor[] = [];
    for (let k = 0; k < N; k++) anchors.push(cloneAnchor(sp.anchors[(i + k) % N]));
    src = { anchors, closed: true };
    j = (j - i + N) % N;
    i = 0;
    if (j === 0) j = N; // wraps all the way round: treat as whole loop minus nothing
  }
  if (j <= i) return cloneSubPath(sp);
  const pts = conditionPoints(portionPoints(src, i, j), tolerance, passes, false);
  const fitted = fitPolyline(pts, tolerance, false);
  if (!fitted || fitted.anchors.length < 2) return cloneSubPath(sp);
  const A = fitted.anchors.map(cloneAnchor);
  const N = src.anchors.length;
  const startAnchor = src.anchors[i];
  const endAnchor = src.anchors[j % N];
  A[0].handleIn = startAnchor.handleIn ? { ...startAnchor.handleIn } : null;
  A[A.length - 1].handleOut = endAnchor.handleOut ? { ...endAnchor.handleOut } : null;
  inferAnchorKind(A[0]);
  inferAnchorKind(A[A.length - 1]);
  const before = src.anchors.slice(0, i).map(cloneAnchor);
  const after = j >= N ? [] : src.anchors.slice(j + 1).map(cloneAnchor);
  if (src.closed && j >= N) {
    // the range ends at the loop start: merge the last fitted anchor into the first
    const last = A.pop()!;
    A[0].handleIn = last.handleIn ? { ...last.handleIn } : null;
    inferAnchorKind(A[0]);
    return { anchors: before.concat(A), closed: true };
  }
  return { anchors: before.concat(A, after), closed: src.closed };
}
