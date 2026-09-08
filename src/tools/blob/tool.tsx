/**
 * Blob Brush tool (Shift+B): paints a filled shape that merges with paths of
 * the same fill it touches (the selection only, when "Merge only with
 * selection" is on). Alt erases from those shapes instead.
 */
import React from 'react';
import { Droplet } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, SubPath, Vec, PathNode } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { shallow } from 'zustand/shallow';
import { worldSubPaths, worldBounds, removeNode } from '@/model/document';
import { noStroke } from '@/model/defaults';
import { pathBounds } from '@/geometry/path';
import { booleanOp, uniteAll, pathArea } from '@/geometry/paperBridge';
import { useToolOptions } from '@/canvas/toolContext';
import { StrokeSampler, smoothSamples } from '../freehand/sampling';
import { strokeArea } from '../freehand/fit';
import { addWorldPath, replaceNodeGeometry, selectedEditablePaths, allEditablePaths, paintEquals, rectsIntersect } from '../freehand/apply';
import { circleCursor, circleCursorIsFallback } from '../freehand/cursors';
import { AreaPreview, CirclePreview, previewColor, toScreen } from '../freehand/preview';
import { OptionSlider, OptionCheck, OptionsRow, PaintSourceOption } from '../freehand/options';
import { resolveBrushPaint, stepSize } from '../brush/tool';

export type BlobOptions = {
  size: number;
  mergeSelectionOnly: boolean;
  keepSelected: boolean;
  smoothing: number;
  paint: 'stroke' | 'fill';
}

const DEFAULTS: BlobOptions = { size: 20, mergeSelectionOnly: false, keepSelected: true, smoothing: 30, paint: 'stroke' };

interface Gesture {
  sampler: StrokeSampler;
  erase: boolean;
}

let gesture: Gesture | null = null;
let pointer: Vec | null = null;
let unsubscribe: (() => void) | null = null;

/** Options read from the store directly (ctx.options() would return the temporary tool's while Space is held). */
function currentOptions(): BlobOptions {
  return { ...DEFAULTS, ...(getState().toolOptions.blob ?? {}) } as BlobOptions;
}

function updateCursor(ctx: ToolContext) {
  const s = ctx.state;
  if (s.temporaryTool) return;
  ctx.setCursor(circleCursor(currentOptions().size * s.zoom));
}

function finish(ctx: ToolContext, g: Gesture) {
  const s = ctx.state;
  const opts = ctx.options<BlobOptions>();
  const pts = g.sampler.points();
  if (!pts.length) return;
  const passes = Math.round(opts.smoothing / 34);
  const smoothed = passes ? smoothSamples(pts, passes) : pts;
  const area = strokeArea(smoothed, opts.size, 0.5 + opts.smoothing * 0.05);
  const areaBounds = pathBounds(area);
  if (!area.length || !areaBounds) return;
  const paint = resolveBrushPaint(s, opts.paint);
  const pool = opts.mergeSelectionOnly ? selectedEditablePaths(s) : allEditablePaths(s);
  const candidates: ID[] = [];
  for (const id of pool) {
    const n = s.doc.nodes[id] as PathNode;
    if (!n || n.type !== 'path' || !paintEquals(n.fill, paint)) continue;
    if (!rectsIntersect(worldBounds(s.doc, id), areaBounds)) continue;
    const wsps = worldSubPaths(s.doc, id).filter((sp) => sp.closed);
    if (!wsps.length) continue;
    let touches = false;
    try {
      touches = pathArea(booleanOp('intersect', { subpaths: wsps, fillRule: n.fillRule }, { subpaths: area, fillRule: 'nonzero' })) > 1e-3;
    } catch {
      touches = false;
    }
    if (touches) candidates.push(id);
  }
  const result: { ids: ID[] } = { ids: [] };
  if (g.erase) {
    if (!candidates.length) return;
    s.updateDoc((d) => {
      for (const id of candidates) {
        const n = d.nodes[id] as PathNode;
        if (!n) continue;
        const wsps = worldSubPaths(d, id);
        const sub = booleanOp('subtract', { subpaths: wsps.filter((sp) => sp.closed), fillRule: n.fillRule }, { subpaths: area, fillRule: 'nonzero' });
        result.ids.push(...replaceNodeGeometry(d, id, sub.concat(wsps.filter((sp) => !sp.closed)), false));
      }
    }, 'Blob Brush Erase');
    if (s.selection.length) s.setSelection(result.ids);
    return;
  }
  if (candidates.length) {
    const target = candidates[candidates.length - 1]; // top-most
    const geoms = candidates.map((id) => {
      const n = s.doc.nodes[id] as PathNode;
      return { subpaths: worldSubPaths(s.doc, id).filter((sp) => sp.closed), fillRule: n.fillRule };
    });
    let union: SubPath[];
    try {
      union = uniteAll(geoms.concat([{ subpaths: area, fillRule: 'nonzero' }]));
    } catch {
      union = [];
    }
    if (!union.length) return;
    s.updateDoc((d) => {
      result.ids = replaceNodeGeometry(d, target, union, false);
      for (const id of candidates) if (id !== target) removeNode(d, id);
    }, 'Blob Brush');
  } else {
    s.updateDoc((d) => {
      const n = addWorldPath(d, area, { fill: paint, stroke: noStroke(), name: 'Blob' });
      if (n) result.ids = [n.id];
    }, 'Blob Brush');
  }
  if (result.ids.length) {
    if (opts.keepSelected) s.setSelection(result.ids);
    else s.clearSelection();
  }
}

export const blobTool: Tool = {
  id: 'blob',
  name: 'Blob Brush Tool',
  shortcut: 'shift+b',
  icon: Droplet,
  group: 'draw',
  order: 202,
  cursor: 'crosshair',
  hint: 'Drag to paint a filled shape that merges with same-coloured paths. Alt: erase. [ and ] change the size.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: BlobOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    pointer = null;
    updateCursor(ctx);
    unsubscribe?.();
    unsubscribe = useStore.subscribe(
      (s) => [s.zoom, s.toolOptions.blob?.size, s.temporaryTool] as const,
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
    const sampler = new StrokeSampler(1 / ctx.zoom);
    sampler.add(e.world, e.pressure);
    gesture = { sampler, erase: e.alt };
    pointer = e.screen;
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    pointer = e.screen;
    const g = gesture;
    if (!g) {
      if (circleCursorIsFallback(ctx.options<BlobOptions>().size * ctx.zoom)) ctx.requestOverlay();
      return;
    }
    g.erase = e.alt;
    g.sampler.add(e.world, e.pressure);
    ctx.requestOverlay();
  },

  onModifiers(e, ctx) {
    if (gesture) {
      gesture.erase = e.alt;
      ctx.requestOverlay();
    }
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    g.sampler.add(e.world, e.pressure);
    ctx.requestOverlay();
    finish(ctx, g);
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture) {
      this.cancel!(ctx);
      return true;
    }
    if ((e.key === '[' || e.key === ']') && !e.primary) {
      const opts = ctx.options<BlobOptions>();
      ctx.setOptions({ size: stepSize(opts.size, e.key === ']' ? 1 : -1, 1, 200) });
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const opts = ctx.options<BlobOptions>();
    const g = gesture;
    const d = opts.size * ctx.zoom;
    if (!g) {
      if (pointer && circleCursorIsFallback(d)) return <CirclePreview center={pointer} diameter={d} />;
      return null;
    }
    const pts = g.sampler.points();
    const paint = resolveBrushPaint(ctx.state, opts.paint);
    const fill = g.erase ? 'rgba(255,90,90,0.55)' : previewColor(paint, 0.6);
    return (
      <g className="blob-preview">
        <AreaPreview points={toScreen(ctx, pts)} diameter={d} fill={fill} />
        {pointer && circleCursorIsFallback(d) && <CirclePreview center={pointer} diameter={d} />}
      </g>
    );
  },
};

function BlobOptionsBar() {
  const [o, set] = useToolOptions<BlobOptions>('blob');
  return (
    <OptionsRow>
      <OptionSlider label="Size" value={o.size} min={1} max={200} unit="px" onChange={(v) => set({ size: Math.round(v) })} title="Brush diameter ([ and ] adjust it)" />
      <OptionSlider label="Smoothing" value={o.smoothing} min={0} max={100} unit="%" onChange={(v) => set({ smoothing: Math.round(v) })} title="Smoothness of the painted outline" width={160} />
      <div className="divider" />
      <PaintSourceOption value={o.paint} onChange={(v) => set({ paint: v })} />
      <OptionCheck label="Merge only with selection" checked={o.mergeSelectionOnly} onChange={(v) => set({ mergeSelectionOnly: v })} title="Only merge with selected paths of the same colour" />
      <OptionCheck label="Keep selected" checked={o.keepSelected} onChange={(v) => set({ keepSelected: v })} title="Leave the painted shape selected" />
    </OptionsRow>
  );
}

export const tool = blobTool;
void React;
