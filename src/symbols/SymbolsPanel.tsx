/**
 * Symbols panel: thumbnails of the document symbols. Click selects (the
 * sprayer uses the selection), "Place" adds an instance, drag & drop onto the
 * canvas is emulated by Place at the artboard centre. Context menu with
 * edit / redefine / replace / duplicate / rename / delete / select instances.
 */
import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Link2Off, RefreshCw, BookOpen, Pencil, LayoutGrid, List, MousePointerClick } from 'lucide-react';
import { useStore, getState, type ContextMenuItem } from '@/store/store';
import type { ID, SymbolDef } from '@/model/types';
import { IconButton, PopoverButton, Select } from '@/ui/widgets';
import { StaticDocument } from '@/canvas/Renderer';
import { symbolDocument, symbolBounds, symbolInstances, instancesOf } from './ops';
import { useSymbolStore } from './store';
import { SYMBOL_LIBRARY } from './library';
import { placeSymbolCommand, makeSymbolCommand, breakLinkCommand, redefineCommand, editSymbolCommand, deleteSymbolCommand, duplicateSymbolCommand, replaceSelectionSymbol, addLibrarySymbol, selectInstances } from './actions';
import './symbols.css';

export function SymbolThumb({ def, size = 44 }: { def: SymbolDef; size?: number }) {
  const doc = useStore((s) => s.doc);
  const content = useMemo(() => {
    const view = symbolDocument(doc, def);
    const b = symbolBounds(doc, def);
    if (!b) return null;
    const pad = Math.max(b.width, b.height) * 0.08 + 0.5;
    return (
      <svg viewBox={`${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`} preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <StaticDocument doc={view} ids={[def.root]} prefix={`sy-${def.id}-`} exportMode={false} />
      </svg>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.nodes, def.root, def.version]);
  return (
    <span className="sym-thumb" style={{ width: size, height: size }}>
      {content}
    </span>
  );
}

export function SymbolsPanel() {
  const symbols = useStore((s) => s.doc.symbols);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const activeId = useSymbolStore((s) => s.activeId);
  const setActive = useSymbolStore((s) => s.setActive);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const active = symbols.find((s) => s.id === activeId) ?? null;
  const selectedInstances = useMemo(() => instancesOf(doc, selection), [doc, selection]);

  const menuFor = (def: SymbolDef): ContextMenuItem[] => [
    { label: 'Place Symbol Instance', onSelect: () => placeSymbolCommand(def.id) },
    { label: 'Replace Symbol', disabled: !selectedInstances.length, onSelect: () => replaceSelectionSymbol(def.id) },
    { separator: true },
    { label: 'Edit Symbol', onSelect: () => editSymbolCommand(def.id) },
    { label: 'Redefine Symbol from Selection', disabled: !selection.length, onSelect: () => redefineCommand(def.id) },
    { label: 'Duplicate Symbol', onSelect: () => duplicateSymbolCommand(def.id) },
    { label: 'Rename…', onSelect: () => getState().openDialog('symbol.rename', { id: def.id, name: def.name }) },
    { label: 'Delete Symbol', onSelect: () => deleteSymbolCommand(def.id) },
    { separator: true },
    { label: `Select All Instances (${symbolInstances(doc, def.id).length})`, onSelect: () => selectInstances(def.id) },
  ];

  const onContext = (e: React.MouseEvent, def: SymbolDef) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(def.id);
    getState().openContextMenu({ x: e.clientX, y: e.clientY, items: menuFor(def) });
  };

  return (
    <div className="symbols-panel" data-testid="symbols-panel">
      <div className="sym-toolbar">
        <IconButton icon={<LayoutGrid size={14} />} active={view === 'grid'} title="Thumbnail view" onClick={() => setView('grid')} />
        <IconButton icon={<List size={14} />} active={view === 'list'} title="List view" onClick={() => setView('list')} />
        <span className="sym-sep" />
        <PopoverButton
          placement="bottom"
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="icon-btn" onClick={toggle} title="Symbol libraries" data-testid="symbols-libraries">
              <BookOpen size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="sym-library" data-testid="symbols-library-menu">
              <div className="section-title">Add from library</div>
              <div className="sym-library-grid">
                {SYMBOL_LIBRARY.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    title={e.name}
                    data-testid={`symbols-lib-${e.id}`}
                    onClick={() => {
                      addLibrarySymbol(e.id);
                      close();
                    }}
                  >
                    <LibThumb id={e.id} />
                    <span>{e.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </PopoverButton>
        <span className="sym-sep" />
        <IconButton icon={<MousePointerClick size={14} />} title="Place an instance of the selected symbol" disabled={!active} onClick={() => active && placeSymbolCommand(active.id)} data-testid="symbols-place" />
        <IconButton icon={<Link2Off size={14} />} title="Break link to symbol (selected instances)" disabled={!selectedInstances.length} onClick={() => breakLinkCommand()} data-testid="symbols-break" />
        <IconButton icon={<RefreshCw size={14} />} title="Redefine the selected symbol from the selection" disabled={!active || !selection.length} onClick={() => active && redefineCommand(active.id)} data-testid="symbols-redefine" />
        <IconButton icon={<Pencil size={14} />} title="Edit symbol (isolation mode; finish with Escape or Exit Isolation)" disabled={!active} onClick={() => active && editSymbolCommand(active.id)} data-testid="symbols-edit" />
        <IconButton icon={<Plus size={14} />} title="New symbol from the selection" disabled={!selection.length} onClick={() => makeSymbolCommand()} data-testid="symbols-new" />
        <IconButton icon={<Trash2 size={14} />} title="Delete symbol" disabled={!active} onClick={() => active && deleteSymbolCommand(active.id)} data-testid="symbols-delete" />
      </div>
      <div className={view === 'grid' ? 'sym-grid' : 'sym-list'} data-testid="symbols-grid">
        {symbols.map((def) => {
          const count = symbolInstances(doc, def.id).length;
          const cls = `${def.id === activeId ? 'selected' : ''}`;
          if (view === 'grid') {
            return (
              <button key={def.id} type="button" className={`sym-cell ${cls}`} title={`${def.name} — ${count} instance${count === 1 ? '' : 's'}\nClick: select. Double-click: place. Right-click: menu.`} onClick={() => setActive(def.id)} onDoubleClick={() => placeSymbolCommand(def.id)} onContextMenu={(e) => onContext(e, def)} data-testid={`symbol-${def.id}`}>
                <SymbolThumb def={def} />
              </button>
            );
          }
          return (
            <button key={def.id} type="button" className={`sym-row ${cls}`} onClick={() => setActive(def.id)} onDoubleClick={() => placeSymbolCommand(def.id)} onContextMenu={(e) => onContext(e, def)} data-testid={`symbol-${def.id}`}>
              <SymbolThumb def={def} size={22} />
              <span className="sym-row-name">{def.name}</span>
              <span className="sym-row-count">{count}</span>
            </button>
          );
        })}
        {!symbols.length && <div className="sym-empty">No symbols yet. Select artwork and click + (or F8), or add one from the library.</div>}
      </div>
      <div className="sym-footer">
        <span className="sym-footer-name" data-testid="symbols-status">
          {active ? `${active.name} — ${symbolInstances(doc, active.id).length} instances` : `${symbols.length} symbols`}
        </span>
        {selectedInstances.length > 0 && active && (
          <Select
            value=""
            options={[{ value: '', label: 'Replace with…' }, ...symbols.map((s) => ({ value: s.id, label: s.name }))]}
            onChange={(v) => v && replaceSelectionSymbol(v)}
            width={120}
            title="Replace the selected instances with another symbol"
          />
        )}
      </div>
    </div>
  );
}

const libCache = new Map<string, SymbolDef>();
function LibThumb({ id }: { id: string }) {
  const doc = useStore((s) => s.doc);
  let def = libCache.get(id);
  if (!def) {
    const e = SYMBOL_LIBRARY.find((x) => x.id === id);
    if (!e) return null;
    def = e.build();
    libCache.set(id, def);
  }
  const view = symbolDocument(doc, def);
  const b = symbolBounds(view, def);
  if (!b) return null;
  return (
    <span className="sym-thumb" style={{ width: 32, height: 32 }}>
      <svg viewBox={`${b.x - 2} ${b.y - 2} ${b.width + 4} ${b.height + 4}`} preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <StaticDocument doc={view} ids={[def.root]} prefix={`syl-${id}-`} exportMode={false} />
      </svg>
    </span>
  );
}

export type { ID };
