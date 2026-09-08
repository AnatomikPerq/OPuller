/**
 * New Document dialog: presets, size with units, orientation, artboard count,
 * background colour / transparency.
 */
import React, { useMemo, useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Segmented, Select, TextField, PopoverButton } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { getState } from '@/store/store';
import type { Units } from '@/model/types';
import { unitToPx, pxToUnit, UNIT_LABELS } from '@/util/units';
import { newDocument } from '@/io/fileOps';

interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
  units: Units;
  sub: string;
}

const PRESETS: Preset[] = [
  { id: 'web', label: 'Web', width: 1920, height: 1080, units: 'px', sub: '1920 × 1080 px' },
  { id: 'hd', label: 'HD', width: 1280, height: 720, units: 'px', sub: '1280 × 720 px' },
  { id: 'square', label: 'Social', width: 1080, height: 1080, units: 'px', sub: '1080 × 1080 px' },
  { id: 'mobile', label: 'Mobile', width: 390, height: 844, units: 'px', sub: '390 × 844 px' },
  { id: 'a4', label: 'A4', width: 210, height: 297, units: 'mm', sub: '210 × 297 mm' },
  { id: 'a3', label: 'A3', width: 297, height: 420, units: 'mm', sub: '297 × 420 mm' },
  { id: 'letter', label: 'Letter', width: 8.5, height: 11, units: 'in', sub: '8.5 × 11 in' },
  { id: 'card', label: 'Card', width: 3.5, height: 2, units: 'in', sub: '3.5 × 2 in' },
];

const UNIT_OPTIONS = (Object.keys(UNIT_LABELS) as Units[]).map((u) => ({ value: u, label: UNIT_LABELS[u] }));

let lastState: { presetId: string; width: number; height: number; units: Units; artboards: number; background: string; transparent: boolean } | null = null;

function NewDocumentDialog({ close }: { props: Record<string, unknown>; close: () => void }) {
  const prefsUnits = getState().prefs.units;
  const initial = lastState ?? { presetId: 'web', width: 1920, height: 1080, units: prefsUnits === 'px' ? 'px' : prefsUnits, artboards: 1, background: '#ffffff', transparent: false };
  const [name, setName] = useState('Untitled');
  const [presetId, setPresetId] = useState(initial.presetId);
  const [units, setUnits] = useState<Units>(initial.units);
  /** size in px */
  const [width, setWidth] = useState(initial.width);
  const [height, setHeight] = useState(initial.height);
  const [artboards, setArtboards] = useState(initial.artboards);
  const [background, setBackground] = useState(initial.background);
  const [transparent, setTransparent] = useState(initial.transparent);

  const orientation = width >= height ? 'landscape' : 'portrait';

  const applyPreset = (p: Preset) => {
    setPresetId(p.id);
    setUnits(p.units);
    setWidth(unitToPx(p.width, p.units));
    setHeight(unitToPx(p.height, p.units));
  };

  const setOrientation = (o: 'portrait' | 'landscape') => {
    if (o === orientation) return;
    setWidth(height);
    setHeight(width);
  };

  const create = () => {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    lastState = { presetId, width: w, height: h, units, artboards, background, transparent };
    newDocument({ name: name.trim() || 'Untitled', width: w, height: h, units, artboards: Math.max(1, Math.min(100, Math.round(artboards))), background, transparent });
    getState().setPrefs({ units });
    close();
    getState().setStatus(`New document ${Math.round(w)} × ${Math.round(h)} px`);
  };

  const sizeLabel = useMemo(() => `${(+pxToUnit(width, units).toFixed(2)).toString()} × ${(+pxToUnit(height, units).toFixed(2)).toString()} ${UNIT_LABELS[units]}`, [width, height, units]);

  return (
    <DialogFrame
      title="New Document"
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={create} data-testid="new-doc-create">
            Create
          </Button>
        </>
      }
    >
      <div className="io-presets" data-testid="new-doc-presets">
        {PRESETS.map((p) => {
          const land = p.width >= p.height;
          const ratio = land ? p.height / p.width : p.width / p.height;
          const w = land ? 30 : 30 * ratio;
          const h = land ? 30 * ratio : 30;
          return (
            <button key={p.id} type="button" className={`io-preset ${presetId === p.id ? 'active' : ''}`} onClick={() => applyPreset(p)} title={p.sub}>
              <span className="io-preset-shape">
                <span style={{ width: Math.max(8, w), height: Math.max(8, h) }} />
              </span>
              <span>{p.label}</span>
              <span className="io-preset-size">{p.sub}</span>
            </button>
          );
        })}
      </div>
      <div className="io-form-row">
        <span className="io-form-label">Name</span>
        <TextField value={name} onChange={setName} onCommit={setName} id="new-doc-name" />
      </div>
      <div className="io-form-row">
        <span className="io-form-label">Size</span>
        <Row gap={6}>
          <NumberField
            label="W"
            value={width}
            unit={units}
            min={1}
            max={100000}
            onChange={(v) => {
              setWidth(v);
              setPresetId('custom');
            }}
            width={120}
            data-testid="new-doc-width"
          />
          <NumberField
            label="H"
            value={height}
            unit={units}
            min={1}
            max={100000}
            onChange={(v) => {
              setHeight(v);
              setPresetId('custom');
            }}
            width={120}
            data-testid="new-doc-height"
          />
          <Select value={units} options={UNIT_OPTIONS} onChange={(u) => setUnits(u)} width={70} title="Units" />
        </Row>
      </div>
      <div className="io-form-row">
        <span className="io-form-label">Orientation</span>
        <Row gap={8}>
          <Segmented
            value={orientation}
            onChange={setOrientation}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
          <span className="io-hint">{sizeLabel}</span>
        </Row>
      </div>
      <div className="io-form-row">
        <span className="io-form-label">Artboards</span>
        <NumberField value={artboards} min={1} max={100} step={1} decimals={0} onChange={(v) => setArtboards(Math.round(v))} width={90} data-testid="new-doc-artboards" />
      </div>
      <div className="io-form-row">
        <span className="io-form-label">Background</span>
        <Row gap={10}>
          <PopoverButton
            button={({ toggle, ref }) => <button type="button" ref={ref} className="io-color-swatch" style={{ background: transparent ? 'repeating-conic-gradient(#999 0 25%, #ddd 0 50%) 0 0/8px 8px' : background }} onClick={toggle} title="Background colour" />}
          >
            <ColorPicker paint={{ type: 'solid', color: background, opacity: 1 }} onChange={(p) => p.type === 'solid' && setBackground(p.color)} allowNone={false} allowGradient={false} />
          </PopoverButton>
          <Checkbox checked={transparent} onChange={setTransparent} label="Transparent" />
        </Row>
      </div>
    </DialogFrame>
  );
}

registerDialog('newDocument', NewDocumentDialog);

void React;
