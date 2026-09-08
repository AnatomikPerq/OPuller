/**
 * Shear tool: drag shears the selection relative to the reference point.
 * Horizontal drags shear along the horizontal axis, vertical drags along the
 * vertical axis (Shift locks to one axis). Alt-drag = copy, Alt-click = dialog.
 */
import React, { useState } from 'react';
import { getState } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { NumberField, Row, Segmented } from '@/ui/widgets';
import { makeTransformTool } from '@/transform/toolFactory';
import { GuideLine } from '@/transform/gesture';
import { aboutPoint, shearAbout } from '@/transform/matrices';
import { applyTransform } from '@/transform/apply';
import { recordMatrixTransform } from '@/transform/again';
import { PivotInfo, Hint, useToolPivot } from '@/transform/ToolOptions';
import '@/transform/transform.css';

/** Parallelogram icon (lucide style). */
export function ShearIcon({ size = 18, className, strokeWidth = 1.75 }: { size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 5h13l-5 14H3z" />
      <path d="M3 5h3M18 19h3" strokeDasharray="1 2" />
    </svg>
  );
}

function ShearOptions() {
  const { pivot, ids } = useToolPivot();
  const [angle, setAngle] = useState(0);
  const [axis, setAxis] = useState<'h' | 'v'>('h');
  const apply = (v: number) => {
    if (!pivot || !ids.length || !v) return;
    const s = getState();
    const m = shearAbout(v, axis === 'h' ? 0 : 90, pivot);
    const bounds = selectionBounds(s.doc, ids);
    applyTransform(m, { label: 'Shear', ids });
    recordMatrixTransform('Shear', m, { kind: 'absolute', point: pivot }, false, bounds);
  };
  return (
    <Row gap={8} className="transform-tool-options">
      <NumberField label="Shear" value={angle} onChange={setAngle} onCommit={apply} unit="deg" min={-89} max={89} width={110} disabled={!ids.length} title="Shear angle applied along the axis (Enter applies)" data-testid="shear-angle" />
      <Segmented
        value={axis}
        onChange={setAxis}
        options={[
          { value: 'h', label: 'Horizontal', title: 'Horizontal axis' },
          { value: 'v', label: 'Vertical', title: 'Vertical axis' },
        ]}
      />
      <PivotInfo dialog="transform.shear" />
      <Hint>Drag: shear · Shift: one axis · Alt-drag: copy · Alt-click: dialog</Hint>
    </Row>
  );
}

export const tool = makeTransformTool({
  id: 'shear',
  name: 'Shear Tool',
  icon: ShearIcon,
  order: 503,
  hint: 'Drag to shear relative to the reference point. Shift locks the axis, Alt-drag copies, Alt-click opens the dialog.',
  dialog: 'transform.shear',
  label: 'Shear',
  Options: ShearOptions,
  matrix(info, ctx) {
    const { gesture: g, pointer: p, event: e } = info;
    const z = ctx.zoom;
    const minDist = 4 / z;
    const d0 = { x: g.start.x - g.pivot.x, y: g.start.y - g.pivot.y };
    const delta = { x: p.x - g.start.x, y: p.y - g.start.y };
    let kx = Math.abs(d0.y) > minDist ? delta.x / d0.y : 0; // x' = x + kx (y - py)
    let ky = Math.abs(d0.x) > minDist ? delta.y / d0.x : 0; // y' = y + ky (x - px)
    if (e.shift) {
      if (Math.abs(delta.x) >= Math.abs(delta.y)) ky = 0;
      else kx = 0;
    }
    const clampK = (k: number) => Math.max(-57, Math.min(57, k)); // ~ ±89°
    kx = clampK(kx);
    ky = clampK(ky);
    const m = aboutPoint({ a: 1, b: ky, c: kx, d: 1, e: 0, f: 0 }, g.pivot);
    const hDeg = (-Math.atan(kx) * 180) / Math.PI;
    const vDeg = (-Math.atan(ky) * 180) / Math.PI;
    const parts: string[] = [];
    if (Math.abs(kx) > 1e-9 || Math.abs(ky) < 1e-9) parts.push(`Horizontal ${hDeg.toFixed(1)}°`);
    if (Math.abs(ky) > 1e-9) parts.push(`Vertical ${vDeg.toFixed(1)}°`);
    return { m, hud: parts.join('\n') };
  },
  overlay(info, ctx) {
    const p = ctx.worldToScreen(info.gesture.pivot);
    const a = ctx.worldToScreen(info.gesture.start);
    const b = ctx.worldToScreen(info.pointer);
    return (
      <g>
        <GuideLine from={p} to={a} color="#9aa0a6" />
        <GuideLine from={a} to={b} dashed={false} />
      </g>
    );
  },
});

void React;
