/**
 * Reflect tool (O): click sets the axis origin, drag (or a second click) sets
 * the axis angle and mirrors the selection across it. Shift snaps the axis to
 * 45° steps, Alt = copy, Alt-click = dialog.
 */
import React from 'react';
import { FlipHorizontal2 } from 'lucide-react';
import { reflect } from '@/geometry/matrix';
import { getState } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { Button, Row } from '@/ui/widgets';
import { makeTransformTool } from '@/transform/toolFactory';
import { GuideLine } from '@/transform/gesture';
import { normalizeAngle, snapAngle, reflectAbout } from '@/transform/matrices';
import { applyTransform } from '@/transform/apply';
import { recordMatrixTransform } from '@/transform/again';
import { PivotInfo, Hint, useToolPivot } from '@/transform/ToolOptions';
import type { Vec } from '@/model/types';
import '@/transform/transform.css';

function ReflectOptions() {
  const { pivot, ids } = useToolPivot();
  const flip = (axis: number) => {
    if (!pivot || !ids.length) return;
    const s = getState();
    const m = reflectAbout(axis, pivot);
    const bounds = selectionBounds(s.doc, ids);
    applyTransform(m, { label: 'Reflect', ids });
    recordMatrixTransform('Reflect', m, { kind: 'absolute', point: pivot }, false, bounds);
  };
  return (
    <Row gap={8} className="transform-tool-options">
      <Button small disabled={!ids.length} onClick={() => flip(0)} title="Reflect across the horizontal axis through the reference point" data-testid="reflect-h">
        Horizontal
      </Button>
      <Button small disabled={!ids.length} onClick={() => flip(90)} title="Reflect across the vertical axis through the reference point" data-testid="reflect-v">
        Vertical
      </Button>
      <PivotInfo dialog="transform.reflect" />
      <Hint>Click: axis origin · Drag / second click: axis · Shift: 45° · Alt: copy · Alt-click: dialog</Hint>
    </Row>
  );
}

function axisScreenDeg(pivot: Vec, p: Vec, shift: boolean, step: number): number {
  let deg = (Math.atan2(p.y - pivot.y, p.x - pivot.x) * 180) / Math.PI;
  if (shift) deg = snapAngle(deg, step);
  return deg;
}

export const tool = makeTransformTool({
  id: 'reflect',
  name: 'Reflect Tool',
  shortcut: 'o',
  icon: FlipHorizontal2,
  order: 502,
  hint: 'Click to set the axis origin, drag to set the axis and mirror. Shift snaps to 45°, Alt copies, Alt-click opens the dialog.',
  dialog: 'transform.reflect',
  label: 'Reflect',
  Options: ReflectOptions,
  matrix(info, ctx) {
    const { gesture: g, pointer: p, event: e } = info;
    const deg = axisScreenDeg(g.pivot, p, e.shift, ctx.state.prefs.constrainAngle || 45);
    const m = reflect(deg, g.pivot.x, g.pivot.y);
    return { m, hud: `Axis ${normalizeAngle(-deg).toFixed(1)}°` };
  },
  clickTransform(pivot, p, e, ctx) {
    const deg = axisScreenDeg(pivot, p, e.shift, ctx.state.prefs.constrainAngle || 45);
    return reflect(deg, pivot.x, pivot.y);
  },
  overlay(info, ctx) {
    const p = ctx.worldToScreen(info.gesture.pivot);
    const b = ctx.worldToScreen(info.pointer);
    const deg = axisScreenDeg(info.gesture.pivot, info.pointer, info.event.shift, ctx.state.prefs.constrainAngle || 45);
    const r = (deg * Math.PI) / 180;
    const dir = { x: Math.cos(r), y: Math.sin(r) };
    const L = 4000;
    return (
      <g>
        <GuideLine from={{ x: p.x - dir.x * L, y: p.y - dir.y * L }} to={{ x: p.x + dir.x * L, y: p.y + dir.y * L }} />
        <circle cx={b.x} cy={b.y} r={3} fill="#4a90e2" />
      </g>
    );
  },
});

void React;
