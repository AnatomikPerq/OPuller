/**
 * Smooth tool: drag along a selected path to re-fit the touched portion with
 * the given tolerance, reducing anchors while keeping the shape. Works in
 * world space so paths inside transformed groups behave.
 */
import React from 'react';
import { Spline } from 'lucide-react';
import { produce } from 'immer';
import type { Tool, ToolContext } from '../types';
import type { Document, ID, SubPath, Vec } from '@/model/types';
import { worldSubPaths, setWorldSubPaths } from '@/model/document';
import { useToolOptions } from '@/canvas/toolContext';
import { StrokeSampler } from '../freehand/sampling';
import { refitRange } from '../freehand/fit';
import { collectTouchedSegments, anchorRangeFromSegments } from '../freehand/cut';
import { selectedEditablePaths } from '../freehand/apply';
import { SMOOTH_CURSOR } from '../freehand/cursors';
import { StrokePreview, toScreen } from '../freehand/preview';
import { OptionSlider, OptionsRow } from '../freehand/options';

export type SmoothOptions = {
  /** re-fit tolerance in px */
  fidelity: number;
  /** 0..100 pre-smoothing of the touched portion */
  smoothness: number;
}

const DEFAULTS: SmoothOptions = { fidelity: 4, smoothness: 50 };

interface Target {
  id: ID;
  sps: SubPath[];
  /** touched segments per subpath, accumulated incrementally over the drag */
  segs: Set<number>[];
}

interface Gesture {
  sampler: StrokeSampler;
  base: Document;
  targets: Target[];
  /** number of samples already matched against the paths */
  processed: number;
  changed: boolean;
}

let gesture: Gesture | null = null;

function radiusFor(ctx: ToolContext): number {
  return Math.max(8 / ctx.zoom, ctx.tolerance() * 1.5);
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

function apply(ctx: ToolContext, g: Gesture) {
  const pts = g.sampler.points();
  const radius = radiusFor(ctx);
  const opts = ctx.options<SmoothOptions>();
  // only the new samples are matched against the paths (the drag can be long)
  const fresh = pts.slice(g.processed);
  g.processed = pts.length;
  for (const t of g.targets) t.sps.forEach((sp, i) => collectTouchedSegments(sp, fresh, radius, t.segs[i]));
  let any = false;
  const next = produce(g.base, (d) => {
    for (const t of g.targets) {
      let touched = false;
      const out = t.sps.map((sp, i) => {
        const r = anchorRangeFromSegments(sp, t.segs[i]);
        if (!r) return sp;
        touched = true;
        return refitRange(sp, r, opts.fidelity, Math.round(opts.smoothness / 25));
      });
      if (touched) {
        any = true;
        setWorldSubPaths(d, t.id, out);
      }
    }
  });
  if (any || g.changed) {
    ctx.state.replaceDoc(any ? next : g.base);
    g.changed = any;
  }
}

export const smoothTool: Tool = {
  id: 'smooth',
  name: 'Smooth Tool',
  icon: Spline,
  group: 'draw',
  order: 203,
  cursor: SMOOTH_CURSOR,
  hint: 'Drag along a selected path to smooth it (fewer anchors, same shape). Fidelity sets how closely the result follows the original.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: SmoothOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    ctx.setCursor(SMOOTH_CURSOR);
  },
  deactivate(ctx) {
    if (gesture) ctx.state.revert();
    gesture = null;
  },
  isBusy: () => !!gesture,
  cancel(ctx) {
    if (gesture) ctx.state.revert();
    gesture = null;
    ctx.requestOverlay();
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const ids = pickTargets(ctx, e.world);
    if (!ids.length) {
      ctx.setStatus('Select a path to smooth');
      return;
    }
    const base = ctx.state.doc;
    const sampler = new StrokeSampler(1 / s.zoom);
    sampler.add(e.world, e.pressure);
    const targets: Target[] = ids.map((id) => {
      const sps = worldSubPaths(base, id);
      return { id, sps, segs: sps.map(() => new Set<number>()) };
    });
    gesture = { sampler, base, targets, processed: 0, changed: false };
    ctx.setStatus('Smoothing');
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    const g = gesture;
    if (!g) return;
    if (!g.sampler.add(e.world, e.pressure)) return;
    apply(ctx, g);
    ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    g.sampler.add(e.world, e.pressure);
    apply(ctx, g);
    ctx.setStatus('');
    ctx.requestOverlay();
    if (g.changed) ctx.commit('Smooth');
    else ctx.state.revert();
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
    if (pts.length < 2) return null;
    return <StrokePreview points={toScreen(ctx, pts)} color="rgba(255,255,255,0.7)" />;
  },
};

function SmoothOptionsBar() {
  const [o, set] = useToolOptions<SmoothOptions>('smooth');
  return (
    <OptionsRow>
      <OptionSlider label="Fidelity" value={o.fidelity} min={0.5} max={20} step={0.5} unit="px" onChange={(v) => set({ fidelity: v })} title="Re-fit tolerance: higher removes more anchors" />
      <OptionSlider label="Smoothness" value={o.smoothness} min={0} max={100} unit="%" onChange={(v) => set({ smoothness: Math.round(v) })} title="How much the touched portion is smoothed before re-fitting" width={170} />
      <span className="muted small">Drag along a selected path</span>
    </OptionsRow>
  );
}

export const tool = smoothTool;
void React;
