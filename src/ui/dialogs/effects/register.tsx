/**
 * Generic effect dialog: sliders + number fields + colour swatch for every
 * parameter of an effect, live preview on the selection, Cancel reverts.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { getState } from '@/store/store';
import { Button, Checkbox, NumberField, PopoverButton } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import type { Effect, ID } from '@/model/types';
import { effectDef, applyEffect, initialEffect, rememberEffect, cloneEffect, type EffectType, type EffectParam, type ApplyMode } from '@/commands/effectCommands/effects';
import './effects.css';

interface EffectDialogProps {
  type: EffectType;
  /** edit the effect at this index of the first selected node */
  index?: number;
}

function paramValue(e: Effect, key: string): number {
  return Number((e as unknown as Record<string, unknown>)[key] ?? 0);
}

function withParam(e: Effect, key: string, value: number | string): Effect {
  return { ...e, [key]: value } as Effect;
}

function ParamRow({ p, effect, units, onChange, onCommit }: { p: EffectParam; effect: Effect; units: 'px' | 'pt' | 'mm' | 'cm' | 'in'; onChange: (v: number) => void; onCommit: () => void }) {
  const v = paramValue(effect, p.key);
  const isPct = p.kind === 'percent' || p.kind === 'factor';
  const shown = isPct ? v * 100 : v;
  const min = isPct ? p.min * 100 : p.min;
  const max = isPct ? p.max * 100 : p.max;
  const step = isPct ? (p.step ?? 0.01) * 100 : (p.step ?? 1);
  const tick = p.neutral !== undefined ? ((isPct ? p.neutral * 100 : p.neutral) - min) / (max - min) : null;
  const set = (val: number) => onChange(isPct ? val / 100 : val);
  return (
    <>
      <span className="ed-label">{p.label}</span>
      <div className="ed-slider">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(shown) ? shown : min}
          onChange={(e) => set(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          onKeyDown={(e) => e.stopPropagation()}
          data-testid={`effect-slider-${p.key}`}
        />
        {tick !== null && <span className="ed-tick" style={{ left: `calc(${(tick * 100).toFixed(2)}% + ${(8 - tick * 16).toFixed(1)}px)` }} />}
      </div>
      <NumberField
        value={shown}
        onChange={set}
        onCommit={onCommit}
        min={min}
        max={max}
        step={step}
        decimals={p.kind === 'angle' ? 0 : isPct ? 0 : 1}
        unit={p.kind === 'length' ? units : p.kind === 'angle' ? 'deg' : isPct ? '%' : 'none'}
        scrub={false}
        data-testid={`effect-${p.key}`}
      />
    </>
  );
}

function ColorRow({ p, effect, onChange, onCommit }: { p: EffectParam; effect: Effect; onChange: (hex: string) => void; onCommit: () => void }) {
  const hex = String((effect as unknown as Record<string, unknown>)[p.key] ?? '#000000');
  return (
    <>
      <span className="ed-label">{p.label}</span>
      <div className="ed-color" style={{ gridColumn: '2 / span 2' }}>
        <PopoverButton
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="swatch-btn" onClick={toggle} title="Effect colour" data-testid={`effect-${p.key}`}>
              <div className="paint-preview" style={{ background: hex }} />
            </button>
          )}
          placement="bottom"
        >
          <ColorPicker
            paint={{ type: 'solid', color: hex, opacity: 1 }}
            onChange={(paint) => {
              if (paint.type === 'solid') onChange(paint.color);
            }}
            onCommit={onCommit}
            allowNone={false}
            allowGradient={false}
          />
        </PopoverButton>
        <span className="ed-hex">{hex}</span>
      </div>
    </>
  );
}

function EffectDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const def = effectDef(props.type);
  const units = getState().prefs.units;
  // targets and initial values are captured once when the dialog opens
  const setup = useMemo(() => {
    const s = getState();
    // make sure Cancel can revert to a clean base
    if (s.doc !== s.historyBase) s.commit('Edit');
    const ids: ID[] = s.selection.filter((id) => !!s.doc.nodes[id]);
    const first = ids[0] ? s.doc.nodes[ids[0]] : undefined;
    let existing: Effect | undefined;
    let mode: ApplyMode = { kind: 'replaceType' };
    if (props.index !== undefined && first && first.effects[props.index]?.type === props.type) {
      existing = first.effects[props.index];
      mode = { kind: 'index', index: props.index };
    } else if (first) existing = first.effects.find((e) => e.type === props.type);
    const initial = existing ? { ...cloneEffect(existing), enabled: true } : initialEffect(props.type);
    return { ids, initial, mode, editing: !!existing };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [effect, setEffect] = useState<Effect>(setup.initial);
  const [preview, setPreview] = useState(true);
  const effectRef = useRef(effect);
  effectRef.current = effect;
  const done = useRef(false);

  const applyPreview = (e: Effect) => {
    if (!setup.ids.length) return;
    applyEffect(e, setup.ids, setup.mode);
  };

  // initial preview
  useEffect(() => {
    if (preview) applyPreview(effectRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (e: Effect) => {
    setEffect(e);
    if (preview) applyPreview(e);
  };

  const togglePreview = (on: boolean) => {
    setPreview(on);
    if (on) applyPreview(effectRef.current);
    else getState().revert();
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    getState().revert();
    close();
  };

  const ok = () => {
    if (done.current) return;
    done.current = true;
    const s = getState();
    if (!setup.ids.length) {
      close();
      return;
    }
    s.revert();
    applyEffect(effectRef.current, setup.ids, setup.mode, setup.editing ? `Edit ${def.label}` : def.label);
    rememberEffect(effectRef.current);
    close();
  };

  const reset = () => update({ ...def.defaults(), enabled: true });
  const Icon = def.icon;
  const noop = () => {};

  return (
    <DialogFrame
      title={def.label}
      onClose={cancel}
      width={440}
      className="effect-dialog"
      footer={
        <>
          <div className="ed-footer-left">
            <Checkbox checked={preview} onChange={togglePreview} label="Preview" />
            <Button small onClick={reset} title="Reset to defaults">
              Reset
            </Button>
          </div>
          <Button onClick={cancel} data-testid="effect-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} data-testid="effect-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="ed-intro">
        <span className="ed-icon">
          <Icon size={16} />
        </span>
        <span>
          {def.description}
          <br />
          {setup.ids.length === 1 ? `Applies to 1 object.` : `Applies to ${setup.ids.length} objects.`}
          {setup.editing ? ' Editing the existing effect.' : ''}
        </span>
      </div>
      <form
        className="ed-grid"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        {def.params.map((p) =>
          p.kind === 'color' ? (
            <ColorRow key={p.key} p={p} effect={effect} onChange={(hex) => update(withParam(effect, p.key, hex))} onCommit={noop} />
          ) : (
            <ParamRow key={p.key} p={p} effect={effect} units={units} onChange={(v) => update(withParam(effectRef.current, p.key, v))} onCommit={noop} />
          ),
        )}
        <button type="submit" hidden />
      </form>
      {!setup.ids.length && <div className="ed-note">Nothing is selected.</div>}
    </DialogFrame>
  );
}

registerDialog<EffectDialogProps>('effect', EffectDialog);

void React;
