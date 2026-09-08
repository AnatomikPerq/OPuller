/**
 * Swatches panel: document swatches as a grid or list. Click applies to the
 * active paint target (Alt-click to the other one), right-click for the swatch
 * menu, double-click to edit, drag to reorder, plus libraries, JSON
 * import/export and new/delete.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGrid, List, Plus, Trash2, BookOpen, Upload, Download, Blend, Check } from 'lucide-react';
import { useStore, getState, type ContextMenuItem } from '@/store/store';
import type { ID, Paint, Swatch, SolidPaint } from '@/model/types';
import { useCurrentAppearance } from '@/commands/appearance';
import { IconButton, Select, Popover, PopoverButton, Checkbox, TextField, Button, Segmented } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { paintEquals, paintTypeLabel, paintLabel } from '@/color/paint';
import { toGradient } from '@/color/gradient';
import { SWATCH_LIBRARIES } from '@/color/libraries';
import { exportSwatchesJson } from '@/color/swatches';
import { applySwatchPaint, applySwatch, deleteSwatches, duplicateSwatch, reorderSwatch, addLibrary, importSwatchesFromJson, selectObjectsUsing, updateSwatchPaint, renameSwatch, addSwatch, setSwatchKind, setSwatchCmyk } from '@/color/actions';
import { findSwatchByPaint } from '@/color/swatches';
import { isGlobalSwatch, colorValuesLabel, hexToCmyk } from '@/color/globals';
import { PaintPreview, CmykFields } from '../color/shared';
import './swatches.css';

type View = 'grid' | 'list';
type Size = 'small' | 'medium' | 'large';
const SIZES: Record<Size, number> = { small: 16, medium: 22, large: 30 };
const PREF_KEY = 'opuller.swatchesPanel';

function loadPrefs(): { view: View; size: Size } {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { view: p.view === 'list' ? 'list' : 'grid', size: p.size in SIZES ? p.size : 'medium' };
    }
  } catch {
    /* ignore */
  }
  return { view: 'grid', size: 'medium' };
}

interface DragState {
  id: ID;
  from: number;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  over: { index: number; after: boolean } | null;
}

export function SwatchesPanel() {
  const swatches = useStore((s) => s.doc.swatches);
  const target = useStore((s) => s.activePaintTarget);
  const app = useCurrentAppearance();
  const activePaint = target === 'fill' ? app.fill : app.stroke.paint;
  const [prefs, setPrefs] = useState(loadPrefs);
  const [selectedId, setSelectedId] = useState<ID | null>(null);
  const [editing, setEditing] = useState<{ id: ID; anchor: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const savePrefs = (p: Partial<{ view: View; size: Size }>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (selectedId && !swatches.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [swatches, selectedId]);

  const colorMode = useStore((s) => s.doc.colorMode);
  const inUseId = findSwatchByPaint(swatches, activePaint)?.id ?? null;
  const selected = selectedId ? swatches.find((s) => s.id === selectedId) ?? null : null;

  // --- actions --------------------------------------------------------------
  const apply = (sw: Swatch, alt: boolean) => {
    const t = alt ? (target === 'fill' ? 'stroke' : 'fill') : target;
    applySwatch(sw, t);
    setSelectedId(sw.id);
  };

  const openEditor = (id: ID, anchor: HTMLElement) => {
    setSelectedId(id);
    setEditing({ id, anchor });
  };

  const menuFor = (sw: Swatch, anchor: HTMLElement): ContextMenuItem[] => {
    const s = getState();
    const solid = sw.paint.type === 'solid';
    return [
      { label: 'Apply to Fill', onSelect: () => applySwatch(sw, 'fill') },
      { label: 'Apply to Stroke', onSelect: () => applySwatch(sw, 'stroke') },
      { separator: true },
      { label: 'Swatch Options…', onSelect: () => openEditor(sw.id, anchor) },
      { label: 'Rename…', onSelect: () => s.openDialog('swatch.rename', { id: sw.id, name: sw.name }) },
      { label: 'Duplicate', onSelect: () => duplicateSwatch(sw.id) },
      { label: 'Delete', onSelect: () => deleteSwatches([sw.id]) },
      { separator: true },
      { label: 'Global Color', checked: sw.kind === 'global', disabled: !solid, onSelect: () => setSwatchKind(sw.id, sw.kind === 'global' ? 'process' : 'global') },
      { label: 'Spot Color', checked: sw.kind === 'spot', disabled: !solid, onSelect: () => setSwatchKind(sw.id, sw.kind === 'spot' ? 'process' : 'spot') },
      { separator: true },
      { label: 'Select All Objects Using This Swatch', onSelect: () => selectObjectsUsing(sw.paint, sw.id) },
    ];
  };

  const onContextMenu = (e: React.MouseEvent, sw: Swatch) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(sw.id);
    getState().openContextMenu({ x: e.clientX, y: e.clientY, items: menuFor(sw, e.currentTarget as HTMLElement) });
  };

  const newSwatch = () => {
    getState().openDialog('swatch.new', { paint: activePaint.type === 'none' ? { type: 'solid', color: '#000000', opacity: 1 } : activePaint });
  };
  const newGradientSwatch = () => {
    const paint = toGradient(activePaint, 'linear');
    const sw = addSwatch(paint, 'New Gradient Swatch');
    setSelectedId(sw.id);
  };

  const exportJson = () => {
    const text = exportSwatchesJson(swatches);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getState().doc.name || 'swatches'}-swatches.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    getState().toast(`Exported ${swatches.length} swatches`, 'success');
  };

  const importFile = async (file: File) => {
    try {
      const text = await file.text();
      const n = importSwatchesFromJson(text);
      getState().toast(`Imported ${n} swatch${n === 1 ? '' : 'es'}`, 'success');
    } catch (err: any) {
      getState().toast(`Import failed: ${err?.message ?? err}`, 'error');
    }
  };

  // --- drag to reorder ----------------------------------------------------
  const cellAt = (x: number, y: number): { index: number; after: boolean } | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const cell = el?.closest?.('[data-swatch-index]') as HTMLElement | null;
    if (!cell || !containerRef.current?.contains(cell)) return null;
    const index = Number(cell.dataset.swatchIndex);
    const r = cell.getBoundingClientRect();
    const after = prefs.view === 'list' ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
    return { index, after };
  };

  const onCellPointerDown = (e: React.PointerEvent, sw: Swatch, index: number) => {
    if (e.button !== 0) return;
    const st: DragState = { id: sw.id, from: index, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, over: null };
    dragRef.current = st;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 4) return;
      st.moved = true;
      // capture only once a drag really starts so plain clicks reach the swatch button
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    st.over = cellAt(e.clientX, e.clientY);
    setDrag({ ...st });
  };
  const endDrag = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    try {
      containerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!st.moved) return;
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    const over = st.over ?? cellAt(e.clientX, e.clientY);
    if (!over) return;
    let to = over.after ? over.index + 1 : over.index;
    if (to > st.from) to -= 1;
    if (to !== st.from) reorderSwatch(st.from, to);
  };

  const dropClass = (index: number): string => {
    if (!drag || !drag.over || drag.over.index !== index || drag.from === index) return '';
    return drag.over.after ? 'drop-after' : 'drop-before';
  };

  const size = SIZES[prefs.size];

  return (
    <div className="swatches-panel" style={{ ['--sw-size' as any]: `${size}px` }} data-testid="swatches-panel">
      <div className="sw-toolbar">
        <IconButton icon={<LayoutGrid size={14} />} active={prefs.view === 'grid'} title="Grid view" onClick={() => savePrefs({ view: 'grid' })} data-testid="swatches-view-grid" />
        <IconButton icon={<List size={14} />} active={prefs.view === 'list'} title="List view" onClick={() => savePrefs({ view: 'list' })} data-testid="swatches-view-list" />
        <Select value={prefs.size} options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }]} onChange={(v) => savePrefs({ size: v as Size })} width={70} title="Swatch size" />
        <span className="sw-sep" />
        <PopoverButton
          placement="bottom"
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="icon-btn" onClick={toggle} title="Swatch libraries" data-testid="swatches-libraries">
              <BookOpen size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="sw-libraries" data-testid="swatches-libraries-menu">
              <div className="section-title">Add library</div>
              {SWATCH_LIBRARIES.map((lib) => (
                <button
                  key={lib.id}
                  type="button"
                  onClick={() => {
                    const n = addLibrary(lib.id);
                    if (n) getState().toast(`Added ${n} "${lib.name}" swatches`, 'success');
                    close();
                  }}
                  data-testid={`swatches-lib-${lib.id}`}
                >
                  <span className="sw-lib-preview">
                    {lib.colors.slice(0, 6).map(([n, c]) => (
                      <span key={n} style={{ background: c }} />
                    ))}
                  </span>
                  {lib.name}
                  <span className="sw-lib-count">{lib.colors.length}</span>
                </button>
              ))}
            </div>
          )}
        </PopoverButton>
        <IconButton icon={<Upload size={14} />} title="Import swatches (JSON)" onClick={() => fileRef.current?.click()} data-testid="swatches-import" />
        <IconButton icon={<Download size={14} />} title="Export swatches (JSON)" onClick={exportJson} data-testid="swatches-export" />
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} data-testid="swatches-import-input" />
        <span className="sw-sep" />
        <IconButton icon={<Blend size={14} />} title="New gradient swatch" onClick={newGradientSwatch} data-testid="swatches-new-gradient" />
        <IconButton icon={<Plus size={14} />} title="New swatch from the current colour…" onClick={newSwatch} data-testid="swatches-new" />
        <IconButton icon={<Trash2 size={14} />} title="Delete selected swatch" disabled={!selected} onClick={() => selected && deleteSwatches([selected.id])} data-testid="swatches-delete" />
      </div>

      <div
        ref={containerRef}
        className={prefs.view === 'grid' ? 'sw-grid' : 'sw-list'}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="swatches-grid"
      >
        <NoneCell view={prefs.view} selected={activePaint.type === 'none'} onClick={(alt) => applySwatchPaint({ type: 'none' }, alt ? (target === 'fill' ? 'stroke' : 'fill') : target)} />
        {swatches.map((sw, index) => {
          const cls = `${sw.id === selectedId ? 'selected' : ''} ${sw.id === inUseId ? 'in-use' : ''} ${drag?.id === sw.id ? 'dragging' : ''} ${dropClass(index)} ${sw.paint.type === 'linear' || sw.paint.type === 'radial' ? 'gradient-cell' : ''} ${sw.kind === 'global' ? 'global' : ''} ${sw.kind === 'spot' ? 'spot' : ''}`;
          const kindLabel = sw.kind === 'spot' ? ' (spot)' : sw.kind === 'global' ? ' (global)' : '';
          const common = {
            title: `${sw.name}${kindLabel} — ${sw.paint.type === 'solid' ? colorValuesLabel(sw, colorMode) : paintLabel(sw.paint)}\nClick: apply to ${target}. Alt+click: apply to ${target === 'fill' ? 'stroke' : 'fill'}. Double-click: options.`,
            'data-swatch-index': index,
            'data-swatch-id': sw.id,
            'data-testid': `swatch-${sw.id}`,
            onPointerDown: (e: React.PointerEvent) => onCellPointerDown(e, sw, index),
            onClick: (e: React.MouseEvent) => {
              if (suppressClick.current) return;
              apply(sw, e.altKey);
            },
            onDoubleClick: (e: React.MouseEvent) => openEditor(sw.id, e.currentTarget as HTMLElement),
            onContextMenu: (e: React.MouseEvent) => onContextMenu(e, sw),
          };
          if (prefs.view === 'grid') {
            return (
              <button key={sw.id} type="button" className={`sw-cell ${cls}`} {...common}>
                <PaintPreview paint={sw.paint} />
              </button>
            );
          }
          return (
            <button key={sw.id} type="button" className={`sw-row ${cls}`} {...common}>
              <span className="sw-row-preview">
                <PaintPreview paint={sw.paint} />
              </span>
              <span className="sw-row-name">{sw.name}</span>
              <span className="sw-row-type">{sw.kind === 'spot' ? 'Spot' : sw.kind === 'global' ? 'Global' : paintTypeLabel(sw.paint)}</span>
            </button>
          );
        })}
      </div>

      <div className="sw-footer">
        <span className="sw-footer-name" data-testid="swatches-status">
          {selected ? `${selected.name} — ${selected.paint.type === 'solid' ? colorValuesLabel(selected, colorMode) : paintLabel(selected.paint)}` : `${swatches.length} swatches`}
        </span>
        <span>{target === 'fill' ? 'Fill' : 'Stroke'}</span>
      </div>

      {editing && <SwatchEditor id={editing.id} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </div>
  );
}

function NoneCell({ view, selected, onClick }: { view: View; selected: boolean; onClick: (alt: boolean) => void }) {
  const title = 'None — removes the paint';
  if (view === 'grid') {
    return (
      <button type="button" className={`sw-cell ${selected ? 'in-use' : ''}`} title={title} onClick={(e) => onClick(e.altKey)} data-testid="swatch-none">
        <PaintPreview paint={{ type: 'none' }} />
      </button>
    );
  }
  return (
    <button type="button" className={`sw-row ${selected ? 'in-use' : ''}`} title={title} onClick={(e) => onClick(e.altKey)} data-testid="swatch-none">
      <span className="sw-row-preview">
        <PaintPreview paint={{ type: 'none' }} />
      </span>
      <span className="sw-row-name">[None]</span>
      <span className="sw-row-type">None</span>
    </button>
  );
}

/** Popover to edit a swatch's name and paint (optionally updating objects that use it). */
function SwatchEditor({ id, anchor, onClose }: { id: ID; anchor: HTMLElement; onClose: () => void }) {
  const sw = useStore((s) => s.doc.swatches.find((x) => x.id === id));
  const colorMode = useStore((s) => s.doc.colorMode);
  const [name, setName] = useState(sw?.name ?? '');
  const [updateObjects, setUpdateObjects] = useState(true);
  const [valueMode, setValueMode] = useState<'rgb' | 'cmyk'>(colorMode === 'cmyk' || sw?.kind === 'spot' ? 'cmyk' : 'rgb');
  const initial = useRef<{ paint: Paint; name: string } | null>(sw ? { paint: JSON.parse(JSON.stringify(sw.paint)), name: sw.name } : null);
  const close = useCallback(() => {
    if (sw && name.trim() && name.trim() !== sw.name) renameSwatch(id, name);
    onClose();
  }, [sw, name, id, onClose]);
  if (!sw) return null;
  const solidish: Paint = sw.paint.type === 'pattern' ? ({ type: 'solid', color: '#000000', opacity: 1 } as SolidPaint) : sw.paint;
  return (
    <Popover open onClose={close} anchor={anchor} placement="left" className="sw-editor-popover">
      <div className="sw-editor" data-testid="swatch-editor">
        <div className="section-title">Swatch options</div>
        <TextField label="Name" value={name} onChange={setName} onCommit={setName} />
        {sw.paint.type === 'solid' && (
          <div className="sw-kind-row" data-testid="swatch-kind-row">
            <Select
              label="Type"
              value={sw.kind === 'spot' ? 'spot' : 'process'}
              options={[
                { value: 'process', label: 'Process Color' },
                { value: 'spot', label: 'Spot Color' },
              ]}
              onChange={(v) => setSwatchKind(id, v === 'spot' ? 'spot' : sw.kind === 'global' ? 'global' : 'process')}
              width={120}
              id="swatch-edit-kind"
            />
            <Checkbox checked={isGlobalSwatch(sw)} disabled={sw.kind === 'spot'} onChange={(v) => setSwatchKind(id, v ? 'global' : 'process')} label="Global" title="Objects painted with a global colour follow its edits" />
            <Segmented value={valueMode} onChange={setValueMode} options={[{ value: 'rgb', label: 'RGB' }, { value: 'cmyk', label: 'CMYK' }]} />
          </div>
        )}
        {sw.paint.type === 'solid' && valueMode === 'cmyk' ? (
          <CmykFields value={sw.cmyk ?? hexToCmyk(sw.paint.color)} onChange={(v) => setSwatchCmyk(id, v, false)} onCommit={() => getState().commit('Edit Swatch')} preview={sw.paint.color} />
        ) : (
          <ColorPicker
            paint={solidish}
            allowNone={false}
            allowGradient
            showSwatches={false}
            onChange={(p) => updateSwatchPaint(id, p, updateObjects, false)}
            onCommit={() => getState().commit('Edit Swatch')}
          />
        )}
        {!isGlobalSwatch(sw) && <Checkbox checked={updateObjects} onChange={setUpdateObjects} label="Update objects using this swatch" title="Objects painted with exactly this swatch follow the edit" />}
        {isGlobalSwatch(sw) && <div className="dim small">{sw.kind === 'spot' ? 'Spot colour: objects painted with it (and their tints) follow every edit.' : 'Global colour: objects painted with it (and their tints) follow every edit.'}</div>}
        <div className="sw-editor-footer">
          <Button
            small
            onClick={() => {
              if (initial.current) {
                updateSwatchPaint(id, initial.current.paint, updateObjects, false);
                getState().commit('Edit Swatch');
                setName(initial.current.name);
              }
            }}
          >
            Reset
          </Button>
          <Button small primary onClick={close}>
            <Check size={12} /> Done
          </Button>
        </div>
      </div>
    </Popover>
  );
}

void paintEquals;
void applySwatchPaint;
