/**
 * Brush document operations: definitions, applying brushes to strokes,
 * building artwork brushes from selected nodes, expanding brush strokes into
 * plain paths. All functions mutate an immer draft.
 */
import type { Document, ID, Node, BrushDef, BrushArtwork, StrokeStyle, PathNode, StrokeBrush } from '@/model/types';
import { makeGroup, makePath, newId, cloneStroke, clonePaint } from '@/model/nodes';
import { addNode, removeNode, cloneSubtree, deepClone, worldMatrix, worldBounds, sortByPaintOrder, topmostOf, indexInParent } from '@/model/document';
import { multiply, translate, identity } from '@/geometry/matrix';
import { rectUnion } from '@/geometry/vec';
import { noStroke } from '@/model/defaults';
import { brushItems } from './geometry';
import { effectiveSubPaths } from '@/canvas/effectiveGeometry';

export function getBrush(doc: Document, id: ID | null | undefined): BrushDef | undefined {
  return id ? doc.brushes.find((b) => b.id === id) : undefined;
}

export function uniqueBrushName(doc: Document, base: string): string {
  const names = new Set(doc.brushes.map((b) => b.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
  return base;
}

export function addBrushDef(doc: Document, def: BrushDef): BrushDef {
  const copy = { ...deepClone(def), id: def.id && !doc.brushes.some((b) => b.id === def.id) ? def.id : newId(), name: uniqueBrushName(doc, def.name) } as BrushDef;
  doc.brushes.push(copy);
  return copy;
}

/** Copy world-space nodes into brush artwork centred on the bounds centre (art brushes: left edge = start). */
export function artworkFromNodes(doc: Document, ids: ID[], name: string): BrushArtwork | null {
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  if (!members.length) return null;
  let bounds = null as ReturnType<typeof worldBounds>;
  for (const id of members) bounds = rectUnion(bounds, worldBounds(doc, id));
  if (!bounds) return null;
  const root = makeGroup([], { name });
  root.parent = null;
  root.transform = identity();
  const nodes: Record<ID, Node> = { [root.id]: root };
  const toArt = translate(-(bounds.x + bounds.width / 2), -(bounds.y + bounds.height / 2));
  for (const id of members) {
    const { root: copy, nodes: all } = cloneSubtree(doc, id);
    copy.transform = multiply(toArt, worldMatrix(doc, id));
    copy.parent = root.id;
    for (const n of all) nodes[n.id] = n;
    root.children.push(copy.id);
  }
  return { nodes, root: root.id };
}

/** Strokes (path nodes) using the brush. */
export function nodesUsingBrush(doc: Document, brushId: ID): ID[] {
  const out: ID[] = [];
  for (const n of Object.values(doc.nodes)) if (n.type === 'path' && n.stroke.brush?.id === brushId) out.push(n.id);
  return out;
}

export function updateBrush(doc: Document, id: ID, patch: Partial<BrushDef>): BrushDef | null {
  const i = doc.brushes.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const next = { ...doc.brushes[i], ...patch, id, kind: doc.brushes[i].kind } as BrushDef;
  if (patch.name !== undefined) next.name = uniqueBrushName({ ...doc, brushes: doc.brushes.filter((b) => b.id !== id) } as Document, patch.name.trim() || next.name);
  doc.brushes[i] = next;
  return next;
}

/** Delete a brush; strokes either keep their look (expand) or become plain strokes. */
export function deleteBrush(doc: Document, id: ID, mode: 'expand' | 'remove' = 'remove'): number {
  const users = nodesUsingBrush(doc, id);
  for (const nid of users) {
    if (mode === 'expand') expandBrushStroke(doc, nid);
    else {
      const n = doc.nodes[nid] as PathNode;
      const { brush: _b, ...rest } = n.stroke;
      n.stroke = rest;
    }
  }
  doc.brushes = doc.brushes.filter((b) => b.id !== id);
  return users.length;
}

/** Apply a brush to a path's stroke (ensures a visible stroke paint and a unit weight). */
export function applyBrushToNode(doc: Document, nodeId: ID, brush: StrokeBrush | null): boolean {
  const n = doc.nodes[nodeId];
  if (!n || n.type !== 'path') return false;
  if (!brush) {
    const { brush: _b, ...rest } = n.stroke;
    n.stroke = rest;
    return true;
  }
  if (n.stroke.brush && JSON.stringify(n.stroke.brush) === JSON.stringify(brush) && n.stroke.paint.type !== 'none' && n.stroke.width > 0) return false;
  const stroke: StrokeStyle = { ...n.stroke, brush: { ...brush }, widthProfile: undefined, dash: [], markerStart: 'none', markerEnd: 'none' };
  if (stroke.paint.type === 'none') stroke.paint = n.fill.type === 'solid' ? clonePaint(n.fill) : { type: 'solid', color: '#000000', opacity: 1 };
  if (stroke.width <= 0) stroke.width = 1;
  n.stroke = stroke;
  return true;
}

/**
 * Replace a brush stroke by a group of plain paths (the fill path, then the
 * brush items). Returns the group id (or the node id when nothing changed).
 */
export function expandBrushStroke(doc: Document, nodeId: ID): ID | null {
  const n = doc.nodes[nodeId];
  if (!n || n.type !== 'path' || !n.stroke.brush) return null;
  const def = getBrush(doc, n.stroke.brush.id);
  if (!def) return null;
  const items = brushItems(def, effectiveSubPaths(n), n.stroke, n.id);
  const parent = n.parent;
  const index = indexInParent(doc, nodeId);
  const g = makeGroup([], { name: `${n.name} (brush)`, transform: n.transform, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects });
  addNode(doc, g, parent, index + 1);
  if (n.fill.type !== 'none') {
    const fillPath = makePath(deepClone(n.subpaths), { name: n.name, fill: clonePaint(n.fill), stroke: noStroke(), fillRule: n.fillRule, shape: n.shape ? { ...n.shape } : undefined });
    addNode(doc, fillPath, g.id);
  }
  items.forEach((it, i) => {
    const p = makePath(it.subpaths, { name: `${def.name} ${i + 1}`, fill: clonePaint(it.fill), stroke: it.stroke ? cloneStroke(it.stroke) : noStroke(), fillRule: it.fillRule, opacity: it.opacity });
    addNode(doc, p, g.id);
  });
  removeNode(doc, nodeId);
  return g.id;
}
