/**
 * Edit > Edit Colors: Recolor Artwork, Adjust Color Balance, Saturate,
 * Blend Front to Back / Horizontally / Vertically, Convert to Grayscale,
 * Invert Colors, Convert to RGB / CMYK. Also exposes the colour helpers on
 * window.__opuller.color for tests and scripting.
 */
import React, { useState } from 'react';
import { registerCommands, when } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Slider, Segmented, Row } from '@/ui/widgets';
import { getState, useStore } from '@/store/store';
import type { EditorState } from '@/store/store';
import { mapColors, invertColor, grayscaleColor, saturateColor, balanceColor, blendColors, collectColors, harmonyPalette, reduceColors, nearestColor, shiftHsb, colorLeaves, type ColorBalance } from './editColors';
import { setDocumentColorMode } from '@/print/register';
import * as globals from './globals';
import * as editColors from './editColors';
import { addSwatch, setSwatchKind, setActiveTint, applySwatch, setSwatchCmyk } from './actions';

const hasColorTargets = (s: EditorState) => colorLeaves(s.doc, s.selection).length > 0;

function applyMapped(fn: (hex: string) => string, label: string): void {
  const s = getState();
  let n = 0;
  s.updateDoc((d) => {
    n = mapColors(d, s.selection, (hex) => fn(hex));
  }, label);
  if (!n) getState().toast('No colours changed', 'info');
}

registerCommands([
  { id: 'edit.colors.recolor', label: 'Recolor Artwork…', menu: 'Edit/Edit Colors', order: 50, run: () => getState().openDialog('recolor', {}), enabled: hasColorTargets },
  { id: 'edit.colors.balance', label: 'Adjust Color Balance…', menu: 'Edit/Edit Colors', order: 51, separatorBefore: true, run: () => getState().openDialog('editColors.balance', {}), enabled: hasColorTargets },
  { id: 'edit.colors.saturate', label: 'Saturate…', menu: 'Edit/Edit Colors', order: 52, run: () => getState().openDialog('editColors.saturate', {}), enabled: hasColorTargets },
  {
    id: 'edit.colors.blendFrontBack',
    label: 'Blend Front to Back',
    menu: 'Edit/Edit Colors',
    order: 53,
    separatorBefore: true,
    run: () => {
      const s = getState();
      let n = 0;
      s.updateDoc((d) => {
        n = blendColors(d, s.selection, 'stack');
      }, 'Blend Front to Back');
      if (!n) getState().toast('Select at least three filled objects to blend colours', 'info');
    },
    enabled: hasColorTargets,
  },
  {
    id: 'edit.colors.blendHorizontal',
    label: 'Blend Horizontally',
    menu: 'Edit/Edit Colors',
    order: 54,
    run: () => {
      const s = getState();
      let n = 0;
      s.updateDoc((d) => {
        n = blendColors(d, s.selection, 'x');
      }, 'Blend Horizontally');
      if (!n) getState().toast('Select at least three filled objects to blend colours', 'info');
    },
    enabled: hasColorTargets,
  },
  {
    id: 'edit.colors.blendVertical',
    label: 'Blend Vertically',
    menu: 'Edit/Edit Colors',
    order: 55,
    run: () => {
      const s = getState();
      let n = 0;
      s.updateDoc((d) => {
        n = blendColors(d, s.selection, 'y');
      }, 'Blend Vertically');
      if (!n) getState().toast('Select at least three filled objects to blend colours', 'info');
    },
    enabled: hasColorTargets,
  },
  { id: 'edit.colors.grayscale', label: 'Convert to Grayscale', menu: 'Edit/Edit Colors', order: 56, separatorBefore: true, run: () => applyMapped(grayscaleColor, 'Convert to Grayscale'), enabled: hasColorTargets },
  { id: 'edit.colors.invert', label: 'Invert Colors', menu: 'Edit/Edit Colors', order: 57, run: () => applyMapped(invertColor, 'Invert Colors'), enabled: hasColorTargets },
  { id: 'edit.colors.toCmyk', label: 'Convert to CMYK', menu: 'Edit/Edit Colors', order: 58, separatorBefore: true, run: () => setDocumentColorMode('cmyk'), enabled: (s) => s.doc.colorMode !== 'cmyk' },
  { id: 'edit.colors.toRgb', label: 'Convert to RGB', menu: 'Edit/Edit Colors', order: 59, run: () => setDocumentColorMode('rgb'), enabled: (s) => s.doc.colorMode !== 'rgb' },
]);

// ---------------------------------------------------------------------------
// Saturate dialog
// ---------------------------------------------------------------------------

function SaturateDialog({ close }: { close: () => void }) {
  const [amount, setAmount] = useState(0);
  const selection = getState().selection;
  const preview = (v: number) => {
    const s = getState();
    s.revert();
    s.updateDoc((d) => {
      mapColors(d, selection, (hex) => saturateColor(hex, v / 100));
    });
  };
  const ok = () => {
    preview(amount);
    getState().commit('Saturate');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  return (
    <DialogFrame
      title="Saturate"
      onClose={cancel}
      width={360}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="saturate-ok">
            OK
          </Button>
        </>
      }
    >
      <Slider
        label="Intensity"
        value={amount}
        min={-100}
        max={100}
        unit="%"
        onChange={(v) => {
          setAmount(v);
          preview(v);
        }}
      />
      <div className="dim small">Negative values desaturate, positive values saturate the fills, strokes and gradient stops of the selection.</div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Adjust Color Balance dialog
// ---------------------------------------------------------------------------

function BalanceDialog({ close }: { close: () => void }) {
  const docMode = useStore((s) => s.doc.colorMode);
  const [b, setB] = useState<ColorBalance>({ r: 0, g: 0, b: 0, c: 0, m: 0, y: 0, k: 0, mode: docMode });
  const selection = getState().selection;
  const preview = (v: ColorBalance) => {
    const s = getState();
    s.revert();
    s.updateDoc((d) => {
      mapColors(d, selection, (hex) => balanceColor(hex, v));
    });
  };
  const update = (patch: Partial<ColorBalance>) => {
    const next = { ...b, ...patch };
    setB(next);
    preview(next);
  };
  const ok = () => {
    preview(b);
    getState().commit('Adjust Color Balance');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  const chans: Array<[keyof ColorBalance, string]> = b.mode === 'rgb' ? [['r', 'Red'], ['g', 'Green'], ['b', 'Blue']] : [['c', 'Cyan'], ['m', 'Magenta'], ['y', 'Yellow'], ['k', 'Black']];
  return (
    <DialogFrame
      title="Adjust Color Balance"
      onClose={cancel}
      width={380}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="balance-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <span className="field-label">Color mode</span>
        <Segmented value={b.mode} onChange={(m) => update({ mode: m })} options={[{ value: 'rgb', label: 'RGB' }, { value: 'cmyk', label: 'CMYK' }]} />
      </Row>
      {chans.map(([k, label]) => (
        <Slider key={k} label={label} value={Number(b[k])} min={-100} max={100} unit="%" onChange={(v) => update({ [k]: v } as Partial<ColorBalance>)} />
      ))}
      <div className="dim small">Shifts every colour of the selection by the given amounts.</div>
    </DialogFrame>
  );
}

registerDialog('editColors.saturate', ({ close }) => <SaturateDialog close={close} />);
registerDialog('editColors.balance', ({ close }) => <BalanceDialog close={close} />);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  color: { ...globals, ...editColors, addSwatch, setSwatchKind, setActiveTint, applySwatch, setSwatchCmyk, collectColors, harmonyPalette, reduceColors, nearestColor, shiftHsb },
};

void when;
void React;
