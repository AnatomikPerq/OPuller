/**
 * Freeform gradient editing inside the Gradient tool: points are dragged on
 * the object, a click on the object adds a point, the small ring handle sets
 * the spread, Delete removes the selected point and double-click opens the
 * colour popover.
 */
import React from 'react';
import type { ToolContext, ToolPointerEvent, ToolKeyEvent } from '../types';
import type { FreeformGradientPaint, ID, Vec } from '@/model/types';
import { appearanceTargets, setFillPaint, setStrokePaint } from '@/commands/appearance';
import { gradientFrame, bboxToWorld, worldToBbox, type GradientFrame } from '@/color/annotator';
import { nodeScreenOutline } from '@/canvas/SelectionOverlay';
import { addFreeformPoint, removeFreeformPoint, moveFreeformPoint, updateFreeformPoint, nearestFreeformPoint } from '@/gradients/freeform';
import { useGradientToolStore } from './state';
import { GRADIENT_CURSOR } from './cursors';

interface Model {
  id: ID;
  target: 'fill' | 'stroke';
  frame: GradientFrame;
  paint: FreeformGradientPaint;
}

type Gesture = { kind: 'none' } | { kind: 'point'; index: number; model: Model; moved: boolean; start: Vec } | { kind: 'spread'; index: number; model: Model };

let gesture: Gesture = { kind: 'none' };

function paintOf(ctx: ToolContext, id: ID, target: 'fill' | 'stroke') {
  const n = ctx.doc.nodes[id];
  if (!n || (n.type !== 'path' && n.type !== 'text')) return null;
  return target === 'fill' ? n.fill : n.stroke.paint;
}

function modelOf(ctx: ToolContext): Model | null {
  const s = ctx.state;
  const targets = appearanceTargets(s.selection);
  const target = s.activePaintTarget;
  for (const id of targets) {
    const p = paintOf(ctx, id, target);
    if (p && p.type === 'freeform') {
      const frame = gradientFrame(s.doc, id);
      if (frame) return { id, target, frame, paint: p };
    }
  }
  return null;
}

/** Whether the gradient tool should run in freeform mode (the active paint is freeform). */
export function freeformActive(ctx: ToolContext): boolean {
  return gesture.kind !== 'none' || !!modelOf(ctx);
}

function apply(m: Model, paint: FreeformGradientPaint, commit: boolean): void {
  if (m.target === 'fill') setFillPaint(paint, commit);
  else setStrokePaint(paint, commit);
}

function screenOf(ctx: ToolContext, m: Model, p: { x: number; y: number }): Vec {
  return ctx.worldToScreen(bboxToWorld(m.frame, p.x, p.y));
}

/** Spread ring radius in screen px (bbox spread × the smaller object side). */
function spreadRadius(ctx: ToolContext, m: Model, spread: number): number {
  const w = m.frame.bounds.width * Math.hypot(m.frame.wm.a, m.frame.wm.b) * ctx.zoom;
  const h = m.frame.bounds.height * Math.hypot(m.frame.wm.c, m.frame.wm.d) * ctx.zoom;
  return Math.max(6, spread * Math.min(w, h));
}

function hitPoint(ctx: ToolContext, m: Model, screen: Vec, tol: number): { kind: 'point' | 'spread'; index: number } | null {
  const active = Math.max(0, Math.min(m.paint.points.length - 1, ctx.state.activeGradientStop));
  // spread handle of the active point sits on its ring, to the right
  const ap = m.paint.points[active];
  if (ap) {
    const c = screenOf(ctx, m, ap);
    const r = spreadRadius(ctx, m, ap.spread);
    if (Math.hypot(c.x + r - screen.x, c.y - screen.y) <= tol) return { kind: 'spread', index: active };
  }
  let best: { index: number; d: number } | null = null;
  m.paint.points.forEach((p, i) => {
    const c = screenOf(ctx, m, p);
    const d = Math.hypot(c.x - screen.x, c.y - screen.y);
    if (d <= tol + 2 && (!best || d < best.d)) best = { index: i, d };
  });
  return best ? { kind: 'point', index: (best as { index: number }).index } : null;
}

export const freeformHandlers = {
  isBusy: () => gesture.kind !== 'none',
  cancel(ctx: ToolContext) {
    gesture = { kind: 'none' };
    ctx.state.revert();
    ctx.requestOverlay();
  },
  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    const s = ctx.state;
    useGradientToolStore.getState().setPopover(null);
    const m = modelOf(ctx);
    if (!m) return;
    const tol = Math.max(6, s.prefs.handleSize);
    const hit = hitPoint(ctx, m, e.screen, tol);
    if (hit) {
      s.setActiveGradientStop(hit.index);
      gesture = hit.kind === 'point' ? { kind: 'point', index: hit.index, model: m, moved: false, start: e.screen } : { kind: 'spread', index: hit.index, model: m };
      ctx.setCursor('move');
      return;
    }
    // click inside the object adds a point; elsewhere selects another object
    const h = ctx.hitTest(e.world);
    if (h && (h.target === m.id || h.id === m.id || s.selection.includes(h.target))) {
      const uv = worldToBbox(m.frame, e.world);
      const r = addFreeformPoint(m.paint, { x: uv.u, y: uv.v });
      apply(m, r.paint, true);
      s.setActiveGradientStop(r.index);
      gesture = { kind: 'point', index: r.index, model: { ...m, paint: r.paint }, moved: false, start: e.screen };
      return;
    }
    if (h && !s.selection.includes(h.target)) s.setSelection([h.target]);
  },
  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    const g = gesture;
    if (g.kind === 'none') {
      const m = modelOf(ctx);
      if (!m) return;
      const hit = hitPoint(ctx, m, e.screen, Math.max(6, ctx.state.prefs.handleSize));
      ctx.setCursor(hit ? 'move' : GRADIENT_CURSOR);
      useGradientToolStore.getState().setHover(hit ? `${hit.kind}-${hit.index}` : null);
      return;
    }
    const m = g.model;
    const uv = worldToBbox(m.frame, e.world);
    if (g.kind === 'point') {
      if (!g.moved && Math.hypot(e.screen.x - g.start.x, e.screen.y - g.start.y) < 2) return;
      g.moved = true;
      const cur = paintOf(ctx, m.id, m.target);
      if (!cur || cur.type !== 'freeform') return;
      apply(m, moveFreeformPoint(cur, g.index, { x: uv.u, y: uv.v }), false);
      return;
    }
    if (g.kind === 'spread') {
      const cur = paintOf(ctx, m.id, m.target);
      if (!cur || cur.type !== 'freeform') return;
      const p = cur.points[g.index];
      const c = screenOf(ctx, m, p);
      const px = Math.hypot(e.screen.x - c.x, e.screen.y - c.y);
      const w = m.frame.bounds.width * Math.hypot(m.frame.wm.a, m.frame.wm.b) * ctx.zoom;
      const h = m.frame.bounds.height * Math.hypot(m.frame.wm.c, m.frame.wm.d) * ctx.zoom;
      const spread = Math.max(0.02, Math.min(3, px / Math.max(1, Math.min(w, h))));
      apply(m, updateFreeformPoint(cur, g.index, { spread }), false);
    }
  },
  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext) {
    const g = gesture;
    gesture = { kind: 'none' };
    if (g.kind === 'none') return;
    if (g.kind === 'point' && !g.moved) {
      ctx.setCursor(GRADIENT_CURSOR);
      ctx.requestOverlay();
      return;
    }
    ctx.commit(g.model.target === 'fill' ? 'Freeform Gradient' : 'Freeform Gradient Stroke');
    ctx.setCursor(GRADIENT_CURSOR);
    ctx.requestOverlay();
  },
  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext) {
    const m = modelOf(ctx);
    if (!m) return;
    const hit = hitPoint(ctx, m, e.screen, Math.max(6, ctx.state.prefs.handleSize));
    if (!hit) return;
    ctx.state.setActiveGradientStop(hit.index);
    useGradientToolStore.getState().setPopover({ index: hit.index, screen: e.screen });
  },
  onKeyDown(e: ToolKeyEvent, ctx: ToolContext): boolean {
    if (e.key === 'Escape') {
      if (gesture.kind !== 'none') {
        this.cancel(ctx);
        return true;
      }
      if (useGradientToolStore.getState().popover) {
        useGradientToolStore.getState().setPopover(null);
        return true;
      }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && gesture.kind === 'none') {
      const m = modelOf(ctx);
      const hover = useGradientToolStore.getState().hover;
      if (m && m.paint.points.length > 1 && hover && hover.startsWith('point-')) {
        const idx = Number(hover.slice(6));
        apply(m, removeFreeformPoint(m.paint, idx), true);
        ctx.state.setActiveGradientStop(Math.max(0, Math.min(idx, m.paint.points.length - 2)));
        useGradientToolStore.getState().setHover(null);
        return true;
      }
    }
    return false;
  },
  renderOverlay(ctx: ToolContext) {
    const s = ctx.state;
    const m = modelOf(ctx);
    const outlines = s.selection.map((id) => {
      const d = nodeScreenOutline(s, id);
      return d ? <path key={id} className="ga-outline" d={d} /> : null;
    });
    if (!m) return <g className="gradient-annotator">{outlines}</g>;
    const active = Math.max(0, Math.min(m.paint.points.length - 1, s.activeGradientStop));
    const hover = useGradientToolStore.getState().hover;
    const hs = Math.max(5, s.prefs.handleSize - 1);
    const lines = m.paint.mode === 'lines' && m.paint.lines ? m.paint.lines : [];
    return (
      <g className="gradient-annotator freeform" data-testid="freeform-annotator">
        {outlines}
        {lines.map((line, li) => {
          const pts = line.map((i) => m.paint.points[i]).filter(Boolean).map((p) => screenOf(ctx, m, p));
          if (pts.length < 2) return null;
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
          return <path key={li} className="ga-line" d={d} fill="none" />;
        })}
        {m.paint.points.map((p, i) => {
          const c = screenOf(ctx, m, p);
          const r = spreadRadius(ctx, m, p.spread);
          const isActive = i === active;
          return (
            <g key={i} data-testid={`freeform-annotator-point-${i}`}>
              {isActive && <circle className="ga-ellipse" cx={c.x} cy={c.y} r={r} />}
              <circle className={`ga-handle ${hover === `point-${i}` ? 'hover' : ''} ${isActive ? 'active' : ''}`} cx={c.x} cy={c.y} r={hs / 2 + 2} fill={p.color} fillOpacity={p.opacity} />
              {isActive && <circle className={`ga-handle ${hover === `spread-${i}` ? 'hover' : ''}`} cx={c.x + r} cy={c.y} r={3.5} fill="#fff" data-testid="freeform-annotator-spread" />}
            </g>
          );
        })}
      </g>
    );
  },
};

void nearestFreeformPoint;
