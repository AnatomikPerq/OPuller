/**
 * Swatches panel + its dialogs (new swatch, rename) and the Window/Object
 * commands that expose swatch actions.
 */
import React, { useState } from 'react';
import { registerPanel } from '@/ui/panels/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, TextField, Select, Row } from '@/ui/widgets';
import { getState } from '@/store/store';
import type { Paint } from '@/model/types';
import { registerCommands } from '@/commands/registry';
import { activePaint } from '@/commands/appearance';
import { SwatchesPanel } from './SwatchesPanel';
import { PaintPreview } from '../color/shared';
import { addSwatch, renameSwatch } from '@/color/actions';
import { defaultSwatchName, uniqueSwatchName } from '@/color/swatches';
import { toGradient } from '@/color/gradient';
import { activeSolid } from '@/color/paint';

registerPanel({ id: 'swatches', title: 'Swatches', component: SwatchesPanel, order: 31, defaultVisible: true });

function NewSwatchDialog({ props, close }: { props: { paint?: Paint }; close: () => void }) {
  const s = getState();
  const base: Paint = props.paint ?? (activePaint().type === 'none' ? { type: 'solid', color: '#000000', opacity: 1 } : activePaint());
  const initialType = base.type === 'linear' || base.type === 'radial' ? base.type : 'solid';
  const [type, setType] = useState<'solid' | 'linear' | 'radial'>(initialType);
  const paint: Paint = type === 'solid' ? activeSolid(base, s.activeGradientStop) : toGradient(base, type, s.activeGradientStop);
  const [name, setName] = useState(uniqueSwatchName(s.doc.swatches, defaultSwatchName(paint)));
  const ok = () => {
    addSwatch(paint, name);
    close();
  };
  return (
    <DialogFrame
      title="New Swatch"
      onClose={close}
      width={360}
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
          <TextField label="Name" value={name} onChange={setName} onCommit={setName} id="swatch-new-name" />
          <Select
            label="Type"
            value={type}
            options={[
              { value: 'solid', label: 'Process Color' },
              { value: 'linear', label: 'Linear Gradient' },
              { value: 'radial', label: 'Radial Gradient' },
            ]}
            onChange={(v) => setType(v as 'solid' | 'linear' | 'radial')}
            id="swatch-new-type"
          />
        </div>
      </Row>
      <div className="muted small">The swatch is added to this document. Double-click a swatch later to edit it.</div>
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
