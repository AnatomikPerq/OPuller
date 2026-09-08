/**
 * Transform dialogs: Move, Rotate, Reflect, Scale, Shear, Transform Each and
 * the tabbed generic Transform dialog. Preview applies the transform live
 * (uncommitted); Cancel reverts; OK / Copy commit one history step.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Document, ID, Matrix, Rect, Vec } from '@/model/types';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Tabs } from '@/ui/widgets';
import { getState, useStore } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { formatLength } from '@/util/units';
import { RefPointGrid } from '@/transform/RefPointGrid';
import { refPointOf, type RefPoint } from '@/transform/refPoint';
import { rotationAbout, reflectAbout, scaleAbout, shearAbout, translation, normalizeAngle } from '@/transform/matrices';
import { applyTransform, transformDocument, transformTargets, type MatrixSource } from '@/transform/apply';
import { recordMatrixTransform } from '@/transform/again';
import { DEFAULT_EACH, applyTransformEach, eachMatrixSource } from '@/transform/each';
import { useTransformStore, type EachParams, type TransformRecord } from '@/transform/store';
import '@/transform/transform.css';

export type TransformTab = 'move' | 'rotate' | 'reflect' | 'scale' | 'shear' | 'each';

export interface TransformDialogProps {
  tab?: TransformTab;
  /** show the tab bar (generic dialog) */
  tabs?: boolean;
  /** absolute reference point (from a tool's Alt-click) */
  pivot?: Vec;
}

const TITLES: Record<TransformTab, string> = { move: 'Move', rotate: 'Rotate', reflect: 'Reflect', scale: 'Scale', shear: 'Shear', each: 'Transform Each' };

interface MoveParams {
  dx: number;
  dy: number;
  distance: number;
  angle: number;
}
interface RotateParams {
  angle: number;
}
interface ReflectParams {
  axis: 'h' | 'v' | 'angle';
  angle: number;
}
interface ScaleParams {
  uniform: boolean;
  s: number;
  sx: number;
  sy: number;
}
interface ShearParams {
  angle: number;
  axis: 'h' | 'v' | 'angle';
  axisAngle: number;
}

interface AllParams {
  move: MoveParams;
  rotate: RotateParams;
  reflect: ReflectParams;
  scale: ScaleParams;
  shear: ShearParams;
  each: EachParams;
  seed: number;
}

/** Parameters persist between dialog invocations (like Illustrator). */
let lastParams: AllParams = {
  move: { dx: 0, dy: 0, distance: 0, angle: 0 },
  rotate: { angle: 0 },
  reflect: { axis: 'v', angle: 0 },
  scale: { uniform: true, s: 100, sx: 100, sy: 100 },
  shear: { angle: 0, axis: 'h', axisAngle: 0 },
  each: { ...DEFAULT_EACH },
  seed: 1,
};

function newSeed(): number {
  return Math.floor(Math.random() * 1e9) + 1;
}

/** World matrix for the non-"each" tabs. */
export function dialogMatrix(tab: Exclude<TransformTab, 'each'>, p: AllParams, pivot: Vec): Matrix {
  switch (tab) {
    case 'move':
      return translation(p.move.dx, p.move.dy);
    case 'rotate':
      return rotationAbout(p.rotate.angle, pivot);
    case 'reflect':
      return reflectAbout(p.reflect.axis === 'h' ? 0 : p.reflect.axis === 'v' ? 90 : p.reflect.angle, pivot);
    case 'scale': {
      const sx = (p.scale.uniform ? p.scale.s : p.scale.sx) / 100;
      const sy = (p.scale.uniform ? p.scale.s : p.scale.sy) / 100;
      return scaleAbout(Math.abs(sx) < 1e-4 ? 1e-4 : sx, Math.abs(sy) < 1e-4 ? 1e-4 : sy, pivot);
    }
    case 'shear':
      return shearAbout(p.shear.angle, p.shear.axis === 'h' ? 0 : p.shear.axis === 'v' ? 90 : p.shear.axisAngle, pivot);
  }
}

function RadioRow<T extends string>({ value, options, onChange, name }: { value: T; options: Array<{ value: T; label: React.ReactNode }>; onChange: (v: T) => void; name: string }) {
  return (
    <div className="td-options">
      {options.map((o) => (
        <label key={o.value} className="td-radio">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export function TransformDialog({ props, close }: { props: TransformDialogProps; close: () => void }) {
  const [tab, setTab] = useState<TransformTab>(props.tab ?? 'move');
  const [params, setParamsState] = useState<AllParams>(() => ({ ...lastParams, seed: newSeed() }));
  const [preview, setPreview] = useState(true);
  const units = useStore((s) => s.prefs.units);
  const scaleStrokes = useStore((s) => s.prefs.scaleStrokes);
  const setPrefs = useStore((s) => s.setPrefs);
  const refPoint = useTransformStore((s) => s.refPoint);
  const setRefPoint = useTransformStore((s) => s.setRefPoint);
  const committed = useRef(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // snapshot of the document / selection the dialog works on
  const session = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    const base = getState().doc;
    const ids = transformTargets(getState());
    const bounds = selectionBounds(base, ids);
    return { base, ids, bounds };
  }, []);
  const { base, ids, bounds } = session;

  const setParams = useCallback((patch: Partial<AllParams>) => {
    setParamsState((p) => {
      const next = { ...p, ...patch };
      lastParams = next;
      return next;
    });
  }, []);

  const pivot: Vec = useMemo(() => props.pivot ?? (bounds ? refPointOf(bounds, refPoint) : { x: 0, y: 0 }), [props.pivot, bounds, refPoint]);
  const pivotRef = useRef(pivot);
  pivotRef.current = pivot;

  const matrixSource = useCallback(
    (t: TransformTab, p: AllParams, pv: Vec): MatrixSource => (t === 'each' ? eachMatrixSource({ ...p.each, ref: props.pivot ? p.each.ref : refPoint }, p.seed) : dialogMatrix(t, p, pv)),
    [props.pivot, refPoint],
  );

  const previewKey = JSON.stringify({ tab, params, pivot, preview, scaleStrokes, refPoint });
  useEffect(() => {
    const s = getState();
    if (!ids.length) return;
    if (!preview) {
      s.revert();
      return;
    }
    const { doc } = transformDocument(base, ids, matrixSource(tab, params, pivot), { scaleStrokes });
    if (doc !== s.doc) s.replaceDoc(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  useEffect(
    () => () => {
      if (!committed.current) getState().revert();
    },
    [],
  );

  const finish = useCallback(
    (copy: boolean) => {
      const s = getState();
      s.revert();
      const t = tabRef.current;
      const p = paramsRef.current;
      const pv = pivotRef.current;
      committed.current = true;
      if (ids.length) {
        if (t === 'each') {
          applyTransformEach({ ...p.each, ref: props.pivot ? p.each.ref : refPoint }, { label: copy ? 'Transform Each Copy' : 'Transform Each', copy, ids, seed: p.seed });
        } else {
          const m = dialogMatrix(t, p, pv);
          const label = TITLES[t];
          applyTransform(m, { label: copy ? `${label} Copy` : label, copy, ids });
          const pivotRec: TransformRecord['pivot'] = props.pivot ? { kind: 'absolute', point: props.pivot } : { kind: 'ref', ref: refPoint };
          recordMatrixTransform(label, m, pivotRec, copy, bounds);
        }
      }
      close();
    },
    [ids, bounds, close, props.pivot, refPoint],
  );

  const cancel = useCallback(() => {
    getState().revert();
    committed.current = true;
    close();
  }, [close]);

  // Enter anywhere in the dialog = OK (after the focused field committed its value)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.('.transform-dialog')) {
        setTimeout(() => finish(false), 0);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [finish]);

  const title = props.tabs ? 'Transform' : TITLES[tab];
  const disabled = !ids.length;
  const showRef = !props.pivot;

  const body = (() => {
    switch (tab) {
      case 'move': {
        const mv = params.move;
        const setMove = (patch: Partial<MoveParams>) => {
          const next = { ...mv, ...patch };
          if ('dx' in patch || 'dy' in patch) {
            next.distance = Math.hypot(next.dx, next.dy);
            next.angle = next.distance > 1e-9 ? normalizeAngle((Math.atan2(-next.dy, next.dx) * 180) / Math.PI) : mv.angle;
          } else {
            const r = (next.angle * Math.PI) / 180;
            next.dx = next.distance * Math.cos(r);
            next.dy = -next.distance * Math.sin(r);
            if (Math.abs(next.dx) < 1e-9) next.dx = 0;
            if (Math.abs(next.dy) < 1e-9) next.dy = 0;
          }
          setParams({ move: next });
        };
        return (
          <div className="td-section">
            <div className="td-section-title">Position</div>
            <div className="td-grid">
              <span className="plain-label">Horizontal</span>
              <NumberField value={mv.dx} onChange={(v) => setMove({ dx: v })} unit={units} data-testid="move-dx" />
              <span className="plain-label">Vertical</span>
              <NumberField value={mv.dy} onChange={(v) => setMove({ dy: v })} unit={units} data-testid="move-dy" />
              <span className="plain-label">Distance</span>
              <NumberField value={mv.distance} onChange={(v) => setMove({ distance: v })} unit={units} min={0} data-testid="move-distance" />
              <span className="plain-label">Angle</span>
              <NumberField value={mv.angle} onChange={(v) => setMove({ angle: v })} unit="deg" data-testid="move-angle" />
            </div>
            <div className="td-note">Positive vertical values move down; angles are counter-clockwise.</div>
          </div>
        );
      }
      case 'rotate':
        return (
          <div className="td-section">
            <div className="td-grid">
              <span className="plain-label">Angle</span>
              <NumberField value={params.rotate.angle} onChange={(v) => setParams({ rotate: { angle: v } })} unit="deg" step={1} bigStep={15} data-testid="rotate-angle" />
            </div>
            <div className="td-options">
              {[-90, -45, 45, 90, 180].map((a) => (
                <Button key={a} small onClick={() => setParams({ rotate: { angle: a } })} title={`Set ${a}°`}>
                  {a}°
                </Button>
              ))}
            </div>
          </div>
        );
      case 'reflect':
        return (
          <div className="td-section">
            <div className="td-section-title">Axis</div>
            <RadioRow
              name="reflect-axis"
              value={params.reflect.axis}
              onChange={(axis) => setParams({ reflect: { ...params.reflect, axis } })}
              options={[
                { value: 'h', label: 'Horizontal' },
                { value: 'v', label: 'Vertical' },
                { value: 'angle', label: 'Angle' },
              ]}
            />
            <div className="td-grid">
              <span className="plain-label">Angle</span>
              <NumberField value={params.reflect.angle} onChange={(v) => setParams({ reflect: { ...params.reflect, angle: v, axis: 'angle' } })} unit="deg" data-testid="reflect-angle" disabled={params.reflect.axis !== 'angle'} />
            </div>
          </div>
        );
      case 'scale': {
        const sc = params.scale;
        return (
          <div className="td-section">
            <RadioRow
              name="scale-mode"
              value={sc.uniform ? 'uniform' : 'nonuniform'}
              onChange={(v) => setParams({ scale: { ...sc, uniform: v === 'uniform' } })}
              options={[
                { value: 'uniform', label: 'Uniform' },
                { value: 'nonuniform', label: 'Non-uniform' },
              ]}
            />
            <div className="td-grid">
              {sc.uniform ? (
                <>
                  <span className="plain-label">Scale</span>
                  <NumberField value={sc.s} onChange={(v) => setParams({ scale: { ...sc, s: v, sx: v, sy: v } })} unit="%" min={0.01} data-testid="scale-uniform" />
                </>
              ) : (
                <>
                  <span className="plain-label">Horizontal</span>
                  <NumberField value={sc.sx} onChange={(v) => setParams({ scale: { ...sc, sx: v } })} unit="%" data-testid="scale-x" />
                  <span className="plain-label">Vertical</span>
                  <NumberField value={sc.sy} onChange={(v) => setParams({ scale: { ...sc, sy: v } })} unit="%" data-testid="scale-y" />
                </>
              )}
            </div>
            <div className="td-options">
              <Checkbox checked={scaleStrokes} onChange={(v) => setPrefs({ scaleStrokes: v })} label="Scale strokes & effects" />
            </div>
          </div>
        );
      }
      case 'shear': {
        const sh = params.shear;
        return (
          <div className="td-section">
            <div className="td-grid">
              <span className="plain-label">Shear angle</span>
              <NumberField value={sh.angle} onChange={(v) => setParams({ shear: { ...sh, angle: v } })} unit="deg" min={-89} max={89} data-testid="shear-angle" />
            </div>
            <div className="td-section-title">Axis</div>
            <RadioRow
              name="shear-axis"
              value={sh.axis}
              onChange={(axis) => setParams({ shear: { ...sh, axis } })}
              options={[
                { value: 'h', label: 'Horizontal' },
                { value: 'v', label: 'Vertical' },
                { value: 'angle', label: 'Angle' },
              ]}
            />
            <div className="td-grid">
              <span className="plain-label">Axis angle</span>
              <NumberField value={sh.axisAngle} onChange={(v) => setParams({ shear: { ...sh, axisAngle: v, axis: 'angle' } })} unit="deg" disabled={sh.axis !== 'angle'} data-testid="shear-axis-angle" />
            </div>
          </div>
        );
      }
      case 'each': {
        const ea = params.each;
        const setEach = (patch: Partial<EachParams>) => setParams({ each: { ...ea, ...patch } });
        return (
          <div className="td-section">
            <div className="td-section-title">Scale</div>
            <div className="td-grid">
              <span className="plain-label">Horizontal</span>
              <NumberField value={ea.scaleX} onChange={(v) => setEach({ scaleX: v })} unit="%" data-testid="each-scale-x" />
              <span className="plain-label">Vertical</span>
              <NumberField value={ea.scaleY} onChange={(v) => setEach({ scaleY: v })} unit="%" data-testid="each-scale-y" />
            </div>
            <div className="td-section-title">Move</div>
            <div className="td-grid">
              <span className="plain-label">Horizontal</span>
              <NumberField value={ea.moveX} onChange={(v) => setEach({ moveX: v })} unit={units} data-testid="each-move-x" />
              <span className="plain-label">Vertical</span>
              <NumberField value={ea.moveY} onChange={(v) => setEach({ moveY: v })} unit={units} data-testid="each-move-y" />
            </div>
            <div className="td-section-title">Rotate</div>
            <div className="td-grid">
              <span className="plain-label">Angle</span>
              <NumberField value={ea.angle} onChange={(v) => setEach({ angle: v })} unit="deg" data-testid="each-angle" />
            </div>
            <div className="td-section-title">Options</div>
            <div className="td-options">
              <Checkbox checked={ea.reflectX} onChange={(v) => setEach({ reflectX: v })} label="Reflect X" />
              <Checkbox checked={ea.reflectY} onChange={(v) => setEach({ reflectY: v })} label="Reflect Y" />
              <Checkbox
                checked={ea.random}
                onChange={(v) => {
                  setEach({ random: v });
                  if (v) setParams({ seed: newSeed() });
                }}
                label="Random"
              />
              {ea.random && (
                <Button small onClick={() => setParams({ seed: newSeed() })} title="Pick new random values">
                  Re-roll
                </Button>
              )}
            </div>
          </div>
        );
      }
    }
  })();

  const refBlock = (
    <div className="td-section">
      <div className="td-section-title">Reference point</div>
      <Row gap={10} align="center">
        {showRef ? (
          <>
            <RefPointGrid value={refPoint} onChange={setRefPoint} size="large" data-testid="dialog-ref-grid" />
            <span className="td-note">
              {tab === 'each' ? 'Each object is transformed around its own reference point.' : bounds ? `${formatLength(pivot.x, units)}, ${formatLength(pivot.y, units)}` : 'No selection'}
            </span>
          </>
        ) : (
          <span className="td-note">
            Custom reference point: {formatLength(pivot.x, units)}, {formatLength(pivot.y, units)}
          </span>
        )}
      </Row>
    </div>
  );

  return (
    <DialogFrame
      title={title}
      onClose={cancel}
      width={props.tabs ? 480 : 420}
      className="transform-dialog"
      footer={
        <>
          <div className="td-footer-left">
            <Checkbox checked={preview} onChange={setPreview} label="Preview" />
            {disabled && <span className="td-note">Nothing selected</span>}
          </div>
          <Button onClick={() => finish(true)} disabled={disabled} title="Apply the transform to a copy" data-testid="transform-copy">
            Copy
          </Button>
          <Button onClick={cancel} data-testid="transform-cancel">
            Cancel
          </Button>
          <Button primary onClick={() => finish(false)} disabled={disabled} data-testid="transform-ok">
            OK
          </Button>
        </>
      }
    >
      {props.tabs && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'move', label: 'Move' },
            { id: 'rotate', label: 'Rotate' },
            { id: 'reflect', label: 'Reflect' },
            { id: 'scale', label: 'Scale' },
            { id: 'shear', label: 'Shear' },
            { id: 'each', label: 'Each' },
          ]}
        />
      )}
      {body}
      {tab !== 'move' && refBlock}
    </DialogFrame>
  );
}

export type { Document, ID, Rect, RefPoint };
