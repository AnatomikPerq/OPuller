/**
 * Transform panel: reference point, X/Y/W/H (relative to the active artboard),
 * rotation & shear, flip / rotate buttons, "Scale strokes & effects".
 */
import React, { useMemo, useRef, useState } from 'react';
import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, Lock, LockOpen } from 'lucide-react';
import { registerPanel } from '@/ui/panels/registry';
import { useStore, getState } from '@/store/store';
import { Checkbox, IconButton, NumberField } from '@/ui/widgets';
import { selectionBounds } from '@/model/document';
import { translate, isIdentity } from '@/geometry/matrix';
import type { Matrix, Rect } from '@/model/types';
import { RefPointGrid } from '@/transform/RefPointGrid';
import { refPointOf } from '@/transform/refPoint';
import { useTransformStore, getTransformState } from '@/transform/store';
import { applyTransform, transformTargets, nodeRotation, nodeShear } from '@/transform/apply';
import { rotationAbout, scaleAbout, shearAbout, normalizeAngle } from '@/transform/matrices';
import { recordMatrixTransform } from '@/transform/again';
import { rotateSelection, flipSelection } from '@/commands/transformCommands/register';
import { shortcutLabel } from '@/util/keys';
import { getCommand } from '@/commands/registry';
import { activeArtboardRect } from '@/transform/align';
import '@/transform/transform.css';

function useSelectionInfo() {
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  const activeArtboardId = useStore((s) => s.activeArtboardId);
  return useMemo(() => {
    const s = getState();
    const ids = transformTargets(s, selection);
    const bounds = selectionBounds(s.doc, ids);
    const ab = activeArtboardRect(s) ?? { x: 0, y: 0, width: 0, height: 0 };
    let rotation: number | null = 0;
    let shear: number | null = 0;
    if (ids.length) {
      const rots = ids.map((id) => nodeRotation(s.doc, id));
      const shears = ids.map((id) => nodeShear(s.doc, id));
      rotation = rots.every((r) => Math.abs(r - rots[0]) < 1e-6) ? normalizeAngle(rots[0]) : null;
      shear = shears.every((r) => Math.abs(r - shears[0]) < 1e-6) ? shears[0] : null;
    }
    return { ids, bounds, artboard: ab, rotation, shear };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, docVersion, activeArtboardId]);
}

function shortcutOf(id: string): string {
  const c = getCommand(id);
  const sc = Array.isArray(c?.shortcut) ? c?.shortcut[0] : c?.shortcut;
  return sc ? ` (${shortcutLabel(sc)})` : '';
}

export function TransformPanel() {
  const units = useStore((s) => s.prefs.units);
  const scaleStrokes = useStore((s) => s.prefs.scaleStrokes);
  const setPrefs = useStore((s) => s.setPrefs);
  const refPoint = useTransformStore((s) => s.refPoint);
  const setRefPoint = useTransformStore((s) => s.setRefPoint);
  const constrain = useTransformStore((s) => s.constrain);
  const setConstrain = useTransformStore((s) => s.setConstrain);
  const { ids, bounds, artboard, rotation, shear } = useSelectionInfo();
  const disabled = !ids.length || !bounds;
  const ref = bounds ? refPointOf(bounds, refPoint) : null;
  // remount angle fields after each commit so they show the fresh value
  const [fieldKey, setFieldKey] = useState(0);
  const pendingRot = useRef<number | null>(null);
  const pendingShear = useRef<number | null>(null);
  /** state at the start of a field edit (for Transform Again) */
  const session = useRef<{ bounds: Rect; rotation: number; shear: number } | null>(null);

  const current = () => {
    const s = getState();
    const tids = transformTargets(s);
    const b = selectionBounds(s.doc, tids);
    return { s, ids: tids, bounds: b, pivot: b ? refPointOf(b, getTransformState().refPoint) : null };
  };

  const beginSession = () => {
    if (session.current) return;
    const { bounds: b } = current();
    if (b) session.current = { bounds: b, rotation: rotation ?? 0, shear: shear ?? 0 };
  };

  const live = (build: () => { m: ReturnType<typeof translate>; label: string } | null) => {
    beginSession();
    const r = build();
    if (!r) return;
    applyTransform(r.m, { label: r.label, commit: false, ids: transformTargets(getState()) });
  };

  /** Commit one history step and record the net edit for Transform Again. */
  const commit = (label: string, kind: 'move' | 'scale' | 'rotate' | 'shear') => {
    getState().commit(label);
    const start = session.current;
    session.current = null;
    const { bounds: after } = current();
    const refNow = getTransformState().refPoint;
    if (start && after) {
      const p0 = refPointOf(start.bounds, refNow);
      const p1 = refPointOf(after, refNow);
      let m: Matrix | null = null;
      if (kind === 'move') m = translate(p1.x - p0.x, p1.y - p0.y);
      else if (kind === 'scale' && start.bounds.width > 1e-9 && start.bounds.height > 1e-9) m = scaleAbout(after.width / start.bounds.width, after.height / start.bounds.height, p0);
      else if (kind === 'rotate') m = rotationAbout((pendingRot.current ?? start.rotation) - start.rotation, p0);
      else if (kind === 'shear') m = shearAbout((pendingShear.current ?? start.shear) - start.shear, 0, p0);
      if (m && !isIdentity(m)) recordMatrixTransform(label, m, { kind: 'ref', ref: refNow }, false, start.bounds);
    }
    pendingRot.current = null;
    pendingShear.current = null;
    setFieldKey((k) => k + 1);
  };

  const setX = (v: number) => {
    const { bounds: b, pivot } = current();
    if (!b || !pivot) return;
    const dx = artboard.x + v - pivot.x;
    if (Math.abs(dx) < 1e-9) return;
    live(() => ({ m: translate(dx, 0), label: 'Move' }));
  };
  const setY = (v: number) => {
    const { bounds: b, pivot } = current();
    if (!b || !pivot) return;
    const dy = artboard.y + v - pivot.y;
    if (Math.abs(dy) < 1e-9) return;
    live(() => ({ m: translate(0, dy), label: 'Move' }));
  };
  const setSize = (axis: 'w' | 'h', v: number) => {
    const { bounds: b, pivot } = current();
    if (!b || !pivot) return;
    const cur = axis === 'w' ? b.width : b.height;
    if (!(cur > 1e-9) || !(v > 1e-9)) return;
    const f = v / cur;
    let sx = axis === 'w' ? f : 1;
    let sy = axis === 'h' ? f : 1;
    if (getTransformState().constrain) sx = sy = f;
    if (Math.abs(sx - 1) < 1e-12 && Math.abs(sy - 1) < 1e-12) return;
    live(() => ({ m: scaleAbout(sx, sy, pivot), label: 'Scale' }));
  };
  const setRotation = (v: number) => {
    const { pivot } = current();
    if (!pivot) return;
    const base = pendingRot.current ?? rotation ?? 0;
    const delta = v - base;
    pendingRot.current = v;
    if (Math.abs(delta) < 1e-9) return;
    live(() => ({ m: rotationAbout(delta, pivot), label: 'Rotate' }));
  };
  const setShear = (v: number) => {
    const { pivot } = current();
    if (!pivot) return;
    const base = pendingShear.current ?? shear ?? 0;
    const delta = v - base;
    pendingShear.current = v;
    if (Math.abs(delta) < 1e-9) return;
    live(() => ({ m: shearAbout(delta, 0, pivot), label: 'Shear' }));
  };

  const x = ref ? ref.x - artboard.x : null;
  const y = ref ? ref.y - artboard.y : null;

  return (
    <div className="transform-panel" data-testid="transform-panel">
      <div className="tp-grid">
        <div className="tp-ref">
          <RefPointGrid value={refPoint} onChange={setRefPoint} />
        </div>
        <NumberField label="X" value={x} onChange={setX} onCommit={() => commit('Move', 'move')} unit={units} disabled={disabled} data-testid="tp-x" title="Reference point X (relative to the active artboard)" />
        <NumberField label="W" value={bounds?.width ?? null} onChange={(v) => setSize('w', v)} onCommit={() => commit('Scale', 'scale')} unit={units} min={0.01} disabled={disabled} data-testid="tp-w" title="Width" />
        <button type="button" className={`tp-lock ${constrain ? 'active' : ''}`} onClick={() => setConstrain(!constrain)} title={constrain ? 'Constrain proportions (on)' : 'Constrain proportions (off)'} aria-pressed={constrain} data-testid="tp-lock">
          {constrain ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
        <NumberField label="Y" value={y} onChange={setY} onCommit={() => commit('Move', 'move')} unit={units} disabled={disabled} data-testid="tp-y" title="Reference point Y (relative to the active artboard)" />
        <NumberField label="H" value={bounds?.height ?? null} onChange={(v) => setSize('h', v)} onCommit={() => commit('Scale', 'scale')} unit={units} min={0.01} disabled={disabled} data-testid="tp-h" title="Height" />
      </div>
      <div className="tp-angles" key={fieldKey}>
        <NumberField
          label={<RotateCw size={11} />}
          value={rotation}
          mixed={rotation === null}
          onChange={setRotation}
          onCommit={() => commit('Rotate', 'rotate')}
          unit="deg"
          disabled={disabled}
          data-testid="tp-rotate"
          title="Rotation angle (counter-clockwise) around the reference point"
        />
        <NumberField
          label={<span style={{ fontStyle: 'italic', fontWeight: 600 }}>S</span>}
          value={shear}
          mixed={shear === null}
          onChange={setShear}
          onCommit={() => commit('Shear', 'shear')}
          unit="deg"
          min={-89}
          max={89}
          disabled={disabled}
          data-testid="tp-shear"
          title="Shear angle along the horizontal axis"
        />
      </div>
      <div className="tp-actions">
        <IconButton icon={<FlipHorizontal2 size={15} />} title={`Flip Horizontal${shortcutOf('object.flipH')}`} disabled={disabled} onClick={() => flipSelection('h')} data-testid="tp-flip-h" />
        <IconButton icon={<FlipVertical2 size={15} />} title={`Flip Vertical${shortcutOf('object.flipV')}`} disabled={disabled} onClick={() => flipSelection('v')} data-testid="tp-flip-v" />
        <span className="sep" />
        <IconButton icon={<RotateCcw size={15} />} title="Rotate 90° CCW" disabled={disabled} onClick={() => rotateSelection(90, 'Rotate 90° CCW')} data-testid="tp-rot-ccw" />
        <IconButton icon={<RotateCw size={15} />} title="Rotate 90° CW" disabled={disabled} onClick={() => rotateSelection(-90, 'Rotate 90° CW')} data-testid="tp-rot-cw" />
        <span className="sep" />
        <Checkbox checked={scaleStrokes} onChange={(v) => setPrefs({ scaleStrokes: v })} label="Scale strokes & effects" title="Scale stroke widths and effects together with objects" />
      </div>
    </div>
  );
}

registerPanel({ id: 'transform', title: 'Transform', component: TransformPanel, order: 20, defaultVisible: true, shortcut: 'shift+f8' });

void React;
