/**
 * Eraser tool (Shift+E): drag to erase. The drag is expanded to a round-capped
 * stroke area that is subtracted from every filled closed path it touches
 * (selected paths only when a selection exists); open / unfilled paths are
 * split where they run through the area. Alt-drag erases a rectangular
 * marquee, Shift constrains to straight lines. Applied once on release.
 */
import React from 'react';
import { Eraser } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, SubPath, Vec, PathNode } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { shallow } from 'zustand/shallow';
import { worldSubPaths, worldBounds } from '@/model/document';
import { pathBounds, transformSubPaths } from '@/geometry/path';
import { rectSubPath } from '@/geometry/shapes';
import { translate } from '@/geometry/matrix';
import { booleanOp, pathArea } from '@/geometry/paperBridge';
import { useToolOptions } from '@/canvas/toolContext';
import { StrokeSampler, constrainTo45 } from '../freehand/sampling';
import { strokeArea } from '../freehand/fit';
import { insideIntervals, eraseIntervals } from '../freehand/cut';
import { replaceNodeGeometry, erasableTargets, rectsIntersect } from '../freehand/apply';
import { circleCursor, circleCursorIsFallback } from '../freehand/cursors';
import { AreaPreview, CirclePreview, RectPreview, toScreen } from '../freehand/preview';
import { OptionSlider, OptionCheck, OptionsRow } from '../freehand/options';
import { stepSize } from '../brush/tool';

export type EraserOptions = {
  diameter: number;
  split: boolean;
}

const DEFAULTS: EraserOptions = { diameter: 20, split: true };

type Gesture = { kind: 'stroke'; sampler: StrokeSampler } | { kind: 'marquee'; start: Vec; current: Vec };

let gesture: Gesture | null = null;
let pointer: Vec | null = null;
let unsubscribe: (() => void) | null = null;

/** Options read from the store directly (ctx.options() would return the temporary tool's while Space is held). */
function currentOptions(): EraserOptions {
  return { ...DEFAULTS, ...(getState().toolOptions.eraser ?? {}) } as EraserOptions;
}

function updateCursor(ctx: ToolContext) {
  const s = ctx.state;
  if (s.temporaryTool) return;
  ctx.setCursor(circleCursor(currentOptions().diameter * s.zoom));
}

function marqueeCorner(start: Vec, p: Vec, square: boolean): Vec {
  if (!square) return p;
  const dx = p.x - start.x;
  const dy = p.y - start.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + Math.sign(dx || 1) * m, y: start.y + Math.sign(dy || 1) * m };
}

/**
 * Subtract a world-space area from the erasable paths. Filled closed paths use
 * a boolean subtract; everything else is split where it runs through the area.
 * Returns the ids of the resulting nodes (or null when nothing changed).
 */
export function eraseArea(ctx: ToolContext, area: SubPath[], split: boolean): ID[] | null {
  const s = ctx.state;
  const areaBounds = pathBounds(area);
  if (!area.length || !areaBounds) return null;
  const { ids, fromSelection } = erasableTargets(s);
  const result: { ids: ID[]; changed: boolean } = { ids: [], changed: false };
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id] as PathNode | undefined;
      if (!n || n.type !== 'path') continue;
      const pad = n.stroke.paint.type !== 'none' ? n.stroke.width : 0;
      if (!rectsIntersect(worldBounds(d, id), areaBounds, pad)) {
        result.ids.push(id);
        continue;
      }
      const wsps = worldSubPaths(d, id).filter((sp) => sp.anchors.length >= 2);
      const closed = wsps.filter((sp) => sp.closed);
      const open = wsps.filter((sp) => !sp.closed);
      const filled = n.fill.type !== 'none' && closed.length > 0;
      const out: SubPath[] = [];
      let touched = false;
      if (filled) {
        let inter = 0;
        try {
          inter = pathArea(booleanOp('intersect', { subpaths: closed, fillRule: n.fillRule }, { subpaths: area, fillRule: 'nonzero' }));
        } catch {
          inter = 0;
        }
        if (inter > 1e-6) {
          touched = true;
          out.push(...booleanOp('subtract', { subpaths: closed, fillRule: n.fillRule }, { subpaths: area, fillRule: 'nonzero' }));
        } else out.push(...closed);
      } else {
        for (const sp of closed) {
          const iv = insideIntervals(sp, area);
          if (iv.length) {
            touched = true;
            out.push(...eraseIntervals(sp, iv));
          } else out.push(sp);
        }
      }
      for (const sp of open) {
        const iv = insideIntervals(sp, area);
        if (iv.length) {
          touched = true;
          out.push(...eraseIntervals(sp, iv));
        } else out.push(sp);
      }
      if (!touched) {
        result.ids.push(id);
        continue;
      }
      result.changed = true;
      result.ids.push(...replaceNodeGeometry(d, id, out, split));
    }
  });
  if (!result.changed) return null;
  ctx.commit('Erase');
  if (fromSelection) s.setSelection(result.ids);
  return result.ids;
}

function finish(ctx: ToolContext, g: Gesture) {
  const opts = ctx.options<EraserOptions>();
  let area: SubPath[] = [];
  if (g.kind === 'marquee') {
    const x = Math.min(g.start.x, g.current.x);
    const y = Math.min(g.start.y, g.current.y);
    const w = Math.abs(g.start.x - g.current.x);
    const h = Math.abs(g.start.y - g.current.y);
    if (w < 0.5 || h < 0.5) return;
    area = transformSubPaths([rectSubPath(w, h)], translate(x, y));
  } else {
    g.sampler.endStraight();
    area = strokeArea(g.sampler.points(), opts.diameter, 1);
  }
  eraseArea(ctx, area, opts.split);
}

export const eraserTool: Tool = {
  id: 'eraser',
  name: 'Eraser Tool',
  shortcut: 'shift+e',
  icon: Eraser,
  group: 'edit',
  order: 610,
  cursor: 'crosshair',
  hint: 'Drag to erase. Alt: rectangular marquee. Shift: straight lines. [ and ] change the size.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: EraserOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    pointer = null;
    updateCursor(ctx);
    unsubscribe?.();
    unsubscribe = useStore.subscribe(
      (s) => [s.zoom, s.toolOptions.eraser?.diameter, s.temporaryTool] as const,
      () => updateCursor(ctx),
      { equalityFn: shallow },
    );
  },
  deactivate(ctx) {
    unsubscribe?.();
    unsubscribe = null;
    if (gesture) ctx.state.revert();
    gesture = null;
    pointer = null;
  },
  isBusy: () => !!gesture,
  cancel(ctx) {
    gesture = null;
    ctx.state.revert();
    ctx.requestOverlay();
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    pointer = e.screen;
    if (e.alt) {
      gesture = { kind: 'marquee', start: e.world, current: e.world };
    } else {
      const sampler = new StrokeSampler(1 / ctx.zoom);
      sampler.add(e.world, e.pressure);
      if (e.shift) sampler.beginStraight(e.world, e.pressure);
      gesture = { kind: 'stroke', sampler };
    }
    ctx.setStatus('Erasing');
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    pointer = e.screen;
    const g = gesture;
    if (!g) {
      if (circleCursorIsFallback(ctx.options<EraserOptions>().diameter * ctx.zoom)) ctx.requestOverlay();
      return;
    }
    if (g.kind === 'marquee') {
      g.current = marqueeCorner(g.start, e.world, e.shift);
    } else {
      const sm = g.sampler;
      if (e.shift && !sm.inStraight) sm.beginStraight(sm.last() ?? e.world, e.pressure);
      else if (!e.shift && sm.inStraight) sm.endStraight();
      const from = sm.straightStart();
      sm.add(from ? constrainTo45(from, e.world) : e.world, e.pressure);
    }
    ctx.requestOverlay();
  },

  onModifiers(e, ctx) {
    const g = gesture;
    if (!g || g.kind !== 'stroke') return;
    const sm = g.sampler;
    const last = sm.last();
    if (e.shift && !sm.inStraight && last) sm.beginStraight(last, last.pressure);
    else if (!e.shift && sm.inStraight) sm.endStraight();
    ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.kind === 'marquee') g.current = marqueeCorner(g.start, e.world, e.shift);
    else {
      const from = g.sampler.straightStart();
      g.sampler.add(from ? constrainTo45(from, e.world) : e.world, e.pressure);
    }
    ctx.setStatus('');
    ctx.requestOverlay();
    finish(ctx, g);
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture) {
      this.cancel!(ctx);
      return true;
    }
    if ((e.key === '[' || e.key === ']') && !e.primary) {
      const opts = ctx.options<EraserOptions>();
      ctx.setOptions({ diameter: stepSize(opts.diameter, e.key === ']' ? 1 : -1, 1, 200) });
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const opts = ctx.options<EraserOptions>();
    const d = opts.diameter * ctx.zoom;
    const g = gesture;
    const circle = pointer && circleCursorIsFallback(d) && (!g || g.kind === 'stroke') ? <CirclePreview center={pointer} diameter={d} /> : null;
    if (!g) return circle;
    if (g.kind === 'marquee') return <RectPreview a={ctx.worldToScreen(g.start)} b={ctx.worldToScreen(g.current)} />;
    return (
      <g className="eraser-preview">
        <AreaPreview points={toScreen(ctx, g.sampler.points())} diameter={d} />
        {circle}
      </g>
    );
  },
};

function EraserOptionsBar() {
  const [o, set] = useToolOptions<EraserOptions>('eraser');
  return (
    <OptionsRow>
      <OptionSlider label="Diameter" value={o.diameter} min={1} max={200} unit="px" onChange={(v) => set({ diameter: Math.round(v) })} title="Eraser diameter ([ and ] adjust it)" />
      <OptionCheck label="Split into separate paths" checked={o.split} onChange={(v) => set({ split: v })} title="When a shape is cut apart, make each piece its own path" />
      <span className="muted small">Alt: marquee · Shift: straight</span>
    </OptionsRow>
  );
}

export const tool = eraserTool;
void React;
