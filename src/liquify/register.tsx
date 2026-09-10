/**
 * Liquify module wiring: the options bar shared by the seven brushes, the
 * Tool Options dialog, and the `window.__opuller.liquify` namespace used by
 * tests and the scripting API.
 */
import React, { useState } from 'react';
import { getState, useStore } from '@/store/store';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Section } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';
import { LIQUIFY_KINDS, TOOL_DEFAULTS, GLOBAL_KEYS, type LiquifyKind, type LiquifyOptions, type GlobalBrushOptions } from './brush';
import * as brush from './brush';
import { applyLiquify, LiquifySession, isLiquifiable, currentOptions, LIQUIFY_LABELS } from './engine';
import './liquify.css';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** The brush dimensions are shared by all liquify tools (Illustrator's "Global Brush Dimensions"). */
export function setGlobalBrush(patch: Partial<GlobalBrushOptions>): void {
  const s = getState();
  for (const k of LIQUIFY_KINDS) s.setToolOptions(k, patch as Record<string, unknown>);
}

export function hasSimplify(kind: LiquifyKind): boolean {
  return kind === 'warp' || kind === 'twirl' || kind === 'pucker' || kind === 'bloat';
}

export function hasComplexity(kind: LiquifyKind): boolean {
  return kind === 'scallop' || kind === 'crystallize' || kind === 'wrinkle';
}

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------

export function LiquifyOptionsBar({ kind }: { kind: LiquifyKind }) {
  const [o, set] = useToolOptions<LiquifyOptions & Record<string, unknown>>(kind);
  const units = useStore((s) => s.prefs.units);
  return (
    <Row gap={8} className="liquify-options">
      <NumberField label="Width" value={o.width} onChange={(v) => setGlobalBrush({ width: clamp(v, 1, 4000) })} min={1} max={4000} unit={units} width={104} data-testid="liquify-width" title="Brush width (Alt-drag on the canvas resizes the brush)" />
      <NumberField label="Height" value={o.height} onChange={(v) => setGlobalBrush({ height: clamp(v, 1, 4000) })} min={1} max={4000} unit={units} width={104} data-testid="liquify-height" title="Brush height" />
      <NumberField label="Angle" value={o.angle} onChange={(v) => setGlobalBrush({ angle: ((v % 360) + 360) % 360 })} unit="deg" width={86} data-testid="liquify-angle" title="Brush angle" />
      <NumberField label="Intensity" value={o.intensity} onChange={(v) => setGlobalBrush({ intensity: clamp(Math.round(v), 1, 100) })} min={1} max={100} unit="%" width={96} data-testid="liquify-intensity" title="How fast the brush distorts" />
      {kind === 'twirl' && <NumberField label="Rate" value={o.rate} onChange={(v) => set({ rate: clamp(v, -180, 180) })} min={-180} max={180} unit="deg" width={90} data-testid="liquify-rate" title="Twirl rate (negative = clockwise)" />}
      {kind === 'wrinkle' && <NumberField label="H" value={o.horizontal} onChange={(v) => set({ horizontal: clamp(Math.round(v), 0, 100) })} min={0} max={100} unit="%" width={74} data-testid="liquify-horizontal" title="Horizontal wrinkles" />}
      {kind === 'wrinkle' && <NumberField label="V" value={o.vertical} onChange={(v) => set({ vertical: clamp(Math.round(v), 0, 100) })} min={0} max={100} unit="%" width={74} data-testid="liquify-vertical" title="Vertical wrinkles" />}
      {hasComplexity(kind) && <NumberField label="Complexity" value={o.complexity} onChange={(v) => set({ complexity: clamp(Math.round(v), 1, 15) })} min={1} max={15} width={100} data-testid="liquify-complexity" title="How many details the brush adds" />}
      <NumberField label="Detail" value={o.detail} onChange={(v) => set({ detail: clamp(Math.round(v), 1, 50) })} min={1} max={50} width={80} data-testid="liquify-detail" title="Density of anchor points added under the brush" />
      {hasSimplify(kind) && <NumberField label="Simplify" value={o.simplify} onChange={(v) => set({ simplify: clamp(Math.round(v), 0, 100) })} min={0} max={100} width={90} data-testid="liquify-simplify" title="Reduce the anchors of the deformed portion after each stroke" />}
      <Button small onClick={() => getState().openDialog('liquifyOptions', { kind })} data-testid="liquify-options" title="All options of this tool">
        Options…
      </Button>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Tool Options dialog
// ---------------------------------------------------------------------------

function LiquifyOptionsDialog({ props, close }: { props: { kind: LiquifyKind }; close: () => void }) {
  const kind = props.kind in TOOL_DEFAULTS ? props.kind : 'warp';
  const [o, setO] = useState<LiquifyOptions>(() => currentOptions(kind));
  const units = getState().prefs.units;
  const set = (patch: Partial<LiquifyOptions>) => setO((cur) => ({ ...cur, ...patch }));
  const ok = () => {
    const global: Partial<GlobalBrushOptions> = {};
    for (const k of GLOBAL_KEYS) (global as Record<string, unknown>)[k] = o[k];
    setGlobalBrush(global);
    const own: Record<string, unknown> = {};
    for (const k of Object.keys(o) as Array<keyof LiquifyOptions>) if (!(GLOBAL_KEYS as string[]).includes(k)) own[k] = o[k];
    getState().setToolOptions(kind, own);
    close();
  };
  const reset = () => setO({ ...TOOL_DEFAULTS[kind] });
  return (
    <DialogFrame
      title={`${LIQUIFY_LABELS[kind]} Options`}
      onClose={close}
      width={460}
      className="liquify-dialog"
      footer={
        <>
          <Button onClick={reset}>Reset</Button>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="liquify-dialog-ok">
            OK
          </Button>
        </>
      }
    >
      <Section title="Global Brush Dimensions">
        <div className="liquify-grid">
          <NumberField label="Width" value={o.width} onChange={(v) => set({ width: clamp(v, 1, 4000) })} min={1} max={4000} unit={units} width={190} data-testid="liquify-dialog-width" />
          <NumberField label="Height" value={o.height} onChange={(v) => set({ height: clamp(v, 1, 4000) })} min={1} max={4000} unit={units} width={190} />
          <NumberField label="Angle" value={o.angle} onChange={(v) => set({ angle: ((v % 360) + 360) % 360 })} unit="deg" width={190} />
          <NumberField label="Intensity" value={o.intensity} onChange={(v) => set({ intensity: clamp(Math.round(v), 1, 100) })} min={1} max={100} unit="%" width={190} />
        </div>
        <Checkbox checked={o.usePressure} onChange={(v) => set({ usePressure: v })} label="Use pressure pen" title="Scale the intensity by the pen pressure" />
        <div className="dim small">The brush dimensions are shared by all liquify tools. Alt-drag on the canvas resizes the brush (Shift keeps it proportional); [ and ] change the size.</div>
      </Section>
      <Section title={`${LIQUIFY_LABELS[kind].replace(' Tool', '')} Options`}>
        <div className="liquify-grid">
          {kind === 'twirl' && <NumberField label="Twirl rate" value={o.rate} onChange={(v) => set({ rate: clamp(v, -180, 180) })} min={-180} max={180} unit="deg" width={190} title="Negative values twirl clockwise" />}
          {kind === 'wrinkle' && <NumberField label="Horizontal" value={o.horizontal} onChange={(v) => set({ horizontal: clamp(Math.round(v), 0, 100) })} min={0} max={100} unit="%" width={190} />}
          {kind === 'wrinkle' && <NumberField label="Vertical" value={o.vertical} onChange={(v) => set({ vertical: clamp(Math.round(v), 0, 100) })} min={0} max={100} unit="%" width={190} />}
          {hasComplexity(kind) && <NumberField label="Complexity" value={o.complexity} onChange={(v) => set({ complexity: clamp(Math.round(v), 1, 15) })} min={1} max={15} width={190} />}
          <NumberField label="Detail" value={o.detail} onChange={(v) => set({ detail: clamp(Math.round(v), 1, 50) })} min={1} max={50} width={190} title="Spacing of the anchor points added under the brush (higher = closer)" />
          {hasSimplify(kind) && <NumberField label="Simplify" value={o.simplify} onChange={(v) => set({ simplify: clamp(Math.round(v), 0, 100) })} min={0} max={100} width={190} title="How strongly the deformed portion is simplified after each stroke (0 = keep every anchor)" />}
        </div>
        {hasComplexity(kind) && (
          <div className="liquify-checks">
            <Checkbox checked={o.affectAnchors} onChange={(v) => set({ affectAnchors: v })} label="Brush affects anchor points" />
            <Checkbox checked={o.affectIn} onChange={(v) => set({ affectIn: v })} label="Brush affects in tangent handles" />
            <Checkbox checked={o.affectOut} onChange={(v) => set({ affectOut: v })} label="Brush affects out tangent handles" />
          </div>
        )}
      </Section>
    </DialogFrame>
  );
}

registerDialog<{ kind: LiquifyKind }>('liquifyOptions', LiquifyOptionsDialog);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  liquify: { ...brush, applyLiquify, LiquifySession, isLiquifiable: (id: string) => isLiquifiable(getState().doc, id), currentOptions, setGlobalBrush, LIQUIFY_LABELS },
};

export { applyLiquify };
void React;
