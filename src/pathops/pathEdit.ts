/**
 * Object > Path, Compound Path, Clipping Mask and Expand operations.
 * Pure geometry helpers first (unit-tested), store-facing commands below.
 */
import type { Document, ID, SubPath, Anchor, Vec, PathNode, AnchorRef, Paint, StrokeStyle } from '@/model/types';
import type { EditorState } from '@/store/store';
import { getState } from '@/store/store';
import {
  worldSubPaths,
  setWorldSubPaths,
  removeNode,
  addNode,
  indexInParent,
  sortByPaintOrder,
  topmostOf,
  paintOrder,
  selectableNodes,
  isEditable,
  worldBounds,
  groupNodes,
  ungroupNode,
  ancestors,
  getChildren,
  descendants,
  worldMatrix,
} from '@/model/document';
import { makePath, makeGroup, clonePaint, cloneStroke } from '@/model/nodes';
import { cloneSubPath, reverseSubPath, insertAnchorAt, segmentCount, absHandleIn, absHandleOut, hasHandle, inferAnchorKind, anchorCount, pathBounds, cloneAnchor, flattenSubPath } from '@/geometry/path';
import { cubicLength, cubicPoint, cubicNearest, type Cubic } from '@/geometry/bezier';
import { sub, dist } from '@/geometry/vec';
import { applyToPoint, invert, scaleFactor } from '@/geometry/matrix';
import { outlineStroke, offsetPath, fitPoints } from '@/geometry/paperBridge';
import { closeAll, safeBoolean, isEmptyGeometry, worldGeom, rectsOverlap, splitIslands } from './geometry';
import { selectionTargets, replaceWithResults, removeEmptyGroups, notifySkipped, commitChange } from './apply';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type EndSide = 'start' | 'end';

/** Join two open subpaths at the given ends (straight segment when the points differ). */
export function joinOpenSubPaths(a: SubPath, aEnd: EndSide, b: SubPath, bEnd: EndSide): SubPath {
  const A = aEnd === 'end' ? cloneSubPath(a) : reverseSubPath(a);
  const B = bEnd === 'start' ? cloneSubPath(b) : reverseSubPath(b);
  const last = A.anchors[A.anchors.length - 1];
  const first = B.anchors[0];
  if (last && first && dist(last.point, first.point) < 1e-6) {
    last.handleOut = first.handleOut ? { ...first.handleOut } : null;
    inferAnchorKind(last);
    B.anchors.shift();
  } else if (last && first) {
    last.handleOut = null;
    first.handleIn = null;
    inferAnchorKind(last);
    inferAnchorKind(first);
  }
  return { anchors: A.anchors.concat(B.anchors), closed: false };
}

/** Insert a midpoint anchor into every segment (or only the listed segments). */
export function addMidAnchors(sp: SubPath, only?: Set<number>): SubPath {
  const out = cloneSubPath(sp);
  const n = segmentCount(out);
  for (let seg = n - 1; seg >= 0; seg--) {
    if (only && !only.has(seg)) continue;
    insertAnchorAt(out, seg, 0.5);
  }
  return out;
}

function nz(v: Vec): Vec | null {
  return hasHandle(v) ? v : null;
}

/**
 * Try to remove `cur` between `prev` and `next`: reconstruct the single cubic
 * the two segments would have come from and accept it when it deviates less
 * than `tol` from the original curves. Returns the new neighbour handles.
 */
export function mergeableAnchor(prev: Anchor, cur: Anchor, next: Anchor, tol = 0.25): { hOut: Vec | null; hIn: Vec | null } | null {
  const c1: Cubic = { p0: prev.point, p1: absHandleOut(prev), p2: absHandleIn(cur), p3: cur.point };
  const c2: Cubic = { p0: cur.point, p1: absHandleOut(cur), p2: absHandleIn(next), p3: next.point };
  const l1 = cubicLength(c1);
  const l2 = cubicLength(c2);
  if (l1 + l2 < 1e-9) return { hOut: null, hIn: null };
  const t0 = l1 / (l1 + l2);
  let P1: Vec;
  let P2: Vec;
  if (t0 < 1e-4) {
    P1 = c2.p1;
    P2 = c2.p2;
  } else if (1 - t0 < 1e-4) {
    P1 = c1.p1;
    P2 = c1.p2;
  } else {
    P1 = { x: prev.point.x + (c1.p1.x - prev.point.x) / t0, y: prev.point.y + (c1.p1.y - prev.point.y) / t0 };
    P2 = { x: next.point.x + (c2.p2.x - next.point.x) / (1 - t0), y: next.point.y + (c2.p2.y - next.point.y) / (1 - t0) };
  }
  const cand: Cubic = { p0: prev.point, p1: P1, p2: P2, p3: next.point };
  for (const c of [c1, c2]) {
    for (let k = 1; k < 8; k++) {
      const p = cubicPoint(c, k / 8);
      if (cubicNearest(cand, p).distance > tol) return null;
    }
  }
  for (let k = 1; k < 8; k++) {
    const p = cubicPoint(cand, k / 8);
    const d = Math.min(cubicNearest(c1, p).distance, cubicNearest(c2, p).distance);
    if (d > tol) return null;
  }
  return { hOut: nz(sub(P1, prev.point)), hIn: nz(sub(P2, next.point)) };
}

/** Remove anchors that do not change the shape (collinear points, split curves, duplicates). */
export function removeRedundantAnchors(sp: SubPath, tol = 0.25): { subpath: SubPath; removed: number } {
  const anchors = sp.anchors.map(cloneAnchor);
  const closed = sp.closed;
  const minCount = closed ? 3 : 2;
  let removed = 0;
  let i = closed ? 0 : 1;
  let guard = 0;
  while (anchors.length > minCount && guard++ < 100000) {
    const n = anchors.length;
    if (closed ? i >= n : i >= n - 1) break;
    const prev = anchors[(i - 1 + n) % n];
    const next = anchors[(i + 1) % n];
    const m = mergeableAnchor(prev, anchors[i], next, tol);
    if (m) {
      prev.handleOut = m.hOut;
      next.handleIn = m.hIn;
      inferAnchorKind(prev);
      inferAnchorKind(next);
      anchors.splice(i, 1);
      removed++;
      if (closed && i >= anchors.length) break;
    } else i++;
  }
  return { subpath: { anchors, closed }, removed };
}

export type AverageAxis = 'h' | 'v' | 'both';

/** Average points: 'h' aligns them on a horizontal line, 'v' on a vertical one, 'both' to one point. */
export function averagePoints(points: Vec[], axis: AverageAxis): Vec[] {
  if (!points.length) return [];
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mean = { x: sx / points.length, y: sy / points.length };
  return points.map((p) => ({ x: axis === 'h' ? p.x : mean.x, y: axis === 'v' ? p.y : mean.y }));
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export interface EndRef {
  nodeId: ID;
  subpath: number;
  end: EndSide;
  point: Vec;
}

function endRefsFromAnchors(doc: Document, refs: AnchorRef[]): EndRef[] {
  const out: EndRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const n = doc.nodes[r.nodeId];
    if (!n || n.type !== 'path') continue;
    const sp = n.subpaths[r.subpath];
    if (!sp || sp.closed || sp.anchors.length < 2) continue;
    const end: EndSide | null = r.index === 0 ? 'start' : r.index === sp.anchors.length - 1 ? 'end' : null;
    if (!end) continue;
    const key = `${r.nodeId}/${r.subpath}/${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodeId: r.nodeId, subpath: r.subpath, end, point: applyToPoint(worldMatrix(doc, r.nodeId), sp.anchors[r.index].point) });
  }
  return out;
}

function openEnds(doc: Document, ids: ID[]): EndRef[] {
  const out: EndRef[] = [];
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || n.type !== 'path') continue;
    const wm = worldMatrix(doc, id);
    n.subpaths.forEach((sp, si) => {
      if (sp.closed || sp.anchors.length < 2) return;
      out.push({ nodeId: id, subpath: si, end: 'start', point: applyToPoint(wm, sp.anchors[0].point) });
      out.push({ nodeId: id, subpath: si, end: 'end', point: applyToPoint(wm, sp.anchors[sp.anchors.length - 1].point) });
    });
  }
  return out;
}

/** Which ends a Join would connect (null when nothing to join). */
export function joinCandidates(s: EditorState): { a: EndRef; b: EndRef } | { close: EndRef } | null {
  const doc = s.doc;
  const fromAnchors = endRefsFromAnchors(doc, s.selectedAnchors);
  if (fromAnchors.length === 2) {
    const [a, b] = fromAnchors;
    if (a.nodeId === b.nodeId && a.subpath === b.subpath) return { close: a };
    return { a, b };
  }
  const ids = selectionTargets(s).ids;
  const ends = openEnds(doc, ids);
  if (!ends.length) return null;
  const subpathKeys = new Set(ends.map((e) => `${e.nodeId}/${e.subpath}`));
  if (subpathKeys.size === 1) return { close: ends[0] };
  let best: { a: EndRef; b: EndRef; d: number } | null = null;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i];
      const b = ends[j];
      if (a.nodeId === b.nodeId && a.subpath === b.subpath) continue;
      const d = dist(a.point, b.point);
      if (!best || d < best.d) best = { a, b, d };
    }
  }
  return best ? { a: best.a, b: best.b } : null;
}

export const canJoin = (s: EditorState): boolean => s.selection.length > 0 && joinCandidates(s) !== null;
export const canAverage = (s: EditorState): boolean => s.selectedAnchors.length >= 2;

export function hasStrokedPath(s: EditorState): boolean {
  if (!s.selection.length) return false;
  return selectionTargets(s).ids.some((id) => {
    const n = s.doc.nodes[id] as PathNode;
    return n.stroke.paint.type !== 'none' && n.stroke.width > 0;
  });
}

export function canReleaseCompound(s: EditorState): boolean {
  if (!s.selection.length) return false;
  return selectionTargets(s).ids.some((id) => (s.doc.nodes[id] as PathNode).subpaths.length > 1);
}

/** Objects a clipping mask would be made from (top-most = clip). */
export function clipMembers(s: EditorState): ID[] {
  const doc = s.doc;
  const ids = sortByPaintOrder(doc, topmostOf(doc, s.selection)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer' && isEditable(doc, id));
  if (ids.length === 1) {
    const n = doc.nodes[ids[0]];
    if (n.type === 'group' && !n.clipId && n.children.length >= 2) return [];
  }
  return ids;
}

export function canClipMake(s: EditorState): boolean {
  if (s.selection.length < 1) return false;
  const doc = s.doc;
  const ids = sortByPaintOrder(doc, topmostOf(doc, s.selection)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer' && isEditable(doc, id));
  if (ids.length >= 2) return true;
  if (ids.length === 1) {
    const n = doc.nodes[ids[0]];
    return n.type === 'group' && !n.clipId && n.children.length >= 2;
  }
  return false;
}

/** Clip groups affected by Release: selected clip groups or the nearest clip group ancestor. */
export function clipGroupsOf(s: EditorState): ID[] {
  const doc = s.doc;
  const out = new Set<ID>();
  for (const id of s.selection) {
    const n = doc.nodes[id];
    if (!n) continue;
    if (n.type === 'group' && n.clipId) {
      out.add(id);
      continue;
    }
    for (const a of ancestors(doc, id)) {
      const an = doc.nodes[a];
      if (an && an.type === 'group' && an.clipId) {
        out.add(a);
        break;
      }
    }
  }
  return Array.from(out);
}

export const canClipRelease = (s: EditorState): boolean => s.selection.length > 0 && clipGroupsOf(s).length > 0;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Join: selected end anchors, else the nearest ends of the selected open paths, else close. */
export function joinCommand(): void {
  const s = getState();
  const cand = joinCandidates(s);
  if (!cand) {
    s.toast('Select two open path endpoints (or an open path) to join.', 'info');
    return;
  }
  let selectNode: ID | null = null;
  let selectAnchor: AnchorRef | null = null;
  commitChange((d) => {
    if ('close' in cand) {
      const n = d.nodes[cand.close.nodeId] as PathNode;
      const sp = n.subpaths[cand.close.subpath];
      sp.closed = true;
      n.shape = undefined;
      selectNode = n.id;
      return;
    }
    const { a, b } = cand;
    const order = sortByPaintOrder(d, [a.nodeId, b.nodeId]);
    const targetId = order[order.length - 1];
    const otherId = targetId === a.nodeId ? b.nodeId : a.nodeId;
    const A = worldSubPaths(d, a.nodeId)[a.subpath];
    const B = worldSubPaths(d, b.nodeId)[b.subpath];
    if (!A || !B) return;
    const joined = joinOpenSubPaths(A, a.end, B, b.end);
    // the joined subpath always starts with A's anchors: the join point is A's last one
    const joinIndex = A.anchors.length - 1;
    if (a.nodeId === b.nodeId) {
      const sps = worldSubPaths(d, a.nodeId);
      const lo = Math.min(a.subpath, b.subpath);
      const hi = Math.max(a.subpath, b.subpath);
      const next = sps.filter((_, i) => i !== lo && i !== hi);
      next.splice(lo, 0, joined);
      setWorldSubPaths(d, a.nodeId, next);
      selectNode = a.nodeId;
      selectAnchor = { nodeId: a.nodeId, subpath: lo, index: joinIndex };
      return;
    }
    const tRef = targetId === a.nodeId ? a : b;
    const oRef = targetId === a.nodeId ? b : a;
    const tSps = worldSubPaths(d, targetId);
    tSps[tRef.subpath] = joined;
    setWorldSubPaths(d, targetId, tSps);
    const oSps = worldSubPaths(d, otherId).filter((_, i) => i !== oRef.subpath);
    if (oSps.length) setWorldSubPaths(d, otherId, oSps);
    else {
      const parent = d.nodes[otherId]?.parent;
      removeNode(d, otherId);
      if (parent) removeEmptyGroups(d, [parent]);
    }
    selectNode = targetId;
    selectAnchor = { nodeId: targetId, subpath: tRef.subpath, index: joined.anchors[joinIndex] ? joinIndex : 0 };
  }, 'Join');
  const st = getState();
  if (selectNode) st.setSelection([selectNode], selectAnchor && st.activeTool === 'direct' ? [selectAnchor] : []);
}

export function averageCommand(axis: AverageAxis): void {
  const s = getState();
  const refs = s.selectedAnchors.filter((r) => {
    const n = s.doc.nodes[r.nodeId];
    return n && n.type === 'path' && n.subpaths[r.subpath]?.anchors[r.index];
  });
  if (refs.length < 2) {
    s.toast('Select two or more anchor points to average.', 'info');
    return;
  }
  const points = refs.map((r) => applyToPoint(worldMatrix(s.doc, r.nodeId), (s.doc.nodes[r.nodeId] as PathNode).subpaths[r.subpath].anchors[r.index].point));
  const avg = averagePoints(points, axis);
  s.updateDoc((d) => {
    refs.forEach((r, i) => {
      const n = d.nodes[r.nodeId] as PathNode;
      const a = n.subpaths[r.subpath]?.anchors[r.index];
      if (!a) return;
      a.point = applyToPoint(invert(worldMatrix(d, r.nodeId)), avg[i]);
      n.shape = undefined;
    });
  }, 'Average');
}

/** Subpaths of a node that carry selected anchors (empty = all). */
function selectedSubpathsOf(s: EditorState, id: ID): Set<number> {
  const out = new Set<number>();
  for (const r of s.selectedAnchors) if (r.nodeId === id) out.add(r.subpath);
  return out;
}

export function addAnchorsCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  if (!t.ids.length) return;
  const useAnchors = s.activeTool === 'direct' && s.selectedAnchors.length >= 2;
  let added = 0;
  s.updateDoc((d) => {
    for (const id of t.ids) {
      const n = d.nodes[id] as PathNode;
      const selected = new Map<number, Set<number>>();
      if (useAnchors) {
        for (const r of s.selectedAnchors) {
          if (r.nodeId !== id) continue;
          if (!selected.has(r.subpath)) selected.set(r.subpath, new Set());
          selected.get(r.subpath)!.add(r.index);
        }
        if (!selected.size) continue;
      }
      n.subpaths = n.subpaths.map((sp, si) => {
        let only: Set<number> | undefined;
        if (useAnchors) {
          const sel = selected.get(si);
          if (!sel) return sp;
          only = new Set<number>();
          const segs = segmentCount(sp);
          for (let seg = 0; seg < segs; seg++) if (sel.has(seg) && sel.has((seg + 1) % sp.anchors.length)) only.add(seg);
          if (!only.size) return sp;
        }
        const next = addMidAnchors(sp, only);
        added += next.anchors.length - sp.anchors.length;
        return next;
      });
      n.shape = undefined;
    }
  }, 'Add Anchor Points');
  if (useAnchors) getState().setSelectedAnchors([]);
  if (!added) getState().toast('No segments to add anchors to.', 'info');
}

export function removeRedundantCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  if (!t.ids.length) return;
  let removed = 0;
  s.updateDoc((d) => {
    for (const id of t.ids) {
      const n = d.nodes[id] as PathNode;
      const tol = 0.25 / (scaleFactor(worldMatrix(d, id)) || 1);
      n.subpaths = n.subpaths.map((sp) => {
        const r = removeRedundantAnchors(sp, tol);
        removed += r.removed;
        return r.removed ? r.subpath : sp;
      });
      if (removed) n.shape = undefined;
    }
  }, 'Remove Redundant Points');
  const st = getState();
  st.setSelectedAnchors([]);
  st.toast(removed ? `Removed ${removed} redundant anchor point${removed > 1 ? 's' : ''}.` : 'No redundant anchor points found.', removed ? 'success' : 'info');
}

export function reverseCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  if (!t.ids.length) return;
  s.updateDoc((d) => {
    for (const id of t.ids) {
      const n = d.nodes[id] as PathNode;
      const only = selectedSubpathsOf(s, id);
      n.subpaths = n.subpaths.map((sp, si) => (only.size && !only.has(si) ? sp : reverseSubPath(sp)));
      n.shape = undefined;
    }
  }, 'Reverse Path Direction');
  getState().setSelectedAnchors([]);
}

/** Divide Objects Below: the top selected path cuts every editable path beneath it. */
export function divideBelowCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  if (!t.ids.length) {
    s.toast('Select a path to use as the cutter.', 'info');
    return;
  }
  const knifeId = t.ids[t.ids.length - 1];
  const knife = worldGeom(s.doc, knifeId);
  if (!knife) return;
  const kb = pathBounds(knife.subpaths);
  const order = new Map(paintOrder(s.doc).map((id, i) => [id, i]));
  const knifeIndex = order.get(knifeId) ?? 0;
  const selected = new Set(t.ids);
  const targets = selectableNodes(s.doc, true).filter((id) => {
    const n = s.doc.nodes[id];
    if (!n || n.type !== 'path' || selected.has(id) || !isEditable(s.doc, id)) return false;
    if ((order.get(id) ?? 0) >= knifeIndex) return false;
    return rectsOverlap(worldBounds(s.doc, id), kb);
  });
  const results: ID[] = [];
  let cut = 0;
  commitChange((d) => {
    const cutter = { subpaths: closeAll(knife.subpaths), fillRule: knife.fillRule };
    for (const id of targets) {
      const g = worldGeom(d, id);
      if (!g) continue;
      const n = d.nodes[id] as PathNode;
      const geom = { subpaths: closeAll(g.subpaths), fillRule: g.fillRule };
      const inside = safeBoolean('intersect', geom, cutter);
      if (isEmptyGeometry(inside)) continue;
      const outside = safeBoolean('subtract', geom, cutter);
      const pieces = [...splitIslands(outside), ...splitIslands(inside)];
      if (!pieces.length) continue;
      cut++;
      setWorldSubPaths(d, id, pieces[0]);
      results.push(id);
      const base = indexInParent(d, id);
      for (let k = 1; k < pieces.length; k++) {
        const copy = makePath([], { fill: clonePaint(n.fill), stroke: cloneStroke(n.stroke), fillRule: n.fillRule, name: n.name, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects });
        addNode(d, copy, n.parent, base + k);
        setWorldSubPaths(d, copy.id, pieces[k]);
        results.push(copy.id);
      }
    }
    if (cut) {
      const parent = d.nodes[knifeId]?.parent;
      removeNode(d, knifeId);
      if (parent) removeEmptyGroups(d, [parent]);
    }
  }, 'Divide Objects Below');
  const st = getState();
  if (!cut) st.toast('No objects below the selected path to divide.', 'info');
  else st.setSelection(results);
}

/** Clean Up: stray points, unpainted paths and empty text objects. */
export function cleanUpCommand(): void {
  const s = getState();
  let strays = 0;
  let unpainted = 0;
  let texts = 0;
  s.updateDoc((d) => {
    const usedAsClip = new Set<ID>();
    const usedAsTextPath = new Set<ID>();
    for (const n of Object.values(d.nodes)) {
      if (n.type === 'group' && n.clipId) usedAsClip.add(n.clipId);
      if (n.type === 'text' && n.pathId) usedAsTextPath.add(n.pathId);
    }
    for (const n of Object.values(d.nodes)) {
      if (!d.nodes[n.id]) continue;
      if (n.type === 'path') {
        if (usedAsClip.has(n.id) || usedAsTextPath.has(n.id)) continue;
        if (anchorCount(n.subpaths) < 2) {
          removeNode(d, n.id);
          strays++;
        } else if (n.fill.type === 'none' && (n.stroke.paint.type === 'none' || n.stroke.width <= 0)) {
          removeNode(d, n.id);
          unpainted++;
        }
      } else if (n.type === 'text' && n.text.trim() === '' && n.id !== s.editingTextId) {
        removeNode(d, n.id);
        texts++;
      }
    }
  }, 'Clean Up');
  const total = strays + unpainted + texts;
  const parts: string[] = [];
  if (strays) parts.push(`${strays} stray point${strays > 1 ? 's' : ''}`);
  if (unpainted) parts.push(`${unpainted} unpainted object${unpainted > 1 ? 's' : ''}`);
  if (texts) parts.push(`${texts} empty text object${texts > 1 ? 's' : ''}`);
  getState().toast(total ? `Removed ${parts.join(', ')}.` : 'Nothing to clean up.', total ? 'success' : 'info');
}

export function compoundMakeCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  notifySkipped(t);
  if (!t.ids.length) return;
  const bottom = t.ids[0];
  let created: ID | null = null;
  commitChange((d) => {
    const subpaths: SubPath[] = [];
    for (const id of t.ids) subpaths.push(...worldSubPaths(d, id).filter((sp) => sp.anchors.length >= 2));
    const r = replaceWithResults(d, t.ids, [{ subpaths, fillRule: 'evenodd', source: bottom, name: 'Compound Path' }], { group: false, slot: 'top' });
    created = r.ids[0] ?? null;
  }, 'Make Compound Path');
  if (created) getState().setSelection([created]);
}

export function compoundReleaseCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  const ids = t.ids.filter((id) => (s.doc.nodes[id] as PathNode).subpaths.length > 1);
  if (!ids.length) {
    s.toast('Select a compound path to release.', 'info');
    return;
  }
  const out: ID[] = [];
  commitChange((d) => {
    for (const id of ids) {
      const n = d.nodes[id] as PathNode;
      const sps = n.subpaths.filter((sp) => sp.anchors.length >= 1);
      if (!sps.length) continue;
      n.subpaths = [sps[0]];
      n.shape = undefined;
      out.push(id);
      const base = indexInParent(d, id);
      for (let k = 1; k < sps.length; k++) {
        const copy = makePath([sps[k]], { fill: clonePaint(n.fill), stroke: cloneStroke(n.stroke), fillRule: n.fillRule, name: n.name, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects, transform: n.transform });
        addNode(d, copy, n.parent, base + k);
        out.push(copy.id);
      }
    }
  }, 'Release Compound Path');
  getState().setSelection(out);
}

export function clipMakeCommand(): void {
  const s = getState();
  if (!canClipMake(s)) {
    s.toast('Select two or more objects; the top one becomes the mask.', 'info');
    return;
  }
  const members = clipMembers(s);
  let groupId: ID | null = null;
  commitChange((d) => {
    let gid: ID;
    let clipId: ID;
    if (!members.length) {
      // a single plain group: its top child becomes the mask
      const doc = d;
      const sel = sortByPaintOrder(doc, topmostOf(doc, s.selection))[0];
      const g = doc.nodes[sel];
      if (!g || g.type !== 'group') return;
      gid = g.id;
      clipId = g.children[g.children.length - 1];
      g.clipId = clipId;
    } else {
      const group = makeGroup([], { name: 'Clip Group' });
      gid = groupNodes(d, members, group);
      if (!gid) return;
      const g = d.nodes[gid];
      if (!g || g.type !== 'group') return;
      clipId = g.children[g.children.length - 1];
      g.clipId = clipId;
    }
    const clip = d.nodes[clipId];
    if (clip && (clip.type === 'path' || clip.type === 'text')) {
      clip.fill = { type: 'none' };
      clip.stroke = { ...clip.stroke, paint: { type: 'none' } };
      if (clip.type === 'path') clip.name = clip.name === 'Path' || /^(Rectangle|Ellipse|Polygon|Star)$/.test(clip.name) ? 'Clipping Path' : clip.name;
    }
    groupId = gid;
  }, 'Make Clipping Mask');
  if (groupId) getState().setSelection([groupId]);
}

export function clipReleaseCommand(): void {
  const s = getState();
  const groups = clipGroupsOf(s);
  if (!groups.length) {
    s.toast('Select a clipping group to release.', 'info');
    return;
  }
  const released: ID[] = [];
  commitChange((d) => {
    for (const gid of groups) {
      const g = d.nodes[gid];
      if (!g || g.type !== 'group') continue;
      g.clipId = null;
      released.push(...ungroupNode(d, gid));
    }
  }, 'Release Clipping Mask');
  getState().setSelection(released);
}

// ---------------------------------------------------------------------------
// Outline Stroke / Expand
// ---------------------------------------------------------------------------

/** World-space filled outline of a node's stroke (respecting stroke alignment). */
export function strokeOutlineOf(doc: Document, id: ID): SubPath[] | null {
  const g = worldGeom(doc, id);
  if (!g) return null;
  const n = g.node;
  if (n.stroke.paint.type === 'none' || n.stroke.width <= 0) return null;
  const width = n.stroke.width * g.scale;
  let outline: SubPath[];
  try {
    outline = outlineStroke(g.subpaths, width, { cap: n.stroke.cap, join: n.stroke.join, miterLimit: n.stroke.miterLimit });
  } catch {
    return null;
  }
  if (!outline.length) return null;
  const closed = g.subpaths.filter((sp) => sp.closed);
  if (n.stroke.align !== 'center' && closed.length) {
    const fill = { subpaths: closed, fillRule: n.fillRule };
    outline = safeBoolean(n.stroke.align === 'inside' ? 'intersect' : 'subtract', { subpaths: outline, fillRule: 'nonzero' }, fill);
  }
  return isEmptyGeometry(outline) ? null : outline;
}

/**
 * Convert the strokes of the given paths into filled paths. A path that also
 * has a fill becomes a group [fill path, stroke outline]. Returns the ids of
 * the resulting objects (per input path).
 */
export function outlineStrokes(draft: Document, ids: ID[]): { results: ID[]; converted: number } {
  const results: ID[] = [];
  let converted = 0;
  for (const id of ids) {
    const n = draft.nodes[id];
    if (!n || n.type !== 'path') continue;
    const outline = strokeOutlineOf(draft, id);
    if (!outline) {
      results.push(id);
      continue;
    }
    converted++;
    const strokePaint = clonePaint(n.stroke.paint);
    const strokeOpacity = n.stroke.paint.type === 'solid' ? n.stroke.paint.opacity : 1;
    const fillPaint: Paint = strokePaint.type === 'solid' ? { ...strokePaint, opacity: strokeOpacity } : strokePaint;
    const noStroke: StrokeStyle = { ...cloneStroke(n.stroke), paint: { type: 'none' }, widthProfile: undefined, markerStart: 'none', markerEnd: 'none' };
    const hasFill = n.fill.type !== 'none' && n.subpaths.some((sp) => sp.closed || sp.anchors.length >= 3);
    if (hasFill) {
      const outlineNode = makePath([], { fill: fillPaint, stroke: noStroke, fillRule: 'nonzero', name: `${n.name} stroke`, opacity: 1, blendMode: 'normal' });
      n.stroke = noStroke;
      n.shape = undefined;
      addNode(draft, outlineNode, n.parent, indexInParent(draft, id) + 1);
      setWorldSubPaths(draft, outlineNode.id, outline);
      const group = makeGroup([], { name: n.name, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects });
      n.opacity = 1;
      n.blendMode = 'normal';
      n.effects = [];
      const gid = groupNodes(draft, [id, outlineNode.id], group);
      results.push(gid || id);
    } else {
      n.fill = fillPaint;
      n.stroke = noStroke;
      n.fillRule = 'nonzero';
      setWorldSubPaths(draft, id, outline);
      results.push(id);
    }
  }
  return { results, converted };
}

export function outlineStrokeCommand(): void {
  const s = getState();
  const t = selectionTargets(s);
  notifySkipped(t);
  if (!t.ids.length) return;
  let out: { results: ID[]; converted: number } = { results: [], converted: 0 };
  commitChange((d) => {
    out = outlineStrokes(d, t.ids);
  }, 'Outline Stroke');
  const st = getState();
  if (!out.converted) st.toast('No stroked paths in the selection.', 'info');
  else st.setSelection(out.results);
}

export interface ExpandOptions {
  object: boolean;
  stroke: boolean;
}

/** Expand live shapes and (optionally) strokes of the given ids. */
export function expandNodes(draft: Document, ids: ID[], opts: ExpandOptions): { results: ID[]; changed: number } {
  let changed = 0;
  let results = ids;
  if (opts.object) {
    for (const id of ids) {
      const n = draft.nodes[id];
      if (n && n.type === 'path' && n.shape) {
        n.shape = undefined;
        changed++;
      }
    }
  }
  if (opts.stroke) {
    const r = outlineStrokes(draft, ids);
    changed += r.converted;
    results = r.results;
  }
  return { results, changed };
}

// ---------------------------------------------------------------------------
// Offset / Simplify (document producers used by the dialogs)
// ---------------------------------------------------------------------------

export interface OffsetParams {
  offset: number;
  join: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  mode: 'new' | 'replace';
}

export function offsetNodes(draft: Document, ids: ID[], p: OffsetParams): ID[] {
  const created: ID[] = [];
  for (const id of ids) {
    const g = worldGeom(draft, id);
    if (!g) continue;
    const n = g.node;
    let sps: SubPath[];
    try {
      sps = offsetPath(g.subpaths, p.offset, { join: p.join, miterLimit: p.miterLimit, fillRule: n.fillRule }).filter((sp) => sp.anchors.length >= 2);
    } catch {
      continue;
    }
    if (!sps.length) continue;
    if (p.mode === 'replace') {
      setWorldSubPaths(draft, id, sps);
      created.push(id);
    } else {
      const copy = makePath([], { fill: clonePaint(n.fill), stroke: cloneStroke(n.stroke), fillRule: n.fillRule, name: `${n.name} offset`, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects });
      addNode(draft, copy, n.parent, indexInParent(draft, id) + 1);
      setWorldSubPaths(draft, copy.id, sps);
      created.push(copy.id);
    }
  }
  return created;
}

/** Direction of the curve arriving at / leaving anchor i (unit vectors, null at open ends). */
function tangentsAt(sp: SubPath, i: number): { inDir: Vec | null; outDir: Vec | null } {
  const n = sp.anchors.length;
  const a = sp.anchors[i];
  const hasPrev = sp.closed || i > 0;
  const hasNext = sp.closed || i < n - 1;
  let inDir: Vec | null = null;
  let outDir: Vec | null = null;
  if (hasPrev) {
    const prev = sp.anchors[(i - 1 + n) % n];
    const from = hasHandle(a.handleIn) ? absHandleIn(a) : hasHandle(prev.handleOut) ? absHandleOut(prev) : prev.point;
    const v = sub(a.point, from);
    const l = Math.hypot(v.x, v.y);
    if (l > 1e-9) inDir = { x: v.x / l, y: v.y / l };
  }
  if (hasNext) {
    const next = sp.anchors[(i + 1) % n];
    const to = hasHandle(a.handleOut) ? absHandleOut(a) : hasHandle(next.handleIn) ? absHandleIn(next) : next.point;
    const v = sub(to, a.point);
    const l = Math.hypot(v.x, v.y);
    if (l > 1e-9) outDir = { x: v.x / l, y: v.y / l };
  }
  return { inDir, outDir };
}

/** Indices of anchors where the direction changes by more than `cornerDeg` (kept by Simplify). */
export function cornerIndices(sp: SubPath, cornerDeg = 30): number[] {
  const out: number[] = [];
  const cos = Math.cos((cornerDeg * Math.PI) / 180);
  sp.anchors.forEach((a, i) => {
    if (a.kind === 'smooth' && hasHandle(a.handleIn) && hasHandle(a.handleOut)) return;
    const { inDir, outDir } = tangentsAt(sp, i);
    if (!inDir || !outDir) return;
    if (inDir.x * outDir.x + inDir.y * outDir.y < cos) out.push(i);
  });
  return out;
}

/** Refit an anchor run (open) through densely sampled points. */
function refitRun(anchors: Anchor[], tolerance: number, closed: boolean): Anchor[] {
  if (anchors.length < 2) return anchors;
  const pts = flattenSubPath({ anchors, closed }, 0.1);
  if (closed && pts.length > 1) pts.push({ ...pts[0] });
  if (pts.length < 2) return anchors;
  // straight runs stay straight
  const first = pts[0];
  const last = pts[pts.length - 1];
  const len = Math.hypot(last.x - first.x, last.y - first.y);
  if (!closed && len > 1e-9) {
    let maxDev = 0;
    for (const p of pts) {
      const d = Math.abs((last.x - first.x) * (p.y - first.y) - (last.y - first.y) * (p.x - first.x)) / len;
      if (d > maxDev) maxDev = d;
    }
    if (maxDev <= tolerance) return [cloneAnchor(anchors[0]), cloneAnchor(anchors[anchors.length - 1])].map((a, k) => ({ ...a, handleIn: k === 0 ? a.handleIn : null, handleOut: k === 0 ? null : a.handleOut }));
  }
  let fitted: SubPath | null = null;
  try {
    fitted = fitPoints(pts, tolerance, false);
  } catch {
    fitted = null;
  }
  if (!fitted || fitted.anchors.length < 2) return anchors;
  const out = fitted.anchors.map(cloneAnchor);
  // keep the exact end points of the run
  out[0].point = { ...anchors[0].point };
  out[out.length - 1].point = { ...anchors[anchors.length - 1].point };
  return out;
}

/**
 * Simplify subpaths Illustrator-style: the curve is sampled densely and
 * refitted with the given tolerance; corner anchors (direction changes above
 * `cornerDeg`) are preserved and the runs between them are fitted separately.
 */
export function simplifySubPaths(sps: SubPath[], tolerance: number, cornerDeg = 30): SubPath[] {
  return sps.map((sp) => {
    const n = sp.anchors.length;
    if (n < 3 && !(n === 2 && !sp.closed)) return sp;
    const corners = cornerIndices(sp, cornerDeg);
    const runs: Anchor[][] = [];
    if (sp.closed) {
      if (!corners.length) {
        // smooth closed loop: fit as one closed run starting at the first anchor
        const run = sp.anchors.map(cloneAnchor);
        run.push(cloneAnchor(sp.anchors[0]));
        const fitted = refitRun(run, tolerance, false);
        const anchors = fitted.slice(0, -1);
        if (anchors.length >= 2) {
          anchors[0].handleIn = fitted[fitted.length - 1].handleIn;
          if (hasHandle(anchors[0].handleIn) && hasHandle(anchors[0].handleOut)) anchors[0].kind = 'smooth';
          return { anchors, closed: true };
        }
        return sp;
      }
      for (let k = 0; k < corners.length; k++) {
        const a = corners[k];
        const b = corners[(k + 1) % corners.length];
        const run: Anchor[] = [cloneAnchor(sp.anchors[a])];
        let i = a;
        do {
          i = (i + 1) % n;
          run.push(cloneAnchor(sp.anchors[i]));
        } while (i !== b);
        runs.push(run);
      }
    } else {
      const idx = Array.from(new Set([0, ...corners.filter((c) => c > 0 && c < n - 1), n - 1])).sort((x, y) => x - y);
      for (let k = 0; k + 1 < idx.length; k++) runs.push(sp.anchors.slice(idx[k], idx[k + 1] + 1).map(cloneAnchor));
    }
    const anchors: Anchor[] = [];
    for (const run of runs) {
      const fitted = refitRun(run, tolerance, false);
      fitted.forEach((a, i) => {
        if (i === 0 && anchors.length) {
          const last = anchors[anchors.length - 1];
          last.handleOut = a.handleOut;
          last.kind = 'corner';
          return;
        }
        anchors.push(a);
      });
    }
    if (sp.closed && anchors.length > 1) {
      const first = anchors[0];
      const last = anchors[anchors.length - 1];
      if (dist(first.point, last.point) < 1e-6) {
        first.handleIn = last.handleIn;
        first.kind = 'corner';
        anchors.pop();
      }
    }
    return anchors.length >= 2 ? { anchors, closed: sp.closed } : sp;
  });
}

export function simplifyNodes(draft: Document, ids: ID[], tolerance: number): { before: number; after: number } {
  let before = 0;
  let after = 0;
  for (const id of ids) {
    const g = worldGeom(draft, id);
    if (!g) continue;
    before += anchorCount(g.subpaths);
    let sps: SubPath[];
    try {
      sps = simplifySubPaths(g.subpaths, tolerance).filter((sp) => sp.anchors.length >= 2);
    } catch {
      after += anchorCount(g.subpaths);
      continue;
    }
    if (!sps.length) {
      after += anchorCount(g.subpaths);
      continue;
    }
    after += anchorCount(sps);
    setWorldSubPaths(draft, id, sps);
  }
  return { before, after };
}

/** Anchor count of the given paths (for the Simplify dialog). */
export function anchorTotal(doc: Document, ids: ID[]): number {
  let n = 0;
  for (const id of ids) {
    const node = doc.nodes[id];
    if (node && node.type === 'path') n += anchorCount(node.subpaths);
  }
  return n;
}

export { getChildren, descendants };
