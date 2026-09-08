/**
 * Path Eraser tool: drag along a selected path to erase the portion under the
 * pointer. The path is split at the entry and exit points and the middle is
 * removed; closed paths become open. Pieces of a single path become separate
 * path nodes with the same appearance.
 */
import React from 'react';
import { Eraser } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, SubPath, Vec } from '@/model/types';
import { worldSubPaths } from '@/model/document';
import { useToolOptions } from '@/canvas/toolContext';
import { StrokeSampler } from '../freehand/sampling';
import { touchIntervals, eraseIntervals } from '../freehand/cut';
import { replaceNodeGeometry, selectedEditablePaths } from '../freehand/apply';
import { PATH_ERASER_CURSOR } from '../freehand/cursors';
import { AreaPreview, toScreen } from '../freehand/preview';
import { OptionSlider, OptionsRow } from '../freehand/options';

export type PathEraserOptions = {
  /** eraser width in px (document units) */
  width: number;
}

const DEFAULTS: PathEraserOptions = { width: 8 };

interface Gesture {
  sampler: StrokeSampler;
  targets: Array<{ id: ID; sps: SubPath[] }>;
}

let gesture: Gesture | null = null;

function radiusFor(ctx: ToolContext): number {
  const opts = ctx.options<PathEraserOptions>();
  return Math.max(opts.width / 2, 3 / ctx.zoom);
}

function pickTargets(ctx: ToolContext, p: Vec): ID[] {
  const s = ctx.state;
  const sel = selectedEditablePaths(s);
  if (sel.length) return sel;
  const hit = ctx.hitTest(p, { enterGroups: true, fills: false });
  if (hit && s.doc.nodes[hit.id]?.type === 'path') {
    s.setSelection([hit.id]);
    return [hit.id];
  }
  return [];
}

/** Erase the touched intervals from every subpath; null when nothing was touched. */
export function erasePathPortions(sps: SubPath[], samples: Vec[], radius: number): SubPath[] | null {
  let changed = false;
  const out: SubPath[] = [];
  for (const sp of sps) {
    const intervals = touchIntervals(sp, samples, radius, radius * 0.8);
    if (!intervals.length) {
      out.push(sp);
      continue;
    }
    changed = true;
    out.push(...eraseIntervals(sp, intervals));
  }
  return changed ? out : null;
}

function finish(ctx: ToolContext, g: Gesture) {
  const s = ctx.state;
  const pts = g.sampler.points();
  const radius = radiusFor(ctx);
  const result: { ids: ID[]; changed: boolean } = { ids: [], changed: false };
  s.updateDoc((d) => {
    for (const t of g.targets) {
      if (!d.nodes[t.id]) continue;
      const out = erasePathPortions(t.sps, pts, radius);
      if (!out) {
        result.ids.push(t.id);
        continue;
      }
      result.changed = true;
      result.ids.push(...replaceNodeGeometry(d, t.id, out, t.sps.length === 1));
    }
  });
  if (!result.changed) return;
  ctx.commit('Erase Path');
  s.setSelection(result.ids);
}

export const pathEraserTool: Tool = {
  id: 'patheraser',
  name: 'Path Eraser Tool',
  icon: Eraser,
  group: 'draw',
  order: 204,
  cursor: PATH_ERASER_CURSOR,
  hint: 'Drag along a selected path to erase that portion. Closed paths become open.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: PathEraserOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    ctx.setCursor(PATH_ERASER_CURSOR);
  },
  deactivate(ctx) {
    if (gesture) ctx.state.revert();
    gesture = null;
  },
  isBusy: () => !!gesture,
  cancel(ctx) {
    gesture = null;
    ctx.state.revert();
    ctx.requestOverlay();
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const ids = pickTargets(ctx, e.world);
    if (!ids.length) {
      ctx.setStatus('Select a path to erase from');
      return;
    }
    const doc = ctx.state.doc;
    const sampler = new StrokeSampler(1 / ctx.zoom);
    sampler.add(e.world, e.pressure);
    gesture = { sampler, targets: ids.map((id) => ({ id, sps: worldSubPaths(doc, id) })) };
    ctx.setStatus('Erasing path');
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    const g = gesture;
    if (!g) return;
    g.sampler.add(e.world, e.pressure);
    ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    g.sampler.add(e.world, e.pressure);
    ctx.setStatus('');
    ctx.requestOverlay();
    finish(ctx, g);
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture) {
      this.cancel!(ctx);
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const g = gesture;
    if (!g) return null;
    const pts = g.sampler.points();
    if (!pts.length) return null;
    return <AreaPreview points={toScreen(ctx, pts)} diameter={radiusFor(ctx) * 2 * ctx.zoom} fill="rgba(255,120,120,0.45)" />;
  },
};

function PathEraserOptionsBar() {
  const [o, set] = useToolOptions<PathEraserOptions>('patheraser');
  return (
    <OptionsRow>
      <OptionSlider label="Width" value={o.width} min={1} max={50} unit="px" onChange={(v) => set({ width: Math.round(v) })} title="Width of the erased band along the path" />
      <span className="muted small">Drag along a selected path</span>
    </OptionsRow>
  );
}

export const tool = pathEraserTool;
void React;
