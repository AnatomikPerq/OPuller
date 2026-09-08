/**
 * Pencil tool (N): freehand drawing fitted to Bézier paths.
 *
 * - drag to draw; the polyline is fitted on release (Fidelity = fit tolerance,
 *   Smoothness = pre-smoothing of the samples)
 * - releasing within "Close within" px of the start closes the path
 * - Alt while drawing draws straight segments
 * - "Edit selected paths": start near the end of a selected open path to
 *   continue it, or start on a selected path and end on it to redraw that
 *   portion (Illustrator behaviour); ending off the path truncates it
 * - "Keep selected", "Fill new strokes"
 * Snapping is off while drawing.
 */
import React from 'react';
import { Pencil } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { ID, SubPath, Vec, Paint, StrokeStyle } from '@/model/types';
import type { EditorState } from '@/store/store';
import { worldSubPaths, setWorldSubPaths } from '@/model/document';
import { clonePaint, cloneStroke } from '@/model/nodes';
import { nearestPointOnPath, segmentCount, cloneSubPaths } from '@/geometry/path';
import { useToolOptions } from '@/canvas/toolContext';
import { currentAppearance } from '@/commands/appearance';
import { NumberField } from '@/ui/widgets';
import { StrokeSampler, smoothSamples, endsNearStart, polylineLength } from '../freehand/sampling';
import { fitRuns } from '../freehand/fit';
import { replacePortion, extendSubPath, closeIfNear, cutAt, slicePiece } from '../freehand/cut';
import { addWorldPath, selectedEditablePaths } from '../freehand/apply';
import { PENCIL_CURSOR, PENCIL_EDIT_CURSOR, PENCIL_CLOSE_CURSOR } from '../freehand/cursors';
import { StrokePreview, CloseMarker, toScreen } from '../freehand/preview';
import { OptionSlider, OptionCheck, OptionsRow } from '../freehand/options';

export type PencilOptions = {
  /** fit tolerance in px (0.5..20) */
  fidelity: number;
  /** 0..100 pre-smoothing */
  smoothness: number;
  /** close the path when ending within this many screen px of the start */
  closeDistance: number;
  editSelected: boolean;
  keepSelected: boolean;
  fillStrokes: boolean;
}

const DEFAULTS: PencilOptions = { fidelity: 4, smoothness: 25, closeDistance: 15, editSelected: true, keepSelected: true, fillStrokes: false };

type EditTarget =
  | { kind: 'continue'; id: ID; subpath: number; atStart: boolean; sps: SubPath[] }
  | { kind: 'redraw'; id: ID; subpath: number; u: number; sps: SubPath[] };

interface Gesture {
  sampler: StrokeSampler;
  edit: EditTarget | null;
}

let gesture: Gesture | null = null;

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function editTolerance(ctx: ToolContext): number {
  return Math.max(ctx.tolerance(), 6 / ctx.zoom);
}

/** Selected open-path end or selected path outline near the point. */
function findEditTarget(ctx: ToolContext, p: Vec): EditTarget | null {
  const s = ctx.state;
  const tol = editTolerance(ctx);
  const ids = selectedEditablePaths(s);
  let bestD = Infinity;
  let best: EditTarget | null = null;
  const cache = new Map<ID, SubPath[]>();
  for (const id of ids) {
    const sps = worldSubPaths(s.doc, id);
    cache.set(id, sps);
    for (let si = 0; si < sps.length; si++) {
      const sp = sps[si];
      if (sp.closed || sp.anchors.length < 2) continue;
      const da = dist(sp.anchors[0].point, p);
      const db = dist(sp.anchors[sp.anchors.length - 1].point, p);
      if (da <= tol && da < bestD) {
        bestD = da;
        best = { kind: 'continue', id, subpath: si, atStart: true, sps };
      }
      if (db <= tol && db < bestD) {
        bestD = db;
        best = { kind: 'continue', id, subpath: si, atStart: false, sps };
      }
    }
  }
  if (best) return best;
  for (const id of ids) {
    const sps = cache.get(id)!;
    const loc = nearestPointOnPath(sps, p);
    if (loc && loc.distance <= tol && loc.distance < bestD) {
      bestD = loc.distance;
      best = { kind: 'redraw', id, subpath: loc.subpath, u: loc.segment + loc.t, sps };
    }
  }
  return best;
}

/** Appearance for a new pencil path: stroke from the current appearance, optional fill. */
export function pencilStyle(state: EditorState, fillStrokes: boolean): { fill: Paint; stroke: StrokeStyle } {
  const app = currentAppearance(state);
  const fill: Paint = fillStrokes ? clonePaint(app.fill) : { type: 'none' };
  let stroke = cloneStroke(app.stroke);
  stroke.widthProfile = undefined;
  if (stroke.paint.type === 'none' && fill.type === 'none') stroke = { ...stroke, paint: { type: 'solid', color: '#000000', opacity: 1 } };
  if (stroke.paint.type !== 'none' && stroke.width <= 0) stroke.width = 1;
  return { fill, stroke };
}

function setAltMode(g: Gesture, alt: boolean, p: Vec, pressure: number) {
  if (alt && !g.sampler.inStraight) g.sampler.beginStraight(p, pressure);
  else if (!alt && g.sampler.inStraight) g.sampler.endStraight();
}

function createPath(ctx: ToolContext, fitted: SubPath, opts: PencilOptions) {
  const s = ctx.state;
  const style = pencilStyle(s, opts.fillStrokes);
  const created: { id: ID | null } = { id: null };
  s.updateDoc((d) => {
    const n = addWorldPath(d, [fitted], { ...style, name: 'Path' });
    created.id = n?.id ?? null;
  }, 'Pencil');
  if (created.id) {
    if (opts.keepSelected) s.setSelection([created.id]);
    else s.clearSelection();
  }
}

function applyEdit(ctx: ToolContext, edit: EditTarget, fitted: SubPath, pts: Vec[], closeDist: number, opts: PencilOptions) {
  const s = ctx.state;
  const tol = editTolerance(ctx);
  const sps = cloneSubPaths(edit.sps);
  const sp = sps[edit.subpath];
  if (!sp) return;
  let next: SubPath | null = null;
  if (edit.kind === 'continue') {
    next = closeIfNear(extendSubPath(sp, fitted, edit.atStart), closeDist);
  } else {
    const end = pts[pts.length - 1];
    const loc = nearestPointOnPath([sp], end);
    if (loc && loc.distance <= tol) {
      const u2 = loc.segment + loc.t;
      if (Math.abs(u2 - edit.u) < 1e-4) return;
      next = replacePortion(sp, edit.u, u2, fitted, pts);
    } else if (!sp.closed) {
      // stroke leaves the path: truncate at the start point and extend with the stroke
      const n = segmentCount(sp);
      const cut = cutAt(sp, [edit.u]);
      const a = cut.indices[0];
      const last = cut.sp.anchors.length - 1;
      if (edit.u >= n / 2) next = a > 0 ? extendSubPath(slicePiece(cut.sp, 0, a), fitted, false) : fitted;
      else next = a < last ? extendSubPath(slicePiece(cut.sp, a, last), fitted, true) : fitted;
      next = closeIfNear(next, closeDist);
    } else {
      createPath(ctx, fitted, opts);
      return;
    }
  }
  if (!next || next.anchors.length < 2) return;
  sps[edit.subpath] = next;
  s.updateDoc((d) => setWorldSubPaths(d, edit.id, sps), 'Pencil');
  s.setSelection([edit.id]);
}

export const pencilTool: Tool = {
  id: 'pencil',
  name: 'Pencil Tool',
  shortcut: 'n',
  icon: Pencil,
  group: 'draw',
  order: 200,
  cursor: PENCIL_CURSOR,
  hint: 'Drag to draw a freehand path. Alt: straight segments. Release near the start to close. Start on a selected path to edit it.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: PencilOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    ctx.setCursor(PENCIL_CURSOR);
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
    ctx.setCursor(PENCIL_CURSOR);
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const opts = ctx.options<PencilOptions>();
    const sampler = new StrokeSampler(1.5 / s.zoom);
    sampler.add(e.world, e.pressure);
    const edit = opts.editSelected && s.selection.length ? findEditTarget(ctx, e.world) : null;
    gesture = { sampler, edit };
    if (e.alt) sampler.beginStraight(e.world, e.pressure);
    ctx.setCursor(PENCIL_CURSOR);
    ctx.setStatus(edit ? (edit.kind === 'continue' ? 'Continuing the selected path' : 'Redrawing the selected path') : 'Drawing');
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    const g = gesture;
    if (!g) {
      const opts = ctx.options<PencilOptions>();
      const near = opts.editSelected && ctx.state.selection.length ? findEditTarget(ctx, e.world) : null;
      ctx.setCursor(near ? PENCIL_EDIT_CURSOR : PENCIL_CURSOR);
      return;
    }
    setAltMode(g, e.alt, e.world, e.pressure);
    g.sampler.add(e.world, e.pressure);
    const opts = ctx.options<PencilOptions>();
    const closing = !g.edit && endsNearStart(g.sampler.points(), opts.closeDistance / ctx.zoom);
    ctx.setCursor(closing ? PENCIL_CLOSE_CURSOR : PENCIL_CURSOR);
    ctx.requestOverlay();
  },

  onModifiers(e, ctx) {
    const g = gesture;
    if (!g) return;
    const last = g.sampler.last();
    if (last) setAltMode(g, e.alt, last, last.pressure);
    ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    ctx.setCursor(PENCIL_CURSOR);
    ctx.requestOverlay();
    const s = ctx.state;
    const opts = ctx.options<PencilOptions>();
    g.sampler.add(e.world, e.pressure);
    g.sampler.endStraight();
    const pts = g.sampler.points();
    if (pts.length < 2 || polylineLength(pts) < 2 / s.zoom) {
      ctx.setStatus('');
      return;
    }
    const passes = Math.round(opts.smoothness / 34);
    const runs = g.sampler.runs().map((r) => (r.straight || passes === 0 ? r : { points: smoothSamples(r.points, passes), straight: false }));
    const closeDist = opts.closeDistance / s.zoom;
    const wantsClose = !g.edit && endsNearStart(pts, closeDist);
    const fitted = fitRuns(runs, opts.fidelity, wantsClose);
    ctx.setStatus('');
    if (!fitted || fitted.anchors.length < 2) return;
    if (g.edit) applyEdit(ctx, g.edit, fitted, pts, closeDist, opts);
    else createPath(ctx, fitted, opts);
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
    const scr = toScreen(ctx, pts);
    const opts = ctx.options<PencilOptions>();
    const closing = !g.edit && endsNearStart(pts, opts.closeDistance / ctx.zoom);
    const straightStart = g.sampler.straightStart();
    return (
      <g className="pencil-preview">
        <StrokePreview points={scr} />
        {straightStart && <StrokePreview points={toScreen(ctx, [straightStart, pts[pts.length - 1]])} color="#ffffff" dashed />}
        {closing && <CloseMarker at={scr[0]} />}
      </g>
    );
  },
};

function PencilOptionsBar() {
  const [o, set] = useToolOptions<PencilOptions>('pencil');
  return (
    <OptionsRow>
      <OptionSlider label="Fidelity" value={o.fidelity} min={0.5} max={20} step={0.5} unit="px" onChange={(v) => set({ fidelity: v })} title="Fit tolerance: low keeps every wobble, high gives smoother paths with fewer anchors" />
      <OptionSlider label="Smoothness" value={o.smoothness} min={0} max={100} unit="%" onChange={(v) => set({ smoothness: Math.round(v) })} title="Pre-smoothing of the drawn stroke" width={170} />
      <NumberField label="Close within" value={o.closeDistance} min={1} max={100} unit="px" width={126} onChange={(v) => set({ closeDistance: Math.round(v) })} title="Close the path when the stroke ends within this distance of its start" />
      <div className="divider" />
      <OptionCheck label="Fill new strokes" checked={o.fillStrokes} onChange={(v) => set({ fillStrokes: v })} title="Apply the current fill to new pencil paths" />
      <OptionCheck label="Keep selected" checked={o.keepSelected} onChange={(v) => set({ keepSelected: v })} title="Leave the drawn path selected" />
      <OptionCheck label="Edit selected paths" checked={o.editSelected} onChange={(v) => set({ editSelected: v })} title="Continue or redraw a selected path when starting on it" />
    </OptionsRow>
  );
}

export const tool = pencilTool;
void React;
export type { ToolPointerEvent };
