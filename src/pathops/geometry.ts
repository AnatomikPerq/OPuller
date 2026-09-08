/**
 * World-space geometry helpers shared by the pathfinder, the Shape Builder and
 * the Object > Path commands. Everything here works on plain SubPath lists in
 * one coordinate space (world) and stays free of store access.
 */
import type { Document, ID, SubPath, FillRule, PathNode, Vec, Rect, Paint } from '@/model/types';
import { worldSubPaths, worldMatrix } from '@/model/document';
import { pathBounds, flattenSubPath, pointInPath, subpathArea, segmentCount, pointAt } from '@/geometry/path';
import { scaleFactor } from '@/geometry/matrix';
import { booleanOp, uniteAll } from '@/geometry/paperBridge';

/** A path node's geometry expressed in world space. */
export interface PathGeom {
  id: ID;
  /** world-space subpaths (only those with at least 2 anchors) */
  subpaths: SubPath[];
  fillRule: FillRule;
  node: PathNode;
  /** uniform scale of the node's world matrix (stroke widths → world units) */
  scale: number;
}

export interface Geometry {
  subpaths: SubPath[];
  fillRule: FillRule;
}

export const MIN_AREA = 0.05;

export function worldGeom(doc: Document, id: ID): PathGeom | null {
  const node = doc.nodes[id];
  if (!node || node.type !== 'path') return null;
  const subpaths = worldSubPaths(doc, id).filter((sp) => sp.anchors.length >= 2);
  if (!subpaths.length) return null;
  return { id, subpaths, fillRule: node.fillRule, node, scale: scaleFactor(worldMatrix(doc, id)) || 1 };
}

/** Treat every subpath as closed (pathfinder semantics for open paths). */
export function closeAll(subpaths: SubPath[]): SubPath[] {
  return subpaths.map((sp) => (sp.closed ? sp : { ...sp, closed: true }));
}

/** Filled geometry of a PathGeom (closed, ready for booleans). */
export function filledGeometry(g: PathGeom | Geometry): Geometry {
  return { subpaths: closeAll(g.subpaths), fillRule: g.fillRule };
}

/** Sum of the absolute areas of the subpaths (islands + holes counted positively). */
export function absArea(subpaths: SubPath[]): number {
  let a = 0;
  for (const sp of subpaths) a += Math.abs(subpathArea(sp));
  return a;
}

/**
 * Area of a face-like geometry: contours are grouped into islands (outer
 * contour + holes) and holes are subtracted from their outer contour.
 */
export function faceArea(subpaths: SubPath[]): number {
  let total = 0;
  for (const island of islands(subpaths)) {
    const outer = Math.abs(subpathArea(island[0]));
    let holes = 0;
    for (let i = 1; i < island.length; i++) holes += Math.abs(subpathArea(island[i]));
    total += Math.max(0, outer - holes);
  }
  return total;
}

export function isEmptyGeometry(subpaths: SubPath[] | null | undefined, minArea = MIN_AREA): boolean {
  if (!subpaths || !subpaths.length) return true;
  const b = pathBounds(subpaths);
  if (!b) return true;
  if (b.width < 1e-6 && b.height < 1e-6) return true;
  return faceArea(subpaths) < minArea;
}

function probePoint(sp: SubPath): Vec {
  return segmentCount(sp) ? pointAt(sp, 0, 0.5) : sp.anchors[0].point;
}

/**
 * Group contours into islands: each group starts with an outer contour and is
 * followed by the holes directly inside it (nesting decided by containment).
 * Contours are assumed not to cross each other (boolean results).
 */
export function islands(subpaths: SubPath[]): SubPath[][] {
  const sps = subpaths.filter((sp) => sp.anchors.length >= 2);
  if (sps.length <= 1) return sps.length ? [sps] : [];
  const areas = sps.map((sp) => Math.abs(subpathArea(sp)));
  const probes = sps.map(probePoint);
  const depth = sps.map((sp, i) => {
    let d = 0;
    sps.forEach((other, j) => {
      if (i !== j && areas[j] > areas[i] * 0.999 && pointInPath([other], probes[i], 'nonzero')) d++;
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
    let best = -1;
    sps.forEach((other, j) => {
      if (depth[j] !== depth[i] - 1 || !groupOf.has(j)) return;
      if (!pointInPath([other], probes[i], 'nonzero')) return;
      if (best < 0 || areas[j] < areas[best]) best = j;
    });
    if (best >= 0) groupOf.get(best)!.push(sp);
    else groups.push([sp]);
  });
  return groups;
}

/** Split a geometry into independent pieces (islands with their holes), dropping slivers. */
export function splitIslands(subpaths: SubPath[], minArea = MIN_AREA): SubPath[][] {
  return islands(subpaths).filter((g) => !isEmptyGeometry(g, minArea));
}

/** Polygon centroid (area weighted) of a flattened subpath. */
function polygonCentroid(pts: Vec[]): { c: Vec; area: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { c: { x: sx / Math.max(1, n), y: sy / Math.max(1, n) }, area: 0 };
  }
  return { c: { x: cx / (3 * a), y: cy / (3 * a) }, area: a / 2 };
}

/**
 * A point guaranteed (as far as numerics allow) to lie inside the filled area
 * of the geometry: the centroid when it is inside, otherwise the midpoint of
 * the widest interior span found on a few horizontal scanlines.
 */
export function interiorPoint(subpaths: SubPath[], fillRule: FillRule = 'evenodd'): Vec {
  const polys = subpaths.filter((sp) => sp.anchors.length >= 2).map((sp) => flattenSubPath({ ...sp, closed: true }, 0.5));
  if (!polys.length) return { x: 0, y: 0 };
  // centroid of the largest contour
  let best = polys[0];
  let bestArea = -1;
  for (const p of polys) {
    const a = Math.abs(polygonCentroid(p).area);
    if (a > bestArea) {
      bestArea = a;
      best = p;
    }
  }
  const c = polygonCentroid(best).c;
  if (pointInPath(subpaths, c, fillRule)) return c;
  const b = pathBounds(subpaths);
  if (!b) return c;
  const fractions = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9, 0.05, 0.95, 0.42, 0.58, 0.27, 0.73];
  let bestSpan = 0;
  let bestPoint: Vec | null = null;
  for (const f of fractions) {
    const y = b.y + b.height * f;
    const xs: number[] = [];
    for (const poly of polys) {
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % n];
        if (p.y === q.y) continue;
        if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) {
          const t = (y - p.y) / (q.y - p.y);
          xs.push(p.x + (q.x - p.x) * t);
        }
      }
    }
    xs.sort((a, b2) => a - b2);
    for (let i = 0; i + 1 < xs.length; i++) {
      const mid = { x: (xs[i] + xs[i + 1]) / 2, y };
      const span = xs[i + 1] - xs[i];
      if (span > bestSpan && span > 1e-6 && pointInPath(subpaths, mid, fillRule)) {
        bestSpan = span;
        bestPoint = mid;
      }
    }
    if (bestPoint && bestSpan > Math.min(b.width, b.height) * 0.1) break;
  }
  return bestPoint ?? c;
}

/** Whether the filled area of the geom contains the world point. */
export function geomContains(g: PathGeom | Geometry, p: Vec): boolean {
  return pointInPath(closeAll(g.subpaths), p, g.fillRule);
}

/**
 * The geom that paints the given point: the top-most one whose fill contains
 * it, preferring geoms with a visible fill. Falls back to the top-most geom.
 */
export function geomAt(geoms: PathGeom[], p: Vec): PathGeom | null {
  if (!geoms.length) return null;
  let unfilled: PathGeom | null = null;
  for (let i = geoms.length - 1; i >= 0; i--) {
    const g = geoms[i];
    if (!geomContains(g, p)) continue;
    if (g.node.fill.type !== 'none') return g;
    if (!unfilled) unfilled = g;
  }
  return unfilled;
}

export function samePaint(a: Paint, b: Paint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function rectsOverlap(a: Rect | null, b: Rect | null, pad = 0): boolean {
  if (!a || !b) return false;
  return a.x - pad <= b.x + b.width && b.x <= a.x + a.width + pad && a.y - pad <= b.y + b.height && b.y <= a.y + a.height + pad;
}

// ---------------------------------------------------------------------------
// Boolean wrappers (safe: never throw, empty results filtered)
// ---------------------------------------------------------------------------

export function safeBoolean(op: 'unite' | 'subtract' | 'intersect' | 'exclude', a: Geometry, b: Geometry): SubPath[] {
  try {
    return booleanOp(op, a, b).filter((sp) => sp.anchors.length >= 2);
  } catch {
    return [];
  }
}

export function safeUnion(geoms: Geometry[]): SubPath[] {
  const list = geoms.filter((g) => g.subpaths.length);
  if (!list.length) return [];
  try {
    return uniteAll(list).filter((sp) => sp.anchors.length >= 2);
  } catch {
    return [];
  }
}

/** Union of geoms as a geometry usable in further booleans. */
export function unionGeometry(geoms: Geometry[]): Geometry {
  return { subpaths: safeUnion(geoms), fillRule: 'nonzero' };
}

/**
 * Planar partition of a set of filled geometries: every region of the plane
 * covered by at least one geometry becomes exactly one face (an island with
 * its holes). Faces are returned as world-space subpath lists.
 */
export function planarFaces(geoms: Geometry[], minArea = MIN_AREA): SubPath[][] {
  let faces: SubPath[][] = [];
  const covered: Geometry[] = [];
  for (const raw of geoms) {
    const g = { subpaths: closeAll(raw.subpaths), fillRule: raw.fillRule };
    if (isEmptyGeometry(g.subpaths, minArea)) continue;
    const next: SubPath[][] = [];
    for (const face of faces) {
      const fg: Geometry = { subpaths: face, fillRule: 'evenodd' };
      const inside = safeBoolean('intersect', fg, g);
      const outside = safeBoolean('subtract', fg, g);
      const inParts = splitIslands(inside, minArea);
      const outParts = splitIslands(outside, minArea);
      if (!inParts.length && !outParts.length) {
        // numerical failure: keep the face untouched
        next.push(face);
        continue;
      }
      next.push(...outParts, ...inParts);
    }
    // the part of g not covered by anything so far
    const fresh = covered.length ? safeBoolean('subtract', g, unionGeometry(covered)) : g.subpaths;
    next.push(...splitIslands(fresh, minArea));
    faces = next;
    covered.push(g);
  }
  return faces;
}
