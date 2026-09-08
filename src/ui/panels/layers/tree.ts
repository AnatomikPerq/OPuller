/**
 * Pure logic for the Layers panel: flattening the document tree into rows
 * (top-most first, like Illustrator), drop-target resolution for drag & drop,
 * and reparenting that keeps objects where they are on the canvas.
 */
import type { Document, ID, Node, Matrix } from '@/model/types';
import { isContainer } from '@/model/types';
import { moveNode, worldMatrix, bakeTransform, layerOf, sortByPaintOrder, topmostOf, isAncestor, getChildren } from '@/model/document';
import { multiply, invert, identity } from '@/geometry/matrix';

export interface LayerRow {
  id: ID;
  depth: number;
  type: Node['type'];
  parent: ID | null;
  /** index in the parent's children list (or in doc.layers) */
  index: number;
  hasChildren: boolean;
  expanded: boolean;
  /** this node is the clipping mask of its parent group */
  isClip: boolean;
}

export type ExpandedLookup = (id: ID, node: Node) => boolean;
export type RowFilter = (id: ID, node: Node) => boolean;

/** Default expansion when nothing was persisted: layers open, groups closed. */
export function defaultExpanded(node: Node): boolean {
  if (node.type === 'layer') return node.expanded ?? true;
  if (node.type === 'group') return node.expanded ?? false;
  return false;
}

/**
 * Flatten the tree into rows in reverse paint order (top-most first). When a
 * filter is given only matching rows (plus their ancestors) are returned and
 * containers holding matches are expanded.
 */
export function flattenTree(doc: Document, isExpanded: ExpandedLookup, filter?: RowFilter): LayerRow[] {
  const rows: LayerRow[] = [];
  const visit = (id: ID, depth: number, parent: ID | null, index: number, isClip: boolean): boolean => {
    const n = doc.nodes[id];
    if (!n) return false;
    const start = rows.length;
    const container = isContainer(n);
    const self = !filter || filter(id, n);
    const row: LayerRow = { id, depth, type: n.type, parent, index, hasChildren: container && n.children.length > 0, expanded: false, isClip };
    rows.push(row);
    let childMatch = false;
    if (container) {
      const expanded = filter ? true : isExpanded(id, n);
      row.expanded = expanded && n.children.length > 0;
      if (expanded) {
        const clipId = n.type === 'group' ? n.clipId : null;
        for (let i = n.children.length - 1; i >= 0; i--) {
          if (visit(n.children[i], depth + 1, id, i, n.children[i] === clipId)) childMatch = true;
        }
      }
    }
    if (filter && !self && !childMatch) {
      rows.length = start;
      return false;
    }
    return self || childMatch;
  };
  for (let i = doc.layers.length - 1; i >= 0; i--) visit(doc.layers[i], 0, null, i, false);
  return rows;
}

/** Case-insensitive match on the node name or type. */
export function makeNameFilter(text: string): RowFilter | undefined {
  const q = text.trim().toLowerCase();
  if (!q) return undefined;
  return (_id, n) => n.name.toLowerCase().includes(q) || n.type.includes(q);
}

/** Ids of object rows (non-layers) between two rows, inclusive, for shift-range selection. */
export function rowRange(rows: LayerRow[], fromId: ID, toId: ID): ID[] {
  const a = rows.findIndex((r) => r.id === fromId);
  const b = rows.findIndex((r) => r.id === toId);
  if (a < 0 || b < 0) return b >= 0 ? [toId] : [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return rows.slice(lo, hi + 1).filter((r) => r.type !== 'layer').map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

export type DropPosition = 'before' | 'after' | 'inside';

export interface DropTarget {
  /** container receiving the nodes (null = document root, layers only) */
  parent: ID | null;
  /** sibling used as the reference for before/after (null for inside) */
  anchor: ID | null;
  position: DropPosition;
  /** row the indicator is drawn on and where (top edge / bottom edge / whole row) */
  rowIndex: number;
  depth: number;
}

export interface DropProbe {
  /** index of the row under the pointer */
  rowIndex: number;
  /** vertical position inside the row, 0..1 */
  relY: number;
  /** horizontal pointer position relative to the list, px */
  x: number;
  /** indentation in px per depth level (for choosing the level of "after" drops) */
  indent: number;
  /** left offset before indentation starts */
  indentBase: number;
}

/** Whether every dragged node is a top-level layer. */
export function draggingLayers(doc: Document, ids: ID[]): boolean {
  return ids.length > 0 && ids.every((id) => doc.nodes[id]?.type === 'layer');
}

/** Ids that may be dragged together: the top-most of the given ids, all of the same kind (layers vs objects). */
export function normalizeDragIds(doc: Document, ids: ID[]): ID[] {
  const top = topmostOf(doc, ids.filter((id) => !!doc.nodes[id]));
  const layers = top.filter((id) => doc.nodes[id].type === 'layer');
  const objects = top.filter((id) => doc.nodes[id].type !== 'layer');
  return layers.length && !objects.length ? layers : objects;
}

/** Resolve where the dragged nodes would land for a pointer position over the rows. */
export function computeDropTarget(doc: Document, rows: LayerRow[], dragIds: ID[], probe: DropProbe): DropTarget | null {
  if (!rows.length || !dragIds.length) return null;
  const idx = Math.max(0, Math.min(rows.length - 1, probe.rowIndex));
  const row = rows[idx];
  const dragSet = new Set(dragIds);
  const isDragged = (id: ID | null) => !!id && (dragSet.has(id) || dragIds.some((d) => isAncestor(doc, d, id)));

  if (draggingLayers(doc, dragIds)) {
    // layers only move among layers: find the layer block the pointer is over
    const layer = layerOf(doc, row.id);
    if (!layer) return null;
    const headerIndex = rows.findIndex((r) => r.id === layer.id);
    if (headerIndex < 0) return null;
    let lastIndex = headerIndex;
    while (lastIndex + 1 < rows.length && rows[lastIndex + 1].depth > 0) lastIndex++;
    const before = idx === headerIndex && probe.relY < 0.5;
    if (dragSet.has(layer.id)) return null;
    return before
      ? { parent: null, anchor: layer.id, position: 'before', rowIndex: headerIndex, depth: 0 }
      : { parent: null, anchor: layer.id, position: 'after', rowIndex: lastIndex, depth: 0 };
  }

  // objects: never inside themselves
  if (isDragged(row.id)) return null;
  const node = doc.nodes[row.id];
  if (!node) return null;

  if (node.type === 'layer') {
    if (node.locked) return null;
    return { parent: node.id, anchor: null, position: 'inside', rowIndex: idx, depth: 1 };
  }
  const container = isContainer(node);
  let position: DropPosition;
  if (container) {
    if (probe.relY < 0.25) position = 'before';
    else if (row.expanded) position = 'inside';
    else if (probe.relY > 0.75) position = 'after';
    else position = 'inside';
  } else position = probe.relY < 0.5 ? 'before' : 'after';

  if (position === 'inside') {
    if (isDragged(node.id)) return null;
    return { parent: node.id, anchor: null, position: 'inside', rowIndex: idx, depth: row.depth + 1 };
  }

  let target: LayerRow = row;
  if (position === 'after') {
    // dropping below the last child of a group: the pointer's x decides the nesting level
    let guard = 0;
    while (guard++ < 100 && target.index === 0 && target.parent && doc.nodes[target.parent]?.type === 'group' && probe.x < probe.indentBase + target.depth * probe.indent) {
      const parentRow = rows.find((r) => r.id === target.parent);
      if (!parentRow) break;
      target = parentRow;
    }
  }
  if (isDragged(target.parent)) return null;
  if (isDragged(target.id)) return null;
  const parentNode = target.parent ? doc.nodes[target.parent] : undefined;
  if (parentNode && parentNode.locked) return null;
  return { parent: target.parent, anchor: target.id, position, rowIndex: position === 'before' ? idx : rows.indexOf(target), depth: target.depth };
}

/**
 * Reparent a node keeping its world-space position (the transform is
 * re-expressed in the new parent's space). Paths get the result baked.
 */
export function moveNodeKeepWorld(doc: Document, id: ID, parentId: ID | null, index?: number): void {
  const n = doc.nodes[id];
  if (!n) return;
  const wm = worldMatrix(doc, id);
  const oldParent = n.parent;
  moveNode(doc, id, parentId, index);
  // move refused (invalid target) or a reorder inside the same parent: nothing to re-express
  if (n.parent !== parentId || oldParent === parentId) return;
  const pw: Matrix = parentId ? worldMatrix(doc, parentId) : identity();
  n.transform = multiply(invert(pw), wm);
  if (n.type === 'path') bakeTransform(doc, id);
}

/** Apply a drop: move the dragged nodes (bottom-most first) so their relative order is kept. */
export function applyDrop(doc: Document, dragIds: ID[], target: DropTarget): ID[] {
  const ids = sortByPaintOrder(doc, normalizeDragIds(doc, dragIds));
  if (!ids.length) return [];
  let inserted = 0;
  for (const id of ids) {
    const list = getChildren(doc, target.parent);
    let index: number | undefined;
    if (target.position === 'inside' || !target.anchor) index = undefined;
    else {
      const ai = list.indexOf(target.anchor);
      if (ai < 0) index = undefined;
      else if (target.position === 'before') index = ai + 1 + inserted;
      else index = ai;
    }
    moveNodeKeepWorld(doc, id, target.parent, index);
    inserted++;
  }
  return ids;
}

/** Index (0..rows.length) at which an insertion line should be drawn for a target. */
export function indicatorLine(target: DropTarget): { rowIndex: number; edge: 'top' | 'bottom' } {
  return target.position === 'before' ? { rowIndex: target.rowIndex, edge: 'top' } : { rowIndex: target.rowIndex, edge: 'bottom' };
}
