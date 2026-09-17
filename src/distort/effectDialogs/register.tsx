/**
 * Dialogs of the Distort & Transform effects: Zig Zag, Pucker & Bloat, Roughen, Transform, Tweak.
 * Each edits the effect live through the shared effect session (preview on the selection,
 * OK commits one history step, Cancel reverts).
 */
import React from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Segmented, Slider } from '@/ui/widgets';
import { useStore } from '@/store/store';
import type { ZigZagEffect, RoughenEffect, TransformEffect, TweakEffect, PuckerBloatEffect } from '@/model/types';
import { useEffectSession, type EffectDialogProps } from '../register';
import { TRANSFORM_ORIGINS, type TransformOrigin } from '../transformEffects';
import './effectDialogs.css';

function Frame({ title, ok, cancel, close, testId, children, width = 420 }: { title: string; ok: (close: () => void) => void; cancel: (close: () => void) => void; close: () => void; testId: string; children: React.ReactNode; width?: number }) {
  return (
    <DialogFrame
      title={title}
      onClose={() => cancel(close)}
      width={width}
      className="dt-dialog"
      footer={
        <>
          <Button onClick={() => cancel(close)} data-testid={`${testId}-cancel`}>
            Cancel
          </Button>
          <Button primary onClick={() => ok(close)} data-testid={`${testId}-ok`}>
            OK
          </Button>
        </>
      }
    >
      {children}
      <div className="dim small">Live effect: the geometry stays editable. Object &gt; Expand Appearance bakes it.</div>
    </DialogFrame>
  );
}

const pointsOptions = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'corner', label: 'Corner' },
];
const sizeModes = [
  { value: 'relative', label: 'Relative' },
  { value: 'absolute', label: 'Absolute' },
];

function ZigZagDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'zigZag' });
  const units = useStore((s) => s.prefs.units);
  const e = effect as ZigZagEffect;
  const set = (p: Partial<ZigZagEffect>) => update({ ...e, ...p });
  return (
    <Frame title="Zig Zag" ok={ok} cancel={cancel} close={close} testId="zigzag">
      <Row gap={8} align="flex-end">
        <NumberField label="Size" value={e.size} onChange={(v) => set({ size: Math.max(0, v) })} min={0} step={0.5} unit={e.relative ? '%' : units} width={150} data-testid="zigzag-size" />
        <Segmented value={e.relative ? 'relative' : 'absolute'} onChange={(v) => set({ relative: v === 'relative' })} options={sizeModes} title="Relative: percent of each segment's length" />
      </Row>
      <Row gap={8} align="flex-end">
        <NumberField label="Ridges per segment" value={e.ridges} onChange={(v) => set({ ridges: Math.max(0, Math.round(v)) })} min={0} max={100} step={1} width={150} data-testid="zigzag-ridges" />
        <Segmented value={e.smooth ? 'smooth' : 'corner'} onChange={(v) => set({ smooth: v === 'smooth' })} options={pointsOptions} title="Smooth points make a wave, corner points a saw tooth" />
      </Row>
    </Frame>
  );
}

function PuckerBloatDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'puckerBloat' });
  const e = effect as PuckerBloatEffect;
  return (
    <Frame title="Pucker & Bloat" ok={ok} cancel={cancel} close={close} testId="puckerbloat">
      <Row gap={8} align="center">
        <span className="dim small">Pucker</span>
        <Slider value={Math.round(e.amount)} min={-200} max={200} step={1} unit="%" onChange={(v) => update({ ...e, amount: v })} className="dt-pb-slider" />
        <span className="dim small">Bloat</span>
      </Row>
      <NumberField label="Amount" value={e.amount} onChange={(v) => update({ ...e, amount: Math.max(-200, Math.min(200, v)) })} min={-200} max={200} step={1} unit="%" width={150} data-testid="puckerbloat-amount" />
    </Frame>
  );
}

function RoughenDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'roughen' });
  const units = useStore((s) => s.prefs.units);
  const e = effect as RoughenEffect;
  const set = (p: Partial<RoughenEffect>) => update({ ...e, ...p });
  return (
    <Frame title="Roughen" ok={ok} cancel={cancel} close={close} testId="roughen">
      <Row gap={8} align="flex-end">
        <NumberField label="Size" value={e.size} onChange={(v) => set({ size: Math.max(0, v) })} min={0} step={0.5} unit={e.relative ? '%' : units} width={150} data-testid="roughen-size" />
        <Segmented value={e.relative ? 'relative' : 'absolute'} onChange={(v) => set({ relative: v === 'relative' })} options={sizeModes} title="Relative: percent of the object's longer side" />
      </Row>
      <Row gap={8} align="flex-end">
        <NumberField label="Detail" value={e.detail} onChange={(v) => set({ detail: Math.max(0.1, v) })} min={0.1} max={100} step={1} suffix="/in" width={150} data-testid="roughen-detail" title="Points per inch" />
        <Segmented value={e.smooth ? 'smooth' : 'corner'} onChange={(v) => set({ smooth: v === 'smooth' })} options={pointsOptions} />
      </Row>
      <Row gap={8} align="flex-end">
        <NumberField label="Seed" value={e.seed} onChange={(v) => set({ seed: Math.round(v) })} step={1} width={150} data-testid="roughen-seed" />
        <Button onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })} title="Pick a new random seed">
          Randomize
        </Button>
      </Row>
    </Frame>
  );
}

function OriginGrid({ value, onChange }: { value: TransformOrigin; onChange: (o: TransformOrigin) => void }) {
  return (
    <div className="dt-origin" title="Reference point of the transform" data-testid="transform-origin">
      {TRANSFORM_ORIGINS.map((o) => (
        <button key={o} type="button" className={`dt-origin-cell ${o === value ? 'on' : ''}`} onClick={() => onChange(o)} aria-label={o} data-origin={o} />
      ))}
    </div>
  );
}

function TransformDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'transform' });
  const units = useStore((s) => s.prefs.units);
  const e = effect as TransformEffect;
  const set = (p: Partial<TransformEffect>) => update({ ...e, ...p });
  return (
    <Frame title="Transform Effect" ok={ok} cancel={cancel} close={close} testId="transform-fx" width={460}>
      <div className="section-title">Scale</div>
      <Row gap={8}>
        <NumberField label="Horizontal" value={e.scaleX} onChange={(v) => set({ scaleX: v })} unit="%" step={1} width={170} data-testid="transform-fx-sx" />
        <NumberField label="Vertical" value={e.scaleY} onChange={(v) => set({ scaleY: v })} unit="%" step={1} width={170} data-testid="transform-fx-sy" />
      </Row>
      <div className="section-title">Move</div>
      <Row gap={8}>
        <NumberField label="Horizontal" value={e.dx} onChange={(v) => set({ dx: v })} unit={units} step={1} width={170} data-testid="transform-fx-dx" />
        <NumberField label="Vertical" value={e.dy} onChange={(v) => set({ dy: v })} unit={units} step={1} width={170} data-testid="transform-fx-dy" />
      </Row>
      <div className="section-title">Rotate</div>
      <Row gap={8} align="flex-end">
        <NumberField label="Angle" value={e.angle} onChange={(v) => set({ angle: v })} unit="deg" step={1} width={170} data-testid="transform-fx-angle" title="Counter-clockwise positive" />
        <Checkbox checked={e.reflectX} onChange={(v) => set({ reflectX: v })} label="Reflect X" />
        <Checkbox checked={e.reflectY} onChange={(v) => set({ reflectY: v })} label="Reflect Y" />
      </Row>
      <Row gap={12} align="flex-end">
        <NumberField label="Copies" value={e.copies} onChange={(v) => set({ copies: Math.max(0, Math.min(500, Math.round(v))) })} min={0} max={500} step={1} width={170} data-testid="transform-fx-copies" />
        <OriginGrid value={(e.origin ?? 'center') as TransformOrigin} onChange={(origin) => set({ origin })} />
      </Row>
    </Frame>
  );
}

function TweakDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'tweak' });
  const units = useStore((s) => s.prefs.units);
  const e = effect as TweakEffect;
  const set = (p: Partial<TweakEffect>) => update({ ...e, ...p });
  return (
    <Frame title="Tweak" ok={ok} cancel={cancel} close={close} testId="tweak">
      <Row gap={8} align="flex-end">
        <NumberField label="Horizontal" value={e.horizontal} onChange={(v) => set({ horizontal: Math.max(0, v) })} min={0} step={1} unit={e.relative ? '%' : units} width={140} data-testid="tweak-h" />
        <NumberField label="Vertical" value={e.vertical} onChange={(v) => set({ vertical: Math.max(0, v) })} min={0} step={1} unit={e.relative ? '%' : units} width={140} data-testid="tweak-v" />
        <Segmented value={e.relative ? 'relative' : 'absolute'} onChange={(v) => set({ relative: v === 'relative' })} options={sizeModes} title="Relative: percent of the object's width / height" />
      </Row>
      <div className="section-title">Modify</div>
      <Row gap={12}>
        <Checkbox checked={e.anchors} onChange={(v) => set({ anchors: v })} label="Anchor points" />
        <Checkbox checked={e.inControl} onChange={(v) => set({ inControl: v })} label={'"In" control points'} />
        <Checkbox checked={e.outControl} onChange={(v) => set({ outControl: v })} label={'"Out" control points'} />
      </Row>
      <Row gap={8} align="flex-end">
        <NumberField label="Seed" value={e.seed} onChange={(v) => set({ seed: Math.round(v) })} step={1} width={150} data-testid="tweak-seed" />
        <Button onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}>Randomize</Button>
      </Row>
    </Frame>
  );
}

registerDialog('effect.zigZag', ZigZagDialog as any);
registerDialog('effect.puckerBloat', PuckerBloatDialog as any);
registerDialog('effect.roughen', RoughenDialog as any);
registerDialog('effect.transform', TransformDialog as any);
registerDialog('effect.tweak', TweakDialog as any);
