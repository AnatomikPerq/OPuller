/**
 * Brushes module wiring: the Brushes panel, Window/Object commands, Expand
 * Appearance (brush strokes), New Brush and Brush Options dialogs.
 */
import React, { useState } from 'react';
import { registerPanel } from '@/ui/panels/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { registerCommands, when, type Command } from '@/commands/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Segmented, Select, TextField, Slider } from '@/ui/widgets';
import { useStore, getState, type EditorState } from '@/store/store';
import type { ID, BrushDef, BrushColorization, CalligraphicBrush, ScatterBrush, ArtBrush, PatternBrush } from '@/model/types';
import { registerExpander } from '@/appearance/expand';
import '@/appearance/expand';
import { BrushesPanel, BrushPreview } from './BrushesPanel';
import { useBrushStore } from './store';
import * as ops from './ops';
import * as actions from './actions';
import * as geometry from './geometry';
import { BRUSH_LIBRARY } from './library';
import { sampleSpine, brushItems } from './geometry';
import { defaultStroke } from '@/model/defaults';
import { pathToSvgD } from '@/geometry/path';

registerPanel({ id: 'brushes', title: 'Brushes', component: BrushesPanel, order: 37, defaultVisible: true, shortcut: 'f5' });

registerExpander('brush', (doc, id) => {
  const g = ops.expandBrushStroke(doc, id);
  return g ? [g] : null;
});

const hasBrushStroke = (s: EditorState) => s.selection.some((id) => {
  const n = s.doc.nodes[id];
  return n && n.type === 'path' && !!n.stroke.brush;
});

const commands: Command[] = [
  { id: 'brush.new', label: 'New Brush…', menu: 'Object/Brush', order: 730, run: () => getState().openDialog('brush.new', {}) },
  { id: 'brush.options', label: 'Brush Options…', menu: 'Object/Brush', order: 731, run: () => { const id = actions.activeBrushId(); if (id) getState().openDialog('brush.options', { id }); }, enabled: () => !!actions.activeBrushId() },
  { id: 'brush.remove', label: 'Remove Brush Stroke', menu: 'Object/Brush', order: 732, run: () => actions.removeBrushStrokeCommand(), enabled: (s) => hasBrushStroke(s) || !!s.appearance.stroke.brush },
  { id: 'brush.expand', label: 'Expand Brush Strokes', menu: 'Object/Brush', order: 733, run: () => actions.expandBrushStrokesCommand(), enabled: hasBrushStroke },
  { id: 'brush.addLibrary', label: 'Add Brush Library', menu: 'Object/Brush', order: 734, separatorBefore: true, run: () => { const n = actions.addWholeBrushLibrary(); getState().toast(n ? `Added ${n} brushes` : 'All library brushes are already in the document', 'info'); } },
];
registerCommands(commands);

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const COLORIZATIONS: Array<{ value: BrushColorization; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'tints', label: 'Tints' },
  { value: 'tintsShades', label: 'Tints and Shades' },
  { value: 'hue', label: 'Hue Shift' },
];

function CalligraphicPreview({ def }: { def: CalligraphicBrush }) {
  const a = def.size / 2;
  const b = a * (def.roundness / 100);
  return (
    <svg className="brush-calli-preview" viewBox="-60 -60 120 120" aria-hidden>
      <ellipse cx={0} cy={0} rx={Math.min(55, a)} ry={Math.min(55, b)} transform={`rotate(${-def.angle})`} fill="#000" />
    </svg>
  );
}

function CalligraphicForm({ def, onChange }: { def: CalligraphicBrush; onChange: (p: Partial<CalligraphicBrush>) => void }) {
  return (
    <div className="brush-dialog-body">
      <div className="brush-form">
        <Slider label="Angle" value={Math.round(def.angle)} min={-180} max={180} unit="deg" onChange={(v) => onChange({ angle: v })} />
        <Slider label="Roundness" value={Math.round(def.roundness)} min={0} max={100} unit="%" onChange={(v) => onChange({ roundness: v })} />
        <Slider label="Size" value={+def.size.toFixed(1)} min={0.5} max={200} step={0.5} unit="px" decimals={1} onChange={(v) => onChange({ size: v })} />
        <Row gap={6}>
          <NumberField label="Angle ±" value={def.angleVariation ?? 0} min={0} max={180} unit="deg" decimals={0} onChange={(v) => onChange({ angleVariation: v || undefined })} width={100} />
          <NumberField label="Round ±" value={def.roundnessVariation ?? 0} min={0} max={100} unit="%" decimals={0} onChange={(v) => onChange({ roundnessVariation: v || undefined })} width={100} />
          <NumberField label="Size ±" value={def.sizeVariation ?? 0} min={0} max={200} unit="px" decimals={1} onChange={(v) => onChange({ sizeVariation: v || undefined })} width={100} />
        </Row>
      </div>
      <CalligraphicPreview def={def} />
    </div>
  );
}

function RangeRow({ label, value, onChange, min, max, unit }: { label: string; value: [number, number]; onChange: (v: [number, number]) => void; min: number; max: number; unit: 'deg' | '%' }) {
  return (
    <div className="range-row">
      <span className="field-label">{label}</span>
      <NumberField value={value[0]} min={min} max={max} unit={unit} decimals={0} onChange={(v) => onChange([v, Math.max(v, value[1])])} title="Minimum" />
      <NumberField value={value[1]} min={min} max={max} unit={unit} decimals={0} onChange={(v) => onChange([Math.min(v, value[0]), v])} title="Maximum" />
    </div>
  );
}

function ScatterForm({ def, onChange }: { def: ScatterBrush; onChange: (p: Partial<ScatterBrush>) => void }) {
  return (
    <div className="brush-form">
      <RangeRow label="Size" value={def.size} min={1} max={1000} unit="%" onChange={(v) => onChange({ size: v })} />
      <RangeRow label="Spacing" value={def.spacing} min={1} max={1000} unit="%" onChange={(v) => onChange({ spacing: v })} />
      <RangeRow label="Scatter" value={def.scatter} min={-1000} max={1000} unit="%" onChange={(v) => onChange({ scatter: v })} />
      <RangeRow label="Rotation" value={def.rotation} min={-180} max={180} unit="deg" onChange={(v) => onChange({ rotation: v })} />
      <Row gap={8}>
        <span className="field-label">Rotation relative to</span>
        <Segmented value={def.rotationRelativeTo} onChange={(v) => onChange({ rotationRelativeTo: v })} options={[{ value: 'page', label: 'Page' }, { value: 'path', label: 'Path' }]} />
      </Row>
      <Select label="Colorization" value={def.colorization} options={COLORIZATIONS} onChange={(v) => onChange({ colorization: v as BrushColorization })} width={180} />
    </div>
  );
}

function ArtForm({ def, onChange }: { def: ArtBrush; onChange: (p: Partial<ArtBrush>) => void }) {
  return (
    <div className="brush-form">
      <Slider label="Width" value={Math.round(def.width)} min={1} max={1000} unit="%" onChange={(v) => onChange({ width: v })} />
      <Row gap={8}>
        <span className="field-label">Brush scaling</span>
        <Segmented value={def.stretch} onChange={(v) => onChange({ stretch: v })} options={[{ value: 'stretch', label: 'Stretch to fit' }, { value: 'proportional', label: 'Proportional' }]} />
      </Row>
      <Row gap={10}>
        <Checkbox checked={!!def.flipAlong} onChange={(v) => onChange({ flipAlong: v })} label="Flip along" />
        <Checkbox checked={!!def.flipAcross} onChange={(v) => onChange({ flipAcross: v })} label="Flip across" />
      </Row>
      <Select label="Colorization" value={def.colorization} options={COLORIZATIONS} onChange={(v) => onChange({ colorization: v as BrushColorization })} width={180} />
    </div>
  );
}

function PatternForm({ def, onChange }: { def: PatternBrush; onChange: (p: Partial<PatternBrush>) => void }) {
  return (
    <div className="brush-form">
      <Slider label="Scale" value={Math.round(def.scale)} min={1} max={1000} unit="%" onChange={(v) => onChange({ scale: v })} />
      <Slider label="Spacing" value={Math.round(def.spacing)} min={0} max={500} unit="%" onChange={(v) => onChange({ spacing: v })} />
      <Row gap={8}>
        <span className="field-label">Fit</span>
        <Segmented value={def.fit} onChange={(v) => onChange({ fit: v })} options={[{ value: 'stretch', label: 'Stretch to fit' }, { value: 'space', label: 'Add space' }, { value: 'approximate', label: 'Approximate' }]} />
      </Row>
      <Row gap={10}>
        <Checkbox checked={!!def.flipAlong} onChange={(v) => onChange({ flipAlong: v })} label="Flip along" />
        <Checkbox checked={!!def.flipAcross} onChange={(v) => onChange({ flipAcross: v })} label="Flip across" />
      </Row>
      <Select label="Colorization" value={def.colorization} options={COLORIZATIONS} onChange={(v) => onChange({ colorization: v as BrushColorization })} width={180} />
      <div className="dim small">{def.start ? 'Has a start tile. ' : ''}{def.end ? 'Has an end tile. ' : ''}Use "New Brush" with a selection to define side / start / end tiles.</div>
    </div>
  );
}

function BrushForm({ def, onChange }: { def: BrushDef; onChange: (p: Partial<BrushDef>) => void }) {
  switch (def.kind) {
    case 'calligraphic':
      return <CalligraphicForm def={def} onChange={onChange as (p: Partial<CalligraphicBrush>) => void} />;
    case 'scatter':
      return <ScatterForm def={def} onChange={onChange as (p: Partial<ScatterBrush>) => void} />;
    case 'art':
      return <ArtForm def={def} onChange={onChange as (p: Partial<ArtBrush>) => void} />;
    case 'pattern':
      return <PatternForm def={def} onChange={onChange as (p: Partial<PatternBrush>) => void} />;
  }
}

function BrushOptionsDialog({ props, close }: { props: { id: ID }; close: () => void }) {
  const def = useStore((s) => s.doc.brushes.find((b) => b.id === props.id));
  const users = useStore((s) => (def ? ops.nodesUsingBrush(s.doc, def.id).length : 0));
  const [name, setName] = useState(def?.name ?? '');
  if (!def) return null;
  const change = (p: Partial<BrushDef>) => actions.updateBrushCommand(def.id, p, false);
  const ok = () => {
    if (name.trim() && name.trim() !== def.name) actions.updateBrushCommand(def.id, { name }, false);
    getState().commit('Brush Options');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  return (
    <DialogFrame
      title={`${def.kind === 'calligraphic' ? 'Calligraphic' : def.kind === 'scatter' ? 'Scatter' : def.kind === 'art' ? 'Art' : 'Pattern'} Brush Options`}
      onClose={cancel}
      width={560}
      footer={
        <>
          <span className="dim small">{users ? `${users} stroke${users === 1 ? '' : 's'} update live` : 'No strokes use this brush yet'}</span>
          <div style={{ flex: 1 }} />
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="brush-options-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={10}>
        <TextField label="Name" value={name} onChange={setName} onCommit={setName} id="brush-name" />
        <BrushPreview def={def} width={160} height={40} />
      </Row>
      <BrushForm def={def} onChange={change} />
    </DialogFrame>
  );
}

function NewBrushDialog({ close }: { close: () => void }) {
  const selection = useStore((s) => s.selection);
  const [kind, setKind] = useState<BrushDef['kind']>('calligraphic');
  const [name, setName] = useState('');
  const ok = () => {
    if (kind === 'calligraphic') actions.newCalligraphicBrush({ name: name.trim() || undefined });
    else {
      const def = actions.newArtworkBrush(kind, { name: name.trim() || undefined });
      if (!def) return;
    }
    close();
    const id = actions.activeBrushId();
    if (id) getState().openDialog('brush.options', { id });
  };
  const needsArt = kind !== 'calligraphic';
  return (
    <DialogFrame
      title="New Brush"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} disabled={needsArt && !selection.length} data-testid="brush-new-ok">
            OK
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} placeholder={kind === 'calligraphic' ? 'Calligraphic Brush' : kind === 'scatter' ? 'Scatter Brush' : kind === 'art' ? 'Art Brush' : 'Pattern Brush'} onChange={setName} onCommit={setName} id="brush-new-name" />
      <div className="section-title">Select new brush type</div>
      <Segmented<BrushDef['kind']>
        value={kind}
        onChange={setKind}
        options={[
          { value: 'calligraphic', label: 'Calligraphic' },
          { value: 'scatter', label: 'Scatter' },
          { value: 'art', label: 'Art' },
          { value: 'pattern', label: 'Pattern' },
        ]}
      />
      <div className="dim small">
        {kind === 'calligraphic' && 'An angled elliptical tip whose width follows the stroke direction.'}
        {kind === 'scatter' && 'Copies of the selected artwork scattered along the path.'}
        {kind === 'art' && 'The selected artwork stretched along the whole path.'}
        {kind === 'pattern' && 'The selected artwork repeated as a tile along the path.'}
        {needsArt && !selection.length && ' Select artwork first.'}
      </div>
    </DialogFrame>
  );
}

registerDialog('brush.options', BrushOptionsDialog as any);
registerDialog('brush.new', ({ close }) => <NewBrushDialog close={close} />);

/** Items of a brush on a sample spine (for tests / previews). */
function sampleItems(def: BrushDef, w = 200, h = 60) {
  return brushItems(def, [sampleSpine(w, h)], defaultStroke({ paint: { type: 'solid', color: '#000000', opacity: 1 }, width: 1, brush: { id: def.id } }), 'sample');
}

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  brushes: { ...ops, ...actions, ...geometry, library: BRUSH_LIBRARY, store: useBrushStore, sampleItems, pathToSvgD },
};

void when;
void React;
