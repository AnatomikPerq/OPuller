/**
 * Symbols: reusable artwork stored in `doc.symbols`, placed as instances.
 * An instance is a plain group carrying `data.symbol = { id, version }` whose
 * children are copies of the symbol artwork (in symbol space, registration
 * point at the group origin). Redefining a symbol bumps its version and every
 * instance is rebuilt from the new artwork (see syncInstances).
 */
import type { Document, ID, Node, SymbolDef, GroupNode, Vec, Matrix, Rect } from '@/model/types';
import { isContainer } from '@/model/types';
import { makeGroup, newId } from '@/model/nodes';
import { addNode, removeNode, addSubtree, cloneSubtree, deepClone, worldMatrix, parentWorldMatrix, worldBounds, sortByPaintOrder, topmostOf, indexInParent, descendants, localBounds } from '@/model/document';
import { multiply, invert, translate, identity, applyToRect, compose, rotate, scale as scaleM } from '@/geometry/matrix';
import { rectUnion } from '@/geometry/vec';

export interface SymbolRef {
  id: ID;
  version: number;
}

export function isSymbolInstance(n: Node | undefined | null): n is GroupNode & { data: { symbol: SymbolRef } } {
  return !!n && n.type === 'group' && !!n.data && !!(n.data as { symbol?: SymbolRef }).symbol;
}

export function instanceRef(n: Node | undefined | null): SymbolRef | null {
  return isSymbolInstance(n) ? (n.data as { symbol: SymbolRef }).symbol : null;
}

export function isSymbolSet(n: Node | undefined | null): n is GroupNode {
  return !!n && n.type === 'group' && !!n.data && !!(n.data as { symbolSet?: boolean }).symbolSet;
}

export function getSymbol(doc: Document, id: ID | null | undefined): SymbolDef | undefined {
  return id ? doc.symbols.find((s) => s.id === id) : undefined;
}

/** Ids of all instances of a symbol (or of all symbols when id is omitted). */
export function symbolInstances(doc: Document, symbolId?: ID): ID[] {
  const out: ID[] = [];
  for (const n of Object.values(doc.nodes)) {
    const ref = instanceRef(n);
    if (ref && (!symbolId || ref.id === symbolId)) out.push(n.id);
  }
  return out;
}

/** A document-shaped view of a symbol's artwork (for bounds and rendering). */
export function symbolDocument(doc: Document, def: SymbolDef): Document {
  return { ...doc, nodes: def.nodes, layers: [def.root] };
}

export function symbolBounds(doc: Document, def: SymbolDef): Rect | null {
  return localBounds(symbolDocument(doc, def), def.root);
}

export function uniqueSymbolName(doc: Document, base: string): string {
  const names = new Set(doc.symbols.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
  return base;
}

/** Clone the artwork of `def` (fresh ids) as children of `parentId`. */
function instantiateChildren(doc: Document, def: SymbolDef, parentId: ID): void {
  const view = symbolDocument(doc, def);
  const root = def.nodes[def.root];
  if (!root || !isContainer(root)) return;
  for (const cid of root.children) {
    const { root: copy, nodes } = cloneSubtree(view, cid);
    addSubtree(doc, copy, nodes, parentId);
  }
}

/**
 * Build a symbol definition from world-space nodes: the artwork is copied into
 * symbol space (centred on the registration point = bounds centre).
 */
export function symbolFromNodes(doc: Document, ids: ID[], name: string): { def: SymbolDef; center: Vec } | null {
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  if (!members.length) return null;
  let bounds: Rect | null = null;
  for (const id of members) bounds = rectUnion(bounds, worldBounds(doc, id));
  const center = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : { x: 0, y: 0 };
  const root = makeGroup([], { name });
  root.parent = null;
  root.transform = identity();
  const nodes: Record<ID, Node> = { [root.id]: root };
  const toSymbol = translate(-center.x, -center.y);
  for (const id of members) {
    const { root: copy, nodes: all } = cloneSubtree(doc, id);
    copy.transform = multiply(toSymbol, worldMatrix(doc, id));
    copy.parent = root.id;
    for (const n of all) nodes[n.id] = n;
    root.children.push(copy.id);
  }
  return { def: { id: newId(), name: uniqueSymbolName(doc, name), nodes, root: root.id, version: 1 }, center };
}

/**
 * Convert the selection into a symbol: adds the definition and replaces the
 * artwork with one instance at the same place. Returns the definition and the
 * instance id.
 */
export function makeSymbol(doc: Document, ids: ID[], name = 'New Symbol'): { def: SymbolDef; instanceId: ID } | null {
  const built = symbolFromNodes(doc, ids, name);
  if (!built) return null;
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  doc.symbols.push(built.def);
  const top = members[members.length - 1];
  const parentId = doc.nodes[top].parent;
  const index = indexInParent(doc, top);
  for (const id of members) removeNode(doc, id);
  const instanceId = placeInstance(doc, built.def.id, built.center, parentId, { index });
  return instanceId ? { def: built.def, instanceId } : null;
}

export interface PlaceOptions {
  index?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

/** Place an instance with its registration point at a world position. */
export function placeInstance(doc: Document, symbolId: ID, at: Vec, parentId: ID | null, opts: PlaceOptions = {}): ID | null {
  const def = getSymbol(doc, symbolId);
  if (!def) return null;
  let parent = parentId;
  if (parent === null || !doc.nodes[parent] || !isContainer(doc.nodes[parent])) parent = doc.layers[doc.layers.length - 1] ?? null;
  if (parent === null) return null;
  const g = makeGroup([], { name: def.name });
  g.data = { symbol: { id: def.id, version: def.version } };
  const pw = parentWorldMatrix(doc, parent);
  const local = multiply(invert(multiply(pw, doc.nodes[parent].transform)), compose(translate(at.x, at.y), rotate(opts.rotation ?? 0), scaleM(opts.scale ?? 1)));
  g.transform = local;
  if (opts.opacity !== undefined) g.opacity = opts.opacity;
  addNode(doc, g, parent, opts.index);
  instantiateChildren(doc, def, g.id);
  return g.id;
}

/** Rebuild the children of an instance from its (current) definition. */
export function rebuildInstance(doc: Document, instanceId: ID): void {
  const inst = doc.nodes[instanceId];
  const ref = instanceRef(inst);
  if (!ref || !isSymbolInstance(inst)) return;
  const def = getSymbol(doc, ref.id);
  if (!def) return;
  for (const c of [...inst.children]) removeNode(doc, c);
  inst.children = [];
  instantiateChildren(doc, def, inst.id);
  inst.data = { ...inst.data, symbol: { id: def.id, version: def.version } };
}

/** Rebuild every instance whose version differs from its definition. Returns the count. */
export function syncInstances(doc: Document, symbolId?: ID): number {
  let n = 0;
  for (const id of symbolInstances(doc, symbolId)) {
    const ref = instanceRef(doc.nodes[id])!;
    const def = getSymbol(doc, ref.id);
    if (!def) continue;
    if (ref.version !== def.version) {
      rebuildInstance(doc, id);
      n++;
    }
  }
  return n;
}

/** Replace the artwork of a symbol with the children of an instance (in instance space). */
export function redefineFromInstance(doc: Document, instanceId: ID): SymbolDef | null {
  const inst = doc.nodes[instanceId];
  if (!isSymbolInstance(inst)) return null;
  const def = getSymbol(doc, inst.data.symbol.id);
  if (!def) return null;
  const root = makeGroup([], { name: def.name });
  root.parent = null;
  const nodes: Record<ID, Node> = { [root.id]: root };
  for (const cid of inst.children) {
    const { root: copy, nodes: all } = cloneSubtree(doc, cid);
    copy.parent = root.id;
    for (const n of all) nodes[n.id] = n;
    root.children.push(copy.id);
  }
  def.nodes = nodes;
  def.root = root.id;
  def.version += 1;
  inst.data = { ...inst.data, symbol: { id: def.id, version: def.version } };
  syncInstances(doc, def.id);
  return def;
}

/** Replace the artwork of a symbol with world-space nodes (they are consumed). */
export function redefineFromNodes(doc: Document, symbolId: ID, ids: ID[]): SymbolDef | null {
  const def = getSymbol(doc, symbolId);
  if (!def) return null;
  const built = symbolFromNodes(doc, ids, def.name);
  if (!built) return null;
  def.nodes = built.def.nodes;
  def.root = built.def.root;
  def.version += 1;
  syncInstances(doc, def.id);
  return def;
}

/** Turn an instance into an ordinary group (keeps the artwork). */
export function breakLink(doc: Document, instanceId: ID): boolean {
  const inst = doc.nodes[instanceId];
  if (!isSymbolInstance(inst)) return false;
  const { symbol: _s, ...rest } = inst.data as Record<string, unknown>;
  const g = inst as GroupNode;
  if (Object.keys(rest).length) g.data = rest;
  else delete g.data;
  return true;
}

/** Point an instance at another symbol (keeps transform and appearance). */
export function replaceInstanceSymbol(doc: Document, instanceId: ID, symbolId: ID): boolean {
  const inst = doc.nodes[instanceId];
  const def = getSymbol(doc, symbolId);
  if (!isSymbolInstance(inst) || !def) return false;
  inst.data = { ...inst.data, symbol: { id: def.id, version: -1 } };
  inst.name = def.name;
  rebuildInstance(doc, instanceId);
  return true;
}

/** Delete a symbol: instances either keep their artwork (break) or are deleted. */
export function deleteSymbol(doc: Document, symbolId: ID, mode: 'break' | 'delete' = 'break'): number {
  const instances = symbolInstances(doc, symbolId);
  for (const id of instances) {
    if (mode === 'break') breakLink(doc, id);
    else removeNode(doc, id);
  }
  doc.symbols = doc.symbols.filter((s) => s.id !== symbolId);
  return instances.length;
}

export function duplicateSymbol(doc: Document, symbolId: ID): SymbolDef | null {
  const def = getSymbol(doc, symbolId);
  if (!def) return null;
  const copy: SymbolDef = { ...deepClone(def), id: newId(), name: uniqueSymbolName(doc, `${def.name} copy`), version: 1 };
  const i = doc.symbols.findIndex((s) => s.id === symbolId);
  doc.symbols.splice(i + 1, 0, copy);
  return copy;
}

export function renameSymbol(doc: Document, symbolId: ID, name: string): void {
  const def = getSymbol(doc, symbolId);
  if (!def) return;
  const n = name.trim();
  if (!n) return;
  def.name = n;
  for (const id of symbolInstances(doc, symbolId)) doc.nodes[id].name = n;
}

/** Add a definition (e.g. from a library); the artwork must be in symbol space. */
export function addSymbolDef(doc: Document, def: SymbolDef): SymbolDef {
  const copy = { ...deepClone(def), name: uniqueSymbolName(doc, def.name) };
  doc.symbols.push(copy);
  return copy;
}

/** Symbol instances among the given ids (instances themselves or their descendants' instances). */
export function instancesOf(doc: Document, ids: ID[]): ID[] {
  const out = new Set<ID>();
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    if (isSymbolInstance(n)) out.add(id);
    else if (isContainer(n)) for (const d of descendants(doc, id)) if (isSymbolInstance(doc.nodes[d])) out.add(d);
  }
  return Array.from(out);
}

/** World bounds of the symbol artwork when placed with the matrix. */
export function placedBounds(doc: Document, def: SymbolDef, m: Matrix): Rect | null {
  const b = symbolBounds(doc, def);
  return b ? applyToRect(m, b) : null;
}

/** Whether the node lives inside a symbol instance (its contents are managed by the symbol). */
export function insideInstance(doc: Document, id: ID): ID | null {
  let cur = doc.nodes[id]?.parent ?? null;
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (isSymbolInstance(doc.nodes[cur])) return cur;
    cur = doc.nodes[cur]?.parent ?? null;
  }
  return null;
}
