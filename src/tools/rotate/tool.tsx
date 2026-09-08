/**
 * Rotate tool (R): click sets the reference point, drag rotates around it.
 * Shift constrains to the preference angle, Alt-drag rotates a copy,
 * Alt-click opens the Rotate dialog.
 */
import React, { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { rotate } from '@/geometry/matrix';
import { getState, useStore } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { NumberField, Row } from '@/ui/widgets';
import { makeTransformTool } from '@/transform/toolFactory';
import { GuideLine } from '@/transform/gesture';
import { normalizeAngle, snapAngle, rotationAbout } from '@/transform/matrices';
import { applyTransform, transformTargets } from '@/transform/apply';
import { recordMatrixTransform } from '@/transform/again';
import { PivotInfo, Hint, useToolPivot } from '@/transform/ToolOptions';
import '@/transform/transform.css';

function RotateOptions() {
  const { pivot, ids } = useToolPivot();
  const [angle, setAngle] = useState(0);
  const apply = (v: number) => {
    if (!pivot || !ids.length || !v) return;
    const s = getState();
    const m = rotationAbout(v, pivot);
    const bounds = selectionBounds(s.doc, ids);
    applyTransform(m, { label: 'Rotate', ids });
    recordMatrixTransform('Rotate', m, { kind: 'absolute', point: pivot }, false, bounds);
  };
  return (
    <Row gap={8} className="transform-tool-options">
      <NumberField label="Angle" value={angle} onChange={setAngle} onCommit={apply} unit="deg" width={110} disabled={!ids.length} title="Rotate the selection by this angle around the reference point (Enter applies)" data-testid="rotate-angle" />
      <PivotInfo dialog="transform.rotate" />
      <Hint>Click: reference point · Drag: rotate · Shift: constrain · Alt-drag: copy · Alt-click: dialog</Hint>
    </Row>
  );
}

export const tool = makeTransformTool({
  id: 'rotate',
  name: 'Rotate Tool',
  shortcut: 'r',
  icon: RotateCw,
  order: 500,
  hint: 'Click to set the reference point, drag to rotate. Shift constrains, Alt-drag copies, Alt-click opens the dialog.',
  dialog: 'transform.rotate',
  label: 'Rotate',
  Options: RotateOptions,
  matrix(info, ctx) {
    const { gesture: g, pointer: p, event: e } = info;
    const a0 = Math.atan2(g.start.y - g.pivot.y, g.start.x - g.pivot.x);
    const a1 = Math.atan2(p.y - g.pivot.y, p.x - g.pivot.x);
    let deg = ((a1 - a0) * 180) / Math.PI;
    if (e.shift) deg = snapAngle(deg, ctx.state.prefs.constrainAngle || 45);
    const m = rotate(deg, g.pivot.x, g.pivot.y);
    return { m, hud: `∠ ${normalizeAngle(-deg).toFixed(1)}°` };
  },
  overlay(info, ctx) {
    const p = ctx.worldToScreen(info.gesture.pivot);
    const a = ctx.worldToScreen(info.gesture.start);
    const b = ctx.worldToScreen(info.pointer);
    const r = Math.min(40, Math.max(12, Math.hypot(a.x - p.x, a.y - p.y) * 0.35));
    const a0 = Math.atan2(a.y - p.y, a.x - p.x);
    const a1 = Math.atan2(b.y - p.y, b.x - p.x);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const sweep = d > 0 ? 1 : 0;
    const large = Math.abs(d) > Math.PI ? 1 : 0;
    const arc = `M${p.x + Math.cos(a0) * r} ${p.y + Math.sin(a0) * r}A${r} ${r} 0 ${large} ${sweep} ${p.x + Math.cos(a1) * r} ${p.y + Math.sin(a1) * r}`;
    return (
      <g>
        <GuideLine from={p} to={a} color="#9aa0a6" />
        <GuideLine from={p} to={b} dashed={false} />
        <path d={arc} fill="none" stroke="#4a90e2" strokeWidth={1.5} />
      </g>
    );
  },
});

void React;
void useStore;
void transformTargets;
