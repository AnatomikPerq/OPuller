/**
 * Perspective operations on the document (pure, immer-draft friendly): attach
 * objects to a grid plane as a live free-distort effect, move them along the
 * plane, release (bake) or remove the perspective again.
 *
 * An attached node carries `data.perspective = { plane, rect }` where `rect` is
 * the flat rectangle (world units, see grid.ts) that is projected onto the
 * plane; the projection itself is a `freeDistort` effect whose corners are
 * recomputed from the flat rectangle whenever it moves.
 */
import type { Document, ID, Rect, Vec, PerspectiveGrid, PerspectiveAttachment, PerspectivePlane, FreeDistortEffect, Node } from '@/model/types';
import { localBounds, worldMatrix } from '@/model/document';
import { applyGeometryEffects } from '@/canvas/effectiveGeometry';
import { pathBounds } from '@/geometry/path';
import { applyToPoint, invert } from '@/geometry/matrix';
import { squareToQuad, applyHomography } from '@/distort/envelope';
import { projectRect } from './grid';

export const ATTACH_KEY = 'perspective';

export function attachmentOf(doc: Document, id: ID): PerspectiveAttachment | null {
  const n = doc.nodes[id];
  const a = n?.data?.[ATTACH_KEY] as PerspectiveAttachment | undefined;
  return a && typeof a === 'object' && a.rect && (a.plane === 'left' || a.plane === 'right' || a.plane === 'floor') ? a : null;
}

export function isAttached(doc: Document, id: ID): boolean {
  return !!attachmentOf(doc, id);
}

/** Nodes that can carry the perspective effect: paths and groups (text needs outlines first, images cannot be warped). */
export function canAttach(n: Node | undefined): boolean {
  return !!n && (n.type === 'path' || n.type === 'group');
}

/** Bounds (local space) of the geometry the free-distort effect is measured in. */
function baseFrame(doc: Document, n: Node): Rect | null {
  if (n.type === 'path') {
    const others = n.effects.filter((e) => e.type !== 'freeDistort');
    return pathBounds(applyGeometryEffects(n.subpaths, others, null));
  }
  return localBounds(doc, n.id);
}

function frameCorners(f: Rect): [Vec, Vec, Vec, Vec] {
  return [
    { x: f.x, y: f.y },
    { x: f.x + f.width, y: f.y },
    { x: f.x + f.width, y: f.y + f.height },
    { x: f.x, y: f.y + f.height },
  ];
}

function bbox(pts: Vec[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1e-6), height: Math.max(maxY - minY, 1e-6) };
}

/** Flat rectangle a node would get when attached now: the world bounds of its base geometry. */
export function flatRectOf(doc: Document, id: ID): Rect | null {
  const n = doc.nodes[id];
  if (!n || !canAttach(n)) return null;
  const f = baseFrame(doc, n);
  if (!f) return null;
  const wm = worldMatrix(doc, id);
  return bbox(frameCorners(f).map((c) => applyToPoint(wm, c)));
}

/**
 * Attach a node to a plane: its flat rectangle (given, remembered from an earlier
 * attachment, or its current world bounds) is projected onto the plane and the
 * node gets a free-distort effect that maps its geometry there.
 */
export function attachToPlane(doc: Document, id: ID, grid: PerspectiveGrid, plane: PerspectivePlane, flatRect?: Rect): boolean {
  const n = doc.nodes[id];
  if (!n || !canAttach(n)) return false;
  const existing = attachmentOf(doc, id);
  const f = baseFrame(doc, n);
  if (!f) return false;
  const wm = worldMatrix(doc, id);
  const inv = invert(wm);
  const worldCorners = frameCorners(f).map((c) => applyToPoint(wm, c));
  // the base geometry's world box is what the flat rectangle stands for
  const base = bbox(worldCorners);
  const flat = flatRect ?? existing?.rect ?? base;
  const H = squareToQuad(projectRect(grid, plane, flat));
  const fw = Math.max(f.width, 1e-6);
  const fh = Math.max(f.height, 1e-6);
  const corners = worldCorners.map((w) => {
    const u = (w.x - base.x) / base.width;
    const v = (w.y - base.y) / base.height;
    const q = applyHomography(H, u, v);
    const l = applyToPoint(inv, q);
    return { x: (l.x - f.x) / fw, y: (l.y - f.y) / fh };
  }) as FreeDistortEffect['corners'];
  if (corners.some((c) => !Number.isFinite(c.x) || !Number.isFinite(c.y))) return false;
  const effect: FreeDistortEffect = { type: 'freeDistort', enabled: true, corners };
  n.effects = [...n.effects.filter((e) => e.type !== 'freeDistort'), effect];
  n.data = { ...(n.data ?? {}), [ATTACH_KEY]: { plane, rect: { ...flat } } satisfies PerspectiveAttachment };
  return true;
}

/** Move an attached node by a flat offset (world units along the plane). */
export function moveAttached(doc: Document, id: ID, grid: PerspectiveGrid, dx: number, dy: number): boolean {
  const a = attachmentOf(doc, id);
  if (!a) return false;
  return attachToPlane(doc, id, grid, a.plane, { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy });
}

/** Drop the perspective: the node returns to its flat geometry. */
export function removePerspective(doc: Document, id: ID): boolean {
  const n = doc.nodes[id];
  if (!n || !attachmentOf(doc, id)) return false;
  n.effects = n.effects.filter((e) => e.type !== 'freeDistort');
  const data = { ...(n.data ?? {}) };
  delete data[ATTACH_KEY];
  n.data = Object.keys(data).length ? data : undefined;
  return true;
}

/** Forget the attachment but keep the geometry as it looks (the caller bakes the effect). */
export function forgetAttachment(doc: Document, id: ID): void {
  const n = doc.nodes[id];
  if (!n || !n.data) return;
  const data = { ...n.data };
  delete data[ATTACH_KEY];
  n.data = Object.keys(data).length ? data : undefined;
}

export function attachedNodes(doc: Document, ids?: ID[]): ID[] {
  const list = ids ?? Object.keys(doc.nodes);
  return list.filter((id) => isAttached(doc, id));
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
