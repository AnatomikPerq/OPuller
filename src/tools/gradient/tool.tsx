/**
 * Gradient tool (G): draws the gradient annotator over the selected object
 * (fill or stroke, per the active paint target) and lets the user drag a new
 * gradient direction, move the endpoints / centre / radius / focal point, drag
 * stop markers along the line, click the line to add a stop and double-click
 * a stop to edit its colour. Live edits go through setFillPaint/setStrokePaint
 * (commit=false) and are committed on pointer-up as one history step.
 */
import React from 'react';
import { Blend, FlipHorizontal2 } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { ID, Vec, GradientPaint, RadialGradientPaint, LinearGradientPaint } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { localBounds } from '@/model/document';
import { setFillPaint, setStrokePaint, useCurrentAppearance } from '@/commands/appearance';
import { applyActivePaint } from '@/color/apply';
import { nodeScreenOutline } from '@/canvas/SelectionOverlay';
import { useToolOptions } from '@/canvas/toolContext';
import { Row, Segmented, IconButton, NumberField, Tooltip } from '@/ui/widgets';
import { bboxToWorld, worldToBbox, radialRadiusFromWorld, clampFocal, type GradientFrame } from '@/color/annotator';
import { toGradient, convertGradientType, updateStop, removeStop, addStopAt, reverseGradient, clamp01, linearAngle, withLinearAngle } from '@/color/gradient';
import { isGradient, clampStopIndex } from '@/color/paint';
import { defaultFreeform } from '@/gradients/freeform';
import { buildAnnotator, hitAnnotator, projectOnSegment, constrainTo45, type AnnotatorModel, type AnnotatorHit } from './model';
import { useGradientToolStore } from './state';
import { GRADIENT_CURSOR } from './cursors';
import { freeformActive, freeformHandlers } from './freeform';
import './gradient-tool.css';

type Gesture =
  | { kind: 'none' }
  | { kind: 'pending'; startScreen: Vec; startWorld: Vec; hit: AnnotatorHit; model: AnnotatorModel | null }
  | { kind: 'draw'; startScreen: Vec; startWorld: Vec; model: AnnotatorModel; base: GradientPaint }
  | { kind: 'handle'; which: 'start' | 'end' | 'center' | 'radius' | 'focal'; model: AnnotatorModel; base: GradientPaint; startScreen: Vec }
  | { kind: 'stop'; index: number; model: AnnotatorModel; base: GradientPaint; removing: boolean; startScreen: Vec; moved: boolean };

let gesture: Gesture = { kind: 'none' };

export function gradientGesture(): Gesture {
  return gesture;
}

function applyPaint(model: AnnotatorModel, paint: GradientPaint, commit: boolean): void {
  if (model.target === 'fill') setFillPaint(paint, commit);
  else setStrokePaint(paint, commit);
}

function commitLabel(model: AnnotatorModel): string {
  return model.target === 'fill' ? 'Gradient Fill' : 'Gradient Stroke';
}

/** Gradient to start a drag from: the current gradient or the solid converted with the tool's type. */
function baseGradient(model: AnnotatorModel, ctx: ToolContext): GradientPaint {
  const opts = ctx.options<{ type: 'linear' | 'radial' }>();
  if (model.paint) return model.paint;
  return toGradient(model.rawPaint, opts.type === 'radial' ? 'radial' : 'linear', ctx.state.activeGradientStop);
}

/** Screen endpoints (start/end or centre/radius) for a gradient in a frame. */
function lineEnds(frame: GradientFrame, g: GradientPaint, ctx: ToolContext): { a: Vec; b: Vec } {
  if (g.type === 'linear') return { a: ctx.worldToScreen(bboxToWorld(frame, g.x1, g.y1)), b: ctx.worldToScreen(bboxToWorld(frame, g.x2, g.y2)) };
  return { a: ctx.worldToScreen(bboxToWorld(frame, g.cx, g.cy)), b: ctx.worldToScreen(bboxToWorld(frame, g.cx + g.r, g.cy)) };
}

function setCursorForHit(ctx: ToolContext, hit: AnnotatorHit): void {
  if (!hit) ctx.setCursor(GRADIENT_CURSOR);
  else if (hit.kind === 'line') ctx.setCursor('copy');
  else ctx.setCursor('move');
}

function model(ctx: ToolContext): AnnotatorModel | null {
  return buildAnnotator(ctx.state, (p) => ctx.worldToScreen(p));
}

export const gradientTool: Tool = {
  id: 'gradient',
  name: 'Gradient Tool',
  shortcut: 'g',
  icon: Blend,
  group: 'edit',
  order: 620,
  cursor: GRADIENT_CURSOR,
  hint: 'Drag across the object to set the gradient direction. Drag the endpoints or stops to adjust; click the line to add a stop; double-click a stop to edit its colour. Shift constrains the angle.',
  showSelectionOverlay: false,
  defaults: { type: 'linear' },
  Options: GradientToolOptions,

  activate() {
    gesture = { kind: 'none' };
  },
  deactivate(ctx) {
    if (gesture.kind === 'draw' || gesture.kind === 'handle' || gesture.kind === 'stop') ctx.state.revert();
    gesture = { kind: 'none' };
    useGradientToolStore.getState().setPopover(null);
    useGradientToolStore.getState().setHover(null);
    ctx.state.setHover(null);
  },
  isBusy: () => gesture.kind === 'draw' || gesture.kind === 'handle' || gesture.kind === 'stop' || freeformHandlers.isBusy(),
  cancel(ctx) {
    if (freeformHandlers.isBusy()) return freeformHandlers.cancel(ctx);
    if (gesture.kind === 'draw' || gesture.kind === 'handle' || gesture.kind === 'stop') ctx.state.revert();
    gesture = { kind: 'none' };
    ctx.setCursor(GRADIENT_CURSOR);
    ctx.requestOverlay();
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    if (freeformActive(ctx)) return freeformHandlers.onPointerDown(e, ctx);
    const s = ctx.state;
    useGradientToolStore.getState().setPopover(null);
    const m = model(ctx);
    const hit = hitAnnotator(m, e.screen, Math.max(6, s.prefs.handleSize));
    if (m && m.paint && hit && hit.kind !== 'line') {
      if (hit.kind === 'stop') {
        s.setActiveGradientStop(hit.index);
        gesture = { kind: 'stop', index: hit.index, model: m, base: m.paint, removing: false, startScreen: e.screen, moved: false };
      } else {
        gesture = { kind: 'handle', which: hit.kind, model: m, base: m.paint, startScreen: e.screen };
      }
      ctx.setCursor('move');
      return;
    }
    gesture = { kind: 'pending', startScreen: e.screen, startWorld: e.world, hit, model: m };
  },

  onPointerMove(e, ctx) {
    if (freeformActive(ctx) && gesture.kind === 'none') return freeformHandlers.onPointerMove(e, ctx);
    const s = ctx.state;
    const g = gesture;
    if (g.kind === 'none') {
      const m = model(ctx);
      const hit = hitAnnotator(m, e.screen, Math.max(6, s.prefs.handleSize));
      setCursorForHit(ctx, hit);
      useGradientToolStore.getState().setHover(hit ? (hit.kind === 'stop' ? `stop-${hit.index}` : hit.kind) : null);
      if (!hit) {
        const h = ctx.hitTest(e.world);
        s.setHover(h && !s.selection.includes(h.target) ? h.target : null);
      } else s.setHover(null);
      return;
    }
    if (g.kind === 'pending') {
      if (Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y) < 3) return;
      if (!g.model) return; // nothing selected: nothing to draw on
      const base = baseGradient(g.model, ctx);
      gesture = { kind: 'draw', startScreen: g.startScreen, startWorld: g.startWorld, model: g.model, base };
      ctx.setCursor(GRADIENT_CURSOR);
      this.onPointerMove!(e, ctx);
      return;
    }
    if (g.kind === 'draw') {
      const p = e.shift ? constrainTo45(g.startScreen, e.screen) : e.screen;
      const world = ctx.screenToWorld(p);
      const a = worldToBbox(g.model.frame, g.startWorld);
      const b = worldToBbox(g.model.frame, world);
      let paint: GradientPaint;
      if (g.base.type === 'linear') paint = { ...g.base, x1: a.u, y1: a.v, x2: b.u, y2: b.v };
      else {
        const r = Math.max(0.001, Math.hypot(b.u - a.u, b.v - a.v));
        const rad: RadialGradientPaint = { type: 'radial', cx: a.u, cy: a.v, r, stops: g.base.stops, spread: g.base.spread };
        paint = rad;
      }
      applyPaint(g.model, paint, false);
      return;
    }
    if (g.kind === 'handle') {
      const f = g.model.frame;
      const base = g.base;
      if (base.type === 'linear') {
        const other = g.which === 'start' ? ctx.worldToScreen(bboxToWorld(f, base.x2, base.y2)) : ctx.worldToScreen(bboxToWorld(f, base.x1, base.y1));
        const p = e.shift ? constrainTo45(other, e.screen) : e.screen;
        const uv = worldToBbox(f, ctx.screenToWorld(p));
        const paint: LinearGradientPaint = g.which === 'start' ? { ...base, x1: uv.u, y1: uv.v } : { ...base, x2: uv.u, y2: uv.v };
        applyPaint(g.model, paint, false);
        return;
      }
      const rb = base;
      if (g.which === 'center') {
        const centerScreen = ctx.worldToScreen(bboxToWorld(f, rb.cx, rb.cy));
        const p = e.shift ? constrainTo45(centerScreen, e.screen) : e.screen;
        const uv = worldToBbox(f, ctx.screenToWorld(p));
        if (e.alt) {
          const fc = clampFocal(rb, uv.u, uv.v);
          applyPaint(g.model, { ...rb, fx: fc.fx, fy: fc.fy }, false);
        } else {
          const dx = uv.u - rb.cx;
          const dy = uv.v - rb.cy;
          const next: RadialGradientPaint = { ...rb, cx: uv.u, cy: uv.v };
          if (rb.fx !== undefined) next.fx = rb.fx + dx;
          if (rb.fy !== undefined) next.fy = rb.fy + dy;
          applyPaint(g.model, next, false);
        }
        return;
      }
      if (g.which === 'radius') {
        const center = bboxToWorld(f, rb.cx, rb.cy);
        const r = Math.max(0.001, radialRadiusFromWorld(f, center, e.world));
        const next: RadialGradientPaint = { ...rb, r };
        if (rb.fx !== undefined || rb.fy !== undefined) {
          const fc = clampFocal(next, rb.fx ?? rb.cx, rb.fy ?? rb.cy);
          next.fx = fc.fx;
          next.fy = fc.fy;
        }
        applyPaint(g.model, next, false);
        return;
      }
      if (g.which === 'focal') {
        const uv = worldToBbox(f, e.world);
        const fc = clampFocal(rb, uv.u, uv.v);
        applyPaint(g.model, { ...rb, fx: fc.fx, fy: fc.fy }, false);
        return;
      }
      return;
    }
    if (g.kind === 'stop') {
      if (!g.moved && Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y) < 2) return;
      g.moved = true;
      const { a, b } = lineEnds(g.model.frame, g.base, ctx);
      const pr = projectOnSegment(a, b, e.screen);
      const removing = g.base.stops.length > 2 && pr.distance > 30;
      g.removing = removing;
      if (!removing) applyPaint(g.model, updateStop(g.base, g.index, { offset: clamp01(pr.t) }), false);
      else ctx.state.revert();
      ctx.requestOverlay();
      return;
    }
  },

  onPointerUp(e, ctx) {
    if (freeformActive(ctx) && gesture.kind === 'none') return freeformHandlers.onPointerUp(e, ctx);
    const s = ctx.state;
    const g = gesture;
    gesture = { kind: 'none' };
    if (g.kind === 'pending') {
      // click without drag
      if (g.model && g.model.paint && g.hit && g.hit.kind === 'line') {
        const { paint, index } = addStopAt(g.model.paint, g.hit.t);
        applyPaint(g.model, paint, true);
        s.setActiveGradientStop(index);
        return;
      }
      const hit = ctx.hitTest(e.world);
      if (hit && !s.selection.includes(hit.target)) {
        s.setSelection([hit.target]);
        s.setHover(null);
      }
      return;
    }
    if (g.kind === 'draw') {
      ctx.commit(commitLabel(g.model));
      s.setActiveGradientStop(0);
      ctx.setCursor(GRADIENT_CURSOR);
      return;
    }
    if (g.kind === 'handle') {
      ctx.commit(commitLabel(g.model));
      ctx.setCursor(GRADIENT_CURSOR);
      return;
    }
    if (g.kind === 'stop') {
      if (g.removing) {
        applyPaint(g.model, removeStop(g.base, g.index), true);
        s.setActiveGradientStop(Math.max(0, Math.min(g.index, g.base.stops.length - 2)));
      } else if (g.moved) ctx.commit(commitLabel(g.model));
      ctx.setCursor(GRADIENT_CURSOR);
      ctx.requestOverlay();
      return;
    }
  },

  onDoubleClick(e, ctx) {
    if (freeformActive(ctx)) return freeformHandlers.onDoubleClick(e, ctx);
    const s = ctx.state;
    const m = model(ctx);
    if (!m || !m.paint) return;
    const hit = hitAnnotator(m, e.screen, Math.max(6, s.prefs.handleSize));
    if (!hit) return;
    if (hit.kind === 'stop' || hit.kind === 'start' || hit.kind === 'end' || hit.kind === 'center' || hit.kind === 'radius') {
      // endpoint handles sit on the first/last stop: edit the stop nearest to that end
      let index: number;
      if (hit.kind === 'stop') index = hit.index;
      else {
        const want = hit.kind === 'start' || hit.kind === 'center' ? 0 : 1;
        index = m.paint.stops.reduce((best, st, i, arr) => (Math.abs(st.offset - want) < Math.abs(arr[best].offset - want) ? i : best), 0);
      }
      s.setActiveGradientStop(index);
      useGradientToolStore.getState().setPopover({ index, screen: e.screen });
    } else if (hit.kind === 'line') {
      // the single click already added a stop; open its editor
      const idx = clampStopIndex(m.paint, s.activeGradientStop);
      useGradientToolStore.getState().setPopover({ index: idx, screen: e.screen });
    }
  },

  onKeyDown(e, ctx) {
    if (freeformActive(ctx)) {
      const r = freeformHandlers.onKeyDown(e, ctx);
      if (r) return true;
    }
    if (e.key === 'Escape') {
      if (this.isBusy!()) {
        this.cancel!(ctx);
        return true;
      }
      if (useGradientToolStore.getState().popover) {
        useGradientToolStore.getState().setPopover(null);
        return true;
      }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !this.isBusy!()) {
      // delete the active stop when hovering the annotator (otherwise the object is deleted)
      const m = model(ctx);
      const hover = useGradientToolStore.getState().hover;
      if (m && m.paint && hover && hover.startsWith('stop-') && m.paint.stops.length > 2) {
        const idx = Number(hover.slice(5));
        applyPaint(m, removeStop(m.paint, idx), true);
        ctx.state.setActiveGradientStop(Math.max(0, Math.min(idx, m.paint.stops.length - 2)));
        useGradientToolStore.getState().setHover(null);
        return true;
      }
    }
    return false;
  },

  renderOverlay(ctx) {
    if (freeformActive(ctx)) return freeformHandlers.renderOverlay(ctx);
    const s = ctx.state;
    const m = model(ctx);
    if (!m) return null;
    const g = gesture;
    const hover = useGradientToolStore.getState().hover;
    const outlines = s.selection.map((id: ID) => {
      const d = nodeScreenOutline(s, id);
      return d ? <path key={id} className="ga-outline" d={d} /> : null;
    });
    if (!m.paint || !m.start || !m.end) {
      return <g className="gradient-annotator">{outlines}</g>;
    }
    const activeStop = clampStopIndex(m.paint, s.activeGradientStop);
    const hs = Math.max(5, s.prefs.handleSize - 1);
    const removingIndex = g.kind === 'stop' && g.removing ? g.index : -1;
    const a = m.start;
    const b = m.end;
    return (
      <g className="gradient-annotator" data-testid="gradient-annotator">
        {outlines}
        {m.paint.type === 'radial' && m.ellipsePath && <path className="ga-ellipse" d={m.ellipsePath} />}
        <line className="ga-line-shadow" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <line className="ga-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        {m.stops.map((st) => (
          <g key={st.index} transform={`translate(${st.screen.x} ${st.screen.y}) rotate(45)`} data-testid={`gradient-annotator-stop-${st.index}`}>
            <rect className={`ga-stop ${st.index === activeStop ? 'active' : ''} ${st.index === removingIndex ? 'removing' : ''} ${hover === `stop-${st.index}` ? 'hover' : ''}`} x={-hs / 2} y={-hs / 2} width={hs} height={hs} fill="#fff" />
            <rect className={`ga-stop ${st.index === activeStop ? 'active' : ''} ${st.index === removingIndex ? 'removing' : ''}`} x={-hs / 2} y={-hs / 2} width={hs} height={hs} fill={st.color} fillOpacity={st.opacity} />
          </g>
        ))}
        {m.paint.type === 'linear' ? (
          <>
            <circle className={`ga-handle ${hover === 'start' ? 'hover' : ''}`} cx={a.x} cy={a.y} r={hs / 2 + 1} data-testid="gradient-annotator-start" />
            <rect className={`ga-handle ${hover === 'end' ? 'hover' : ''}`} x={b.x - hs / 2 - 1} y={b.y - hs / 2 - 1} width={hs + 2} height={hs + 2} data-testid="gradient-annotator-end" />
          </>
        ) : (
          <>
            <circle className={`ga-handle ${hover === 'center' ? 'hover' : ''}`} cx={a.x} cy={a.y} r={hs / 2 + 1} data-testid="gradient-annotator-center" />
            <rect className={`ga-handle ${hover === 'radius' ? 'hover' : ''}`} x={b.x - hs / 2 - 1} y={b.y - hs / 2 - 1} width={hs + 2} height={hs + 2} data-testid="gradient-annotator-radius" />
            {m.focal && (
              <g transform={`translate(${m.focal.x} ${m.focal.y}) rotate(45)`} data-testid="gradient-annotator-focal">
                <rect className={`ga-focal ${hover === 'focal' ? 'hover' : ''}`} x={-3} y={-3} width={6} height={6} />
              </g>
            )}
          </>
        )}
      </g>
    );
  },
};

function GradientToolOptions() {
  const app = useCurrentAppearance();
  const doc = useStore((s) => s.doc);
  const target = useStore((s) => s.activePaintTarget);
  const [opts, set] = useToolOptions<{ type: 'linear' | 'radial' | 'freeform' }>('gradient');
  const paint = target === 'fill' ? app.fill : app.stroke.paint;
  const g = isGradient(paint) ? paint : null;
  const type: 'linear' | 'radial' | 'freeform' = paint.type === 'freeform' ? 'freeform' : g ? g.type : opts.type === 'radial' ? 'radial' : opts.type === 'freeform' ? 'freeform' : 'linear';
  const id = app.targets[0];
  const b = id ? localBounds(doc, id) : null;
  const aspect = b && b.width > 1e-6 && b.height > 1e-6 ? b.width / b.height : 1;
  const label = target === 'fill' ? 'Fill' : 'Stroke';
  return (
    <Row gap={10}>
      <Segmented
        value={type}
        onChange={(t) => {
          set({ type: t });
          if (t === 'freeform') {
            if (paint.type !== 'freeform' && app.targets.length) applyActivePaint(defaultFreeform(paint), true);
            return;
          }
          if (paint.type === 'freeform' && app.targets.length) applyActivePaint(toGradient({ type: 'solid', color: paint.points[0]?.color ?? '#000000', opacity: 1 }, t), true);
          else if (g && g.type !== t) applyActivePaint(convertGradientType(g, t), true);
        }}
        options={[
          { value: 'linear', label: 'Linear', title: 'Linear gradient' },
          { value: 'radial', label: 'Radial', title: 'Radial gradient' },
          { value: 'freeform', label: 'Freeform', title: 'Freeform gradient (colour points)' },
        ]}
      />
      <Tooltip text="Reverse gradient">
        <IconButton icon={<FlipHorizontal2 size={14} />} disabled={!g} onClick={() => g && applyActivePaint(reverseGradient(g), true)} title="Reverse gradient" data-testid="gradient-tool-reverse" />
      </Tooltip>
      {g && g.type === 'linear' && (
        <NumberField
          label="Angle"
          value={Math.round(linearAngle(g, aspect) * 10) / 10}
          unit="deg"
          decimals={1}
          step={1}
          bigStep={15}
          width={110}
          onChange={(v) => applyActivePaint(withLinearAngle(g, v, aspect), false)}
          onCommit={() => getState().commit('Gradient')}
          data-testid="gradient-tool-angle"
        />
      )}
      <span className="muted">
        {app.targets.length ? (paint.type === 'freeform' ? `${label}: freeform — drag points, click to add, Delete removes` : g ? `${label}: ${g.type} gradient` : `${label}: drag to apply a ${type} gradient`) : 'Select an object to edit its gradient'}
      </span>
    </Row>
  );
}

export const tool = gradientTool;
void React;
