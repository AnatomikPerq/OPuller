/**
 * Bridge between OPuller's path model and paper.js, which we use as a geometry
 * kernel for boolean operations, offsetting, simplification and robust queries.
 *
 * paper.js runs headless (a hidden 1x1 canvas). Items are created with
 * `insert: false` so they never touch the project's scene graph.
 */
import paper from 'paper';
import { PaperOffset } from 'paperjs-offset';
import type { SubPath, Vec, FillRule, Matrix } from '@/model/types';
import { anchor, hasHandle, inferAnchorKind } from './path';

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

/** Offset a path outline by `distance` (positive = outward). */
export function offsetPath(
  subpaths: SubPath[],
  distance: number,
  opts: { join?: 'miter' | 'round' | 'bevel'; miterLimit?: number; fillRule?: FillRule } = {},
): SubPath[] {
  ensurePaper();
  const item = subpathsToPaper(subpaths, opts.fillRule ?? 'nonzero');
  try {
    const res = PaperOffset.offset(item as any, distance, {
      join: opts.join ?? 'miter',
      limit: opts.miterLimit ?? 10,
      insert: false,
    });
    const out = paperToSubPaths(res as paper.Item);
    (res as paper.Item).remove();
    item.remove();
    return out;
  } catch {
    item.remove();
    return subpaths;
  }
}

/** Convert a stroke into a filled outline (Outline Stroke). */
export function outlineStroke(
  subpaths: SubPath[],
  width: number,
  opts: { cap?: 'butt' | 'round' | 'square'; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number } = {},
): SubPath[] {
  ensurePaper();
  const out: SubPath[] = [];
  for (const sp of subpaths) {
    const item = subpathToPaper(sp);
    try {
      const res = PaperOffset.offsetStroke(item as any, width / 2, {
        cap: opts.cap === 'round' ? 'round' : 'butt',
        join: opts.join ?? 'miter',
        limit: opts.miterLimit ?? 10,
        insert: false,
      });
      out.push(...paperToSubPaths(res as paper.Item));
      (res as paper.Item).remove();
    } catch {
      /* ignore failed segment */
    }
    item.remove();
  }
  if (out.length > 1) {
    // merge overlapping pieces
    return uniteAll([{ subpaths: out, fillRule: 'nonzero' }]);
  }
  return out;
}

/** Simplify (fit) a path with the given tolerance (paper.js Path#simplify). */
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

/** Fit a Bezier path through freehand points. */
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
