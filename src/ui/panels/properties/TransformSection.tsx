/**
 * Compact transform fields: X / Y / W / H relative to the active artboard
 * (top-left reference), proportional lock and rotation angle.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Link, Unlink, RotateCw } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { NumberField } from '@/ui/widgets';
import { selectionBounds } from '@/model/document';
import { translate, scale, rotate } from '@/geometry/matrix';
import { editTargets, artboardRect, nodeRotationDeg, beginTransformSession, previewTransform, finishTransform, type TransformSession } from './edit';

export function TransformSection() {
  const units = useStore((s) => s.prefs.units);
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  useStore((s) => s.activeArtboardId);
  const [lock, setLock] = useState(true);
  const session = useRef<TransformSession | null>(null);
  const [fieldKey, setFieldKey] = useState(0);

  const info = useMemo(() => {
    const s = getState();
    const ids = editTargets(s, selection);
    const bounds = selectionBounds(s.doc, ids);
    const ab = artboardRect(s);
    let rotation: number | null = 0;
    if (ids.length) {
      const rots = ids.map((id) => nodeRotationDeg(s.doc, id));
      rotation = rots.every((r) => Math.abs(r - rots[0]) < 1e-6) ? rots[0] : null;
    }
    return { ids, bounds, ab, rotation };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, docVersion]);

  const disabled = !info.ids.length || !info.bounds;
  const b = info.bounds;

  const live = (build: (S: TransformSession) => ReturnType<typeof translate> | null) => {
    session.current = beginTransformSession(session.current);
    const S = session.current;
    if (!S) return;
    const m = build(S);
    if (m) previewTransform(S, m);
  };
  const finish = (label: string) => {
    finishTransform(session.current, label);
    session.current = null;
    setFieldKey((k) => k + 1);
  };

  const setX = (v: number) => live((S) => translate(info.ab.x + v - S.bounds.x, 0));
  const setY = (v: number) => live((S) => translate(0, info.ab.y + v - S.bounds.y));
  const setW = (v: number) =>
    live((S) => {
      if (S.bounds.width < 1e-9) return null;
      const sx = Math.max(v, 0.01) / S.bounds.width;
      const sy = lock ? sx : 1;
      return scale(sx, sy, S.bounds.x, S.bounds.y);
    });
  const setH = (v: number) =>
    live((S) => {
      if (S.bounds.height < 1e-9) return null;
      const sy = Math.max(v, 0.01) / S.bounds.height;
      const sx = lock ? sy : 1;
      return scale(sx, sy, S.bounds.x, S.bounds.y);
    });
  const setAngle = (v: number) =>
    live((S) => {
      const delta = v - S.rotation;
      if (Math.abs(delta) < 1e-9) return null;
      const cx = S.bounds.x + S.bounds.width / 2;
      const cy = S.bounds.y + S.bounds.height / 2;
      return rotate(-delta, cx, cy);
    });

  return (
    <div className="pp-transform" key={fieldKey}>
      <NumberField label="X" value={b ? b.x - info.ab.x : null} onChange={setX} onCommit={() => finish('Move')} unit={units} disabled={disabled} data-testid="pp-x" title="X (top-left, relative to the artboard)" />
      <NumberField label="W" value={b ? b.width : null} onChange={setW} onCommit={() => finish('Scale')} unit={units} min={0.01} disabled={disabled} data-testid="pp-w" title="Width" />
      <button type="button" className={`pp-lock ${lock ? 'active' : ''}`} onClick={() => setLock(!lock)} title={lock ? 'Proportions locked' : 'Lock proportions'} data-testid="pp-lock" aria-pressed={lock}>
        {lock ? <Link size={11} /> : <Unlink size={11} />}
      </button>
      <NumberField label="Y" value={b ? b.y - info.ab.y : null} onChange={setY} onCommit={() => finish('Move')} unit={units} disabled={disabled} data-testid="pp-y" title="Y (top-left, relative to the artboard)" />
      <NumberField label="H" value={b ? b.height : null} onChange={setH} onCommit={() => finish('Scale')} unit={units} min={0.01} disabled={disabled} data-testid="pp-h" title="Height" />
      <NumberField
        label={<RotateCw size={11} />}
        value={info.rotation}
        mixed={info.rotation === null}
        onChange={setAngle}
        onCommit={() => finish('Rotate')}
        unit="deg"
        decimals={1}
        disabled={disabled}
        data-testid="pp-angle"
        title="Rotation angle (counter-clockwise)"
      />
      <span className="dim small" style={{ gridColumn: '2 / span 2' }}>
        {info.ids.length > 1 ? `${info.ids.length} objects` : ''}
      </span>
    </div>
  );
}
