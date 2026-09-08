/**
 * Measure tool: drag between two points to measure distance, delta and angle.
 * The last measurement stays on screen and is shown in the Info panel.
 * Shift constrains the line to 45° steps, Alt-drag measures from the previous
 * end point.
 */
import React from 'react';
import { Ruler } from 'lucide-react';
import { create } from 'zustand';
import type { Tool } from '../types';
import type { Vec } from '@/model/types';
import { useStore } from '@/store/store';
import { constrainDelta } from '@/canvas/snap';
import { formatLength } from '@/util/units';
import { useOverlayStore } from '@/canvas/overlayStore';
import type { SnapSession } from '@/canvas/snap';
import { Checkbox, Row, Button } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';

export interface Measurement {
  from: Vec;
  to: Vec;
  distance: number;
  dx: number;
  dy: number;
  /** degrees, Illustrator convention (counter-clockwise, y up) */
  angle: number;
}

export const useMeasureStore = create<{ last: Measurement | null; set: (m: Measurement | null) => void }>((set) => ({ last: null, set: (last) => set({ last }) }));

let drag: { from: Vec; snap: SnapSession } | null = null;

function measurement(from: Vec, to: Vec): Measurement {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let angle = (-Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { from, to, distance: Math.hypot(dx, dy), dx, dy, angle };
}

export function measureText(m: Measurement, units: any): string {
  return `D: ${formatLength(m.distance, units)}\nW: ${formatLength(Math.abs(m.dx), units)}  H: ${formatLength(Math.abs(m.dy), units)}\n∠ ${m.angle.toFixed(1)}°`;
}

export const tool: Tool = {
  id: 'measure',
  name: 'Measure Tool',
  icon: Ruler,
  group: 'edit',
  order: 622,
  cursor: 'crosshair',
  hint: 'Drag to measure distance and angle between two points. Shift constrains to 45°, Alt continues from the previous end point.',
  showSelectionOverlay: true,
  defaults: { snap: true, keep: true },
  Options: MeasureOptions,

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const opts = ctx.options<{ snap: boolean }>();
    const snap = ctx.beginSnap();
    const last = useMeasureStore.getState().last;
    let from = e.world;
    if (e.alt && last) from = last.to;
    else if (opts.snap && !e.primary) from = snap.snap(e.world).point;
    drag = { from, snap };
    ctx.capture(e.pointerId);
    useMeasureStore.getState().set(measurement(from, from));
    ctx.requestOverlay();
  },
  onPointerMove(e, ctx) {
    if (!drag) return;
    const s = ctx.state;
    const opts = ctx.options<{ snap: boolean }>();
    let to = e.world;
    if (opts.snap && !e.primary) {
      const sr = drag.snap.snap(to);
      to = sr.point;
      ctx.setSnapGuides(sr);
    }
    if (e.shift) {
      const d = constrainDelta({ x: to.x - drag.from.x, y: to.y - drag.from.y });
      to = { x: drag.from.x + d.x, y: drag.from.y + d.y };
    }
    const m = measurement(drag.from, to);
    useMeasureStore.getState().set(m);
    useOverlayStore.getState().setHud({ screen: { x: e.screen.x + 14, y: e.screen.y + 14 }, text: measureText(m, s.prefs.units) });
    ctx.setStatus(`Distance ${formatLength(m.distance, s.prefs.units)}, angle ${m.angle.toFixed(1)}°`);
    ctx.requestOverlay();
  },
  onPointerUp(_e, ctx) {
    drag = null;
    ctx.setSnapGuides(null);
    useOverlayStore.getState().setHud(null);
    const opts = ctx.options<{ keep: boolean }>();
    if (!opts.keep) useMeasureStore.getState().set(null);
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      drag = null;
      useMeasureStore.getState().set(null);
      useOverlayStore.getState().setHud(null);
      ctx.setSnapGuides(null);
      ctx.requestOverlay();
      return true;
    }
    return false;
  },
  renderOverlay(ctx) {
    const m = useMeasureStore.getState().last;
    if (!m) return null;
    const a = ctx.worldToScreen(m.from);
    const b = ctx.worldToScreen(m.to);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const label = `${formatLength(m.distance, ctx.state.prefs.units)}  ∠${m.angle.toFixed(1)}°`;
    return (
      <g className="measure-overlay" pointerEvents="none" data-testid="measure-overlay">
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#fff" strokeWidth={3} strokeOpacity={0.5} />
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#e0245e" strokeWidth={1.2} />
        <line x1={a.x} y1={a.y} x2={b.x} y2={a.y} stroke="#e0245e" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        <line x1={b.x} y1={a.y} x2={b.x} y2={b.y} stroke="#e0245e" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        <circle cx={a.x} cy={a.y} r={3.5} fill="#e0245e" stroke="#fff" strokeWidth={1} />
        <circle cx={b.x} cy={b.y} r={3.5} fill="#e0245e" stroke="#fff" strokeWidth={1} />
        {m.distance > 0 && (
          <g transform={`translate(${mid.x + 8} ${mid.y - 8})`}>
            <rect x={-4} y={-12} width={label.length * 6.4 + 8} height={16} rx={3} fill="rgba(20,20,24,0.85)" />
            <text x={0} y={0} fontSize={11} fill="#fff" fontFamily="Inter, system-ui, sans-serif">
              {label}
            </text>
          </g>
        )}
      </g>
    );
  },
  cancel(ctx) {
    drag = null;
    useOverlayStore.getState().setHud(null);
    ctx.setSnapGuides(null);
    ctx.requestOverlay();
  },
  deactivate(ctx) {
    drag = null;
    useMeasureStore.getState().set(null);
    ctx.requestOverlay();
  },
};

function MeasureOptions() {
  const [opts, set] = useToolOptions<{ snap: boolean; keep: boolean }>('measure');
  const last = useMeasureStore((s) => s.last);
  const units = useStore((s) => s.prefs.units);
  return (
    <Row gap={10}>
      <Checkbox checked={!!opts.snap} onChange={(v) => set({ snap: v })} label="Snap" />
      <Checkbox checked={!!opts.keep} onChange={(v) => set({ keep: v })} label="Keep last measurement" />
      {last ? (
        <span className="mono small" data-testid="measure-readout">
          D {formatLength(last.distance, units)} · W {formatLength(Math.abs(last.dx), units)} · H {formatLength(Math.abs(last.dy), units)} · ∠ {last.angle.toFixed(1)}°
        </span>
      ) : (
        <span className="muted small">Drag between two points.</span>
      )}
      {last && (
        <Button small onClick={() => useMeasureStore.getState().set(null)}>
          Clear
        </Button>
      )}
    </Row>
  );
}

void React;
