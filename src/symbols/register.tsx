/**
 * Symbols module wiring: the Symbols panel, Object > Symbol commands, the
 * symbol-editing session (isolation on an instance → redefine on exit) and
 * the rename dialog.
 */
import React, { useState } from 'react';
import { registerPanel } from '@/ui/panels/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { registerCommands, when, type Command } from '@/commands/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, TextField } from '@/ui/widgets';
import { useStore, getState, setState, type EditorState } from '@/store/store';
import type { ID } from '@/model/types';
import { descendants } from '@/model/document';
import { SymbolsPanel } from './SymbolsPanel';
import { useSymbolStore } from './store';
import * as ops from './ops';
import * as actions from './actions';
import { SYMBOL_LIBRARY } from './library';

registerPanel({ id: 'symbols', title: 'Symbols', component: SymbolsPanel, order: 36, defaultVisible: true, shortcut: 'shift+ctrl+f11' });

const hasInstances = (s: EditorState) => ops.instancesOf(s.doc, s.selection).length > 0;
const hasSymbols = (s: EditorState) => s.doc.symbols.length > 0;

const commands: Command[] = [
  { id: 'symbol.make', label: 'Make Symbol', menu: 'Object/Symbol', shortcut: 'f8', order: 700, run: () => actions.makeSymbolCommand(), enabled: when.hasSelection },
  { id: 'symbol.place', label: 'Place Symbol Instance', menu: 'Object/Symbol', order: 701, run: () => { const id = actions.currentSymbolId(); if (id) actions.placeSymbolCommand(id); else getState().toast('No symbols in the document (Object > Symbol > Add Library)', 'info'); }, enabled: hasSymbols },
  { id: 'symbol.breakLink', label: 'Break Link to Symbol', menu: 'Object/Symbol', order: 702, run: () => actions.breakLinkCommand(), enabled: hasInstances },
  { id: 'symbol.edit', label: 'Edit Symbol', menu: 'Object/Symbol', order: 703, run: () => { const s = getState(); const inst = ops.instancesOf(s.doc, s.selection)[0]; const id = inst ? ops.instanceRef(s.doc.nodes[inst])!.id : actions.currentSymbolId(); if (id) actions.editSymbolCommand(id); }, enabled: (s) => hasInstances(s) || hasSymbols(s) },
  { id: 'symbol.redefine', label: 'Redefine Symbol from Selection', menu: 'Object/Symbol', order: 704, run: () => { const id = actions.currentSymbolId(); if (id) actions.redefineCommand(id); }, enabled: (s) => when.hasSelection(s) && hasSymbols(s) },
  { id: 'symbol.selectInstances', label: 'Select All Instances', menu: 'Object/Symbol', order: 705, separatorBefore: true, run: () => { const s = getState(); const inst = ops.instancesOf(s.doc, s.selection)[0]; const id = inst ? ops.instanceRef(s.doc.nodes[inst])!.id : actions.currentSymbolId(); if (id) actions.selectInstances(id); }, enabled: (s) => hasInstances(s) || hasSymbols(s) },
  { id: 'symbol.addLibrary', label: 'Add Symbol Library', menu: 'Object/Symbol', order: 706, separatorBefore: true, run: () => { const n = actions.addWholeLibrary(); getState().toast(n ? `Added ${n} symbols` : 'All library symbols are already in the document', 'info'); } },
  { id: 'symbol.expandSet', label: 'Expand Symbol Set', menu: 'Object/Symbol', order: 707, run: () => { const s = getState(); const sets = s.selection.filter((id) => ops.isSymbolSet(s.doc.nodes[id])); s.updateDoc((d) => { for (const id of sets) { const g = d.nodes[id]; if (g && g.type === 'group' && g.data) { const { symbolSet: _x, ...rest } = g.data as Record<string, unknown>; g.data = Object.keys(rest).length ? rest : undefined; if (!g.data) delete g.data; } } }, 'Expand Symbol Set'); }, enabled: (s) => s.selection.some((id) => ops.isSymbolSet(s.doc.nodes[id])) },
];
registerCommands(commands);

// ---------------------------------------------------------------------------
// Editing session: entering isolation on an instance starts a session; leaving
// it redefines the symbol from the instance when its contents changed.
// ---------------------------------------------------------------------------

function snapshotOf(state: EditorState, instanceId: ID) {
  return descendants(state.doc, instanceId, true).map((id) => state.doc.nodes[id]);
}

function changed(state: EditorState, session: { instanceId: ID; snapshot: unknown[] }): boolean {
  const now = snapshotOf(state, session.instanceId);
  if (now.length !== session.snapshot.length) return true;
  for (let i = 0; i < now.length; i++) if (now[i] !== session.snapshot[i]) return true;
  return false;
}

function finishEditing(state: EditorState): void {
  const session = useSymbolStore.getState().editing;
  if (!session) return;
  useSymbolStore.getState().setEditing(null);
  const inst = state.doc.nodes[session.instanceId];
  if (!ops.isSymbolInstance(inst) || inst.data.symbol.id !== session.symbolId) return;
  if (!changed(state, session)) return;
  // fold the redefinition into one step
  let count = 0;
  state.updateDoc((d) => {
    const def = ops.redefineFromInstance(d, session.instanceId);
    count = def ? ops.symbolInstances(d, def.id).length : 0;
  }, 'Edit Symbol');
  if (count > 1) getState().toast(`Symbol updated: ${count} instances follow`, 'success');
}

useStore.subscribe(
  (s) => s.isolationId,
  (iso, prev) => {
    const s = getState();
    const session = useSymbolStore.getState().editing;
    if (session && iso !== session.instanceId) {
      // leaving the instance (or moving to another group)
      // isolation may have moved deeper into the instance: keep the session then
      const stillInside = iso ? ops.insideInstance(s.doc, iso) === session.instanceId || iso === session.instanceId : false;
      if (!stillInside) finishEditing(s);
    }
    if (iso && iso !== prev) {
      const inst = ops.isSymbolInstance(s.doc.nodes[iso]) ? iso : ops.insideInstance(s.doc, iso);
      if (inst && !useSymbolStore.getState().editing) {
        const ref = ops.instanceRef(s.doc.nodes[inst])!;
        useSymbolStore.getState().setEditing({ instanceId: inst, symbolId: ref.id, snapshot: snapshotOf(s, inst) as never });
        useSymbolStore.getState().setActive(ref.id);
      }
    }
  },
);

// instances rebuilt lazily when a definition changed elsewhere (e.g. undo/redo, MCP)
let syncing = false;
useStore.subscribe(
  (s) => s.doc,
  (doc) => {
    if (syncing) return;
    if (!doc.symbols.length) return;
    let stale = false;
    for (const id of ops.symbolInstances(doc)) {
      const ref = ops.instanceRef(doc.nodes[id])!;
      const def = ops.getSymbol(doc, ref.id);
      if (def && def.version !== ref.version) {
        stale = true;
        break;
      }
    }
    if (!stale) return;
    const s = getState();
    if (s.doc !== doc || s.doc !== s.historyBase) return;
    syncing = true;
    try {
      s.updateDoc((d) => {
        ops.syncInstances(d);
      });
      setState({ historyBase: getState().doc });
    } finally {
      syncing = false;
    }
  },
);

// ---------------------------------------------------------------------------
// Rename dialog
// ---------------------------------------------------------------------------

function RenameSymbolDialog({ props, close }: { props: { id: ID; name: string }; close: () => void }) {
  const [name, setName] = useState(props.name);
  const ok = () => {
    actions.renameSymbolCommand(props.id, name);
    close();
  };
  return (
    <DialogFrame
      title="Symbol Options"
      onClose={close}
      width={320}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="symbol-rename-ok">
            OK
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={setName} onCommit={setName} id="symbol-rename-name" />
    </DialogFrame>
  );
}
registerDialog('symbol.rename', RenameSymbolDialog as any);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  symbols: { ...ops, ...actions, library: SYMBOL_LIBRARY, store: useSymbolStore },
};

void React;
