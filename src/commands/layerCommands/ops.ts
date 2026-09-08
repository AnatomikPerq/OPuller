/**
 * Layer operations shared by the Layers panel, its context menu and the
 * Object > Layers commands. Every function records exactly one history step.
 */
import type { ID, Document, Node } from '@/model/types';
import { isContainer } from '@/model/types';
import { getState } from '@/store/store';
import { makeLayer, makeGroup, newId } from '@/model/nodes';
import { addNode, removeNode, cloneSubtree, addSubtree, indexInParent, sortByPaintOrder, topmostOf, layerOf, getChildren, descendants } from '@/model/document';
import { LAYER_COLORS } from '@/model/defaults';
import { moveNodeKeepWorld } from '@/ui/panels/layers/tree';

/** "Layer N" with N above every existing numbered layer. */
export function nextLayerName(doc: Document, prefix = 'Layer'): string {
  let max = 0;
  const re = new RegExp(`^${prefix}\\s+(\\d+)$`);
  for (const n of Object.values(doc.nodes)) {
    const m = n.name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix} ${Math.max(max, 0) + 1}`;
}

export function nextLayerColor(doc: Document): string {
  const used = new Set(doc.layers.map((id) => (doc.nodes[id] as { color?: string }).color));
  for (const c of LAYER_COLORS) if (!used.has(c)) return c;
  return LAYER_COLORS[doc.layers.length % LAYER_COLORS.length];
}

/** Create a new layer above the given (or active) layer and make it active. */
export function newLayer(opts: { above?: ID | null; name?: string; color?: string } = {}): ID {
  const s = getState();
  const doc = s.doc;
  const ref = opts.above ?? s.activeLayerId ?? doc.layers[doc.layers.length - 1] ?? null;
  const layer = makeLayer({ name: opts.name ?? nextLayerName(doc), color: opts.color ?? nextLayerColor(doc) }, doc.layers.length);
  s.updateDoc((d) => {
    const i = ref ? d.layers.indexOf(ref) : -1;
    addNode(d, layer, null, i >= 0 ? i + 1 : undefined);
  }, 'New Layer');
  s.setActiveLayer(layer.id);
  return layer.id;
}

/** New sublayer (a group) at the top of the active layer / selected group. */
export function newSublayer(parentId?: ID | null): ID | null {
  const s = getState();
  const doc = s.doc;
  let parent: ID | null = parentId ?? null;
  if (!parent) {
    const g = s.selection.find((id) => doc.nodes[id]?.type === 'group');
    parent = g ?? s.activeLayerId ?? doc.layers[doc.layers.length - 1] ?? null;
  }
  if (!parent || !isContainer(doc.nodes[parent])) return null;
  const group = makeGroup([], { name: nextLayerName(doc, 'Sublayer') });
  group.expanded = true;
  s.updateDoc((d) => addNode(d, group, parent), 'New Sublayer');
  return group.id;
}

export function duplicateLayers(ids: ID[]): ID[] {
  const s = getState();
  const layers = sortByPaintOrder(s.doc, ids.filter((id) => s.doc.nodes[id]?.type === 'layer'));
  if (!layers.length) return [];
  const out: ID[] = [];
  s.updateDoc((d) => {
    for (const id of layers) {
      const { root, nodes } = cloneSubtree(d, id);
      root.name = `${d.nodes[id].name} copy`;
      addSubtree(d, root, nodes, null, indexInParent(d, id) + 1);
      out.push(root.id);
    }
  }, layers.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer');
  if (out.length) s.setActiveLayer(out[out.length - 1]);
  return out;
}

/** Delete layers (the document always keeps at least one layer). */
export function deleteLayers(ids: ID[]): void {
  const s = getState();
  const layers = ids.filter((id) => s.doc.nodes[id]?.type === 'layer');
  if (!layers.length) return;
  s.updateDoc((d) => {
    for (const id of layers) {
      if (d.layers.length <= 1) break;
      removeNode(d, id);
    }
  }, layers.length > 1 ? 'Delete Layers' : 'Delete Layer');
}

/** Merge layers into the top-most of them; the others are removed. */
export function mergeLayers(ids: ID[]): ID | null {
  const s = getState();
  const layers = sortByPaintOrder(s.doc, Array.from(new Set(ids.filter((id) => s.doc.nodes[id]?.type === 'layer'))));
  if (layers.length < 2) return null;
  const target = layers[layers.length - 1];
  s.updateDoc((d) => {
    // insert the content of lower layers below the target's existing content, keeping paint order
    let insertAt = 0;
    for (const id of layers) {
      if (id === target) break;
      const children = [...getChildren(d, id)];
      for (const c of children) {
        moveNodeKeepWorld(d, c, target, insertAt);
        insertAt++;
      }
      removeNode(d, id);
    }
  }, 'Merge Layers');
  s.setActiveLayer(target);
  return target;
}

/** Move the selected objects into a new layer placed above the top-most layer they came from. */
export function collectInNewLayer(ids: ID[] = getState().selection): ID | null {
  const s = getState();
  const doc = s.doc;
  const objects = sortByPaintOrder(doc, topmostOf(doc, ids).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer'));
  if (!objects.length) return null;
  let topLayer: ID | null = null;
  let topIndex = -1;
  for (const id of objects) {
    const l = layerOf(doc, id);
    if (!l) continue;
    const i = doc.layers.indexOf(l.id);
    if (i > topIndex) {
      topIndex = i;
      topLayer = l.id;
    }
  }
  const layer = makeLayer({ name: nextLayerName(doc), color: nextLayerColor(doc) }, doc.layers.length);
  s.updateDoc((d) => {
    addNode(d, layer, null, topLayer ? d.layers.indexOf(topLayer) + 1 : undefined);
    for (const id of objects) moveNodeKeepWorld(d, id, layer.id);
  }, 'Collect in New Layer');
  s.setActiveLayer(layer.id);
  s.setSelection(objects);
  return layer.id;
}

/** Release to Layers (Sequence): every child of the container becomes its own sublayer (group). */
export function releaseToLayers(containerId?: ID | null): ID[] {
  const s = getState();
  const doc = s.doc;
  const id = containerId ?? s.selection.find((x) => doc.nodes[x]?.type === 'group') ?? s.activeLayerId ?? null;
  if (!id) return [];
  const n = doc.nodes[id];
  if (!n || !isContainer(n) || !n.children.length) return [];
  const created: ID[] = [];
  s.updateDoc((d) => {
    const c = d.nodes[id];
    if (!isContainer(c)) return;
    const children = [...c.children];
    children.forEach((cid, i) => {
      const child = d.nodes[cid];
      if (!child) return;
      const g = makeGroup([], { name: `${nextLayerName(d)}` });
      g.name = `Layer ${i + 1}`;
      g.expanded = true;
      addNode(d, g, id, i);
      // the wrapper is placed where the child was; move the child inside (identity transform → position kept)
      moveNodeKeepWorld(d, cid, g.id);
      created.push(g.id);
    });
  }, 'Release to Layers');
  return created;
}

/** Flatten all layers into the target (active) layer; other layers are removed. */
export function flattenArtwork(targetId?: ID | null): void {
  const s = getState();
  const doc = s.doc;
  const target = targetId ?? s.activeLayerId ?? doc.layers[doc.layers.length - 1];
  if (!target || doc.nodes[target]?.type !== 'layer' || doc.layers.length < 2) return;
  s.updateDoc((d) => {
    const order = [...d.layers];
    const ti = order.indexOf(target);
    // layers below the target go under its content, layers above on top
    let insertAt = 0;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      if (id === target) {
        insertAt = getChildren(d, target).length;
        continue;
      }
      const children = [...getChildren(d, id)];
      for (const c of children) {
        moveNodeKeepWorld(d, c, target, i < ti ? insertAt++ : undefined);
      }
      removeNode(d, id);
    }
  }, 'Flatten Artwork');
  s.setActiveLayer(target);
}

/** Lock every sibling of the given nodes (Illustrator: Lock Others). */
export function lockOthers(ids: ID[]): void {
  const s = getState();
  const keep = new Set(ids);
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n) continue;
      for (const sib of getChildren(d, n.parent)) if (!keep.has(sib)) d.nodes[sib].locked = true;
      d.nodes[id].locked = false;
    }
  }, 'Lock Others');
}

export function hideOthers(ids: ID[]): void {
  const s = getState();
  const keep = new Set(ids);
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n) continue;
      for (const sib of getChildren(d, n.parent)) if (!keep.has(sib)) d.nodes[sib].visible = false;
      d.nodes[id].visible = true;
    }
  }, 'Hide Others');
}

/** Alt-click on the eye: show only this node among its siblings, or show all when it is already alone. */
export function soloVisibility(id: ID): void {
  const s = getState();
  const n = s.doc.nodes[id];
  if (!n) return;
  const siblings = getChildren(s.doc, n.parent).filter((x) => x !== id);
  const othersVisible = siblings.some((x) => s.doc.nodes[x]?.visible);
  s.updateDoc((d) => {
    d.nodes[id].visible = true;
    for (const x of siblings) if (d.nodes[x]) d.nodes[x].visible = !othersVisible;
  }, othersVisible ? 'Solo' : 'Show All');
}

export function soloLock(id: ID): void {
  const s = getState();
  const n = s.doc.nodes[id];
  if (!n) return;
  const siblings = getChildren(s.doc, n.parent).filter((x) => x !== id);
  const othersUnlocked = siblings.some((x) => !s.doc.nodes[x]?.locked);
  s.updateDoc((d) => {
    d.nodes[id].locked = false;
    for (const x of siblings) if (d.nodes[x]) d.nodes[x].locked = othersUnlocked;
  }, othersUnlocked ? 'Lock Others' : 'Unlock All');
}

export function setNodeVisible(id: ID, visible: boolean): void {
  getState().updateDoc((d) => {
    if (d.nodes[id]) d.nodes[id].visible = visible;
  }, visible ? 'Show' : 'Hide');
}

export function setNodeLocked(id: ID, locked: boolean): void {
  const s = getState();
  s.updateDoc((d) => {
    if (d.nodes[id]) d.nodes[id].locked = locked;
  }, locked ? 'Lock' : 'Unlock');
  if (locked) {
    const inside = new Set(descendants(s.doc, id, true));
    if (s.selection.some((x) => inside.has(x))) s.setSelection(s.selection.filter((x) => !inside.has(x)));
  }
}

export function renameNode(id: ID, name: string): void {
  const s = getState();
  const n = s.doc.nodes[id];
  const clean = name.trim();
  if (!n || !clean || n.name === clean) return;
  s.updateDoc((d) => {
    if (d.nodes[id]) d.nodes[id].name = clean;
  }, 'Rename');
}

/** Selectable content of a layer/group (its direct children that are editable). */
export function containerContents(doc: Document, id: ID): ID[] {
  const n: Node | undefined = doc.nodes[id];
  if (!n || !isContainer(n)) return [];
  return n.children.filter((c) => {
    const cn = doc.nodes[c];
    return cn && cn.visible && !cn.locked;
  });
}

export function selectContents(id: ID, add = false): void {
  const s = getState();
  const ids = containerContents(s.doc, id);
  if (add) s.addToSelection(ids);
  else s.setSelection(ids);
}

export { newId };
