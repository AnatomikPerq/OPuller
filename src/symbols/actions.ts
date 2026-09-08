/**
 * Store-aware symbol actions (one history step each) used by the panel, the
 * commands and the MCP bridge.
 */
import type { ID, Vec } from '@/model/types';
import { getState } from '@/store/store';
import { descendants, worldBounds } from '@/model/document';
import { insertionParent } from '@/tools/shapes/tool';
import { activeArtboard, viewCenter } from '@/io/fileOps';
import { makeSymbol, placeInstance, breakLink, redefineFromNodes, redefineFromInstance, deleteSymbol, duplicateSymbol, renameSymbol, replaceInstanceSymbol, symbolInstances, instancesOf, getSymbol, addSymbolDef, isSymbolInstance } from './ops';
import { useSymbolStore } from './store';
import { SYMBOL_LIBRARY } from './library';

/** Convert the selection into a symbol + one instance. */
export function makeSymbolCommand(name?: string): ID | null {
  const s = getState();
  if (!s.selection.length) {
    s.toast('Select artwork to make a symbol from', 'info');
    return null;
  }
  const label = name ?? `Symbol ${s.doc.symbols.length + 1}`;
  let instanceId: ID | null = null;
  let symbolId: ID | null = null;
  s.updateDoc((d) => {
    const r = makeSymbol(d, s.selection, label);
    if (r) {
      instanceId = r.instanceId;
      symbolId = r.def.id;
    }
  }, 'Make Symbol');
  if (instanceId) getState().setSelection([instanceId]);
  if (symbolId) useSymbolStore.getState().setActive(symbolId);
  return symbolId;
}

/** Place an instance at a world point (default: the centre of the active artboard / view). */
export function placeSymbolCommand(symbolId: ID, at?: Vec, opts: { scale?: number; rotation?: number; select?: boolean } = {}): ID | null {
  const s = getState();
  const def = getSymbol(s.doc, symbolId);
  if (!def) return null;
  const ab = activeArtboard();
  const p = at ?? (ab ? { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 } : viewCenter());
  const parent = insertionParent();
  let id: ID | null = null;
  s.updateDoc((d) => {
    id = placeInstance(d, symbolId, p, parent, { scale: opts.scale, rotation: opts.rotation });
  }, 'Place Symbol Instance');
  if (id && opts.select !== false) getState().setSelection([id]);
  useSymbolStore.getState().setActive(symbolId);
  return id;
}

export function breakLinkCommand(ids?: ID[]): number {
  const s = getState();
  const targets = instancesOf(s.doc, ids ?? s.selection);
  if (!targets.length) return 0;
  s.updateDoc((d) => {
    for (const id of targets) breakLink(d, id);
  }, 'Break Link to Symbol');
  return targets.length;
}

/** Redefine a symbol from the current selection (the selection becomes an instance). */
export function redefineCommand(symbolId: ID): boolean {
  const s = getState();
  const def = getSymbol(s.doc, symbolId);
  if (!def || !s.selection.length) return false;
  // when the selection is a single instance of the symbol, take its (edited) children
  const single = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null;
  if (single && isSymbolInstance(single) && single.data.symbol.id === symbolId) {
    s.updateDoc((d) => {
      redefineFromInstance(d, single.id);
    }, 'Redefine Symbol');
    return true;
  }
  let instanceId: ID | null = null;
  s.updateDoc((d) => {
    const r = redefineFromNodes(d, symbolId, s.selection);
    if (!r) return;
    // replace the selection by an instance at the same place
    let b: ReturnType<typeof worldBounds> = null;
    for (const id of s.selection) {
      const wb = worldBounds(d, id);
      if (wb) b = b ? { x: Math.min(b.x, wb.x), y: Math.min(b.y, wb.y), width: Math.max(b.x + b.width, wb.x + wb.width) - Math.min(b.x, wb.x), height: Math.max(b.y + b.height, wb.y + wb.height) - Math.min(b.y, wb.y) } : wb;
    }
    const top = s.selection[s.selection.length - 1];
    const parent = d.nodes[top]?.parent ?? null;
    for (const id of s.selection) if (d.nodes[id]) {
      const n = d.nodes[id];
      const list = n.parent === null ? d.layers : (d.nodes[n.parent] as { children: ID[] }).children;
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      for (const x of descendants(d, id, true)) delete d.nodes[x];
    }
    if (b) instanceId = placeInstance(d, symbolId, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, parent);
  }, 'Redefine Symbol');
  if (instanceId) getState().setSelection([instanceId]);
  return true;
}

/** Enter isolation on an instance to edit the symbol; the definition updates when isolation ends. */
export function editSymbolCommand(symbolId: ID): boolean {
  const s = getState();
  const selected = instancesOf(s.doc, s.selection).find((id) => isSymbolInstance(s.doc.nodes[id]) && (s.doc.nodes[id] as { data: { symbol: { id: ID } } }).data.symbol.id === symbolId);
  let inst: ID | null = selected ?? symbolInstances(s.doc, symbolId)[0] ?? null;
  if (!inst) inst = placeSymbolCommand(symbolId, undefined, { select: false });
  if (!inst) return false;
  const st = getState();
  st.setSelection([inst]);
  st.setIsolation(inst);
  st.toast('Editing symbol: changes apply to every instance when you exit isolation (Escape)', 'info');
  return true;
}

export function deleteSymbolCommand(symbolId: ID, mode: 'break' | 'delete' = 'break'): void {
  const s = getState();
  const def = getSymbol(s.doc, symbolId);
  if (!def) return;
  const count = symbolInstances(s.doc, symbolId).length;
  s.updateDoc((d) => {
    deleteSymbol(d, symbolId, mode);
  }, 'Delete Symbol');
  if (useSymbolStore.getState().activeId === symbolId) useSymbolStore.getState().setActive(null);
  if (count) getState().toast(mode === 'break' ? `${count} instance${count === 1 ? '' : 's'} converted to groups` : `${count} instance${count === 1 ? '' : 's'} deleted`, 'info');
}

export function duplicateSymbolCommand(symbolId: ID): ID | null {
  let id: ID | null = null;
  getState().updateDoc((d) => {
    id = duplicateSymbol(d, symbolId)?.id ?? null;
  }, 'Duplicate Symbol');
  if (id) useSymbolStore.getState().setActive(id);
  return id;
}

export function renameSymbolCommand(symbolId: ID, name: string): void {
  getState().updateDoc((d) => renameSymbol(d, symbolId, name), 'Rename Symbol');
}

export function replaceSelectionSymbol(symbolId: ID): number {
  const s = getState();
  const targets = instancesOf(s.doc, s.selection);
  if (!targets.length) return 0;
  s.updateDoc((d) => {
    for (const id of targets) replaceInstanceSymbol(d, id, symbolId);
  }, 'Replace Symbol');
  return targets.length;
}

export function selectInstances(symbolId: ID): number {
  const s = getState();
  const ids = symbolInstances(s.doc, symbolId);
  s.setSelection(ids);
  if (!ids.length) s.toast('No instances of this symbol', 'info');
  return ids.length;
}

export function addLibrarySymbol(libraryId: string): ID | null {
  const entry = SYMBOL_LIBRARY.find((e) => e.id === libraryId);
  if (!entry) return null;
  let id: ID | null = null;
  getState().updateDoc((d) => {
    id = addSymbolDef(d, entry.build()).id;
  }, 'Add Symbol');
  if (id) useSymbolStore.getState().setActive(id);
  return id;
}

/** Add every library symbol that is not in the document yet (by name). */
export function addWholeLibrary(): number {
  const s = getState();
  const names = new Set(s.doc.symbols.map((x) => x.name));
  const missing = SYMBOL_LIBRARY.filter((e) => !names.has(e.name));
  if (!missing.length) return 0;
  s.updateDoc((d) => {
    for (const e of missing) addSymbolDef(d, e.build());
  }, 'Add Symbol Library');
  return missing.length;
}

/** The symbol used by Place and the sprayer: the panel selection, else the first symbol. */
export function currentSymbolId(): ID | null {
  const s = getState();
  const a = useSymbolStore.getState().activeId;
  if (a && getSymbol(s.doc, a)) return a;
  return s.doc.symbols[0]?.id ?? null;
}
