/**
 * Pure path surgery used by the freehand tools: cutting subpaths at
 * parametric locations, erasing intervals, replacing a portion of a path with
 * a new stroke (pencil redraw), locating touched ranges and grouping the
 * result of boolean operations into islands.
 *
 * A path location is expressed as `u = segment + t` (t in 0..1), so an open
 * subpath spans u in [0, segmentCount] and a closed one wraps at segmentCount.
 * No paper.js here so everything can be unit tested in jsdom.
 */
import type { SubPath, Anchor, Vec, FillRule } from '@/model/types';
import {
  segmentCount,
  segmentCubic,
  insertAnchorAt,
  cloneAnchor,
  cloneSubPath,
  nearestPointOnPath,
  pointAt,
  pointInPath,
  subpathArea,
  reverseSubPath,
  inferAnchorKind,
  hasHandle,
  flattenSubPath,
} from '@/geometry/path';
import { cubicPoint, cubicLength, cubicNearest, cubicSplit } from '@/geometry/bezier';

export interface UInterval {
  from: number;
  /** for closed subpaths `to < from` means the interval wraps through u = 0 */
  to: number;
}

const EPS = 1e-4;

const cloneVec = (v: Vec | null | undefined): Vec | null => (v ? { x: v.x, y: v.y } : null);

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface Cut {
  /** ordering key (the original u; anchor cuts use integer values) */
  u: number;
  insert: boolean;
  segment: number;
  t: number;
  /** index of the anchor for anchor cuts */
  anchorIndex: number;
}

/**
 * Insert anchors at the given parametric locations. Returns the new subpath and
 * the anchor index of every requested location (same order as `us`).
 */
export function cutAt(sp: SubPath, us: number[]): { sp: SubPath; indices: number[] } {
  const copy = cloneSubPath(sp);
  const n = segmentCount(copy);
  const N = copy.anchors.length;
  if (n === 0) return { sp: copy, indices: us.map(() => 0) };
  const cuts: Cut[] = us.map((raw) => {
    const u = clamp(raw, 0, n);
    const s = Math.min(n - 1, Math.floor(u));
    const t = u - s;
    if (t < EPS) return { u: s, insert: false, segment: s, t: 0, anchorIndex: s };
    if (t > 1 - EPS) {
      const idx = copy.closed ? (s + 1) % N : s + 1;
      return { u: copy.closed && idx === 0 ? 0 : s + 1, insert: false, segment: s, t: 1, anchorIndex: idx };
    }
    return { u, insert: true, segment: s, t, anchorIndex: -1 };
  });
  // unique insert cuts, descending, so earlier indices stay valid
  const inserts: Cut[] = [];
  for (const c of cuts.slice().sort((a, b) => b.u - a.u)) {
    if (!c.insert) continue;
    if (inserts.some((o) => Math.abs(o.u - c.u) < 1e-6)) continue;
    inserts.push({ ...c });
  }
  // Inserting an anchor re-parameterises the segment (straight segments have a
  // non-linear cubic parameterisation), so later cuts in the same segment are
  // re-located by their world point rather than by rescaling t.
  const pts = inserts.map((c) => cubicPoint(segmentCubic(copy, c.segment), c.t));
  for (let i = 0; i < inserts.length; i++) {
    const c = inserts[i];
    insertAnchorAt(copy, c.segment, c.t);
    for (let k = i + 1; k < inserts.length; k++) {
      if (inserts[k].segment !== c.segment) continue;
      inserts[k].t = clamp(cubicNearest(segmentCubic(copy, c.segment), pts[k]).t, 1e-6, 1 - 1e-6);
    }
  }
  const indexFor = (c: Cut): number => {
    const base = c.insert ? c.segment + 1 : c.anchorIndex;
    let shift = 0;
    for (const ins of inserts) if (ins.u < c.u - 1e-9) shift++;
    return base + shift;
  };
  return { sp: copy, indices: cuts.map(indexFor) };
}

/** Close an open subpath when its ends are within `distance` (the last anchor merges into the first). */
export function closeIfNear(sp: SubPath, distance: number): SubPath {
  if (sp.closed || sp.anchors.length < 3) return sp;
  const first = sp.anchors[0];
  const last = sp.anchors[sp.anchors.length - 1];
  if (Math.hypot(first.point.x - last.point.x, first.point.y - last.point.y) > distance) return sp;
  const out = cloneSubPath(sp);
  const l = out.anchors.pop()!;
  out.anchors[0].handleIn = cloneVec(l.handleIn);
  inferAnchorKind(out.anchors[0]);
  out.closed = true;
  return out;
}

/** Open piece of a subpath between two anchor indices (after `cutAt`). */
export function slicePiece(sp: SubPath, a: number, b: number): SubPath {
  return piece(sp.anchors, a, b);
}

/** Clone anchors a..b (inclusive) as an open piece with trimmed outer handles. */
function piece(anchors: Anchor[], a: number, b: number): SubPath {
  const out = anchors.slice(a, b + 1).map(cloneAnchor);
  if (out.length) {
    out[0].handleIn = null;
    out[out.length - 1].handleOut = null;
    for (const an of out) inferAnchorKind(an);
  }
  return { anchors: out, closed: false };
}

/** Rotate a closed subpath so that anchor `k` comes first; opens it (k is duplicated at the end). */
function openAt(sp: SubPath, k: number): SubPath {
  const N = sp.anchors.length;
  const anchors: Anchor[] = [];
  for (let i = 0; i < N; i++) anchors.push(cloneAnchor(sp.anchors[(k + i) % N]));
  const dup = cloneAnchor(sp.anchors[k]);
  anchors[0].handleIn = null;
  dup.handleOut = null;
  anchors.push(dup);
  return { anchors, closed: false };
}

/** Merge and normalise intervals. Returns arcs (for closed subpaths at most one wraps). */
export function normalizeIntervals(intervals: UInterval[], n: number, closed: boolean): UInterval[] | 'all' {
  if (!closed) {
    const lin = intervals
      .map((iv) => {
        let a = clamp(iv.from, 0, n);
        let b = clamp(iv.to, 0, n);
        if (a > b) [a, b] = [b, a];
        return { from: a, to: b };
      })
      .filter((iv) => iv.to - iv.from > 1e-6)
      .sort((x, y) => x.from - y.from);
    const merged: UInterval[] = [];
    for (const iv of lin) {
      const last = merged[merged.length - 1];
      if (last && iv.from <= last.to + EPS) last.to = Math.max(last.to, iv.to);
      else merged.push({ ...iv });
    }
    if (merged.length === 1 && merged[0].from < EPS && merged[0].to > n - EPS) return 'all';
    return merged;
  }
  // closed: split wrapping arcs at the seam, merge linearly, re-join at the seam
  const lin: UInterval[] = [];
  for (const iv of intervals) {
    const a = ((iv.from % n) + n) % n;
    let b = ((iv.to % n) + n) % n;
    if (Math.abs(iv.to - n) < 1e-9 && b === 0) b = n;
    if (Math.abs(a - b) < 1e-9 && Math.abs(iv.to - iv.from) >= n - 1e-9) return 'all';
    if (a <= b) lin.push({ from: a, to: b });
    else {
      lin.push({ from: a, to: n });
      lin.push({ from: 0, to: b });
    }
  }
  const sorted = lin.filter((iv) => iv.to - iv.from > 1e-6).sort((x, y) => x.from - y.from);
  const merged: UInterval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.from <= last.to + EPS) last.to = Math.max(last.to, iv.to);
    else merged.push({ ...iv });
  }
  if (!merged.length) return [];
  if (merged.length === 1 && merged[0].from < EPS && merged[0].to > n - EPS) return 'all';
  const first = merged[0];
  const last = merged[merged.length - 1];
  if (merged.length >= 2 && first.from < EPS && last.to > n - EPS) {
    // join through the seam into a wrapping arc
    const wrap = { from: last.from, to: first.to };
    return [wrap, ...merged.slice(1, -1)];
  }
  if (merged.length === 1 && first.to > n - EPS && first.from > EPS) return [{ from: first.from, to: n }];
  return merged;
}

/**
 * Remove the given parametric intervals from a subpath. Closed subpaths become
 * open. Returns the remaining pieces in path order (empty when fully erased).
 */
export function eraseIntervals(sp: SubPath, intervals: UInterval[]): SubPath[] {
  const n = segmentCount(sp);
  if (n === 0) return sp.anchors.length ? [cloneSubPath(sp)] : [];
  const arcs = normalizeIntervals(intervals, n, sp.closed);
  if (arcs === 'all') return [];
  if (!arcs.length) return [cloneSubPath(sp)];

  if (!sp.closed) {
    const us: number[] = [];
    for (const a of arcs) {
      if (a.from > EPS) us.push(a.from);
      if (a.to < n - EPS) us.push(a.to);
    }
    const cut = cutAt(sp, us);
    const idxOf = new Map<number, number>();
    us.forEach((u, i) => idxOf.set(u, cut.indices[i]));
    const last = cut.sp.anchors.length - 1;
    const erased = arcs.map((a) => ({ a: a.from > EPS ? idxOf.get(a.from)! : 0, b: a.to < n - EPS ? idxOf.get(a.to)! : last }));
    const bounds = Array.from(new Set([0, last, ...erased.flatMap((e) => [e.a, e.b])])).sort((x, y) => x - y);
    const out: SubPath[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i];
      const b = bounds[i + 1];
      if (erased.some((e) => e.a === a && e.b === b)) continue;
      const p = piece(cut.sp.anchors, a, b);
      if (p.anchors.length >= 2) out.push(p);
    }
    return out;
  }

  // closed
  const wrapIdx = arcs.findIndex((a) => a.to < a.from);
  const ordered = wrapIdx >= 0 ? [arcs[wrapIdx], ...arcs.filter((_, i) => i !== wrapIdx)] : arcs;
  const us = ordered.flatMap((a) => [a.from, a.to]);
  const cut = cutAt(sp, us);
  const N = cut.sp.anchors.length;
  const k = cut.indices[0];
  const rot = openAt(cut.sp, k);
  const map = (idx: number) => (idx - k + N) % N;
  const erased = ordered.map((_, i) => {
    const a = map(cut.indices[i * 2]);
    let b = map(cut.indices[i * 2 + 1]);
    if (b === 0) b = N; // ends where the rotation started: the duplicate at the end
    return { a, b };
  });
  const bounds = Array.from(new Set([0, N, ...erased.flatMap((e) => [e.a, e.b])])).sort((x, y) => x - y);
  const out: SubPath[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (erased.some((e) => e.a === a && e.b === b)) continue;
    const p = piece(rot.anchors, a, b);
    if (p.anchors.length >= 2) out.push(p);
  }
  return out;
}

/** Distance from a point to a polyline. */
export function distanceToPolyline(p: Vec, pts: Vec[]): number {
  if (!pts.length) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Replace the portion of a subpath between two locations with `repl` (an open
 * subpath drawn from u1 to u2). For closed subpaths the arc closest to the
 * drawn stroke (`strokePts`) is the one replaced.
 */
export function replacePortion(sp: SubPath, u1: number, u2: number, repl: SubPath, strokePts: Vec[]): SubPath {
  const n = segmentCount(sp);
  if (n === 0 || repl.anchors.length < 2) return cloneSubPath(sp);
  const cut = cutAt(sp, [u1, u2]);
  let [a, b] = cut.indices;
  const anchors = cut.sp.anchors;
  const N = anchors.length;
  if (a === b) return cloneSubPath(sp);
  let stroke = repl;
  if (!sp.closed) {
    if (a > b) {
      [a, b] = [b, a];
      stroke = reverseSubPath(repl);
    }
    const head = anchors.slice(0, a + 1).map(cloneAnchor);
    const tail = anchors.slice(b).map(cloneAnchor);
    return { anchors: assemble(head, stroke, tail), closed: false };
  }
  // closed: pick the arc (a→b forward or b→a forward) nearest to the stroke
  const arcAB = arcIndices(a, b, N);
  const arcBA = arcIndices(b, a, N);
  const score = (arc: number[]) => {
    const pts: Vec[] = [];
    for (let i = 0; i < arc.length - 1; i++) {
      const seg = arc[i];
      pts.push(pointAt(cut.sp, seg, 0.5));
      if (i > 0) pts.push(anchors[seg].point);
    }
    if (!pts.length) return Infinity;
    let sum = 0;
    for (const p of pts) sum += distanceToPolyline(p, strokePts);
    return sum / pts.length;
  };
  const replaceAB = score(arcAB) <= score(arcBA);
  const kept = (replaceAB ? arcBA : arcAB).map((i) => cloneAnchor(anchors[i]));
  const s = replaceAB ? stroke : reverseSubPath(stroke);
  // kept runs from X to Y, the stroke goes from Y back to X
  const first = kept[0];
  const last = kept[kept.length - 1];
  last.handleOut = cloneVec(s.anchors[0].handleOut);
  first.handleIn = cloneVec(s.anchors[s.anchors.length - 1].handleIn);
  inferAnchorKind(first);
  inferAnchorKind(last);
  const interior = s.anchors.slice(1, -1).map(cloneAnchor);
  return { anchors: kept.concat(interior), closed: true };
}

function arcIndices(a: number, b: number, N: number): number[] {
  const out: number[] = [];
  let i = a;
  out.push(i);
  let guard = 0;
  while (i !== b && guard++ < N + 1) {
    i = (i + 1) % N;
    out.push(i);
  }
  return out;
}

/** head (ends at the junction) + stroke interior + tail (starts at the junction). */
function assemble(head: Anchor[], stroke: SubPath, tail: Anchor[]): Anchor[] {
  const s = stroke.anchors;
  const j1 = head[head.length - 1];
  const j2 = tail[0];
  j1.handleOut = cloneVec(s[0].handleOut);
  j2.handleIn = cloneVec(s[s.length - 1].handleIn);
  inferAnchorKind(j1);
  inferAnchorKind(j2);
  return head.concat(s.slice(1, -1).map(cloneAnchor), tail);
}

/** Append an open stroke to the end (or reversed to the start) of an open subpath. */
export function extendSubPath(sp: SubPath, stroke: SubPath, atStart: boolean): SubPath {
  if (sp.closed) return cloneSubPath(sp);
  const base = cloneSubPath(sp);
  let s = cloneSubPath(stroke);
  if (atStart) {
    s = reverseSubPath(s);
    // s ends at the path start
    const junction = base.anchors[0];
    const sl = s.anchors[s.anchors.length - 1];
    junction.handleIn = cloneVec(sl.handleIn);
    inferAnchorKind(junction);
    return { anchors: s.anchors.slice(0, -1).map(cloneAnchor).concat(base.anchors), closed: false };
  }
  const junction = base.anchors[base.anchors.length - 1];
  junction.handleOut = cloneVec(s.anchors[0].handleOut);
  inferAnchorKind(junction);
  return { anchors: base.anchors.concat(s.anchors.slice(1).map(cloneAnchor)), closed: false };
}

/** Move a location along the path by (approximately) `distance` world units. */
export function offsetU(sp: SubPath, u: number, distance: number): number {
  const n = segmentCount(sp);
  if (n === 0) return u;
  let cur = u;
  let remaining = Math.abs(distance);
  const dir = Math.sign(distance);
  if (dir === 0) return u;
  let guard = 0;
  while (remaining > 0 && guard++ < 2 * n + 4) {
    if (sp.closed) {
      if (cur >= n) cur -= n;
      if (cur < 0) cur += n;
    } else {
      if (dir > 0 && cur >= n - 1e-9) return n;
      if (dir < 0 && cur <= 1e-9) return 0;
    }
    let seg: number;
    if (dir > 0) seg = Math.floor(cur);
    else {
      seg = Math.ceil(cur) - 1;
      if (seg < 0) {
        if (sp.closed) {
          cur += n;
          continue;
        }
        return 0;
      }
    }
    if (seg >= n) {
      if (sp.closed) {
        cur -= n;
        continue;
      }
      return n;
    }
    const t = cur - seg;
    const c = segmentCubic(sp, seg);
    // arc length is not linear in t (straight segments with null handles are
    // parameterised non-uniformly), so measure real lengths
    const total = cubicLength(c);
    const lenAt = (tt: number) => (tt <= 0 ? 0 : tt >= 1 ? total : cubicLength(cubicSplit(c, tt)[0]));
    const base = lenAt(t);
    const avail = dir > 0 ? total - base : base;
    if (avail >= remaining) {
      const target = dir > 0 ? base + remaining : base - remaining;
      let lo = dir > 0 ? t : 0;
      let hi = dir > 0 ? 1 : t;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (lenAt(mid) < target) lo = mid;
        else hi = mid;
      }
      return seg + (lo + hi) / 2;
    }
    cur = dir > 0 ? seg + 1 : seg;
    remaining -= avail;
  }
  return sp.closed ? ((cur % n) + n) % n : clamp(cur, 0, n);
}

/** Circular span covered by a set of u values (complement of the largest gap). */
function circularSpan(us: number[], n: number): UInterval {
  const s = us.slice().sort((a, b) => a - b);
  if (s.length === 1) return { from: s[0], to: s[0] };
  let gapIdx = -1;
  let gap = n - s[s.length - 1] + s[0]; // wrap gap
  for (let i = 0; i < s.length - 1; i++) {
    const g = s[i + 1] - s[i];
    if (g > gap) {
      gap = g;
      gapIdx = i;
    }
  }
  if (gapIdx < 0) return { from: s[0], to: s[s.length - 1] };
  return { from: s[gapIdx + 1], to: s[gapIdx] };
}

/**
 * Intervals of a subpath touched by a sequence of pointer samples (each sample
 * touches the path when its nearest point is within `radius`). Consecutive
 * touching samples form one interval; `pad` widens every interval by that
 * many world units on both sides.
 */
export function touchIntervals(sp: SubPath, samples: Vec[], radius: number, pad = 0): UInterval[] {
  const n = segmentCount(sp);
  if (n === 0) return [];
  const groups: number[][] = [];
  let cur: number[] | null = null;
  for (const s of samples) {
    const loc = nearestPointOnPath([sp], s);
    if (loc && loc.distance <= radius) {
      if (!cur) {
        cur = [];
        groups.push(cur);
      }
      cur.push(loc.segment + loc.t);
    } else cur = null;
  }
  const out: UInterval[] = [];
  for (const g of groups) {
    let iv: UInterval = sp.closed ? circularSpan(g, n) : { from: Math.min(...g), to: Math.max(...g) };
    if (pad > 0) {
      const padded = { from: offsetU(sp, iv.from, -pad), to: offsetU(sp, iv.to, pad) };
      if (sp.closed) {
        // padding may have wrapped the arc around onto itself: erase everything
        const before = (((iv.to - iv.from) % n) + n) % n;
        const after = (((padded.to - padded.from) % n) + n) % n;
        if (after < before || (after === 0 && pad > 0)) return [{ from: 0, to: n }];
      }
      iv = padded;
    }
    out.push(iv);
  }
  return out;
}

/** Point-in-area test with the area flattened once (much cheaper than pointInPath per query). */
export function makeInsideTest(area: SubPath[], fillRule: FillRule = 'nonzero'): (p: Vec) => boolean {
  const polys = area.filter((sp) => sp.anchors.length >= 3).map((sp) => flattenSubPath({ ...sp, closed: true }, 0.25));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys)
    for (const q of poly) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
  return (p: Vec) => {
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
    let winding = 0;
    let crossings = 0;
    for (const poly of polys) {
      const m = poly.length;
      for (let i = 0; i < m; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % m];
        if (a.y <= p.y) {
          if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) {
            winding++;
            crossings++;
          }
        } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
          winding--;
          crossings++;
        }
      }
    }
    return fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
  };
}

/**
 * Intervals of a subpath lying inside a filled area (eraser on open paths).
 * Crossings are refined by bisection.
 */
export function insideIntervals(sp: SubPath, area: SubPath[], fillRule: FillRule = 'nonzero', maxSamplesPerSegment = 48): UInterval[] {
  const n = segmentCount(sp);
  if (n === 0) return [];
  const test = makeInsideTest(area, fillRule);
  const inside = (u: number): boolean => {
    const s = Math.min(n - 1, Math.floor(u));
    return test(pointAt(sp, s, u - s));
  };
  const refine = (uOut: number, uIn: number): number => {
    let a = uOut;
    let b = uIn;
    for (let i = 0; i < 14; i++) {
      const m = (a + b) / 2;
      if (inside(m)) b = m;
      else a = m;
    }
    return (a + b) / 2;
  };
  const samples: Array<{ u: number; inside: boolean }> = [];
  for (let seg = 0; seg < n; seg++) {
    const c = segmentCubic(sp, seg);
    const len = cubicLength(c);
    const m = Math.max(4, Math.min(maxSamplesPerSegment, Math.ceil(len / 2)));
    for (let k = seg === 0 ? 0 : 1; k <= m; k++) {
      const t = k / m;
      samples.push({ u: seg + t, inside: test(cubicPoint(c, t)) });
    }
  }
  const intervals: UInterval[] = [];
  let open: number | null = samples[0].inside ? 0 : null;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev.inside === cur.inside) continue;
    if (cur.inside) open = refine(prev.u, cur.u);
    else if (open !== null) {
      intervals.push({ from: open, to: refine(cur.u, prev.u) });
      open = null;
    }
  }
  if (open !== null) intervals.push({ from: open, to: n });
  if (sp.closed && intervals.length >= 2) {
    const first = intervals[0];
    const last = intervals[intervals.length - 1];
    if (first.from <= EPS && last.to >= n - EPS) {
      intervals.splice(intervals.length - 1, 1);
      intervals[0] = { from: last.from, to: first.to };
    }
  }
  return intervals;
}

/** Add the segments touched by the samples (nearest point within `radius`) to `segs`. */
export function collectTouchedSegments(sp: SubPath, samples: Vec[], radius: number, segs: Set<number>): Set<number> {
  if (segmentCount(sp) === 0) return segs;
  for (const s of samples) {
    const loc = nearestPointOnPath([sp], s);
    if (loc && loc.distance <= radius) segs.add(loc.segment);
  }
  return segs;
}

/** Contiguous anchor range [i, j] covering a set of touched segments (smooth tool). */
export function anchorRangeFromSegments(sp: SubPath, segs: Set<number>): { i: number; j: number; whole: boolean } | null {
  const n = segmentCount(sp);
  if (n === 0 || !segs.size) return null;
  if (segs.size >= n) return { i: 0, j: sp.closed ? 0 : n, whole: true };
  const sorted = Array.from(segs).sort((a, b) => a - b);
  if (!sp.closed) return { i: sorted[0], j: sorted[sorted.length - 1] + 1, whole: false };
  const span = circularSpan(sorted, n);
  const first = span.from;
  const last = span.to;
  return { i: first, j: (last + 1) % sp.anchors.length, whole: false };
}

/** Contiguous anchor range [i, j] of a subpath touched by the samples (smooth tool). */
export function touchedAnchorRange(sp: SubPath, samples: Vec[], radius: number): { i: number; j: number; whole: boolean } | null {
  return anchorRangeFromSegments(sp, collectTouchedSegments(sp, samples, radius, new Set<number>()));
}

/**
 * Group closed subpaths into islands: each outer contour with the holes it
 * contains. Contours nested inside holes form their own islands.
 */
export function islands(subpaths: SubPath[]): SubPath[][] {
  const sps = subpaths.filter((sp) => sp.anchors.length >= 2);
  if (sps.length <= 1) return sps.length ? [sps] : [];
  const probe = (sp: SubPath): Vec => (segmentCount(sp) ? pointAt(sp, 0, 0.5) : sp.anchors[0].point);
  const areas = sps.map((sp) => Math.abs(subpathArea(sp)));
  const depth = sps.map((sp, i) => {
    const p = probe(sp);
    let d = 0;
    sps.forEach((other, j) => {
      if (i !== j && areas[j] > areas[i] * 0.999 && pointInPath([other], p, 'nonzero')) d++;
    });
    return d;
  });
  const groups: SubPath[][] = [];
  const groupOf = new Map<number, SubPath[]>();
  sps.forEach((sp, i) => {
    if (depth[i] % 2 === 0) {
      const g = [sp];
      groups.push(g);
      groupOf.set(i, g);
    }
  });
  sps.forEach((sp, i) => {
    if (depth[i] % 2 === 0) return;
    const p = probe(sp);
    let best = -1;
    sps.forEach((other, j) => {
      if (depth[j] !== depth[i] - 1 || !groupOf.has(j)) return;
      if (!pointInPath([other], p, 'nonzero')) return;
      if (best < 0 || areas[j] < areas[best]) best = j;
    });
    if (best >= 0) groupOf.get(best)!.push(sp);
    else groups.push([sp]);
  });
  return groups;
}

export { hasHandle };
