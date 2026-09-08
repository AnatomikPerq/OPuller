/**
 * Document-level helpers shared by the freehand tools: creating paths from
 * world-space geometry, replacing a node's geometry (optionally splitting the
 * result into separate nodes) and finding erasable targets.
 */
import type { Document, ID, SubPath, Paint, StrokeStyle, PathNode, Rect, FillRule } from '@/model/types';
import type { EditorState } from '@/store/store';
import { addNode, removeNode, setWorldSubPaths, indexInParent, collectPaths, selectableNodes, isEditable, descendants, worldMatrix } from '@/model/document';
import { makePath, clonePaint, cloneStroke } from '@/model/nodes';
import { identity } from '@/geometry/matrix';
import { insertionParent } from '@/tools/shapes/tool';
import { islands } from './cut';

export interface NewPathOptions {
  fill: Paint;
  stroke: StrokeStyle;
  name?: string;
  fillRule?: FillRule;
  /** container; defaults to the insertion parent (isolation group or active layer) */
  parent?: ID | null;
  index?: number;
}

/** Create a path node from world-space subpaths inside the given container. */
export function addWorldPath(draft: Document, worldSps: SubPath[], opts: NewPathOptions): PathNode | null {
  const parent = opts.parent === undefined ? insertionParent() : opts.parent;
  if (parent === null || !draft.nodes[parent]) return null;
  const node = makePath([], { fill: clonePaint(opts.fill), stroke: cloneStroke(opts.stroke), name: opts.name ?? 'Path', fillRule: opts.fillRule ?? 'nonzero' });
  addNode(draft, node, parent, opts.index);
  setWorldSubPaths(draft, node.id, worldSps);
  return draft.nodes[node.id] as PathNode;
}

/**
 * Replace a path node's geometry with world-space subpaths. With `split`, each
 * island (outer contour + its holes) and each open subpath becomes its own
 * node placed right above the original. Returns the ids of the resulting nodes
 * (the original id first when it survives); an empty result removes the node.
 */
export function replaceNodeGeometry(draft: Document, id: ID, worldSps: SubPath[], split: boolean): ID[] {
  const n = draft.nodes[id];
  if (!n || n.type !== 'path') return [];
  const sps = worldSps.filter((sp) => sp.anchors.length >= 2);
  if (!sps.length) {
    removeNode(draft, id);
    return [];
  }
  if (!split) {
    setWorldSubPaths(draft, id, sps);
    return [id];
  }
  const groups: SubPath[][] = [];
  const closed = sps.filter((sp) => sp.closed);
  const open = sps.filter((sp) => !sp.closed);
  for (const g of islands(closed)) groups.push(g);
  for (const sp of open) groups.push([sp]);
  if (groups.length <= 1) {
    setWorldSubPaths(draft, id, sps);
    return [id];
  }
  setWorldSubPaths(draft, id, groups[0]);
  const ids: ID[] = [id];
  const base = indexInParent(draft, id);
  for (let k = 1; k < groups.length; k++) {
    const copy = makePath([], {
      fill: clonePaint(n.fill),
      stroke: cloneStroke(n.stroke),
      fillRule: n.fillRule,
      name: n.name,
      opacity: n.opacity,
      blendMode: n.blendMode,
      effects: n.effects,
      transform: identity(),
    });
    if (n.data) copy.data = JSON.parse(JSON.stringify(n.data));
    addNode(draft, copy, n.parent, base + k);
    setWorldSubPaths(draft, copy.id, groups[k]);
    ids.push(copy.id);
  }
  return ids;
}

/** Selected path nodes (descending into groups) that can be edited, in paint order. */
export function selectedEditablePaths(state: EditorState): ID[] {
  return collectPaths(state.doc, state.selection).filter((id) => isEditable(state.doc, id));
}

/** Every visible, unlocked path (inside the isolation group when isolating), in paint order. */
export function allEditablePaths(state: EditorState): ID[] {
  const doc = state.doc;
  if (state.isolationId && doc.nodes[state.isolationId]) return descendants(doc, state.isolationId).filter((id) => doc.nodes[id]?.type === 'path' && isEditable(doc, id));
  return selectableNodes(doc, true).filter((id) => doc.nodes[id]?.type === 'path');
}

/** Paths an eraser-like tool acts on: the selection when there is one, else every editable path. */
export function erasableTargets(state: EditorState): { ids: ID[]; fromSelection: boolean } {
  const sel = selectedEditablePaths(state);
  if (sel.length) return { ids: sel, fromSelection: true };
  return { ids: allEditablePaths(state), fromSelection: false };
}

export function paintEquals(a: Paint, b: Paint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function rectsIntersect(a: Rect | null, b: Rect | null, pad = 0): boolean {
  if (!a || !b) return false;
  return a.x - pad <= b.x + b.width && b.x <= a.x + a.width + pad && a.y - pad <= b.y + b.height && b.y <= a.y + a.height + pad;
}

/** World-space scale of a node (for converting screen tolerances). */
export function nodeScale(doc: Document, id: ID): number {
  const m = worldMatrix(doc, id);
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}
