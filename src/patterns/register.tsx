/**
 * Patterns module wiring: Object > Pattern commands (Make, Edit Pattern,
 * Pattern Options, Pattern Fill Options, Expand Pattern Fill, Add Library),
 * the pattern editing session (tile group in isolation) and the dialogs.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { registerCommands, when, type Command } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Select, TextField, PopoverButton, Slider } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { useStore, getState, type EditorState } from '@/store/store';
import type { ID, PatternDef, PatternLayout, Paint } from '@/model/types';
import { activePaint, setActivePaint, currentAppearance } from '@/commands/appearance';
import { activeArtboard, viewCenter } from '@/io/fileOps';
import { insertionParent } from '@/tools/shapes/tool';
import { patternCell, LAYOUTS } from './tile';
import * as ops from './ops';
import './render';
import { PATTERN_LIBRARY } from './library';
import './patterns.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pattern of the active paint (fill/stroke of the selection or the defaults). */
function activePatternId(s: EditorState = getState()): ID | null {
  const p = activePaint(s);
  if (p.type === 'pattern') return p.patternId;
  const app = currentAppearance(s);
  if (app.fill.type === 'pattern') return app.fill.patternId;
  if (app.stroke.paint.type === 'pattern') return app.stroke.paint.patternId;
  return null;
}

export function makePatternCommand(opts: ops.MakePatternOptions = {}): PatternDef | null {
  const s = getState();
  if (!s.selection.length) {
    s.toast('Select artwork to make a pattern from', 'info');
    return null;
  }
  let def: PatternDef | null = null;
  s.updateDoc((d) => {
    def = ops.makePattern(d, s.selection, { name: opts.name ?? `Pattern ${d.patterns.length + 1}`, ...opts })?.def ?? null;
  }, 'Make Pattern');
  if (def) {
    getState().toast(`Pattern "${(def as PatternDef).name}" added to the swatches`, 'success');
    getState().openDialog('pattern.options', { id: (def as PatternDef).id, fresh: true });
  }
  return def;
}

export function editPatternCommand(patternId?: ID | null): boolean {
  const s = getState();
  const id = patternId ?? activePatternId(s);
  const def = ops.getPattern(s.doc, id);
  if (!def) {
    s.toast('Select an object filled with a pattern (or a pattern swatch) to edit it', 'info');
    return false;
  }
  if (!def.nodes) {
    s.toast('This pattern has no editable artwork', 'info');
    return false;
  }
  const ab = activeArtboard();
  const at = ab ? { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 } : viewCenter();
  let gid: ID | null = null;
  s.updateDoc((d) => {
    gid = ops.createTileGroup(d, def, at, insertionParent());
  }, 'Edit Pattern');
  if (!gid) return false;
  const st = getState();
  st.setSelection([]);
  st.setIsolation(gid);
  st.zoomToRect({ x: at.x - def.width, y: at.y - def.height, width: def.width * 2, height: def.height * 2 }, 80);
  st.toast('Editing pattern tile: edit the artwork, resize the dashed tile, then exit isolation (Escape) to apply', 'info');
  return true;
}

function finishPatternEdit(groupId: ID): void {
  const s = getState();
  if (!ops.isTileGroup(s.doc.nodes[groupId])) return;
  let name = '';
  s.updateDoc((d) => {
    const def = ops.commitTileGroup(d, groupId);
    name = def?.name ?? '';
  }, 'Edit Pattern');
  if (name) getState().toast(`Pattern "${name}" updated`, 'success');
}

// leaving isolation on a tile group commits the pattern
useStore.subscribe(
  (s) => s.isolationId,
  (iso, prev) => {
    if (!prev || iso === prev) return;
    const s = getState();
    if (!ops.isTileGroup(s.doc.nodes[prev])) return;
    // moved deeper inside the tile group: keep editing
    let cur = iso;
    let guard = 0;
    while (cur && guard++ < 1000) {
      if (cur === prev) return;
      cur = s.doc.nodes[cur]?.parent ?? null;
    }
    finishPatternEdit(prev);
  },
);

export function expandPatternFillCommand(): number {
  const s = getState();
  const ids = s.selection.filter((id) => {
    const n = s.doc.nodes[id];
    return n && n.type === 'path' && n.fill.type === 'pattern';
  });
  if (!ids.length) {
    s.toast('Select paths filled with a pattern', 'info');
    return 0;
  }
  const out: ID[] = [];
  s.updateDoc((d) => {
    for (const id of ids) {
      const g = ops.expandPatternFill(d, id);
      if (g) out.push(g);
    }
  }, 'Expand Pattern Fill');
  if (out.length) getState().setSelection(out);
  return out.length;
}

export function addPatternLibraryCommand(entryId?: string): number {
  const s = getState();
  const entries = entryId ? PATTERN_LIBRARY.filter((e) => e.id === entryId) : PATTERN_LIBRARY;
  const names = new Set(s.doc.patterns.map((p) => p.name));
  const missing = entryId ? entries : entries.filter((e) => !names.has(e.name));
  if (!missing.length) return 0;
  s.updateDoc((d) => {
    for (const e of missing) {
      const def = e.build();
      const added = ops.addPatternDef(d, def);
      ops.updatePatternOptions(d, added.id, {});
    }
  }, entryId ? 'Add Pattern' : 'Add Pattern Library');
  return missing.length;
}

const hasPatternFill = (s: EditorState) => s.selection.some((id) => {
  const n = s.doc.nodes[id];
  return n && n.type === 'path' && n.fill.type === 'pattern';
});

const commands: Command[] = [
  { id: 'pattern.make', label: 'Make', menu: 'Object/Pattern', order: 720, run: () => makePatternCommand(), enabled: when.hasSelection },
  { id: 'pattern.edit', label: 'Edit Pattern', menu: 'Object/Pattern', order: 721, run: () => editPatternCommand(), enabled: (s) => !!activePatternId(s) },
  { id: 'pattern.options', label: 'Pattern Options…', menu: 'Object/Pattern', order: 722, run: () => { const id = activePatternId(); if (id) getState().openDialog('pattern.options', { id }); }, enabled: (s) => !!activePatternId(s) },
  { id: 'pattern.fillOptions', label: 'Pattern Fill Options…', menu: 'Object/Pattern', order: 723, run: () => getState().openDialog('pattern.fill', {}), enabled: (s) => activePaint(s).type === 'pattern' },
  { id: 'pattern.expand', label: 'Expand Pattern Fill', menu: 'Object/Pattern', order: 724, separatorBefore: true, run: () => expandPatternFillCommand(), enabled: hasPatternFill },
  { id: 'pattern.addLibrary', label: 'Add Pattern Library', menu: 'Object/Pattern', order: 725, separatorBefore: true, run: () => { const n = addPatternLibraryCommand(); getState().toast(n ? `Added ${n} pattern swatches` : 'All library patterns are already in the document', 'info'); } },
];
registerCommands(commands);

// ---------------------------------------------------------------------------
// Pattern preview (used by the dialogs)
// ---------------------------------------------------------------------------

export function PatternPreview({ def, paint, width = 220, height = 120 }: { def: PatternDef; paint?: Paint; width?: number; height?: number }) {
  const cell = patternCell(def);
  const id = `ppv-${def.id}`;
  const p = paint && paint.type === 'pattern' ? paint : null;
  const pt = `translate(${p?.x ?? 0} ${p?.y ?? 0}) rotate(${p?.angle ?? 0}) scale(${p?.scale ?? 1})`;
  return (
    <svg className="pattern-preview" width={width} height={height} viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg" data-testid="pattern-preview">
      <defs>
        <pattern id={id} patternUnits="userSpaceOnUse" width={cell.width} height={cell.height} patternTransform={pt} dangerouslySetInnerHTML={{ __html: def.svg }} />
      </defs>
      <rect width={width} height={height} fill="#ffffff" />
      <rect width={width} height={height} fill={`url(#${id})`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pattern Options dialog (tile type, offset, spacing, size, background)
// ---------------------------------------------------------------------------

function PatternOptionsDialog({ props, close }: { props: { id: ID; fresh?: boolean }; close: () => void }) {
  const def = useStore((s) => s.doc.patterns.find((p) => p.id === props.id));
  const units = useStore((s) => s.prefs.units);
  const initial = useRef<PatternDef | null>(def ? JSON.parse(JSON.stringify(def)) : null);
  const [name, setName] = useState(def?.name ?? '');
  const patch = (p: ops.PatternOptionsPatch) => {
    getState().updateDoc((d) => {
      ops.updatePatternOptions(d, props.id, p);
    });
  };
  const ok = () => {
    if (name.trim() && name.trim() !== def?.name) patch({ name });
    getState().commit('Pattern Options');
    close();
  };
  const cancel = () => {
    if (props.fresh) {
      getState().commit('Pattern Options');
      close();
      return;
    }
    getState().revert();
    close();
  };
  if (!def) return null;
  const editable = !!def.nodes;
  return (
    <DialogFrame
      title="Pattern Options"
      onClose={cancel}
      width={560}
      className="pattern-dialog"
      footer={
        <>
          <Button onClick={() => { cancel(); editPatternCommand(def.id); }} disabled={!editable} title="Edit the tile artwork on the canvas">
            Edit Artwork…
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={cancel}>{props.fresh ? 'Done' : 'Cancel'}</Button>
          <Button primary onClick={ok} data-testid="pattern-options-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="pattern-options">
        <div className="pattern-form">
          <TextField label="Name" value={name} onChange={setName} onCommit={setName} id="pattern-name" />
          <Select label="Tile type" value={def.layout ?? 'grid'} options={LAYOUTS.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => patch({ layout: v as PatternLayout })} id="pattern-layout" />
          {(def.layout === 'brick-row' || def.layout === 'brick-col') && (
            <Select
              label="Brick offset"
              value={String(def.offset ?? 0.5)}
              options={[
                { value: '0.5', label: '1/2' },
                { value: '0.3333', label: '1/3' },
                { value: '0.25', label: '1/4' },
                { value: '0.2', label: '1/5' },
                { value: '0.6667', label: '2/3' },
                { value: '0.75', label: '3/4' },
              ]}
              onChange={(v) => patch({ offset: Number(v) })}
              id="pattern-offset"
            />
          )}
          <Row gap={6}>
            <NumberField label="Width" value={def.width} unit={units} min={1} max={10000} onChange={(v) => patch({ width: v })} width={120} data-testid="pattern-width" />
            <NumberField label="Height" value={def.height} unit={units} min={1} max={10000} onChange={(v) => patch({ height: v })} width={120} data-testid="pattern-height" />
          </Row>
          <Row gap={6}>
            <NumberField label="H spacing" value={def.spacing?.x ?? 0} unit={units} min={-10000} max={10000} onChange={(v) => patch({ spacing: { x: v, y: def.spacing?.y ?? 0 } })} width={120} data-testid="pattern-spacing-x" />
            <NumberField label="V spacing" value={def.spacing?.y ?? 0} unit={units} min={-10000} max={10000} onChange={(v) => patch({ spacing: { x: def.spacing?.x ?? 0, y: v } })} width={120} data-testid="pattern-spacing-y" />
          </Row>
          <Row gap={8}>
            <Checkbox checked={!!def.background} onChange={(v) => patch({ background: v ? '#ffffff' : null })} label="Tile background" />
            {def.background && (
              <PopoverButton button={({ toggle, ref }) => <button type="button" ref={ref} className="io-color-swatch" style={{ background: def.background ?? '#fff' }} onClick={toggle} title="Background colour" />}>
                <ColorPicker paint={{ type: 'solid', color: def.background, opacity: 1 }} onChange={(p) => p.type === 'solid' && patch({ background: p.color })} allowNone={false} allowGradient={false} />
              </PopoverButton>
            )}
          </Row>
          <div className="dim small">{editable ? 'Objects filled with this pattern update live. "Edit Artwork" places the tile on the canvas for editing.' : 'Library markup pattern: tiling options only.'}</div>
        </div>
        <PatternPreview def={def} />
      </div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Pattern Fill Options dialog (scale / angle / offset of the applied paint)
// ---------------------------------------------------------------------------

function PatternFillDialog({ close }: { close: () => void }) {
  const paint = useStore((s) => activePaint(s));
  const patterns = useStore((s) => s.doc.patterns);
  const p = paint.type === 'pattern' ? paint : null;
  const def = p ? patterns.find((x) => x.id === p.patternId) : undefined;
  const [scale, setScale] = useState(p?.scale ?? 1);
  const [angle, setAngle] = useState(p?.angle ?? 0);
  const [x, setX] = useState(p?.x ?? 0);
  const [y, setY] = useState(p?.y ?? 0);
  const apply = (next: { scale: number; angle: number; x: number; y: number }) => {
    if (!p) return;
    setActivePaint({ ...p, scale: next.scale, angle: next.angle, x: next.x, y: next.y }, false);
  };
  const ok = () => {
    getState().commit('Pattern Fill Options');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  if (!p || !def) return null;
  return (
    <DialogFrame
      title="Pattern Fill Options"
      onClose={cancel}
      width={520}
      className="pattern-dialog"
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="pattern-fill-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="pattern-options">
        <div className="pattern-form">
          <Slider label="Scale" value={Math.round(scale * 100)} min={5} max={500} unit="%" onChange={(v) => { setScale(v / 100); apply({ scale: v / 100, angle, x, y }); }} />
          <Slider label="Angle" value={angle} min={-180} max={180} unit="deg" onChange={(v) => { setAngle(v); apply({ scale, angle: v, x, y }); }} />
          <Row gap={6}>
            <NumberField label="X" value={x} onChange={(v) => { setX(v); apply({ scale, angle, x: v, y }); }} width={110} data-testid="pattern-fill-x" />
            <NumberField label="Y" value={y} onChange={(v) => { setY(v); apply({ scale, angle, x, y: v }); }} width={110} data-testid="pattern-fill-y" />
          </Row>
          <div className="dim small">{def.name}: adjusts how the pattern is placed inside the selected objects.</div>
        </div>
        <PatternPreview def={def} paint={{ ...p, scale, angle, x, y }} />
      </div>
    </DialogFrame>
  );
}

registerDialog('pattern.options', PatternOptionsDialog as any);
registerDialog('pattern.fill', ({ close }) => <PatternFillDialog close={close} />);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  patterns: { ...ops, patternCell, library: PATTERN_LIBRARY, makePatternCommand, editPatternCommand, expandPatternFillCommand, addPatternLibraryCommand, activePatternId },
};

void useEffect;
void useMemo;
