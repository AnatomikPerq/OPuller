/**
 * Corner rounding — the maths behind live corners (`anchor.cornerRadius`), the Round
 * Corners effect and rectangle radii. Pure geometry: no React, no paper.js.
 *
 * A corner is an anchor where the incoming and outgoing tangents break (not an anchor
 * "without handles": after a warp every anchor carries handles, the former sharp vertex
 * included). Rounding trims `d = r / tan(θ/2)` of path length on both sides of the corner —
 * walking across as many segments as needed — and joins the two trim points with a cubic
 * approximating a circular arc, so the same code rounds a polygon, a warped polygon and a
 * path drawn with curves.
 */
import type { SubPath, Anchor, Vec } from '@/model/types';
import { anchor as makeAnchor, segmentCount, segmentCubic, absHandleIn, absHandleOut } from './path';
import { cubicSplit, cubicLength, cubicDerivative, cubicTAtLength, type Cubic } from './bezier';

/** Break angle below which a junction counts as smooth (≈ 1°). */
const SMOOTH_EPS = Math.PI / 180;

function norm(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Unit tangent leaving anchor i (towards the next anchor). */
function outTangent(sp: SubPath, i: number): Vec {
  const a = sp.anchors[i];
  const n = sp.anchors.length;
  const next = sp.anchors[(i + 1) % n];
  if (a.handleOut && (Math.abs(a.handleOut.x) > 1e-9 || Math.abs(a.handleOut.y) > 1e-9)) return norm(a.handleOut);
  const hin = absHandleIn(next);
  const v = { x: hin.x - a.point.x, y: hin.y - a.point.y };
  if (Math.hypot(v.x, v.y) > 1e-9) return norm(v);
  return norm({ x: next.point.x - a.point.x, y: next.point.y - a.point.y });
}

/** Unit tangent arriving at anchor i (direction of travel from the previous anchor). */
function inTangent(sp: SubPath, i: number): Vec {
  const a = sp.anchors[i];
  const n = sp.anchors.length;
  const prev = sp.anchors[(i - 1 + n) % n];
  if (a.handleIn && (Math.abs(a.handleIn.x) > 1e-9 || Math.abs(a.handleIn.y) > 1e-9)) return norm({ x: -a.handleIn.x, y: -a.handleIn.y });
  const hout = absHandleOut(prev);
  const v = { x: a.point.x - hout.x, y: a.point.y - hout.y };
  if (Math.hypot(v.x, v.y) > 1e-9) return norm(v);
  return norm({ x: a.point.x - prev.point.x, y: a.point.y - prev.point.y });
}

/** Interior angle θ at anchor i (π = straight through, 0 = a spike); NaN for path ends. */
export function cornerAngle(sp: SubPath, i: number): number {
  const n = sp.anchors.length;
  if (n < 2) return NaN;
  if (!sp.closed && (i === 0 || i === n - 1)) return NaN;
  const tin = inTangent(sp, i);
  const tout = outTangent(sp, i);
  // u1 points back along the incoming segment, u2 forward along the outgoing one
  const cos = -tin.x * tout.x - tin.y * tout.y;
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

/** Whether anchor i is a corner that rounding can act on. */
export function isRoundableCorner(sp: SubPath, i: number): boolean {
  const theta = cornerAngle(sp, i);
  return Number.isFinite(theta) && theta < Math.PI - SMOOTH_EPS && theta > SMOOTH_EPS;
}

/** Unit direction of the corner's bisector pointing into the shape's interior side of the angle (between the two edges). */
export function cornerBisector(sp: SubPath, i: number): Vec {
  const tin = inTangent(sp, i);
  const tout = outTangent(sp, i);
  const u1 = { x: -tin.x, y: -tin.y };
  const b = norm({ x: u1.x + tout.x, y: u1.y + tout.y });
  if (Math.hypot(b.x, b.y) > 0) return b;
  // straight through: perpendicular
  return { x: -tout.y, y: tout.x };
}

/** Anchors that are corners (tangent break) in path order — every one is a barrier for the roundings next to it. */
function cornerVertices(sp: SubPath): Array<{ i: number; theta: number }> {
  const out: Array<{ i: number; theta: number }> = [];
  for (let i = 0; i < sp.anchors.length; i++) {
    const theta = cornerAngle(sp, i);
    if (!Number.isFinite(theta) || theta >= Math.PI - SMOOTH_EPS || theta <= SMOOTH_EPS) continue;
    out.push({ i, theta });
  }
  return out;
}

function segLength(sp: SubPath, i: number, cache: Map<number, number>): number {
  let l = cache.get(i);
  if (l === undefined) {
    l = cubicLength(segmentCubic(sp, i), 0.02);
    cache.set(i, l);
  }
  return l;
}

function sumLengths(sp: SubPath, cache: Map<number, number>): number {
  let t = 0;
  for (let i = 0; i < segmentCount(sp); i++) t += segLength(sp, i, cache);
  return t;
}

/** Path length from anchor a forward to anchor b (closed paths wrap; a === b → the whole loop). */
function lengthBetween(sp: SubPath, a: number, b: number, cache: Map<number, number>): number {
  const segs = segmentCount(sp);
  if (a === b) return sumLengths(sp, cache);
  let total = 0;
  let seg = a % segs;
  const stop = b % segs;
  for (let guard = 0; guard < segs; guard++) {
    if (seg === stop) break;
    total += segLength(sp, seg, cache);
    seg = (seg + 1) % segs;
  }
  return total;
}

interface Plan {
  i: number;
  theta: number;
  /** trim length on each side of the corner */
  d: number;
}

/**
 * Trim lengths for every corner: wanted = r / tan(θ/2), then reduced so that the two
 * roundings sharing an edge (the path between consecutive corner vertices) fit into it —
 * proportionally when both are rounded, and a sharp corner leaves the whole edge to its
 * neighbour. Open path ends count as sharp corners.
 */
function planTrims(sp: SubPath, radiusOf: (i: number, a: Anchor) => number, cache: Map<number, number>): Plan[] {
  const verts = cornerVertices(sp);
  const n = sp.anchors.length;
  const plans: Plan[] = verts.map(({ i, theta }) => {
    const r = Math.max(0, radiusOf(i, sp.anchors[i]) || 0);
    return { i, theta, d: r > 0 ? r / Math.tan(theta / 2) : 0 };
  });
  if (!plans.length) return plans;
  // edges between consecutive barriers (corner vertices, plus the ends of an open path)
  type Edge = { a: Plan | null; b: Plan | null; len: number };
  const edges: Edge[] = [];
  if (sp.closed) {
    for (let k = 0; k < plans.length; k++) {
      const a = plans[k];
      const b = plans[(k + 1) % plans.length];
      edges.push({ a, b, len: plans.length === 1 ? sumLengths(sp, cache) : lengthBetween(sp, a.i, b.i, cache) });
    }
  } else {
    edges.push({ a: null, b: plans[0], len: lengthBetween(sp, 0, plans[0].i, cache) });
    for (let k = 0; k + 1 < plans.length; k++) edges.push({ a: plans[k], b: plans[k + 1], len: lengthBetween(sp, plans[k].i, plans[k + 1].i, cache) });
    edges.push({ a: plans[plans.length - 1], b: null, len: lengthBetween(sp, plans[plans.length - 1].i, n - 1, cache) });
  }
  // a lone rounded corner on a closed loop shares the loop with itself
  for (const e of edges) {
    const da = e.a?.d ?? 0;
    const db = e.b?.d ?? 0;
    const room = Math.max(0, e.len - 1e-6);
    if (da + db <= room) continue;
    const f = da + db > 0 ? room / (da + db) : 0;
    if (e.a) e.a.d = da * f;
    if (e.b) e.b.d = db * f;
  }
  return plans;
}

/** Largest radius the corner at anchor i can take with the other corners at the radii `radiusOf` gives them. */
export function maxCornerRadius(sp: SubPath, i: number, radiusOf: (j: number, a: Anchor) => number = (_, a) => a.cornerRadius ?? 0): number {
  const theta = cornerAngle(sp, i);
  if (!Number.isFinite(theta) || theta >= Math.PI - SMOOTH_EPS || theta <= SMOOTH_EPS) return 0;
  const cache = new Map<number, number>();
  // the neighbours keep what they have; this corner gets the room they leave on its two edges
  const plans = planTrims(sp, (j, a) => (j === i ? 0 : radiusOf(j, a)), cache);
  const k = plans.findIndex((p) => p.i === i);
  if (k < 0) return 0;
  const n = sp.anchors.length;
  let before: number;
  let after: number;
  if (sp.closed) {
    const prev = plans[(k - 1 + plans.length) % plans.length];
    const next = plans[(k + 1) % plans.length];
    before = (plans.length === 1 ? sumLengths(sp, cache) : lengthBetween(sp, prev.i, i, cache)) - prev.d;
    after = (plans.length === 1 ? sumLengths(sp, cache) : lengthBetween(sp, i, next.i, cache)) - next.d;
    if (plans.length === 1) before = after = sumLengths(sp, cache) / 2;
  } else {
    const prev = k > 0 ? plans[k - 1] : null;
    const next = k < plans.length - 1 ? plans[k + 1] : null;
    before = lengthBetween(sp, prev ? prev.i : 0, i, cache) - (prev?.d ?? 0);
    after = lengthBetween(sp, i, next ? next.i : n - 1, cache) - (next?.d ?? 0);
  }
  return Math.max(0, Math.min(before, after)) * Math.tan(theta / 2);
}

const tAtLength = cubicTAtLength;

/** Position along the path (segment + t) after walking `d` backwards from anchor i. */
function walkBack(sp: SubPath, i: number, d: number, cache: Map<number, number>): number {
  const segs = segmentCount(sp);
  let seg = i - 1;
  let remaining = d;
  for (let guard = 0; guard < segs; guard++) {
    const s = ((seg % segs) + segs) % segs;
    const len = segLength(sp, s, cache);
    if (remaining <= len) {
      const c = segmentCubic(sp, s);
      return seg + tAtLength(c, len - remaining);
    }
    remaining -= len;
    seg--;
  }
  return i - segs;
}

/** Position along the path after walking `d` forwards from anchor i. */
function walkForward(sp: SubPath, i: number, d: number, cache: Map<number, number>): number {
  const segs = segmentCount(sp);
  let seg = i;
  let remaining = d;
  for (let guard = 0; guard < segs; guard++) {
    const s = seg % segs;
    const len = segLength(sp, s, cache);
    if (remaining <= len) {
      const c = segmentCubic(sp, s);
      return seg + tAtLength(c, remaining);
    }
    remaining -= len;
    seg++;
  }
  return i + segs;
}

/** The sub-cubic of segment `seg` between parameters t0 and t1. */
function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  let piece = c;
  if (t0 > 1e-9) piece = cubicSplit(piece, t0)[1];
  if (t1 < 1 - 1e-9) piece = cubicSplit(piece, t0 > 1e-9 ? (t1 - t0) / (1 - t0) : t1)[0];
  return piece;
}

/** Cubic pieces of the path between positions a and b (a < b, positions may exceed segs on closed paths). */
function piecesBetween(sp: SubPath, a: number, b: number): Cubic[] {
  const segs = segmentCount(sp);
  const out: Cubic[] = [];
  for (let s = Math.floor(a); s < b - 1e-9; s++) {
    const t0 = Math.max(0, a - s);
    const t1 = Math.min(1, b - s);
    if (t1 <= t0 + 1e-9) continue;
    const seg = ((s % segs) + segs) % segs;
    out.push(subCubic(segmentCubic(sp, seg), t0, t1));
  }
  return out;
}

function pointAndTangent(sp: SubPath, pos: number): { point: Vec; tangent: Vec } {
  const segs = segmentCount(sp);
  let s = Math.floor(pos);
  let t = pos - s;
  if (t > 1 - 1e-9) {
    s++;
    t = 0;
  }
  const seg = ((s % segs) + segs) % segs;
  const c = segmentCubic(sp, seg);
  const [l, r] = cubicSplit(c, Math.min(1, Math.max(0, t)));
  let tangent = norm(cubicDerivative(c, Math.min(1, Math.max(0, t))));
  if (Math.hypot(tangent.x, tangent.y) === 0) tangent = norm({ x: r.p3.x - l.p0.x, y: r.p3.y - l.p0.y });
  return { point: l.p3, tangent };
}

/**
 * Round the corners of a subpath. `radiusOf(i)` gives the radius wanted at anchor i (0 =
 * leave sharp). Adjacent roundings share the path between them, so a radius that does not
 * fit is reduced (Illustrator caps a corner at the available edge, it never overlaps the
 * neighbour). Anchors that are not corners (smooth junctions, path ends) are kept as they are.
 */
export function roundSubPathCorners(sp: SubPath, radiusOf: (i: number, a: Anchor) => number): SubPath {
  const n = sp.anchors.length;
  const segs = segmentCount(sp);
  if (n < 2 || segs < 1) return sp;
  const cache = new Map<number, number>();
  if (!sp.anchors.some((a, i) => radiusOf(i, a) > 0)) return sp;

  // removed interval [from, to] in path positions and the arc replacing it, per corner
  interface Round {
    i: number;
    from: number;
    to: number;
    theta: number;
    d: number;
  }
  const rounds: Round[] = [];
  for (const { i, theta, d } of planTrims(sp, radiusOf, cache)) {
    if (d <= 1e-6) continue;
    rounds.push({ i, from: walkBack(sp, i, d, cache), to: walkForward(sp, i, d, cache), theta, d });
  }
  if (!rounds.length) return sp;

  const pieces: Cubic[] = [];
  const arcIndex = new Set<number>();
  const addArc = (rd: Round) => {
    const a = pointAndTangent(sp, rd.from);
    const b = pointAndTangent(sp, rd.to);
    const phi = Math.PI - rd.theta; // turning angle of the arc
    const rEff = rd.d * Math.tan(rd.theta / 2);
    const k = (4 / 3) * Math.tan(phi / 4) * rEff;
    pieces.push({ p0: a.point, p1: { x: a.point.x + a.tangent.x * k, y: a.point.y + a.tangent.y * k }, p2: { x: b.point.x - b.tangent.x * k, y: b.point.y - b.tangent.y * k }, p3: b.point });
    arcIndex.add(pieces.length - 1);
  };

  if (sp.closed) {
    // normalise every removed interval to from ∈ [0, segs), to = from + span
    const norm = rounds.map((rd) => {
      const from = ((rd.from % segs) + segs) % segs;
      let to = ((rd.to % segs) + segs) % segs;
      if (to <= from + 1e-9) to += segs;
      return { ...rd, from, to };
    });
    norm.sort((a, b) => a.from - b.from);
    // keep the original start anchor when it survives, so anchor indices stay stable
    const covering = norm.find((rd) => rd.from <= 1e-9 || rd.to >= segs - 1e-9);
    const start = covering ? (covering.from <= 1e-9 ? covering.to : covering.to - segs) : 0;
    let cursor = start;
    // rounds in walking order from `start`
    const ordered = norm.filter((rd) => rd.from >= start - 1e-9).concat(norm.filter((rd) => rd.from < start - 1e-9).map((rd) => ({ ...rd, from: rd.from + segs, to: rd.to + segs })));
    for (const rd of ordered) {
      if (rd.from < cursor - 1e-9) continue; // interval already consumed (the one that covered the start)
      for (const p of piecesBetween(sp, cursor, rd.from)) pieces.push(p);
      addArc(rd);
      cursor = rd.to;
    }
    for (const p of piecesBetween(sp, cursor, start + segs)) pieces.push(p);
  } else {
    let pos = 0;
    for (const rd of rounds) {
      for (const p of piecesBetween(sp, pos, rd.from)) pieces.push(p);
      addArc(rd);
      pos = rd.to;
    }
    for (const p of piecesBetween(sp, pos, segs)) pieces.push(p);
  }
  if (!pieces.length) return sp;
  return cubicsToSubPath(pieces, sp.closed, arcIndex, sp, rounds.map((r) => r.i));
}

/** Re-anchor a chain of cubic pieces. Arc endpoints become corner-kind anchors (like Illustrator's live corners). */
function cubicsToSubPath(pieces: Cubic[], closed: boolean, arcs: Set<number>, src: SubPath, rounded: number[]): SubPath {
  const anchors: Anchor[] = [];
  const count = pieces.length;
  const rel = (p: Vec, h: Vec | null): Vec | null => (h && (Math.abs(h.x - p.x) > 1e-9 || Math.abs(h.y - p.y) > 1e-9) ? { x: h.x - p.x, y: h.y - p.y } : null);
  // anchors of the source that survive untouched keep their kind and (for live corners) drop their radius
  const survivors = new Map<string, Anchor>();
  for (let i = 0; i < src.anchors.length; i++) if (!rounded.includes(i)) survivors.set(`${src.anchors[i].point.x.toFixed(6)},${src.anchors[i].point.y.toFixed(6)}`, src.anchors[i]);
  const push = (p: Vec, hin: Vec | null, hout: Vec | null, isArcEnd: boolean) => {
    const rin = rel(p, hin);
    const rout = rel(p, hout);
    let kind: 'corner' | 'smooth' = 'corner';
    const orig = survivors.get(`${p.x.toFixed(6)},${p.y.toFixed(6)}`);
    if (orig) kind = orig.kind;
    else if (!isArcEnd && rin && rout) {
      const a = norm(rin);
      const b = norm(rout);
      if (a.x * b.x + a.y * b.y < -0.999) kind = 'smooth';
    }
    const a = makeAnchor(p, rin, rout, kind);
    anchors.push(a);
  };
  for (let i = 0; i < count; i++) {
    const cur = pieces[i];
    const prevIdx = i > 0 ? i - 1 : closed ? count - 1 : -1;
    const prev = prevIdx >= 0 ? pieces[prevIdx] : null;
    const isArcEnd = arcs.has(i) || (prevIdx >= 0 && arcs.has(prevIdx));
    push(cur.p0, prev ? prev.p2 : null, cur.p1, isArcEnd);
  }
  if (!closed) {
    const last = pieces[count - 1];
    push(last.p3, last.p2, null, arcs.has(count - 1));
  }
  return { anchors, closed };
}

/**
 * Rectangle radii clamped so adjacent corners never overlap: when a pair of radii along an
 * edge exceeds it, that pair is scaled down proportionally (CSS `border-radius` / Illustrator
 * behaviour); other corners keep their value.
 */
export function clampRectRadii(width: number, height: number, radii: [number, number, number, number]): [number, number, number, number] {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const [tl, tr, br, bl] = radii.map((r) => (Number.isFinite(r) ? Math.max(0, r) : 0));
  const f = (sum: number, edge: number) => (sum > edge && sum > 0 ? edge / sum : 1);
  const top = f(tl + tr, w);
  const bottom = f(bl + br, w);
  const left = f(tl + bl, h);
  const right = f(tr + br, h);
  return [tl * Math.min(top, left), tr * Math.min(top, right), br * Math.min(bottom, right), bl * Math.min(bottom, left)];
}

/** Whether any anchor carries a live corner radius. */
export function hasLiveCorners(sps: SubPath[]): boolean {
  return sps.some((sp) => sp.anchors.some((a) => (a.cornerRadius ?? 0) > 0));
}

/** Live corners: apply `anchor.cornerRadius` of every anchor (the rounded result carries no radii). */
export function applyLiveCorners(sp: SubPath): SubPath {
  if (!sp.anchors.some((a) => (a.cornerRadius ?? 0) > 0)) return sp;
  const out = roundSubPathCorners(sp, (_, a) => a.cornerRadius ?? 0);
  if (out === sp) return { anchors: sp.anchors.map(stripRadius), closed: sp.closed };
  return out;
}

export function applyLiveCornersAll(sps: SubPath[]): SubPath[] {
  return hasLiveCorners(sps) ? sps.map(applyLiveCorners) : sps;
}

function stripRadius(a: Anchor): Anchor {
  if (a.cornerRadius === undefined) return a;
  const { cornerRadius: _r, ...rest } = a;
  return rest;
}
