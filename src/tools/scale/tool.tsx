/**
 * Scale tool (S): drag scales the selection around the reference point.
 * Shift = uniform (or a single axis when dragging along it), Alt-drag = copy,
 * Alt-click = dialog.
 */
import React, { useState } from 'react';
import { Scaling } from 'lucide-react';
import { scale } from '@/geometry/matrix';
import { getState, useStore } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { Checkbox, NumberField, Row } from '@/ui/widgets';
import { formatLength } from '@/util/units';
import { makeTransformTool } from '@/transform/toolFactory';
import { GuideLine } from '@/transform/gesture';
import { scaleAbout } from '@/transform/matrices';
import { applyTransform } from '@/transform/apply';
import { recordMatrixTransform } from '@/transform/again';
import { PivotInfo, Hint, useToolPivot } from '@/transform/ToolOptions';
import '@/transform/transform.css';

function ScaleOptions() {
  const { pivot, ids } = useToolPivot();
  const scaleStrokes = useStore((s) => s.prefs.scaleStrokes);
  const setPrefs = useStore((s) => s.setPrefs);
  const [pct, setPct] = useState(100);
  const apply = (v: number) => {
    if (!pivot || !ids.length || !v || v === 100) return;
    const s = getState();
    const m = scaleAbout(v / 100, v / 100, pivot);
    const bounds = selectionBounds(s.doc, ids);
    applyTransform(m, { label: 'Scale', ids });
    recordMatrixTransform('Scale', m, { kind: 'absolute', point: pivot }, false, bounds);
  };
  return (
    <Row gap={8} className="transform-tool-options">
      <NumberField label="Scale" value={pct} onChange={setPct} onCommit={apply} unit="%" width={110} min={0.1} decimals={1} disabled={!ids.length} title="Uniform scale around the reference point (Enter applies)" data-testid="scale-pct" />
      <Checkbox checked={scaleStrokes} onChange={(v) => setPrefs({ scaleStrokes: v })} label="Scale strokes & effects" />
      <PivotInfo dialog="transform.scale" />
      <Hint>Drag: scale · Shift: uniform / one axis · Alt-drag: copy · Alt-click: dialog</Hint>
    </Row>
  );
}

const EPS = 1e-6;

export const tool = makeTransformTool({
  id: 'scale',
  name: 'Scale Tool',
  shortcut: 's',
  icon: Scaling,
  order: 501,
  hint: 'Drag to scale around the reference point. Shift: uniform, Alt-drag: copy, Alt-click: dialog.',
  dialog: 'transform.scale',
  label: 'Scale',
  Options: ScaleOptions,
  matrix(info, ctx) {
    const { gesture: g, pointer: p, event: e, bounds } = info;
    const z = ctx.zoom;
    const d0 = { x: g.start.x - g.pivot.x, y: g.start.y - g.pivot.y };
    const d1 = { x: p.x - g.pivot.x, y: p.y - g.pivot.y };
    const minAxis = 6 / z; // start too close to the pivot on an axis → use the uniform ratio there
    const l0 = Math.hypot(d0.x, d0.y);
    const uniform = l0 > EPS ? (d1.x * d0.x + d1.y * d0.y) / (l0 * l0) : 1;
    let sx: number;
    let sy: number;
    if (e.shift) {
      const ax = Math.abs(d1.x - d0.x);
      const ay = Math.abs(d1.y - d0.y);
      if (ax > ay * 2 && Math.abs(d0.x) > minAxis) {
        sx = d1.x / d0.x;
        sy = 1;
      } else if (ay > ax * 2 && Math.abs(d0.y) > minAxis) {
        sx = 1;
        sy = d1.y / d0.y;
      } else {
        sx = sy = uniform;
      }
    } else {
      sx = Math.abs(d0.x) > minAxis ? d1.x / d0.x : uniform;
      sy = Math.abs(d0.y) > minAxis ? d1.y / d0.y : uniform;
    }
    if (!Number.isFinite(sx) || Math.abs(sx) < 1e-3) sx = 1e-3 * Math.sign(sx || 1);
    if (!Number.isFinite(sy) || Math.abs(sy) < 1e-3) sy = 1e-3 * Math.sign(sy || 1);
    const m = scale(sx, sy, g.pivot.x, g.pivot.y);
    const units = ctx.state.prefs.units;
    const hud = `${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%\nW: ${formatLength(Math.abs(bounds.width * sx), units)}\nH: ${formatLength(Math.abs(bounds.height * sy), units)}`;
    return { m, hud };
  },
  overlay(info, ctx) {
    const p = ctx.worldToScreen(info.gesture.pivot);
    const b = ctx.worldToScreen(info.pointer);
    return <GuideLine from={p} to={b} />;
  },
});

void React;
