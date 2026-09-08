/**
 * Segment reshaping and "curvature" (smooth-through-points) handle computation.
 * Everything here works in world space and converts through node matrices.
 */
import type { Document, ID, Vec, SubPath, Anchor } from '@/model/types';
import { worldMatrix } from '@/model/document';
import { invert, applyToPoint, applyToVector } from '@/geometry/matrix';
import { add, sub, mul, len, normalize, dist, dot, constrainAngle } from '@/geometry/vec';
import { hasHandle, segmentCubic, segmentCount } from '@/geometry/path';
import { cubicPoint, type Cubic } from '@/geometry/bezier';
import { getPathNode, touchPath } from './anchors';

export interface SegmentRef {
  nodeId: ID;
  subpath: number;
  segment: number;
}

/** The cubic of a segment in world space. */
export function segmentWorldCubic(doc: Document, ref: SegmentRef): Cubic | null {
  const n = getPathNode(doc, ref.nodeId);
  const sp = n?.subpaths[ref.subpath];
  if (!n || !sp || ref.segment < 0 || ref.segment >= segmentCount(sp)) return null;
  const c = segmentCubic(sp, ref.segment);
  const wm = worldMatrix(doc, ref.nodeId);
  return { p0: applyToPoint(wm, c.p0), p1: applyToPoint(wm, c.p1), p2: applyToPoint(wm, c.p2), p3: applyToPoint(wm, c.p3) };
}

export function segmentIsStraight(sp: SubPath, segment: number): boolean {
  const a = sp.anchors[segment];
  const b = sp.anchors[(segment + 1) % sp.anchors.length];
  if (!a || !b) return true;
  return !hasHandle(a.handleOut) && !hasHandle(b.handleIn);
}

/** Point on a segment (world) at parameter t. */
export function segmentWorldPoint(doc: Document, ref: SegmentRef, t: number): Vec | null {
  const c = segmentWorldCubic(doc, ref);
  return c ? cubicPoint(c, t) : null;
}

/**
 * Reshape a curved segment so that the point at parameter `t` lands on
 * `target` (world). Both adjacent handles move (least-norm distribution,
 * which feels like Illustrator's segment drag); smooth neighbours keep their
 * opposite handle collinear.
 */
export function reshapeSegmentWorld(draft: Document, ref: SegmentRef, t: number, target: Vec, opts: { smoothNeighbours?: boolean } = {}): void {
  const n = getPathNode(draft, ref.nodeId);
  const sp = n?.subpaths[ref.subpath];
  if (!n || !sp) return;
  const segs = segmentCount(sp);
  if (ref.segment < 0 || ref.segment >= segs) return;
  const a = sp.anchors[ref.segment];
  const b = sp.anchors[(ref.segment + 1) % sp.anchors.length];
  const wm = worldMatrix(draft, ref.nodeId);
  const inv = invert(wm);
  const c = segmentCubic(sp, ref.segment);
  const w: Cubic = { p0: applyToPoint(wm, c.p0), p1: applyToPoint(wm, c.p1), p2: applyToPoint(wm, c.p2), p3: applyToPoint(wm, c.p3) };
  const tt = Math.max(0.05, Math.min(0.95, t));
  const cur = cubicPoint(w, tt);
  const delta = sub(target, cur);
  const a1 = 3 * (1 - tt) * (1 - tt) * tt;
  const a2 = 3 * (1 - tt) * tt * tt;
  const s = a1 * a1 + a2 * a2;
  if (s < 1e-12) return;
  const k1 = a1 / s;
  const k2 = a2 / s;
  const p1 = add(w.p1, mul(delta, k1));
  const p2 = add(w.p2, mul(delta, k2));
  const hOut = applyToVector(inv, sub(p1, w.p0));
  const hIn = applyToVector(inv, sub(p2, w.p3));
  a.handleOut = len(hOut) < 1e-6 ? null : hOut;
  b.handleIn = len(hIn) < 1e-6 ? null : hIn;
  const smooth = opts.smoothNeighbours ?? true;
  if (smooth && a.kind === 'smooth' && hasHandle(a.handleIn) && hasHandle(a.handleOut)) {
    a.handleIn = mul(normalize(a.handleOut), -len(a.handleIn));
  }
  if (smooth && b.kind === 'smooth' && hasHandle(b.handleOut) && hasHandle(b.handleIn)) {
    b.handleOut = mul(normalize(b.handleIn), -len(b.handleOut));
  }
  touchPath(n);
}

/** Translate both anchors of a segment by a world delta. */
export function translateSegmentWorld(draft: Document, ref: SegmentRef, delta: Vec): void {
  const n = getPathNode(draft, ref.nodeId);
  const sp = n?.subpaths[ref.subpath];
  if (!n || !sp) return;
  const local = applyToVector(invert(worldMatrix(draft, ref.nodeId)), delta);
  const ia = ref.segment;
  const ib = (ref.segment + 1) % sp.anchors.length;
  const a = sp.anchors[ia];
  const b = sp.anchors[ib];
  if (!a || !b) return;
  a.point = add(a.point, local);
  if (ib !== ia) b.point = add(b.point, local);
  touchPath(n);
}

/** Constrain a world point relative to an origin to 45° increments. */
export function constrainTo45(origin: Vec, p: Vec, stepDeg = 45): Vec {
  return add(origin, constrainAngle(sub(p, origin), stepDeg));
}

// ---------------------------------------------------------------------------
// Curvature tool: smooth curve through points
// ---------------------------------------------------------------------------

/** Handle length that approximates a circular arc for a tangent deviation θ from the chord. */
function arcHandleLength(chord: number, theta: number): number {
  const th = Math.min(Math.abs(theta), (100 * Math.PI) / 180);
  if (th < 1e-4) return chord / 3;
  // arc through both ends with symmetric tangent deviation θ: central angle 2θ
  const r = chord / (2 * Math.sin(th));
  return (4 / 3) * Math.tan(th / 2) * r;
}

function angleBetween(a: Vec, b: Vec): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb))));
}

/** Reflect a direction across the chord direction `d` (unit). */
function reflectAcross(v: Vec, d: Vec): Vec {
  const k = dot(v, d);
  return sub(mul(d, 2 * k), v);
}

/**
 * Tangent direction of the curve at anchor i (unit vector, following the path
 * direction). Corner anchors have no tangent (null).
 */
function tangentAt(sp: SubPath, i: number, depth = 0): Vec | null {
  const n = sp.anchors.length;
  const a = sp.anchors[i];
  if (!a || a.kind === 'corner') return null;
  const hasPrev = sp.closed || i > 0;
  const hasNext = sp.closed || i < n - 1;
  if (n < 2) return null;
  const prev = hasPrev ? sp.anchors[(i - 1 + n) % n].point : null;
  const next = hasNext ? sp.anchors[(i + 1) % n].point : null;
  if (prev && next) {
    const t = normalize(sub(next, prev));
    if (len(t) < 1e-9) return null;
    return t;
  }
  if (depth > 0) return null;
  if (next) {
    const d = normalize(sub(next, a.point));
    const tn = tangentAt(sp, i + 1, depth + 1);
    return tn && len(d) > 1e-9 ? normalize(reflectAcross(tn, d)) : d;
  }
  if (prev) {
    const d = normalize(sub(a.point, prev));
    const tp = tangentAt(sp, i - 1, depth + 1);
    return tp && len(d) > 1e-9 ? normalize(reflectAcross(tp, d)) : d;
  }
  return null;
}

/**
 * Recompute the handles of smooth anchors so the subpath passes smoothly
 * through its anchor points (Catmull-Rom style tangents, arc-like handle
 * lengths). Corner anchors keep no handles. `only` restricts the update to a
 * set of indices (neighbourhood of an edit).
 */
export function recomputeCurvatureHandles(sp: SubPath, only?: Iterable<number>): void {
  const n = sp.anchors.length;
  const indices = only ? Array.from(new Set(Array.from(only).map((i) => ((i % n) + n) % n))) : sp.anchors.map((_, i) => i);
  for (const i of indices) {
    const a = sp.anchors[i];
    if (!a) continue;
    if (a.kind === 'corner') {
      a.handleIn = null;
      a.handleOut = null;
      continue;
    }
    const hasPrev = sp.closed || i > 0;
    const hasNext = sp.closed || i < n - 1;
    const t = tangentAt(sp, i);
    if (!t) {
      a.handleIn = null;
      a.handleOut = null;
      continue;
    }
    if (hasNext) {
      const next = sp.anchors[(i + 1) % n].point;
      const chordV = sub(next, a.point);
      const chord = len(chordV);
      a.handleOut = chord < 1e-9 ? null : mul(t, arcHandleLength(chord, angleBetween(t, chordV)));
    } else a.handleOut = null;
    if (hasPrev) {
      const prev = sp.anchors[(i - 1 + n) % n].point;
      const chordV = sub(a.point, prev);
      const chord = len(chordV);
      a.handleIn = chord < 1e-9 ? null : mul(t, -arcHandleLength(chord, angleBetween(t, chordV)));
    } else a.handleIn = null;
  }
}

/** Indices around i whose handles depend on anchor i (for incremental updates). */
export function curvatureNeighbourhood(sp: SubPath, i: number, radius = 2): number[] {
  const n = sp.anchors.length;
  const out: number[] = [];
  for (let k = -radius; k <= radius; k++) {
    const j = i + k;
    if (sp.closed) out.push(((j % n) + n) % n);
    else if (j >= 0 && j < n) out.push(j);
  }
  // open paths: the end anchors depend on their neighbour's tangent
  if (!sp.closed && n <= radius + 2) {
    out.push(0, n - 1);
  }
  return Array.from(new Set(out));
}

/** Curvature handles for a subpath expressed in world space, written back into local space. */
export function recomputeCurvatureWorld(draft: Document, nodeId: ID, subpath: number, only?: Iterable<number>): void {
  const n = getPathNode(draft, nodeId);
  const sp = n?.subpaths[subpath];
  if (!n || !sp) return;
  const wm = worldMatrix(draft, nodeId);
  const inv = invert(wm);
  const world: SubPath = {
    closed: sp.closed,
    anchors: sp.anchors.map((a) => ({ point: applyToPoint(wm, a.point), handleIn: a.handleIn ? applyToVector(wm, a.handleIn) : null, handleOut: a.handleOut ? applyToVector(wm, a.handleOut) : null, kind: a.kind })),
  };
  recomputeCurvatureHandles(world, only);
  const idx = only ? Array.from(new Set(Array.from(only).map((i) => ((i % sp.anchors.length) + sp.anchors.length) % sp.anchors.length))) : sp.anchors.map((_, i) => i);
  for (const i of idx) {
    const wa = world.anchors[i];
    const a = sp.anchors[i];
    if (!wa || !a) continue;
    a.handleIn = wa.handleIn ? applyToVector(inv, wa.handleIn) : null;
    a.handleOut = wa.handleOut ? applyToVector(inv, wa.handleOut) : null;
  }
  touchPath(n);
}

/** Build a preview subpath (world) with an extra point appended and handles recomputed. */
export function curvaturePreview(worldSubPath: SubPath, extra: Vec | null, closing: boolean): SubPath {
  const anchors: Anchor[] = worldSubPath.anchors.map((a) => ({ point: { ...a.point }, handleIn: a.handleIn ? { ...a.handleIn } : null, handleOut: a.handleOut ? { ...a.handleOut } : null, kind: a.kind }));
  const sp: SubPath = { anchors, closed: worldSubPath.closed || closing };
  if (extra && !closing) sp.anchors.push({ point: { ...extra }, handleIn: null, handleOut: null, kind: 'smooth' });
  const n = sp.anchors.length;
  const last = n - 1;
  recomputeCurvatureHandles(sp, closing ? undefined : curvatureNeighbourhood(sp, last, 2));
  return sp;
}

export { dist };
