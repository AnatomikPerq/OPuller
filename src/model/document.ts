/**
 * Pure operations on the document tree. All mutating functions expect an immer
 * draft (or a mutable copy) of the document; queries work on any document.
 */
import type { Document, ID, Node, ContainerNode, Matrix, Rect, SubPath, PathNode, LayerNode, GroupNode, Vec } from './types';
import { isContainer } from './types';
import { identity, multiply, invert, applyToRect, isIdentity, scaleFactor, applyToPoint } from '@/geometry/matrix';
import { pathBounds, transformSubPaths, cloneSubPaths } from '@/geometry/path';
import { rectUnion } from '@/geometry/vec';
import { layoutText } from '@/text/layout';
import { liveShapeSubPaths } from '@/geometry/shapes';
import { newId } from './nodes';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getNode(doc: Document, id: ID | null | undefined): Node | undefined {
  return id ? doc.nodes[id] : undefined;
}

export function getContainer(doc: Document, id: ID | null | undefined): ContainerNode | undefined {
  const n = getNode(doc, id);
  return isContainer(n) ? n : undefined;
}

export function getChildren(doc: Document, id: ID | null): ID[] {
  if (id === null) return doc.layers;
  const n = doc.nodes[id];
  return isContainer(n) ? n.children : [];
}

export function getParent(doc: Document, id: ID): Node | undefined {
  const n = doc.nodes[id];
  return n && n.parent ? doc.nodes[n.parent] : undefined;
}

/** Ancestors from nearest parent up to the layer. */
export function ancestors(doc: Document, id: ID): ID[] {
  const out: ID[] = [];
  let cur = doc.nodes[id]?.parent ?? null;
  let guard = 0;
  while (cur && guard++ < 10000) {
    out.push(cur);
    cur = doc.nodes[cur]?.parent ?? null;
  }
  return out;
}

export function isAncestor(doc: Document, maybeAncestor: ID, id: ID): boolean {
  return ancestors(doc, id).includes(maybeAncestor);
}

/** The layer that contains the node (or the node itself if it is a layer). */
export function layerOf(doc: Document, id: ID): LayerNode | undefined {
  let n = doc.nodes[id];
  let guard = 0;
  while (n && n.type !== 'layer' && guard++ < 10000) n = n.parent ? doc.nodes[n.parent] : (undefined as any);
  return n && n.type === 'layer' ? n : undefined;
}

/** Depth-first descendants in paint order (bottom to top). */
export function descendants(doc: Document, id: ID, includeSelf = false): ID[] {
  const out: ID[] = [];
  const visit = (nid: ID) => {
    const n = doc.nodes[nid];
    if (!n) return;
    out.push(nid);
    if (isContainer(n)) for (const c of n.children) visit(c);
  };
  const root = doc.nodes[id];
  if (!root) return out;
  if (includeSelf) visit(id);
  else if (isContainer(root)) for (const c of root.children) visit(c);
  return out;
}

/** All nodes in paint order (bottom to top), layers included. */
export function paintOrder(doc: Document): ID[] {
  const out: ID[] = [];
  for (const l of doc.layers) out.push(...descendants(doc, l, true));
  return out;
}

export function indexInParent(doc: Document, id: ID): number {
  const n = doc.nodes[id];
  if (!n) return -1;
  return getChildren(doc, n.parent).indexOf(id);
}

/** Whether all ancestors and the node itself are visible. */
export function isEffectivelyVisible(doc: Document, id: ID): boolean {
  let n: Node | undefined = doc.nodes[id];
  while (n) {
    if (!n.visible) return false;
    n = n.parent ? doc.nodes[n.parent] : undefined;
  }
  return true;
}

export function isEffectivelyLocked(doc: Document, id: ID): boolean {
  let n: Node | undefined = doc.nodes[id];
  while (n) {
    if (n.locked) return true;
    n = n.parent ? doc.nodes[n.parent] : undefined;
  }
  return false;
}

/** Is the node editable: visible, unlocked (including ancestors). */
export function isEditable(doc: Document, id: ID): boolean {
  return isEffectivelyVisible(doc, id) && !isEffectivelyLocked(doc, id);
}

/**
 * Top-level selectable objects (children of layers, walking into groups only when
 * `enterGroups` is set), in paint order.
 */
export function selectableNodes(doc: Document, enterGroups = false): ID[] {
  const out: ID[] = [];
  const visit = (id: ID) => {
    const n = doc.nodes[id];
    if (!n || !n.visible || n.locked) return;
    if (n.type === 'layer') {
      for (const c of n.children) visit(c);
      return;
    }
    if (n.type === 'group' && enterGroups) {
      for (const c of n.children) visit(c);
      return;
    }
    out.push(id);
  };
  for (const l of doc.layers) visit(l);
  return out;
}

/** Reduce a set of ids to those whose ancestors are not also in the set. */
export function topmostOf(doc: Document, ids: ID[]): ID[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestors(doc, id).some((a) => set.has(a)));
}

/** Sort ids by paint order (bottom first). */
export function sortByPaintOrder(doc: Document, ids: ID[]): ID[] {
  const order = paintOrder(doc);
  const idx = new Map(order.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Insert a node (and nothing else) into the tree. `index` undefined = on top. */
export function addNode(doc: Document, node: Node, parentId: ID | null, index?: number): void {
  node.parent = parentId;
  doc.nodes[node.id] = node;
  const list = parentId === null ? doc.layers : getChildren(doc, parentId);
  if (parentId !== null && !isContainer(doc.nodes[parentId])) throw new Error('Parent is not a container');
  if (index === undefined || index < 0 || index > list.length) list.push(node.id);
  else list.splice(index, 0, node.id);
}

/** Insert a whole subtree (nodes must already have consistent parent links among themselves). */
export function addSubtree(doc: Document, root: Node, all: Node[], parentId: ID | null, index?: number): void {
  for (const n of all) doc.nodes[n.id] = n;
  addNode(doc, root, parentId, index);
}

/** Remove a node and all its descendants. */
export function removeNode(doc: Document, id: ID): void {
  const n = doc.nodes[id];
  if (!n) return;
  const list = n.parent === null ? doc.layers : getChildren(doc, n.parent);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  const parent = n.parent ? doc.nodes[n.parent] : undefined;
  if (parent && parent.type === 'group' && parent.clipId === id) parent.clipId = null;
  for (const d of descendants(doc, id, true)) delete doc.nodes[d];
  // clean text-on-path references
  for (const other of Object.values(doc.nodes)) {
    if (other.type === 'text' && other.pathId === id) {
      other.pathId = null;
      other.kind = 'point';
    }
  }
}

/** Reparent a node. Index refers to the position in the *new* parent's list. */
export function moveNode(doc: Document, id: ID, parentId: ID | null, index?: number): void {
  const n = doc.nodes[id];
  if (!n) return;
  if (parentId === id || (parentId && isAncestor(doc, id, parentId))) return;
  if (parentId === null && n.type !== 'layer') return;
  if (parentId !== null && n.type === 'layer') return;
  const oldList = n.parent === null ? doc.layers : getChildren(doc, n.parent);
  const oldIndex = oldList.indexOf(id);
  if (oldIndex >= 0) oldList.splice(oldIndex, 1);
  const oldParent = n.parent ? doc.nodes[n.parent] : undefined;
  if (oldParent && oldParent.type === 'group' && oldParent.clipId === id) oldParent.clipId = null;
  const newList = parentId === null ? doc.layers : getChildren(doc, parentId);
  let idx = index;
  if (idx !== undefined && oldList === newList && oldIndex >= 0 && oldIndex < idx) idx -= 1;
  n.parent = parentId;
  if (idx === undefined || idx < 0 || idx > newList.length) newList.push(id);
  else newList.splice(idx, 0, id);
}

/** Deep clone a subtree with fresh ids. Returns the new root and all new nodes. */
export function cloneSubtree(doc: Document, id: ID): { root: Node; nodes: Node[] } {
  const nodes: Node[] = [];
  const idMap = new Map<ID, ID>();
  const collect = (nid: ID) => {
    idMap.set(nid, newId());
    const n = doc.nodes[nid];
    if (isContainer(n)) for (const c of n.children) collect(c);
  };
  collect(id);
  const build = (nid: ID, parent: ID | null): Node => {
    const src = doc.nodes[nid];
    const copy: Node = deepClone(src);
    copy.id = idMap.get(nid)!;
    copy.parent = parent;
    if (isContainer(copy)) {
      copy.children = (src as ContainerNode).children.map((c) => idMap.get(c)!);
      if (copy.type === 'group') copy.clipId = copy.clipId ? (idMap.get(copy.clipId) ?? null) : null;
      for (const c of (src as ContainerNode).children) build(c, copy.id);
    }
    if (copy.type === 'text' && copy.pathId) copy.pathId = idMap.get(copy.pathId) ?? copy.pathId;
    nodes.push(copy);
    return copy;
  };
  const root = build(id, null);
  return { root, nodes };
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Group nodes: the group is placed where the top-most member was. Returns the group id. */
export function groupNodes(doc: Document, ids: ID[], group: GroupNode): ID {
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id]?.type !== 'layer');
  if (!members.length) return '';
  const top = members[members.length - 1];
  const parentId = doc.nodes[top].parent;
  const index = indexInParent(doc, top);
  // group's transform is identity in the parent's space; members keep their transforms
  // (members from other parents are re-expressed in the new parent's space)
  const parentWorld = parentId ? worldMatrix(doc, parentId) : identity();
  const invParent = invert(parentWorld);
  addNode(doc, group, parentId, index + 1);
  for (const id of members) {
    const world = worldMatrix(doc, id);
    moveNode(doc, id, group.id);
    doc.nodes[id].transform = multiply(invParent, world);
  }
  return group.id;
}

/** Ungroup: children are moved into the group's parent at the group's index; the group is removed. */
export function ungroupNode(doc: Document, id: ID): ID[] {
  const g = doc.nodes[id];
  if (!g || g.type !== 'group') return [];
  const parentId = g.parent;
  const index = indexInParent(doc, id);
  const gm = g.transform;
  const children = [...g.children];
  children.forEach((cid, i) => {
    const child = doc.nodes[cid];
    child.transform = multiply(gm, child.transform);
    moveNode(doc, cid, parentId, index + 1 + i);
  });
  removeNode(doc, id);
  return children;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** Matrix mapping the node's local space to world space. */
export function worldMatrix(doc: Document, id: ID): Matrix {
  const chain: Matrix[] = [];
  let n: Node | undefined = doc.nodes[id];
  while (n) {
    chain.push(n.transform);
    n = n.parent ? doc.nodes[n.parent] : undefined;
  }
  let m = identity();
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, chain[i]);
  return m;
}

export function parentWorldMatrix(doc: Document, id: ID): Matrix {
  const n = doc.nodes[id];
  return n?.parent ? worldMatrix(doc, n.parent) : identity();
}

/**
 * Apply a world-space matrix to a node (i.e. the node's world transform becomes
 * `m * world`). Paths without live shapes get the transform baked into geometry.
 */
export function applyWorldMatrix(doc: Document, id: ID, m: Matrix, bake = true): void {
  const n = doc.nodes[id];
  if (!n) return;
  const pw = parentWorldMatrix(doc, id);
  const local = multiply(multiply(invert(pw), m), multiply(pw, n.transform));
  n.transform = local;
  if (bake) bakeTransform(doc, id);
}

/** Apply a matrix in the node's parent space. */
export function applyParentMatrix(doc: Document, id: ID, m: Matrix, bake = true): void {
  const n = doc.nodes[id];
  if (!n) return;
  n.transform = multiply(m, n.transform);
  if (bake) bakeTransform(doc, id);
}

/**
 * Bake the node's transform into its geometry when that is lossless:
 * - plain paths: geometry is transformed, transform becomes identity
 * - live rect/ellipse under pure scale: parameters are scaled, translation/rotation kept
 * Other node types keep their matrix.
 */
export function bakeTransform(doc: Document, id: ID): void {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path') return;
  const m = n.transform;
  if (isIdentity(m)) return;
  if (n.shape) {
    // keep live shapes when the matrix is a similarity/scale (no skew)
    const pureScale = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
    if (pureScale && (n.shape.kind === 'rect' || n.shape.kind === 'ellipse' || n.shape.kind === 'line')) {
      const sx = m.a;
      const sy = m.d;
      if (n.shape.kind === 'rect') {
        const w = n.shape.width * sx;
        const h = n.shape.height * sy;
        // normalise negative sizes by moving the origin
        const ox = w < 0 ? w : 0;
        const oy = h < 0 ? h : 0;
        n.shape = { ...n.shape, width: Math.abs(w), height: Math.abs(h), radii: n.shape.radii.map((r) => r * Math.min(Math.abs(sx), Math.abs(sy))) as [number, number, number, number] };
        n.transform = { a: 1, b: 0, c: 0, d: 1, e: m.e + ox, f: m.f + oy };
      } else if (n.shape.kind === 'ellipse') {
        n.shape = { ...n.shape, rx: Math.abs(n.shape.rx * sx), ry: Math.abs(n.shape.ry * sy) };
        n.transform = { a: 1, b: 0, c: 0, d: 1, e: m.e, f: m.f };
      } else if (n.shape.kind === 'line') {
        n.shape = { ...n.shape, x1: n.shape.x1 * sx, y1: n.shape.y1 * sy, x2: n.shape.x2 * sx, y2: n.shape.y2 * sy };
        n.transform = { a: 1, b: 0, c: 0, d: 1, e: m.e, f: m.f };
      }
      n.subpaths = liveShapeSubPaths(n.shape);
      return;
    }
    const uniform = Math.abs(m.a * m.a + m.b * m.b - (m.c * m.c + m.d * m.d)) < 1e-6 && Math.abs(m.a * m.c + m.b * m.d) < 1e-6;
    if (uniform && (n.shape.kind === 'polygon' || n.shape.kind === 'star' || n.shape.kind === 'ellipse' || n.shape.kind === 'rect')) {
      // rotation + uniform scale: scale parameters, keep rotation & translation
      const s = Math.hypot(m.a, m.b);
      const rot = { a: m.a / s, b: m.b / s, c: m.c / s, d: m.d / s, e: m.e, f: m.f };
      if (n.shape.kind === 'polygon') n.shape = { ...n.shape, radius: n.shape.radius * s };
      else if (n.shape.kind === 'star') n.shape = { ...n.shape, outerRadius: n.shape.outerRadius * s, innerRadius: n.shape.innerRadius * s };
      else if (n.shape.kind === 'ellipse') n.shape = { ...n.shape, rx: n.shape.rx * s, ry: n.shape.ry * s };
      else if (n.shape.kind === 'rect') n.shape = { ...n.shape, width: n.shape.width * s, height: n.shape.height * s, radii: n.shape.radii.map((r) => r * s) as [number, number, number, number] };
      n.subpaths = liveShapeSubPaths(n.shape);
      n.transform = rot;
      return;
    }
    // anything else: drop the live shape
    n.shape = undefined;
  }
  n.subpaths = transformSubPaths(n.subpaths, m);
  n.transform = identity();
}

/** Regenerate geometry from live shape params (call after editing `shape`). */
export function refreshLiveShape(n: PathNode): void {
  if (n.shape) n.subpaths = liveShapeSubPaths(n.shape);
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const leafBoundsCache = new WeakMap<Node, Rect | null>();

/** Geometry bounds in the node's local space (no stroke). */
export function localBounds(doc: Document, id: ID): Rect | null {
  const n = doc.nodes[id];
  if (!n) return null;
  switch (n.type) {
    case 'path': {
      const c = leafBoundsCache.get(n);
      if (c !== undefined) return c;
      const b = pathBounds(n.subpaths);
      leafBoundsCache.set(n, b);
      return b;
    }
    case 'text': {
      const c = leafBoundsCache.get(n);
      if (c !== undefined) return c;
      let b: Rect | null;
      if (n.kind === 'path' && n.pathId && doc.nodes[n.pathId]) {
        const p = doc.nodes[n.pathId];
        b = p.type === 'path' ? applyToRect(p.transform, pathBounds(p.subpaths) ?? { x: 0, y: 0, width: 0, height: 0 }) : null;
        if (b) {
          const pad = n.style.fontSize;
          b = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
        }
      } else b = layoutText(n).bounds;
      leafBoundsCache.set(n, b);
      return b;
    }
    case 'image':
      return { x: 0, y: 0, width: n.width, height: n.height };
    case 'group':
    case 'layer': {
      let r: Rect | null = null;
      for (const c of n.children) {
        const child = doc.nodes[c];
        if (!child || !child.visible) continue;
        if (n.type === 'group' && n.clipId) {
          // clipping group: bounds are the clip path's bounds
          if (c !== n.clipId) continue;
        }
        const cb = localBounds(doc, c);
        if (cb) r = rectUnion(r, applyToRect(child.transform, cb));
      }
      return r;
    }
  }
}

/** Tight bounds in world space (path geometry is transformed before measuring). */
export function worldBounds(doc: Document, id: ID): Rect | null {
  const n = doc.nodes[id];
  if (!n) return null;
  const wm = worldMatrix(doc, id);
  if (n.type === 'path') {
    if (isIdentity(wm)) return localBounds(doc, id);
    return pathBounds(transformSubPaths(n.subpaths, wm));
  }
  if (n.type === 'group' || n.type === 'layer') {
    let r: Rect | null = null;
    for (const c of n.children) {
      const child = doc.nodes[c];
      if (!child || !child.visible) continue;
      if (n.type === 'group' && n.clipId && c !== n.clipId) continue;
      r = rectUnion(r, worldBounds(doc, c));
    }
    return r;
  }
  const lb = localBounds(doc, id);
  return lb ? applyToRect(wm, lb) : null;
}

/** World bounds including stroke width and (approximately) effects. */
export function visualBounds(doc: Document, id: ID): Rect | null {
  const n = doc.nodes[id];
  if (!n) return null;
  if (n.type === 'group' || n.type === 'layer') {
    let r: Rect | null = null;
    for (const c of n.children) {
      const child = doc.nodes[c];
      if (!child || !child.visible) continue;
      if (n.type === 'group' && n.clipId && c !== n.clipId) continue;
      r = rectUnion(r, visualBounds(doc, c));
    }
    return r;
  }
  const b = worldBounds(doc, id);
  if (!b) return null;
  let pad = 0;
  if ((n.type === 'path' || n.type === 'text') && n.stroke.paint.type !== 'none' && n.stroke.width > 0) {
    const s = scaleFactor(worldMatrix(doc, id));
    pad = (n.stroke.width / 2) * s;
    if (n.stroke.join === 'miter') pad *= Math.min(n.stroke.miterLimit, 4) / 2 + 0.5;
    if (n.stroke.markerStart !== 'none' || n.stroke.markerEnd !== 'none') pad = Math.max(pad, n.stroke.width * 4 * n.stroke.markerScale * s);
  }
  for (const e of n.effects) {
    if (!e.enabled) continue;
    if (e.type === 'dropShadow') pad = Math.max(pad, Math.abs(e.dx) + Math.abs(e.dy) + e.blur * 2);
    else if (e.type === 'blur') pad = Math.max(pad, e.radius * 3);
    else if (e.type === 'outerGlow') pad = Math.max(pad, e.blur * 2);
  }
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

export function selectionBounds(doc: Document, ids: ID[]): Rect | null {
  let r: Rect | null = null;
  for (const id of ids) r = rectUnion(r, worldBounds(doc, id));
  return r;
}

export function nodeCenter(doc: Document, id: ID): Vec | null {
  const b = worldBounds(doc, id);
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** World-space subpaths of a path node. */
export function worldSubPaths(doc: Document, id: ID): SubPath[] {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path') return [];
  const wm = worldMatrix(doc, id);
  return isIdentity(wm) ? cloneSubPaths(n.subpaths) : transformSubPaths(n.subpaths, wm);
}

/** Replace a path node's geometry with world-space subpaths (transform reset). */
export function setWorldSubPaths(doc: Document, id: ID, subpaths: SubPath[]): void {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path') return;
  const pw = parentWorldMatrix(doc, id);
  n.subpaths = isIdentity(pw) ? subpaths : transformSubPaths(subpaths, invert(pw));
  n.transform = identity();
  n.shape = undefined;
}

/** All path-node descendants (including self) of the given ids, in paint order. */
export function collectPaths(doc: Document, ids: ID[]): ID[] {
  const out: ID[] = [];
  for (const id of sortByPaintOrder(doc, ids)) {
    for (const d of descendants(doc, id, true)) if (doc.nodes[d]?.type === 'path') out.push(d);
  }
  return Array.from(new Set(out));
}

export function worldPoint(doc: Document, id: ID, local: Vec): Vec {
  return applyToPoint(worldMatrix(doc, id), local);
}

export function touch(doc: Document): void {
  doc.meta.modified = new Date().toISOString();
}

/** Artboard containing (or nearest to) a world point. */
export function artboardAt(doc: Document, p: Vec): ID | null {
  for (let i = doc.artboards.length - 1; i >= 0; i--) {
    const a = doc.artboards[i];
    if (p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height) return a.id;
  }
  return null;
}
