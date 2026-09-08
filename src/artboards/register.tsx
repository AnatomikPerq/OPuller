/**
 * Artboards module wiring: the Artboards panel, Object > Artboards commands,
 * Select > All on Active Artboard, and the Artboard Options / Rearrange dialogs.
 */
import React, { useState, useEffect, useRef } from 'react';
import { Plus, Copy, Trash2, ArrowUp, ArrowDown, Settings2, Maximize, LayoutGrid, Frame } from 'lucide-react';
import type { Artboard, ID } from '@/model/types';
import { useStore, getState, type EditorState } from '@/store/store';
import { registerPanel } from '@/ui/panels/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { registerCommands, when } from '@/commands/registry';
import { IconButton, Button, NumberField, TextField, Select, Checkbox, Row, Segmented, Tooltip } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { formatLength } from '@/util/units';
import { shortcutLabel } from '@/util/keys';
import { topmostOf } from '@/model/document';
import {
  ARTBOARD_PRESETS,
  addArtboard,
  duplicateArtboard,
  deleteArtboard,
  fitArtboardToArtwork,
  rearrangeArtboards,
  reorderArtboard,
  convertToArtboards,
  artworkOnArtboard,
  getArtboard,
  presetFor,
  uniqueArtboardName,
  type RearrangeOptions,
} from './ops';
import './artboards.css';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function active(s: EditorState = getState()): Artboard | undefined {
  return getArtboard(s.doc, s.activeArtboardId) ?? s.doc.artboards[0];
}

export function newArtboardCommand(): void {
  const s = getState();
  const cur = active(s);
  let id: ID | null = null;
  s.updateDoc((d) => {
    const ab = addArtboard(d, cur ? { width: cur.width, height: cur.height, background: cur.background, transparent: cur.transparent } : {});
    id = ab.id;
  }, 'New Artboard');
  if (id) {
    const st = getState();
    st.setActiveArtboard(id);
    const ab = getArtboard(st.doc, id);
    if (ab) st.zoomToRect(ab, 60);
  }
}

export function duplicateArtboardCommand(withArtwork = true): void {
  const s = getState();
  const cur = active(s);
  if (!cur) return;
  let id: ID | null = null;
  s.updateDoc((d) => {
    const ab = duplicateArtboard(d, cur.id, withArtwork);
    id = ab?.id ?? null;
  }, 'Duplicate Artboard');
  if (id) {
    const st = getState();
    st.setActiveArtboard(id);
    const ab = getArtboard(st.doc, id);
    if (ab) st.zoomToRect(ab, 60);
  }
}

export function deleteArtboardCommand(id?: ID, deleteArtwork = false): void {
  const s = getState();
  const target = id ?? active(s)?.id;
  if (!target) return;
  if (s.doc.artboards.length <= 1) {
    s.toast('A document needs at least one artboard.', 'info');
    return;
  }
  const idx = s.doc.artboards.findIndex((a) => a.id === target);
  s.updateDoc((d) => {
    deleteArtboard(d, target, deleteArtwork);
  }, 'Delete Artboard');
  const st = getState();
  const next = st.doc.artboards[Math.min(idx, st.doc.artboards.length - 1)];
  if (next) st.setActiveArtboard(next.id);
}

export function fitToArtworkCommand(selectedOnly: boolean): void {
  const s = getState();
  const cur = active(s);
  if (!cur) return;
  const ids = selectedOnly ? topmostOf(s.doc, s.selection) : undefined;
  let ok = false;
  s.updateDoc((d) => {
    ok = fitArtboardToArtwork(d, cur.id, ids);
  }, selectedOnly ? 'Fit Artboard to Selected Art' : 'Fit Artboard to Artwork');
  if (!ok) s.toast(selectedOnly ? 'Select some artwork first.' : 'There is no artwork on this artboard.', 'info');
}

export function selectAllOnArtboard(): void {
  const s = getState();
  const cur = active(s);
  if (!cur) return;
  const ids = artworkOnArtboard(s.doc, cur, 'intersect').filter((id) => {
    const n = s.doc.nodes[id];
    return n && n.visible && !n.locked;
  });
  s.setSelection(ids);
}

export function convertSelectionToArtboards(): void {
  const s = getState();
  const roots = topmostOf(s.doc, s.selection);
  if (!roots.length) return;
  let created: Artboard[] = [];
  s.updateDoc((d) => {
    created = convertToArtboards(d, roots);
  }, 'Convert to Artboards');
  if (created.length) getState().setActiveArtboard(created[created.length - 1].id);
  else s.toast('Nothing could be converted (objects need a size).', 'info');
}

function gotoArtboard(delta: number): void {
  const s = getState();
  const list = s.doc.artboards;
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((a) => a.id === s.activeArtboardId));
  const next = list[(i + delta + list.length) % list.length];
  s.setActiveArtboard(next.id);
  s.zoomToRect(next, 40);
}

registerCommands([
  { id: 'artboard.new', label: 'New Artboard', menu: 'Object/Artboards', order: 400, run: newArtboardCommand },
  { id: 'artboard.duplicate', label: 'Duplicate Artboard', menu: 'Object/Artboards', order: 401, run: () => duplicateArtboardCommand(true) },
  { id: 'artboard.duplicateEmpty', label: 'Duplicate Artboard (Empty)', menu: 'Object/Artboards', order: 402, run: () => duplicateArtboardCommand(false) },
  { id: 'artboard.delete', label: 'Delete Artboard', menu: 'Object/Artboards', order: 403, run: () => deleteArtboardCommand(), enabled: (s) => s.doc.artboards.length > 1 },
  { id: 'artboard.deleteWithArt', label: 'Delete Artboard and Artwork', menu: 'Object/Artboards', order: 404, run: () => deleteArtboardCommand(undefined, true), enabled: (s) => s.doc.artboards.length > 1 },
  { id: 'artboard.options', label: 'Artboard Options…', menu: 'Object/Artboards', order: 410, separatorBefore: true, run: () => { const a = active(); if (a) getState().openDialog('artboardOptions', { id: a.id }); } },
  { id: 'artboard.rearrange', label: 'Rearrange All Artboards…', menu: 'Object/Artboards', order: 411, run: () => getState().openDialog('rearrangeArtboards', {}), enabled: (s) => s.doc.artboards.length > 1 },
  { id: 'artboard.fitToArtwork', label: 'Fit to Artwork Bounds', menu: 'Object/Artboards', order: 420, separatorBefore: true, run: () => fitToArtworkCommand(false) },
  { id: 'artboard.fitToSelected', label: 'Fit to Selected Art', menu: 'Object/Artboards', order: 421, run: () => fitToArtworkCommand(true), enabled: when.hasSelection },
  { id: 'artboard.convert', label: 'Convert to Artboards', menu: 'Object/Artboards', order: 422, run: convertSelectionToArtboards, enabled: when.hasSelection },
  { id: 'artboard.tool', label: 'Edit Artboards', menu: 'Object/Artboards', shortcut: 'shift+o', order: 430, separatorBefore: true, hidden: true, run: () => getState().setTool('artboard') },
  { id: 'select.allOnArtboard', label: 'All on Active Artboard', menu: 'Select', shortcut: 'mod+alt+a', order: 2, run: selectAllOnArtboard },
  { id: 'view.nextArtboard', label: 'Next Artboard', menu: 'View', order: 16, run: () => gotoArtboard(1), enabled: (s) => s.doc.artboards.length > 1 },
  { id: 'view.prevArtboard', label: 'Previous Artboard', menu: 'View', order: 17, run: () => gotoArtboard(-1), enabled: (s) => s.doc.artboards.length > 1 },
]);

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function ArtboardRow({ ab, index, isActive }: { ab: Artboard; index: number; isActive: boolean }) {
  const units = useStore((s) => s.prefs.units);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ab.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const commitName = () => {
    setEditing(false);
    const v = name.trim();
    if (!v || v === ab.name) {
      setName(ab.name);
      return;
    }
    getState().updateDoc((d) => {
      const a = getArtboard(d, ab.id);
      if (a) a.name = uniqueArtboardName(d, v, a.id);
    }, 'Rename Artboard');
  };
  return (
    <div
      className={`ab-row ${isActive ? 'active' : ''}`}
      data-testid={`artboard-row-${index}`}
      onClick={() => getState().setActiveArtboard(ab.id)}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.ab-name')) {
          setName(ab.name);
          setEditing(true);
        } else getState().zoomToRect(ab, 40);
      }}
    >
      <span className="ab-index">{index + 1}</span>
      <Frame size={12} className="ab-icon" />
      {editing ? (
        <input
          ref={inputRef}
          className="ab-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') {
              setName(ab.name);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="ab-name" title="Double-click to rename">
          {ab.name}
        </span>
      )}
      <span className="ab-size">
        {formatLength(ab.width, units)} × {formatLength(ab.height, units)}
      </span>
      <IconButton
        icon={<Settings2 size={12} />}
        title="Artboard Options"
        size={12}
        className="ab-row-btn"
        onClick={() => {
          getState().setActiveArtboard(ab.id);
          getState().openDialog('artboardOptions', { id: ab.id });
        }}
      />
    </div>
  );
}

export function ArtboardsPanel() {
  const artboards = useStore((s) => s.doc.artboards);
  const activeId = useStore((s) => s.activeArtboardId);
  const idx = artboards.findIndex((a) => a.id === activeId);
  const move = (delta: number) => {
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= artboards.length) return;
    getState().updateDoc((d) => reorderArtboard(d, artboards[idx].id, target), 'Reorder Artboards');
  };
  return (
    <div className="artboards-panel" data-testid="artboards-panel">
      <div className="ab-list">
        {artboards.map((ab, i) => (
          <ArtboardRow key={ab.id} ab={ab} index={i} isActive={ab.id === activeId} />
        ))}
      </div>
      <div className="ab-footer">
        <Tooltip text="Edit artboards on the canvas" shortcut="shift+o">
          <IconButton icon={<Frame size={13} />} title="Artboard Tool" onClick={() => getState().setTool('artboard')} data-testid="artboards-tool" />
        </Tooltip>
        <IconButton icon={<ArrowUp size={13} />} title="Move Up" disabled={idx <= 0} onClick={() => move(-1)} data-testid="artboards-up" />
        <IconButton icon={<ArrowDown size={13} />} title="Move Down" disabled={idx < 0 || idx >= artboards.length - 1} onClick={() => move(1)} data-testid="artboards-down" />
        <IconButton icon={<Maximize size={13} />} title="Fit to Artwork Bounds" onClick={() => fitToArtworkCommand(false)} />
        <IconButton icon={<LayoutGrid size={13} />} title="Rearrange All Artboards…" disabled={artboards.length < 2} onClick={() => getState().openDialog('rearrangeArtboards', {})} />
        <span className="grow" />
        <IconButton icon={<Plus size={13} />} title="New Artboard" onClick={newArtboardCommand} data-testid="artboards-new" />
        <IconButton icon={<Copy size={13} />} title="Duplicate Artboard (with artwork)" onClick={() => duplicateArtboardCommand(true)} data-testid="artboards-duplicate" />
        <IconButton icon={<Trash2 size={13} />} title="Delete Artboard" disabled={artboards.length <= 1} onClick={() => deleteArtboardCommand()} data-testid="artboards-delete" />
      </div>
    </div>
  );
}

registerPanel({ id: 'artboards', title: 'Artboards', component: ArtboardsPanel, order: 11, defaultVisible: true, shortcut: 'shift+f9', minHeight: 120 });

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function ArtboardOptionsDialog({ props, close }: { props: { id: ID }; close: () => void }) {
  const s = getState();
  const ab = getArtboard(s.doc, props.id);
  const units = s.prefs.units;
  const [name, setName] = useState(ab?.name ?? '');
  const [width, setWidth] = useState(ab?.width ?? 1920);
  const [height, setHeight] = useState(ab?.height ?? 1080);
  const [x, setX] = useState(ab?.x ?? 0);
  const [y, setY] = useState(ab?.y ?? 0);
  const [background, setBackground] = useState(ab?.background ?? '#ffffff');
  const [transparent, setTransparent] = useState(ab?.transparent ?? false);
  const [colorOpen, setColorOpen] = useState(false);
  if (!ab) return null;
  const preset = presetFor(width, height);
  const orientation = width >= height ? 'landscape' : 'portrait';
  const ok = () => {
    getState().updateDoc((d) => {
      const a = getArtboard(d, ab.id);
      if (!a) return;
      a.name = uniqueArtboardName(d, name.trim() || a.name, a.id);
      a.width = Math.max(1, width);
      a.height = Math.max(1, height);
      a.x = x;
      a.y = y;
      a.background = background;
      a.transparent = transparent;
    }, 'Artboard Options');
    close();
  };
  return (
    <DialogFrame
      title="Artboard Options"
      onClose={close}
      width={420}
      className="artboard-options-dialog"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="artboard-options-ok">
            OK
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={setName} onCommit={setName} id="ab-opt-name" width={260} />
      <Row gap={8}>
        <Select
          label="Preset"
          value={preset ? preset.name : ''}
          options={[{ value: '', label: 'Custom' }, ...ARTBOARD_PRESETS.map((p) => ({ value: p.name, label: `${p.group} · ${p.name}` }))]}
          onChange={(v) => {
            if (!v) return;
            const pr = ARTBOARD_PRESETS.find((q) => q.name === v);
            if (!pr) return;
            const [w, h] = [pr.width, pr.height];
            const landscape = width >= height;
            setWidth(landscape ? Math.max(w, h) : Math.min(w, h));
            setHeight(landscape ? Math.min(w, h) : Math.max(w, h));
          }}
          width={230}
        />
        <Segmented
          value={orientation}
          options={[
            { value: 'portrait', label: 'Portrait' },
            { value: 'landscape', label: 'Landscape' },
          ]}
          onChange={(v) => {
            if (v !== orientation) {
              setWidth(height);
              setHeight(width);
            }
          }}
        />
      </Row>
      <Row gap={8}>
        <NumberField label="Width" value={width} onChange={setWidth} min={1} unit={units} width={130} data-testid="ab-opt-w" />
        <NumberField label="Height" value={height} onChange={setHeight} min={1} unit={units} width={130} data-testid="ab-opt-h" />
      </Row>
      <Row gap={8}>
        <NumberField label="X" value={x} onChange={setX} unit={units} width={130} />
        <NumberField label="Y" value={y} onChange={setY} unit={units} width={130} />
      </Row>
      <Row gap={10} align="center">
        <span className="field-label">Background</span>
        <button type="button" className="ab-color-swatch" style={{ background: transparent ? 'transparent' : background }} onClick={() => setColorOpen((v) => !v)} title="Background colour" />
        <Checkbox checked={transparent} onChange={setTransparent} label="Transparent" />
      </Row>
      {colorOpen && (
        <div className="ab-color-picker">
          <ColorPicker paint={{ type: 'solid', color: background, opacity: 1 }} onChange={(p) => p.type === 'solid' && setBackground(p.color)} allowNone={false} allowGradient={false} />
        </div>
      )}
      <div className="dim small">Position and size are in world units; the background is used on canvas and for opaque exports.</div>
    </DialogFrame>
  );
}

let lastRearrange: RearrangeOptions = { columns: 3, spacing: 100, layout: 'row', moveArtwork: true };

function RearrangeDialog({ close }: { close: () => void }) {
  const count = getState().doc.artboards.length;
  const [opts, setOpts] = useState<RearrangeOptions>({ ...lastRearrange, columns: Math.min(lastRearrange.columns, Math.max(1, count)) });
  const ok = () => {
    lastRearrange = opts;
    getState().updateDoc((d) => rearrangeArtboards(d, opts), 'Rearrange Artboards');
    close();
    const s = getState();
    let r = s.doc.artboards[0] ? { ...s.doc.artboards[0] } : null;
    for (const a of s.doc.artboards) {
      if (!r) break;
      const x = Math.min(r.x, a.x);
      const y = Math.min(r.y, a.y);
      const right = Math.max(r.x + r.width, a.x + a.width);
      const bottom = Math.max(r.y + r.height, a.y + a.height);
      r = { ...r, x, y, width: right - x, height: bottom - y };
    }
    if (r) s.zoomToRect(r, 40);
  };
  return (
    <DialogFrame
      title="Rearrange All Artboards"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="rearrange-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <span className="field-label">Layout</span>
        <Segmented
          value={opts.layout}
          options={[
            { value: 'row', label: 'Grid by row' },
            { value: 'column', label: 'Grid by column' },
          ]}
          onChange={(v) => setOpts({ ...opts, layout: v })}
        />
      </Row>
      <Row gap={8}>
        <NumberField label={opts.layout === 'row' ? 'Columns' : 'Rows'} value={opts.columns} onChange={(v) => setOpts({ ...opts, columns: Math.max(1, Math.round(v)) })} min={1} max={count} width={120} data-testid="rearrange-columns" />
        <NumberField label="Spacing" value={opts.spacing} onChange={(v) => setOpts({ ...opts, spacing: Math.max(0, v) })} min={0} unit={getState().prefs.units} width={140} />
      </Row>
      <Checkbox checked={opts.moveArtwork} onChange={(v) => setOpts({ ...opts, moveArtwork: v })} label="Move artwork with artboards" />
      <div className="dim small">
        {count} artboards will be laid out starting at the first artboard's position ({shortcutLabel('shift+o')} edits artboards on the canvas).
      </div>
    </DialogFrame>
  );
}

registerDialog<{ id: ID }>('artboardOptions', ArtboardOptionsDialog);
registerDialog('rearrangeArtboards', ({ close }) => <RearrangeDialog close={close} />);

void React;
