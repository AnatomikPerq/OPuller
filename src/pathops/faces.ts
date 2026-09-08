/**
 * Shape Builder engine: planar faces of a set of paths (world space), hit
 * testing of faces, and applying a merge / delete operation while rebuilding
 * the untouched parts of every involved source object.
 */
import type { Document, ID, SubPath, Vec, Rect, Paint, StrokeStyle } from '@/model/types';
import { indexInParent, removeNode, addNode, setWorldSubPaths, getChildren } from '@/model/document';
import { makePath } from '@/model/nodes';
import { pathBounds, pointInPath, flattenSubPath } from '@/geometry/path';
import { rectContainsPoint } from '@/geometry/vec';
import { type PathGeom, worldGeom, filledGeometry, planarFaces, interiorPoint, geomAt, faceArea, safeUnion, safeBoolean, isEmptyGeometry, rectsOverlap } from './geometry';
import { removeEmptyGroups, slotAbove } from './apply';

export interface Face {
  index: number;
  /** world-space contours (outer + holes) */
  subpaths: SubPath[];
  /** original path that paints this region (top-most containing it) */
  source: ID;
  interior: Vec;
  bounds: Rect;
  area: number;
  /** flattened contours (lazy cache for hit testing) */
  polys?: Vec[][];
}

function facePolys(f: Face): Vec[][] {
  if (!f.polys) f.polys = f.subpaths.map((sp) => flattenSubPath({ ...sp, closed: true }, 0.35));
  return f.polys;
}

/** Even-odd point-in-face test on the cached flattened contours. */
export function pointInFace(f: Face, p: Vec): boolean {
  if (!rectContainsPoint(f.bounds, p)) return false;
  let inside = false;
  for (const poly of facePolys(f)) {
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

export interface FaceSet {
  /** ids of the paths that took part, paint order */
  ids: ID[];
  geoms: PathGeom[];
  faces: Face[];
}

/** Minimum face area (world units²) — smaller slivers are ignored. */
export const FACE_MIN_AREA = 0.5;

export function computeFaceSet(doc: Document, ids: ID[]): FaceSet {
  const geoms: PathGeom[] = [];
  for (const id of ids) {
    const g = worldGeom(doc, id);
    if (g) geoms.push(g);
  }
  const faces: Face[] = [];
  if (geoms.length >= 2) {
    for (const sps of planarFaces(geoms.map(filledGeometry), FACE_MIN_AREA)) {
      const bounds = pathBounds(sps);
      if (!bounds) continue;
      const interior = interiorPoint(sps, 'evenodd');
      const src = geomAt(geoms, interior) ?? geoms[geoms.length - 1];
      faces.push({ index: faces.length, subpaths: sps, source: src.id, interior, bounds, area: faceArea(sps) });
    }
  }
  return { ids: geoms.map((g) => g.id), geoms, faces };
}

/** The face containing a world point (smallest one when several claim it). */
export function faceAt(set: FaceSet, p: Vec): Face | null {
  let best: Face | null = null;
  for (const f of set.faces) {
    if (!pointInFace(f, p)) continue;
    if (!best || f.area < best.area) best = f;
  }
  return best;
}

/** Faces crossed by the segment a→b (sampled every `step` world units). */
export function facesAlong(set: FaceSet, a: Vec, b: Vec, step: number): number[] {
  const out: number[] = [];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / Math.max(step, 1e-3)));
  let last = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const f = faceAt(set, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (f && f.index !== last) {
      out.push(f.index);
      last = f.index;
    }
  }
  return out;
}

/** Faces touched by a marquee rectangle (world). */
export function facesInRect(set: FaceSet, r: Rect): number[] {
  const out: number[] = [];
  const corners: Vec[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x, y: r.y + r.height },
    { x: r.x + r.width, y: r.y + r.height },
  ];
  for (const f of set.faces) {
    if (!rectsOverlap(f.bounds, r)) continue;
    let hit = rectContainsPoint(r, f.interior);
    if (!hit) hit = corners.some((c) => pointInFace(f, c));
    if (!hit) {
      outer: for (const poly of facePolys(f)) {
        for (const p of poly) {
          if (rectContainsPoint(r, p)) {
            hit = true;
            break outer;
          }
        }
      }
    }
    if (hit) out.push(f.index);
  }
  return out;
}

export interface ShapeBuilderPlan {
  mode: 'merge' | 'delete';
  faces: number[];
  /** appearance of the merged shape */
  fill: Paint;
  stroke: StrokeStyle;
}

export interface ShapeBuilderResult {
  created: ID[];
  removed: ID[];
  modified: ID[];
}

/**
 * Apply a Shape Builder operation to the document draft. The selected regions
 * are removed from every object that covers them (each involved object keeps
 * "itself minus the regions", so hidden parts of untouched objects survive);
 * merged regions become one new path placed above the top-most involved object.
 */
export function applyShapeBuilder(draft: Document, set: FaceSet, plan: ShapeBuilderPlan): ShapeBuilderResult {
  const res: ShapeBuilderResult = { created: [], removed: [], modified: [] };
  const sel = new Set(plan.faces);
  if (!sel.size) return res;
  const selected = set.faces.filter((f) => sel.has(f.index));
  if (!selected.length) return res;
  const union = safeUnion(selected.map((f) => ({ subpaths: f.subpaths, fillRule: 'evenodd' as const })));
  if (isEmptyGeometry(union, FACE_MIN_AREA)) return res;
  const unionGeom = { subpaths: union, fillRule: 'nonzero' as const };
  const unionBounds = pathBounds(union);
  // which objects cover the selected regions
  const involved: PathGeom[] = [];
  for (const g of set.geoms) {
    if (!draft.nodes[g.id]) continue;
    if (!rectsOverlap(pathBounds(g.subpaths), unionBounds)) continue;
    const inter = safeBoolean('intersect', filledGeometry(g), unionGeom);
    if (!isEmptyGeometry(inter, FACE_MIN_AREA)) involved.push(g);
  }
  // insertion slot: above the top-most involved object
  let slotParent: ID | null = null;
  let siblingsBefore: ID[] = [];
  const topInvolved = involved[involved.length - 1];
  if (topInvolved) {
    slotParent = draft.nodes[topInvolved.id].parent;
    const idx = indexInParent(draft, topInvolved.id);
    siblingsBefore = getChildren(draft, slotParent).slice(0, idx + 1);
  }
  const formerParents: ID[] = [];
  for (const g of involved) {
    const n = draft.nodes[g.id];
    if (!n || n.type !== 'path') continue;
    const rest = safeBoolean('subtract', filledGeometry(g), unionGeom);
    if (isEmptyGeometry(rest, FACE_MIN_AREA)) {
      if (n.parent) formerParents.push(n.parent);
      removeNode(draft, g.id);
      res.removed.push(g.id);
    } else {
      setWorldSubPaths(draft, g.id, rest);
      n.fillRule = 'nonzero';
      res.modified.push(g.id);
    }
  }
  if (plan.mode === 'merge') {
    if (slotParent === null || draft.nodes[slotParent]) {
      const node = makePath([], { fill: plan.fill, stroke: plan.stroke, fillRule: 'nonzero', name: 'Path' });
      const at = slotAbove(draft, slotParent, siblingsBefore);
      addNode(draft, node, slotParent, at);
      setWorldSubPaths(draft, node.id, union);
      res.created.push(node.id);
    }
  }
  removeEmptyGroups(draft, formerParents);
  return res;
}
