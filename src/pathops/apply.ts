/**
 * Document-level helpers for the path operations: which paths a command acts
 * on, and replacing originals with result geometry (one place in the tree,
 * appearance inherited, empty groups cleaned up).
 */
import type { Document, ID, Node, PathNode, SubPath, FillRule, Paint, StrokeStyle } from '@/model/types';
import type { EditorState } from '@/store/store';
import { getState, setState } from '@/store/store';
import { collectPaths, isEditable, removeNode, addNode, setWorldSubPaths, descendants, getChildren, topmostOf, sortByPaintOrder } from '@/model/document';
import { makePath, makeGroup } from '@/model/nodes';
import { worldGeom, type PathGeom } from './geometry';

export interface Targets {
  /** editable path nodes (descending into groups), in paint order */
  ids: ID[];
  /** non-empty text objects that were skipped */
  textCount: number;
  /** images / other unsupported objects */
  otherCount: number;
  /** locked or hidden paths */
  lockedCount: number;
}

/** Paths a path operation acts on: the selection expanded into groups, editable only. */
export function selectionTargets(state: EditorState = getState()): Targets {
  const doc = state.doc;
  const roots = sortByPaintOrder(doc, topmostOf(doc, state.selection)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  let textCount = 0;
  let otherCount = 0;
  let lockedCount = 0;
  for (const r of roots) {
    for (const d of descendants(doc, r, true)) {
      const n = doc.nodes[d];
      if (!n) continue;
      if (n.type === 'text') {
        if (n.text.trim()) textCount++;
      } else if (n.type === 'image') otherCount++;
      else if (n.type === 'path' && !isEditable(doc, d)) lockedCount++;
    }
  }
  const ids = collectPaths(doc, roots).filter((id) => isEditable(doc, id));
  return { ids, textCount, otherCount, lockedCount };
}

/** Number of editable paths in the selection (for `enabled` predicates). */
export function targetCount(state: EditorState): number {
  if (!state.selection.length) return 0;
  return selectionTargets(state).ids.length;
}

export function targetGeoms(doc: Document, ids: ID[]): PathGeom[] {
  const out: PathGeom[] = [];
  for (const id of ids) {
    const g = worldGeom(doc, id);
    if (g) out.push(g);
  }
  return out;
}

/**
 * Apply a document change as one history step. The store prunes deleted ids
 * from the selection before it records the undo entry, so the entry is patched
 * to remember the selection as it was before the change (undo restores it).
 * Returns false when the document did not change.
 */
export function commitChange(fn: (d: Document) => void, label: string): boolean {
  const s = getState();
  const before = s.selection;
  const version = s.docVersion;
  s.updateDoc(fn, label);
  const st = getState();
  if (st.docVersion === version) return false;
  const past = st.past;
  const last = past[past.length - 1];
  if (last && last.label === label && last.selection !== before) {
    setState({ past: past.slice(0, -1).concat([{ ...last, selection: before }]) });
  }
  return true;
}

/** Toast about skipped objects (text / images / locked). */
export function notifySkipped(t: Targets): void {
  const parts: string[] = [];
  if (t.textCount) parts.push(`${t.textCount} text object${t.textCount > 1 ? 's' : ''} skipped (create outlines first)`);
  if (t.otherCount) parts.push(`${t.otherCount} image${t.otherCount > 1 ? 's' : ''} skipped`);
  if (t.lockedCount) parts.push(`${t.lockedCount} locked or hidden path${t.lockedCount > 1 ? 's' : ''} skipped`);
  if (parts.length) getState().toast(parts.join(', '), 'info');
}

export interface ResultSpec {
  subpaths: SubPath[];
  fillRule: FillRule;
  source: ID;
  fill?: Paint;
  stroke?: StrokeStyle;
  name?: string;
}

/** A new path node carrying the appearance of `source` (geometry set later). */
export function resultNode(source: PathNode, r: Omit<ResultSpec, 'subpaths' | 'source'>): PathNode {
  return makePath([], {
    fill: r.fill ?? source.fill,
    stroke: r.stroke ?? source.stroke,
    fillRule: r.fillRule,
    name: r.name ?? source.name,
    opacity: source.opacity,
    blendMode: source.blendMode,
    effects: source.effects,
  });
}

export interface ReplaceOptions {
  group: boolean;
  groupName?: string;
  /** where the results go: the slot of the top-most (default) or bottom-most original */
  slot?: 'top' | 'bottom';
}

/**
 * Replace the original paths (paint order) with result paths inserted at the
 * slot of the top-most original. Returns the new path ids and the selectable
 * roots (the group when grouped).
 */
export function replaceWithResults(draft: Document, originals: ID[], results: ResultSpec[], opts: ReplaceOptions): { ids: ID[]; roots: ID[] } {
  const set = new Set(originals);
  const anchorId = opts.slot === 'bottom' ? originals[0] : originals[originals.length - 1];
  const anchorNode = draft.nodes[anchorId];
  if (!anchorNode) return { ids: [], roots: [] };
  const parent = anchorNode.parent;
  const siblings = getChildren(draft, parent);
  const idx = siblings.indexOf(anchorId);
  const insertAt = siblings.slice(0, idx).filter((id) => !set.has(id)).length;
  // build result nodes before the originals disappear (appearance sources)
  const built = results.map((r) => {
    const src = (draft.nodes[r.source] ?? anchorNode) as PathNode;
    return { node: resultNode(src, r), subpaths: r.subpaths };
  });
  const formerParents = new Set<ID>();
  for (const id of originals) {
    const n = draft.nodes[id];
    if (!n) continue;
    if (n.parent) formerParents.add(n.parent);
    removeNode(draft, id);
  }
  const ids: ID[] = [];
  let roots: ID[];
  if (opts.group) {
    const g = makeGroup([], { name: opts.groupName ?? 'Group' });
    addNode(draft, g, parent, insertAt);
    for (const b of built) {
      addNode(draft, b.node, g.id);
      setWorldSubPaths(draft, b.node.id, b.subpaths);
      ids.push(b.node.id);
    }
    roots = [g.id];
  } else {
    built.forEach((b, k) => {
      addNode(draft, b.node, parent, insertAt + k);
      setWorldSubPaths(draft, b.node.id, b.subpaths);
      ids.push(b.node.id);
    });
    roots = ids;
  }
  removeEmptyGroups(draft, Array.from(formerParents));
  return { ids, roots };
}

/** Remove groups that lost all their children (walking up the tree). */
export function removeEmptyGroups(draft: Document, candidates: ID[]): void {
  for (const id of candidates) {
    let cur: ID | null = id;
    let guard = 0;
    while (cur && guard++ < 1000) {
      const n: Node | undefined = draft.nodes[cur];
      if (!n || n.type !== 'group' || n.children.length) break;
      const p: ID | null = n.parent;
      removeNode(draft, cur);
      cur = p;
    }
  }
}

/** Insertion index inside `parent` right above `anchorId`, robust to removed siblings. */
export function slotAbove(draft: Document, parent: ID | null, siblingsBefore: ID[]): number {
  const siblings = getChildren(draft, parent);
  let count = 0;
  for (const id of siblingsBefore) if (siblings.includes(id)) count++;
  return count;
}
