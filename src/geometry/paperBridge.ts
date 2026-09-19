/**
 * Bridge between OPuller's path model and paper.js, which we use as a geometry
 * kernel for boolean operations, offsetting, simplification and robust queries.
 *
 * paper.js runs headless (a hidden 1x1 canvas). Items are created with
 * `insert: false` so they never touch the project's scene graph.
 */
import paper from 'paper';
import { PaperOffset } from 'paperjs-offset';
import type { SubPath, Anchor, Vec, FillRule, Matrix } from '@/model/types';
import { anchor, hasHandle, inferAnchorKind, subpathToCubics } from './path';
import { isLine, type Cubic } from './bezier';
import { offsetCubic, cubicTangent } from './offsetCurve';

let initialized = false;

export function ensurePaper(): typeof paper {
  if (!initialized) {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : (null as unknown as HTMLCanvasElement);
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
      paper.setup(canvas);
    } else {
      paper.setup(new paper.Size(1, 1));
    }
    paper.settings.insertItems = false;
    initialized = true;
  }
  return paper;
}

export type PaperPathItem = paper.Path | paper.CompoundPath;

export function subpathToPaper(sp: SubPath): paper.Path {
  ensurePaper();
  const segments = sp.anchors.map(
    (a) =>
      new paper.Segment(
        new paper.Point(a.point.x, a.point.y),
        a.handleIn ? new paper.Point(a.handleIn.x, a.handleIn.y) : undefined,
        a.handleOut ? new paper.Point(a.handleOut.x, a.handleOut.y) : undefined,
      ),
  );
  const p = new paper.Path({ segments, closed: sp.closed, insert: false });
  return p;
}

export function subpathsToPaper(subpaths: SubPath[], fillRule: FillRule = 'nonzero', matrix?: Matrix): PaperPathItem {
  ensurePaper();
  const paths = subpaths.map(subpathToPaper);
  let item: PaperPathItem;
  if (paths.length === 1) item = paths[0];
  else item = new paper.CompoundPath({ children: paths, insert: false });
  item.fillRule = fillRule;
  if (matrix) item.transform(new paper.Matrix(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f));
  return item;
}

export function paperPathToSubPath(p: paper.Path): SubPath {
  const anchors = p.segments.map((s) => {
    const a = anchor(
      { x: s.point.x, y: s.point.y },
      s.handleIn && !s.handleIn.isZero() ? { x: s.handleIn.x, y: s.handleIn.y } : null,
      s.handleOut && !s.handleOut.isZero() ? { x: s.handleOut.x, y: s.handleOut.y } : null,
    );
    inferAnchorKind(a);
    return a;
  });
  return { anchors, closed: p.closed };
}

export function paperToSubPaths(item: paper.Item | null | undefined): SubPath[] {
  if (!item) return [];
  if (item instanceof paper.Path) return item.segments.length ? [paperPathToSubPath(item)] : [];
  if (item instanceof paper.CompoundPath) {
    return (item.children as paper.Path[]).filter((c) => c.segments.length > 0).map(paperPathToSubPath);
  }
  if (item instanceof paper.Group || item instanceof paper.Layer) {
    const out: SubPath[] = [];
    for (const c of item.children) out.push(...paperToSubPaths(c));
    return out;
  }
  return [];
}

export type BooleanOp = 'unite' | 'subtract' | 'intersect' | 'exclude' | 'divide';

export interface PathGeometry {
  subpaths: SubPath[];
  fillRule: FillRule;
}

/** Apply a boolean operation on two geometries expressed in the same coordinate space. */
export function booleanOp(op: BooleanOp, a: PathGeometry, b: PathGeometry): SubPath[] {
  ensurePaper();
  const pa = subpathsToPaper(a.subpaths, a.fillRule);
  const pb = subpathsToPaper(b.subpaths, b.fillRule);
  let result: paper.PathItem;
  const opts = { insert: false };
  switch (op) {
    case 'unite':
      result = pa.unite(pb, opts);
      break;
    case 'subtract':
      result = pa.subtract(pb, opts);
      break;
    case 'intersect':
      result = pa.intersect(pb, opts);
      break;
    case 'exclude':
      result = pa.exclude(pb, opts);
      break;
    case 'divide':
      result = pa.divide(pb, opts);
      break;
  }
  const out = paperToSubPaths(result);
  pa.remove();
  pb.remove();
  result.remove();
  return out;
}

/**
 * Divide: returns each resulting face as a separate geometry (list of subpaths).
 * Faces are computed by dividing a with b and splitting compound results into
 * individual closed paths (holes are kept with their parent when nested).
 */
export function divideToFaces(geoms: PathGeometry[]): SubPath[][] {
  ensurePaper();
  if (!geoms.length) return [];
  let acc: paper.PathItem = subpathsToPaper(geoms[0].subpaths, geoms[0].fillRule);
  for (let i = 1; i < geoms.length; i++) {
    const other = subpathsToPaper(geoms[i].subpaths, geoms[i].fillRule);
    const next = acc.divide(other, { insert: false });
    acc.remove();
    other.remove();
    acc = next;
  }
  const faces: SubPath[][] = [];
  const collect = (item: paper.Item) => {
    if (item instanceof paper.Path) {
      if (item.segments.length > 1) faces.push([paperPathToSubPath(item)]);
    } else if (item instanceof paper.CompoundPath) {
      // A compound path from divide is a face with holes
      const sps = paperToSubPaths(item);
      if (sps.length) faces.push(sps);
    } else if (item.children) {
      for (const c of item.children) collect(c);
    }
  };
  collect(acc);
  acc.remove();
  return faces;
}

/** Union of many geometries (in the same coordinate space). */
export function uniteAll(geoms: PathGeometry[]): SubPath[] {
  ensurePaper();
  if (!geoms.length) return [];
  let acc: paper.PathItem = subpathsToPaper(geoms[0].subpaths, geoms[0].fillRule);
  for (let i = 1; i < geoms.length; i++) {
    const other = subpathsToPaper(geoms[i].subpaths, geoms[i].fillRule);
    const next = acc.unite(other, { insert: false });
    acc.remove();
    other.remove();
    acc = next;
  }
  const out = paperToSubPaths(acc);
  acc.remove();
  return out;
}

/**
 * paperjs-offset measures a miter by the distance from an offset corner to the miter tip
 * (offset × tan(φ/2), φ the turning angle); Illustrator and PostScript use the miter length
 * over the line width, 1 / sin(θ/2) = 1 / cos(φ/2). Same corner is mitered iff
 * tan(φ/2) ≤ √(limit² − 1), so that is the limit paperjs-offset gets.
 */
function paperMiterLimit(limit: number | undefined, fallback: number): number {
  const l = Math.max(1, limit ?? fallback);
  return Math.sqrt(l * l - 1);
}

/**
 * Offset a path outline by `distance` (positive = outward), like Object > Path > Offset Path:
 * closed subpaths grow or shrink; an open subpath becomes the closed outline around it —
 * both sides at `distance` with flat ends (Illustrator; the sign only matters for closed ones).
 * The miter limit is Illustrator's (see paperMiterLimit); the fixture test
 * tests/e2e/offset-illustrator.spec.ts compares the outlines with Illustrator's.
 */
export function offsetPath(
  subpaths: SubPath[],
  distance: number,
  opts: { join?: 'miter' | 'round' | 'bevel'; miterLimit?: number; fillRule?: FillRule } = {},
): SubPath[] {
  ensurePaper();
  const closed = subpaths.filter((sp) => sp.closed);
  const open = subpaths.filter((sp) => !sp.closed && sp.anchors.length >= 2);
  const out: SubPath[] = [];
  if (closed.length) {
    const item = subpathsToPaper(closed, opts.fillRule ?? 'nonzero');
    try {
      const res = PaperOffset.offset(item as any, distance, {
        join: opts.join ?? 'miter',
        limit: paperMiterLimit(opts.miterLimit, 4),
        insert: false,
      });
      out.push(...paperToSubPaths(res as paper.Item));
      (res as paper.Item).remove();
    } catch {
      out.push(...closed);
    }
    item.remove();
  }
  // open subpaths: the outline around the path; Illustrator rounds the ends too when the join is round
  for (const sp of open) out.push(...strokeRegion(sp, Math.abs(distance), { join: opts.join ?? 'miter', miterLimit: opts.miterLimit ?? 4, cap: (opts.join ?? 'miter') === 'round' ? 'round' : 'butt' }));
  return out;
}

/**
 * The closed region within `halfWidth` of a subpath, as Illustrator's Offset Path of an open
 * path and Outline Stroke draw it. Both one-sided offsets (`offsetCubic`, exact at the ends)
 * are chained segment by segment: at a corner the outer side gets its join — the miter tip
 * within the limit (PostScript's 1 / sin(θ/2) ≤ limit), a straight bevel otherwise, an arc for
 * round — while the inner side is simply connected, which leaves a small loop; an open path's
 * chains are closed by the caps, a closed path's form two rings. The loops fall out of one
 * self-union under the nonzero rule (paper.js resolves the crossings), so inner corners and
 * bends tighter than the offset come out right without trimming by hand.
 */
export function strokeRegion(
  sp: SubPath,
  halfWidth: number,
  opts: { join: 'miter' | 'round' | 'bevel'; miterLimit: number; cap: 'butt' | 'round' | 'square' },
): SubPath[] {
  const d = Math.abs(halfWidth);
  const cubics = subpathToCubics(sp).filter((c) => !isLine(c) || Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y) > 1e-9);
  if (!cubics.length || d <= 0) return [];
  const n = cubics.length;
  const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
  const mk = (p: Vec, hin: Vec | null, hout: Vec | null): Anchor => anchor(p, hin && (hin.x || hin.y) ? hin : null, hout && (hout.x || hout.y) ? hout : null);
  /** anchors of a chain of cubics (handles relative), open at both ends */
  const chain = (cs: Cubic[]): Anchor[] => {
    const out: Anchor[] = [mk(cs[0].p0, null, sub(cs[0].p1, cs[0].p0))];
    cs.forEach((c, i) => out.push(mk(c.p3, sub(c.p2, c.p3), cs[i + 1] ? sub(cs[i + 1].p1, cs[i + 1].p0) : null)));
    return out;
  };
  /** arc of radius d around `centre` from `from` to `to` (the shorter way), as anchors with handles */
  const arc = (centre: Vec, from: Vec, to: Vec): Anchor[] => {
    const a0 = Math.atan2(from.y - centre.y, from.x - centre.x);
    let sweep = Math.atan2(to.y - centre.y, to.x - centre.x) - a0;
    while (sweep <= -Math.PI) sweep += 2 * Math.PI;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / steps;
    const h = (4 / 3) * Math.tan(step / 4) * d;
    const out: Anchor[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + step * i;
      const p = { x: centre.x + Math.cos(a) * d, y: centre.y + Math.sin(a) * d };
      const t = { x: -Math.sin(a) * h, y: Math.cos(a) * h };
      out.push(mk(p, i > 0 ? { x: -t.x, y: -t.y } : null, i < steps ? t : null));
    }
    return out;
  };
  /**
   * Connect the end `last` of one side chain to the start `next` of the following one at the
   * corner between cubics `a` and `b`. Returns the anchors to insert between them, or null when
   * the tangent is continuous and the two ends coincide (merge them instead).
   */
  const connect = (a: Cubic, b: Cubic, last: Anchor, next: Anchor, sign: 1 | -1): Anchor[] | null => {
    const t1 = cubicTangent(a, 1);
    const t2 = cubicTangent(b, 0);
    const turn = t1.x * t2.y - t1.y * t2.x;
    if (Math.abs(turn) < 1e-9 && t1.x * t2.x + t1.y * t2.y > 0) return null;
    // the path turns towards its left normal when turn > 0 (y down); the outer side is the other one
    const outer = sign === 1 ? turn < 0 : turn > 0;
    last.handleOut = null;
    next.handleIn = null;
    if (!outer) return [];
    const p = a.p3;
    if (opts.join === 'round') {
      const full = arc(p, last.point, next.point);
      last.handleOut = full[0].handleOut;
      next.handleIn = full[full.length - 1].handleIn;
      return full.slice(1, -1);
    }
    if (opts.join !== 'miter') return [];
    const cosTheta = -(t1.x * t2.x + t1.y * t2.y);
    const sinHalf = Math.sqrt(Math.max(0, (1 - cosTheta) / 2));
    if (sinHalf < 1e-9 || 1 / sinHalf > Math.max(1, opts.miterLimit)) return [];
    const n1 = unitVec(sub(last.point, p));
    const n2 = unitVec(sub(next.point, p));
    const bis = unitVec({ x: n1.x + n2.x, y: n1.y + n2.y });
    return [mk({ x: p.x + (bis.x * d) / sinHalf, y: p.y + (bis.y * d) / sinHalf }, null, null)];
  };
  const sideChain = (sign: 1 | -1): Anchor[] => {
    const parts = cubics.map((c) => chain(offsetCubic(c, sign * d)));
    const out: Anchor[] = [...parts[0]];
    for (let i = 1; i < n; i++) {
      const last = out[out.length - 1];
      const between = connect(cubics[i - 1], cubics[i], last, parts[i][0], sign);
      if (between === null) {
        last.handleOut = parts[i][0].handleOut;
        out.push(...parts[i].slice(1));
      } else out.push(...between, ...parts[i]);
    }
    if (sp.closed && n > 0) {
      const last = out[out.length - 1];
      const between = connect(cubics[n - 1], cubics[0], last, out[0], sign);
      if (between === null) {
        out[0].handleIn = last.handleIn;
        out.pop();
      } else out.push(...between);
    }
    return out;
  };
  const left = sideChain(1);
  const right = sideChain(-1).reverse().map((a) => mk(a.point, a.handleOut, a.handleIn));
  let outline: SubPath[];
  if (sp.closed) {
    outline = [
      { anchors: left, closed: true },
      { anchors: right, closed: true },
    ];
  } else {
    const first = cubics[0].p0;
    const last = cubics[n - 1].p3;
    const t0 = cubicTangent(cubics[0], 0);
    const t1 = cubicTangent(cubics[n - 1], 1);
    const cap = (end: Vec, out: Vec, from: Anchor, to: Anchor): Anchor[] => {
      if (opts.cap === 'round') {
        const mid = { x: end.x + out.x * d, y: end.y + out.y * d };
        const a1 = arc(end, from.point, mid);
        const a2 = arc(end, mid, to.point);
        from.handleOut = a1[0].handleOut;
        to.handleIn = a2[a2.length - 1].handleIn;
        return [...a1.slice(1, -1), mk(mid, a1[a1.length - 1].handleIn, a2[0].handleOut), ...a2.slice(1, -1)];
      }
      from.handleOut = null;
      to.handleIn = null;
      if (opts.cap === 'square') return [mk({ x: from.point.x + out.x * d, y: from.point.y + out.y * d }, null, null), mk({ x: to.point.x + out.x * d, y: to.point.y + out.y * d }, null, null)];
      return [];
    };
    const endCap = cap(last, t1, left[left.length - 1], right[0]);
    const startCap = cap(first, { x: -t0.x, y: -t0.y }, right[right.length - 1], left[0]);
    outline = [{ anchors: [...left, ...endCap, ...right, ...startCap], closed: true }];
  }
  // one self-union resolves the inner-corner loops, crossings of the two sides and the ring orientation
  const item = subpathsToPaper(outline, 'nonzero');
  try {
    const res = item.unite(item, { insert: false });
    const out = paperToSubPaths(res);
    res.remove();
    return out;
  } catch {
    return outline;
  } finally {
    item.remove();
  }
}

function unitVec(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

/** Convert a stroke into a filled outline (Outline Stroke). */
export function outlineStroke(
  subpaths: SubPath[],
  width: number,
  opts: { cap?: 'butt' | 'round' | 'square'; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number } = {},
): SubPath[] {
  ensurePaper();
  const regions = subpaths.filter((sp) => sp.anchors.length >= 2).map((sp) => strokeRegion(sp, width / 2, { cap: opts.cap ?? 'butt', join: opts.join ?? 'miter', miterLimit: opts.miterLimit ?? 10 }));
  if (regions.length === 1) return regions[0];
  // merge overlapping pieces
  return uniteAll(regions.filter((r) => r.length).map((r) => ({ subpaths: r, fillRule: 'nonzero' as const })));
}

/**
 * Simplify (fit) a path with the given tolerance (paper.js Path#simplify).
 * NOTE: paper.js compares the tolerance against *squared* distances, so a value of
 * t allows roughly sqrt(t) px of deviation (pass px*px for pixel semantics).
 */
export function simplifyPath(subpaths: SubPath[], tolerance = 2.5): SubPath[] {
  ensurePaper();
  return subpaths.map((sp) => {
    if (sp.anchors.length < 3) return sp;
    const p = subpathToPaper(sp);
    p.simplify(tolerance);
    const r = paperPathToSubPath(p);
    p.remove();
    return r;
  });
}

/** Smooth a path (paper.js Path#smooth). */
export function smoothPath(subpaths: SubPath[], type: 'asymmetric' | 'continuous' | 'catmull-rom' | 'geometric' = 'continuous'): SubPath[] {
  ensurePaper();
  return subpaths.map((sp) => {
    const p = subpathToPaper(sp);
    p.smooth({ type });
    const r = paperPathToSubPath(p);
    p.remove();
    return r;
  });
}

/** Flatten curves into straight segments. */
export function flattenPath(subpaths: SubPath[], flatness = 0.25): SubPath[] {
  ensurePaper();
  return subpaths.map((sp) => {
    const p = subpathToPaper(sp);
    p.flatten(flatness);
    const r = paperPathToSubPath(p);
    p.remove();
    return r;
  });
}

/** Fit a Bezier path through freehand points (tolerance has paper.js squared-distance semantics, see simplifyPath). */
export function fitPoints(points: Vec[], tolerance = 2.5, closed = false): SubPath | null {
  ensurePaper();
  if (points.length < 2) return null;
  const p = new paper.Path({ segments: points.map((q) => new paper.Point(q.x, q.y)), closed, insert: false });
  p.simplify(tolerance);
  const r = paperPathToSubPath(p);
  p.remove();
  return r;
}

/** Whether point p is inside the filled geometry. */
export function containsPoint(subpaths: SubPath[], fillRule: FillRule, p: Vec): boolean {
  ensurePaper();
  const item = subpathsToPaper(subpaths, fillRule);
  const r = item.contains(new paper.Point(p.x, p.y));
  item.remove();
  return r;
}

/** All self/mutual intersections between two geometries (in the same space). */
export function intersections(a: SubPath[], b: SubPath[]): Vec[] {
  ensurePaper();
  const pa = subpathsToPaper(a);
  const pb = subpathsToPaper(b);
  const locs = pa.getIntersections(pb);
  const out = locs.map((l) => ({ x: l.point.x, y: l.point.y }));
  pa.remove();
  pb.remove();
  return out;
}

/** Interpolate between two geometries with matching topology (used by Blend). */
export function interpolatePaths(from: SubPath[], to: SubPath[], t: number): SubPath[] {
  const n = Math.max(from.length, to.length);
  const out: SubPath[] = [];
  for (let i = 0; i < n; i++) {
    const a = from[Math.min(i, from.length - 1)];
    const b = to[Math.min(i, to.length - 1)];
    const [ra, rb] = matchAnchorCounts(a, b);
    const anchors = ra.anchors.map((pa, k) => {
      const pb = rb.anchors[k];
      const lerp = (u: Vec | null, v: Vec | null): Vec | null => {
        if (!u && !v) return null;
        const uu = u ?? { x: 0, y: 0 };
        const vv = v ?? { x: 0, y: 0 };
        return { x: uu.x + (vv.x - uu.x) * t, y: uu.y + (vv.y - uu.y) * t };
      };
      const res = anchor(lerp(pa.point, pb.point)!, lerp(pa.handleIn, pb.handleIn), lerp(pa.handleOut, pb.handleOut));
      if (res.handleIn && !hasHandle(res.handleIn)) res.handleIn = null;
      if (res.handleOut && !hasHandle(res.handleOut)) res.handleOut = null;
      inferAnchorKind(res);
      return res;
    });
    out.push({ anchors, closed: t < 0.5 ? a.closed : b.closed });
  }
  return out;
}

/** Equalize anchor counts by subdividing the path with fewer anchors (via paper's divideAt). */
function matchAnchorCounts(a: SubPath, b: SubPath): [SubPath, SubPath] {
  if (a.anchors.length === b.anchors.length) return [a, b];
  ensurePaper();
  const grow = (sp: SubPath, target: number): SubPath => {
    const p = subpathToPaper(sp);
    while (p.segments.length < target) {
      // split the longest curve
      let longest = p.curves[0];
      for (const c of p.curves) if (c.length > longest.length) longest = c;
      if (!longest) break;
      longest.divideAtTime(0.5);
    }
    const r = paperPathToSubPath(p);
    p.remove();
    return r;
  };
  if (a.anchors.length < b.anchors.length) return [grow(a, b.anchors.length), b];
  return [a, grow(b, a.anchors.length)];
}

/** Area of a geometry (absolute, in square units). */
export function pathArea(subpaths: SubPath[], fillRule: FillRule = 'nonzero'): number {
  ensurePaper();
  const item = subpathsToPaper(subpaths, fillRule);
  const a = Math.abs(item.area);
  item.remove();
  return a;
}

/** Reorient sub paths so that outer contours are clockwise and holes counter-clockwise. */
export function reorient(subpaths: SubPath[], fillRule: FillRule = 'nonzero'): SubPath[] {
  ensurePaper();
  const item = subpathsToPaper(subpaths, fillRule);
  const res = item.reorient(true, true);
  const out = paperToSubPaths(res);
  if (res !== item) res.remove();
  item.remove();
  return out;
}
