/**
 * Anchor-level editing helpers shared by the Direct Selection, Pen, Anchor
 * Point, Curvature and Lasso tools.
 *
 * All positions passed in/out of these functions are in WORLD space; the
 * helpers convert through the node's world matrix so that paths inside
 * transformed groups (or paths that still carry a transform) are edited in
 * place. Mutating functions expect an immer draft of the document and always
 * clear the node's live shape (`shape`) because anchors were edited by hand.
 */
import type { Document, ID, AnchorRef, HandleRef, Vec, PathNode, SubPath, Anchor, Rect } from '@/model/types';
import { worldMatrix, removeNode, collectPaths, selectableNodes, descendants } from '@/model/document';
import { invert, applyToPoint, applyToVector } from '@/geometry/matrix';
import { add, sub, mul, len, normalize, dist, rectContainsPoint, rectFromPointList } from '@/geometry/vec';
import { hasHandle, insertAnchorAt, removeAnchor, makeSmooth, makeCorner, transformSubPath, nearestPointOnPath, cloneAnchor } from '@/geometry/path';

// ---------------------------------------------------------------------------
// Keys / lookups
// ---------------------------------------------------------------------------

export const anchorKey = (r: AnchorRef): string => `${r.nodeId}/${r.subpath}/${r.index}`;

export function sameAnchor(a: AnchorRef | null | undefined, b: AnchorRef | null | undefined): boolean {
  return !!a && !!b && a.nodeId === b.nodeId && a.subpath === b.subpath && a.index === b.index;
}

export function anchorSet(refs: AnchorRef[]): Set<string> {
  return new Set(refs.map(anchorKey));
}

export function dedupeRefs(refs: AnchorRef[]): AnchorRef[] {
  const seen = new Set<string>();
  const out: AnchorRef[] = [];
  for (const r of refs) {
    const k = anchorKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ nodeId: r.nodeId, subpath: r.subpath, index: r.index });
  }
  return out;
}

export function getPathNode(doc: Document, id: ID | null | undefined): PathNode | undefined {
  const n = id ? doc.nodes[id] : undefined;
  return n && n.type === 'path' ? n : undefined;
}

export function getAnchor(doc: Document, ref: AnchorRef): Anchor | undefined {
  return getPathNode(doc, ref.nodeId)?.subpaths[ref.subpath]?.anchors[ref.index];
}

export function getSubPath(doc: Document, ref: { nodeId: ID; subpath: number }): SubPath | undefined {
  return getPathNode(doc, ref.nodeId)?.subpaths[ref.subpath];
}

/** Drop refs that no longer point at an existing anchor. */
export function validAnchors(doc: Document, refs: AnchorRef[]): AnchorRef[] {
  return refs.filter((r) => !!getAnchor(doc, r));
}

/** World position of an anchor. */
export function anchorWorldPoint(doc: Document, ref: AnchorRef): Vec | null {
  const a = getAnchor(doc, ref);
  if (!a) return null;
  return applyToPoint(worldMatrix(doc, ref.nodeId), a.point);
}

/** World position of a handle end (null when the handle does not exist). */
export function handleWorldPoint(doc: Document, ref: HandleRef): Vec | null {
  const a = getAnchor(doc, ref);
  if (!a) return null;
  const h = ref.side === 'in' ? a.handleIn : a.handleOut;
  if (!hasHandle(h)) return null;
  return applyToPoint(worldMatrix(doc, ref.nodeId), add(a.point, h));
}

/** All anchors of the given path nodes (descending into groups). */
export function allAnchorRefs(doc: Document, ids: ID[]): AnchorRef[] {
  const out: AnchorRef[] = [];
  for (const id of collectPaths(doc, ids)) {
    const n = getPathNode(doc, id);
    if (!n) continue;
    n.subpaths.forEach((sp, si) => sp.anchors.forEach((_, ai) => out.push({ nodeId: id, subpath: si, index: ai })));
  }
  return out;
}

/** Path ids the anchor editing tools operate on for a selection (leaf paths). */
export function editablePathIds(doc: Document, selection: ID[]): ID[] {
  return collectPaths(doc, selection).filter((id) => {
    const n = doc.nodes[id];
    return !!n && n.visible && !n.locked;
  });
}

/** Paths that can be edited anywhere in the document (honours isolation, locks, visibility). */
export function allEditablePathIds(doc: Document, isolation: ID | null): ID[] {
  if (isolation && doc.nodes[isolation]) {
    return descendants(doc, isolation).filter((id) => {
      const n = doc.nodes[id];
      return !!n && n.type === 'path' && n.visible && !n.locked;
    });
  }
  return selectableNodes(doc, true).filter((id) => doc.nodes[id]?.type === 'path');
}

/** Is the anchor an end of an open subpath? */
export function isEndAnchor(doc: Document, ref: AnchorRef): { first: boolean; last: boolean } {
  const sp = getSubPath(doc, ref);
  if (!sp || sp.closed) return { first: false, last: false };
  return { first: ref.index === 0, last: ref.index === sp.anchors.length - 1 };
}

// ---------------------------------------------------------------------------
// Geometry queries (world space)
// ---------------------------------------------------------------------------

export function anchorsInRect(doc: Document, ids: ID[], rect: Rect): AnchorRef[] {
  const out: AnchorRef[] = [];
  for (const id of ids) {
    const n = getPathNode(doc, id);
    if (!n) continue;
    const wm = worldMatrix(doc, id);
    n.subpaths.forEach((sp, si) =>
      sp.anchors.forEach((a, ai) => {
        if (rectContainsPoint(rect, applyToPoint(wm, a.point))) out.push({ nodeId: id, subpath: si, index: ai });
      }),
    );
  }
  return out;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function anchorsInPolygon(doc: Document, ids: ID[], poly: Vec[]): AnchorRef[] {
  const out: AnchorRef[] = [];
  if (poly.length < 3) return out;
  const bb = rectFromPointList(poly)!;
  for (const id of ids) {
    const n = getPathNode(doc, id);
    if (!n) continue;
    const wm = worldMatrix(doc, id);
    n.subpaths.forEach((sp, si) =>
      sp.anchors.forEach((a, ai) => {
        const p = applyToPoint(wm, a.point);
        if (rectContainsPoint(bb, p) && pointInPolygon(p, poly)) out.push({ nodeId: id, subpath: si, index: ai });
      }),
    );
  }
  return out;
}

/** World bounds of a set of anchors (points only). */
export function anchorsBounds(doc: Document, refs: AnchorRef[]): Rect | null {
  const pts: Vec[] = [];
  for (const r of refs) {
    const p = anchorWorldPoint(doc, r);
    if (p) pts.push(p);
  }
  return rectFromPointList(pts);
}

/** Nodes whose anchors are ALL contained in `refs`. */
export function fullySelectedNodes(doc: Document, refs: AnchorRef[]): ID[] {
  const set = anchorSet(refs);
  const ids = Array.from(new Set(refs.map((r) => r.nodeId)));
  return ids.filter((id) => {
    const n = getPathNode(doc, id);
    if (!n) return false;
    return n.subpaths.every((sp, si) => sp.anchors.every((_, ai) => set.has(`${id}/${si}/${ai}`)));
  });
}

// ---------------------------------------------------------------------------
// Mutations (immer drafts)
// ---------------------------------------------------------------------------

/** Mark a path as hand-edited: live shape parameters no longer apply. */
export function touchPath(n: PathNode): void {
  if (n.shape) n.shape = undefined;
}

/** Translate anchors by a world-space delta. */
export function translateAnchorsWorld(draft: Document, refs: AnchorRef[], delta: Vec): void {
  const byNode = new Map<ID, AnchorRef[]>();
  for (const r of refs) {
    if (!byNode.has(r.nodeId)) byNode.set(r.nodeId, []);
    byNode.get(r.nodeId)!.push(r);
  }
  for (const [id, list] of byNode) {
    const n = getPathNode(draft, id);
    if (!n) continue;
    const local = applyToVector(invert(worldMatrix(draft, id)), delta);
    const seen = new Set<string>();
    for (const r of list) {
      const k = anchorKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      const a = n.subpaths[r.subpath]?.anchors[r.index];
      if (!a) continue;
      a.point = add(a.point, local);
    }
    touchPath(n);
  }
}

/** Move a single anchor to a world position (handles travel with it). */
export function setAnchorWorld(draft: Document, ref: AnchorRef, world: Vec): void {
  const n = getPathNode(draft, ref.nodeId);
  const a = n?.subpaths[ref.subpath]?.anchors[ref.index];
  if (!n || !a) return;
  a.point = applyToPoint(invert(worldMatrix(draft, ref.nodeId)), world);
  touchPath(n);
}

export interface SetHandleOptions {
  /** Alt-drag: move only this handle and turn the anchor into a corner */
  breakPair?: boolean;
  /** when the anchor is smooth keep the opposite handle collinear (default true) */
  keepSmooth?: boolean;
  /** force symmetric handles (opposite handle mirrors this one) */
  symmetric?: boolean;
}

/**
 * Move a handle end to a world position. Smooth anchors keep the opposite
 * handle collinear (its length is preserved) unless the pair is broken.
 */
export function setHandleWorld(draft: Document, ref: HandleRef, world: Vec, opts: SetHandleOptions = {}): void {
  const n = getPathNode(draft, ref.nodeId);
  const a = n?.subpaths[ref.subpath]?.anchors[ref.index];
  if (!n || !a) return;
  const inv = invert(worldMatrix(draft, ref.nodeId));
  const local = applyToPoint(inv, world);
  const vec = sub(local, a.point);
  const tiny = len(vec) < 1e-6;
  const setSide = (side: 'in' | 'out', v: Vec | null) => {
    if (side === 'in') a.handleIn = v;
    else a.handleOut = v;
  };
  const other: 'in' | 'out' = ref.side === 'in' ? 'out' : 'in';
  setSide(ref.side, tiny ? null : vec);
  if (opts.breakPair) {
    a.kind = 'corner';
  } else if (opts.symmetric) {
    setSide(other, tiny ? null : mul(vec, -1));
    a.kind = tiny ? 'corner' : 'smooth';
  } else if ((opts.keepSmooth ?? true) && a.kind === 'smooth' && !tiny) {
    const oh = other === 'in' ? a.handleIn : a.handleOut;
    if (hasHandle(oh)) setSide(other, mul(normalize(vec), -len(oh)));
  }
  touchPath(n);
}

/** Remove a handle (retract it into the anchor). */
export function retractHandle(draft: Document, ref: HandleRef): void {
  const n = getPathNode(draft, ref.nodeId);
  const a = n?.subpaths[ref.subpath]?.anchors[ref.index];
  if (!n || !a) return;
  if (ref.side === 'in') a.handleIn = null;
  else a.handleOut = null;
  if (a.kind === 'smooth' && !(hasHandle(a.handleIn) && hasHandle(a.handleOut))) a.kind = 'corner';
  touchPath(n);
}

/**
 * Convert an anchor to smooth (tangent handles computed in world space so the
 * result is correct inside transformed groups) or to a plain corner.
 */
export function convertAnchor(draft: Document, ref: AnchorRef, kind: 'smooth' | 'corner'): void {
  const n = getPathNode(draft, ref.nodeId);
  const sp = n?.subpaths[ref.subpath];
  const a = sp?.anchors[ref.index];
  if (!n || !sp || !a) return;
  if (kind === 'corner') {
    makeCorner(sp, ref.index);
  } else {
    const wm = worldMatrix(draft, ref.nodeId);
    const wsp = transformSubPath(sp, wm);
    makeSmooth(wsp, ref.index);
    const inv = invert(wm);
    const wa = wsp.anchors[ref.index];
    a.handleIn = wa.handleIn ? applyToVector(inv, wa.handleIn) : null;
    a.handleOut = wa.handleOut ? applyToVector(inv, wa.handleOut) : null;
    a.kind = 'smooth';
  }
  touchPath(n);
}

/** Alt-click behaviour: anchors with handles become corners, corners become smooth. */
export function toggleAnchorKind(draft: Document, ref: AnchorRef): 'smooth' | 'corner' | null {
  const a = getAnchor(draft, ref);
  if (!a) return null;
  const next: 'smooth' | 'corner' = hasHandle(a.handleIn) || hasHandle(a.handleOut) ? 'corner' : 'smooth';
  convertAnchor(draft, ref, next);
  return next;
}

/** Insert an anchor on a known segment location. */
export function insertAnchorAtLocation(draft: Document, nodeId: ID, subpath: number, segment: number, t: number): AnchorRef | null {
  const n = getPathNode(draft, nodeId);
  const sp = n?.subpaths[subpath];
  if (!n || !sp) return null;
  const tt = Math.max(0.02, Math.min(0.98, t));
  const idx = insertAnchorAt(sp, segment, tt);
  touchPath(n);
  return { nodeId, subpath, index: idx };
}

/** Insert an anchor at the point of the outline closest to a world position. */
export function insertAnchorWorld(draft: Document, nodeId: ID, world: Vec, maxDistance = Infinity): AnchorRef | null {
  const n = getPathNode(draft, nodeId);
  if (!n) return null;
  const wm = worldMatrix(draft, nodeId);
  const local = applyToPoint(invert(wm), world);
  const loc = nearestPointOnPath(n.subpaths, local);
  if (!loc) return null;
  if (dist(applyToPoint(wm, loc.point), world) > maxDistance) return null;
  return insertAnchorAtLocation(draft, nodeId, loc.subpath, loc.segment, loc.t);
}

/**
 * Remove a single anchor keeping the path continuous (Delete Anchor Point tool
 * semantics). Degenerate subpaths and empty nodes are removed. Returns whether
 * the node still exists.
 */
export function removeAnchorJoin(draft: Document, ref: AnchorRef): boolean {
  const n = getPathNode(draft, ref.nodeId);
  const sp = n?.subpaths[ref.subpath];
  if (!n || !sp || !sp.anchors[ref.index]) return !!n;
  removeAnchor(sp, ref.index);
  touchPath(n);
  return cleanupPath(draft, ref.nodeId);
}

/** Drop subpaths with fewer than 2 anchors; remove the node when nothing is left. */
export function cleanupPath(draft: Document, nodeId: ID): boolean {
  const n = getPathNode(draft, nodeId);
  if (!n) return false;
  n.subpaths = n.subpaths.filter((sp) => sp.anchors.length >= 2);
  if (!n.subpaths.length) {
    removeNode(draft, nodeId);
    return false;
  }
  return true;
}

/**
 * Delete key semantics: closed subpaths lose the anchors but stay closed
 * (neighbouring handles are adjusted to keep the shape); open subpaths are cut
 * at the deleted anchors, which may split them into several pieces. Paths that
 * end up without geometry are removed. Returns the ids of removed nodes.
 */
export function deleteAnchors(draft: Document, refs: AnchorRef[]): { removedNodes: ID[] } {
  const removedNodes: ID[] = [];
  const byNode = new Map<ID, Map<number, Set<number>>>();
  for (const r of refs) {
    if (!byNode.has(r.nodeId)) byNode.set(r.nodeId, new Map());
    const m = byNode.get(r.nodeId)!;
    if (!m.has(r.subpath)) m.set(r.subpath, new Set());
    m.get(r.subpath)!.add(r.index);
  }
  for (const [id, bySub] of byNode) {
    const n = getPathNode(draft, id);
    if (!n) continue;
    const next: SubPath[] = [];
    n.subpaths.forEach((sp, si) => {
      const del = bySub.get(si);
      if (!del || !del.size) {
        next.push(sp);
        return;
      }
      if (sp.closed) {
        const indices = Array.from(del).sort((a, b) => b - a);
        for (const i of indices) if (i < sp.anchors.length) removeAnchor(sp, i);
        if (sp.anchors.length >= 2) next.push(sp);
        return;
      }
      // open: split into runs of consecutive surviving anchors
      let run: Anchor[] = [];
      const flush = () => {
        if (run.length >= 2) {
          run[0].handleIn = null;
          run[run.length - 1].handleOut = null;
          next.push({ anchors: run, closed: false });
        }
        run = [];
      };
      sp.anchors.forEach((a, ai) => {
        if (del.has(ai)) flush();
        else run.push(cloneAnchor(a));
      });
      flush();
    });
    n.subpaths = next;
    touchPath(n);
    if (!n.subpaths.length) {
      removeNode(draft, id);
      removedNodes.push(id);
    }
  }
  return { removedNodes };
}

/** Close an open subpath (no-op when already closed or too short). */
export function closeSubPath(draft: Document, nodeId: ID, subpath: number): boolean {
  const n = getPathNode(draft, nodeId);
  const sp = n?.subpaths[subpath];
  if (!n || !sp || sp.closed || sp.anchors.length < 2) return false;
  sp.closed = true;
  touchPath(n);
  return true;
}

/** Reverse the anchor order of a subpath in place (used when continuing a path from its start). */
export function reverseSubPathInPlace(draft: Document, nodeId: ID, subpath: number): void {
  const n = getPathNode(draft, nodeId);
  const sp = n?.subpaths[subpath];
  if (!n || !sp) return;
  sp.anchors = sp.anchors
    .slice()
    .reverse()
    .map((a) => ({ point: { ...a.point }, handleIn: a.handleOut ? { ...a.handleOut } : null, handleOut: a.handleIn ? { ...a.handleIn } : null, kind: a.kind }));
  touchPath(n);
}

/** Append an anchor (given in world space) to a subpath. Returns its ref. */
export function appendAnchorWorld(draft: Document, nodeId: ID, subpath: number, world: Vec, kind: 'corner' | 'smooth' = 'corner'): AnchorRef | null {
  const n = getPathNode(draft, nodeId);
  const sp = n?.subpaths[subpath];
  if (!n || !sp) return null;
  const local = applyToPoint(invert(worldMatrix(draft, nodeId)), world);
  sp.anchors.push({ point: local, handleIn: null, handleOut: null, kind });
  touchPath(n);
  return { nodeId, subpath, index: sp.anchors.length - 1 };
}

/** Convert a local-space direction vector of a node into world space. */
export function localVecToWorld(doc: Document, nodeId: ID, v: Vec): Vec {
  return applyToVector(worldMatrix(doc, nodeId), v);
}

export function worldVecToLocal(doc: Document, nodeId: ID, v: Vec): Vec {
  return applyToVector(invert(worldMatrix(doc, nodeId)), v);
}
