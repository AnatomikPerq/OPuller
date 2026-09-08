/**
 * Swatches panel + its dialogs (new swatch, rename) and the Window/Object
 * commands that expose swatch actions.
 */
import React, { useMemo, useState } from 'react';
import { registerPanel } from '@/ui/panels/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, TextField, Select, Row, Checkbox, Segmented } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { getState, useStore } from '@/store/store';
import type { Paint, CMYK, SolidPaint } from '@/model/types';
import { registerCommands } from '@/commands/registry';
import { activePaint } from '@/commands/appearance';
import { SwatchesPanel } from './SwatchesPanel';
import { PaintPreview, CmykFields } from '../color/shared';
import { addSwatch, renameSwatch } from '@/color/actions';
import { defaultSwatchName, uniqueSwatchName } from '@/color/swatches';
import { toGradient } from '@/color/gradient';
import { activeSolid } from '@/color/paint';
import { hexToCmyk, cmykToHex, cmykName, plainPaint } from '@/color/globals';

registerPanel({ id: 'swatches', title: 'Swatches', component: SwatchesPanel, order: 31, defaultVisible: true });

type SwatchType = 'solid' | 'spot' | 'linear' | 'radial';

function NewSwatchDialog({ props, close }: { props: { paint?: Paint }; close: () => void }) {
  const s = getState();
  const colorMode = useStore((st) => st.doc.colorMode);
  const base: Paint = plainPaint(props.paint ?? (activePaint().type === 'none' ? { type: 'solid', color: '#000000', opacity: 1 } : activePaint()));
  const initialType: SwatchType = base.type === 'linear' || base.type === 'radial' ? base.type : 'solid';
  const [type, setType] = useState<SwatchType>(initialType);
  const [global, setGlobal] = useState(false);
  const [valueMode, setValueMode] = useState<'rgb' | 'cmyk'>(colorMode);
  const [solid, setSolid] = useState<SolidPaint>(activeSolid(base, s.activeGradientStop));
  const [cmyk, setCmyk] = useState<CMYK>(() => hexToCmyk(activeSolid(base, s.activeGradientStop).color));
  const paint: Paint = type === 'solid' || type === 'spot' ? solid : toGradient(base, type, s.activeGradientStop);
  const autoName = useMemo(() => uniqueSwatchName(s.doc.swatches, type === 'spot' ? `Spot ${cmykName(cmyk)}` : defaultSwatchName(paint, valueMode === 'cmyk' ? 'cmyk' : 'rgb')), [s.doc.swatches, type, cmyk, paint, valueMode]);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const shownName = nameTouched ? name : autoName;

  const setCmykValues = (v: CMYK) => {
    setCmyk(v);
    setSolid({ ...solid, color: cmykToHex(v) });
  };
  const ok = () => {
    const kind = type === 'spot' ? 'spot' : global ? 'global' : 'process';
    addSwatch(paint, shownName, { kind, cmyk: type === 'spot' || valueMode === 'cmyk' ? cmyk : undefined });
    close();
  };
  return (
    <DialogFrame
      title="New Swatch"
      onClose={close}
      width={400}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="swatch-new-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={10}>
        <span style={{ width: 40, height: 40, display: 'inline-block', border: '1px solid var(--border-strong)', borderRadius: 4, position: 'relative' }}>
          <PaintPreview paint={paint} />
        </span>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <TextField
            label="Name"
            value={shownName}
            onChange={(v) => {
              setName(v);
              setNameTouched(true);
            }}
            onCommit={(v) => {
              setName(v);
              setNameTouched(true);
            }}
            id="swatch-new-name"
          />
          <Select
            label="Type"
            value={type}
            options={[
              { value: 'solid', label: 'Process Color' },
              { value: 'spot', label: 'Spot Color' },
              { value: 'linear', label: 'Linear Gradient' },
              { value: 'radial', label: 'Radial Gradient' },
            ]}
            onChange={(v) => setType(v as SwatchType)}
            id="swatch-new-type"
          />
        </div>
      </Row>
      {(type === 'solid' || type === 'spot') && (
        <>
          <Row gap={10}>
            <Checkbox checked={type === 'spot' || global} disabled={type === 'spot'} onChange={setGlobal} label="Global" title="Objects painted with a global colour follow its edits; tints are available" />
            <Segmented value={valueMode} onChange={setValueMode} options={[{ value: 'rgb', label: 'RGB' }, { value: 'cmyk', label: 'CMYK' }]} />
          </Row>
          {valueMode === 'cmyk' ? (
            <CmykFields value={cmyk} onChange={setCmykValues} preview={solid.color} testIdPrefix="swatch-new-cmyk" />
          ) : (
            <ColorPicker
              paint={solid}
              allowNone={false}
              allowGradient={false}
              showSwatches={false}
              onChange={(p) => {
                if (p.type === 'solid') {
                  setSolid(p);
                  setCmyk(hexToCmyk(p.color));
                }
              }}
            />
          )}
        </>
      )}
      <div className="muted small">{type === 'spot' ? 'A spot colour is a named ink; objects keep a link to it and can use tints.' : 'The swatch is added to this document. Double-click a swatch later to edit it.'}</div>
    </DialogFrame>
  );
}

function RenameSwatchDialog({ props, close }: { props: { id: string; name: string }; close: () => void }) {
  const [name, setName] = useState(props.name);
  const ok = () => {
    renameSwatch(props.id, name);
    close();
  };
  return (
    <DialogFrame
      title="Rename Swatch"
      onClose={close}
      width={320}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="swatch-rename-ok">
            OK
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={setName} onCommit={(v) => { setName(v); }} id="swatch-rename-name" />
    </DialogFrame>
  );
}

registerDialog('swatch.new', NewSwatchDialog as any);
registerDialog('swatch.rename', RenameSwatchDialog as any);

registerCommands([
  { id: 'swatches.new', label: 'New Swatch…', hidden: true, run: () => getState().openDialog('swatch.new', {}) },
  { id: 'swatches.addCurrent', label: 'Add Current Color to Swatches', hidden: true, run: () => { const p = activePaint(); if (p.type !== 'none') addSwatch(p); } },
]);

void React;
