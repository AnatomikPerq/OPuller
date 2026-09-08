/**
 * Paintbrush tool (B): paints a round, optionally pressure-sensitive and
 * tapered brush stroke as a filled outline (or a plain round-capped stroked
 * path with "Simple stroke").
 */
import React from 'react';
import { Brush } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, Paint, Vec } from '@/model/types';
import type { EditorState } from '@/store/store';
import { clonePaint } from '@/model/nodes';
import { noStroke } from '@/model/defaults';
import { ellipseSubPath } from '@/geometry/shapes';
import { useToolOptions } from '@/canvas/toolContext';
import { currentAppearance } from '@/commands/appearance';
import { StrokeSampler, smoothSamples, polylineLength, brushWidthAt, pressureLookup, outlineRing } from '../freehand/sampling';
import { fitPolyline, variableOutline } from '../freehand/fit';
import { addWorldPath } from '../freehand/apply';
import { BRUSH_CURSOR } from '../freehand/cursors';
import { PolygonPreview, previewColor, toScreen } from '../freehand/preview';
import { OptionSlider, OptionCheck, OptionsRow, PaintSourceOption } from '../freehand/options';

export type BrushOptions = {
  width: number;
  pressure: boolean;
  taperStart: number;
  taperEnd: number;
  smoothing: number;
  paint: 'stroke' | 'fill';
  simple: boolean;
  keepSelected: boolean;
}

const DEFAULTS: BrushOptions = { width: 12, pressure: true, taperStart: 0, taperEnd: 0, smoothing: 30, paint: 'stroke', simple: false, keepSelected: true };

interface Gesture {
  sampler: StrokeSampler;
  pen: boolean;
  paint: Paint;
}

let gesture: Gesture | null = null;

/** Paint used by brush-like tools: the chosen source, falling back to the other one, then black. */
export function resolveBrushPaint(state: EditorState, source: 'stroke' | 'fill'): Paint {
  const app = currentAppearance(state);
  const primary = source === 'stroke' ? app.stroke.paint : app.fill;
  const secondary = source === 'stroke' ? app.fill : app.stroke.paint;
  if (primary.type !== 'none') return clonePaint(primary);
  if (secondary.type !== 'none') return clonePaint(secondary);
  return { type: 'solid', color: '#000000', opacity: 1 };
}

/** Adjust a size option with [ and ] like Illustrator's brush size shortcuts. */
export function stepSize(current: number, dir: number, min: number, max: number): number {
  const step = current < 10 ? 1 : current < 50 ? 2 : current < 100 ? 5 : 10;
  return Math.max(min, Math.min(max, Math.round(current + dir * step)));
}

function widthOpts(opts: BrushOptions, pen: boolean) {
  return { width: opts.width, usePressure: opts.pressure && pen, taperStart: opts.taperStart, taperEnd: opts.taperEnd };
}

function finish(ctx: ToolContext, g: Gesture) {
  const s = ctx.state;
  const opts = ctx.options<BrushOptions>();
  const pts = g.sampler.points();
  const created: { id: ID | null } = { id: null };
  const label = 'Paintbrush';
  if (pts.length < 2 || polylineLength(pts) < 1 / s.zoom) {
    if (opts.simple) return;
    // a click paints a dot
    const p = pts[0] ?? null;
    if (!p) return;
    const r = (opts.pressure && g.pen ? brushWidthAt(0.5, p.pressure, widthOpts(opts, g.pen)) : opts.width) / 2;
    if (r <= 0) return;
    s.updateDoc((d) => {
      const n = addWorldPath(d, [ellipseSubPath(r, r, p.x, p.y)], { fill: g.paint, stroke: noStroke(), name: 'Brush Stroke' });
      created.id = n?.id ?? null;
    }, label);
  } else {
    const passes = Math.round(opts.smoothing / 34);
    const smoothed = passes ? smoothSamples(pts, passes) : pts;
    const tolerance = 0.5 + opts.smoothing * 0.08;
    const center = fitPolyline(smoothed, tolerance, false);
    if (!center) return;
    if (opts.simple) {
      const app = currentAppearance(s);
      const stroke = { ...app.stroke, paint: g.paint, width: opts.width, cap: 'round' as const, join: 'round' as const, dash: [] as number[], widthProfile: undefined, markerStart: 'none' as const, markerEnd: 'none' as const };
      s.updateDoc((d) => {
        const n = addWorldPath(d, [center], { fill: { type: 'none' }, stroke, name: 'Brush Stroke' });
        created.id = n?.id ?? null;
      }, label);
    } else {
      const pressureAt = pressureLookup(smoothed);
      const wo = widthOpts(opts, g.pen);
      const outline = variableOutline(center, (t) => brushWidthAt(t, pressureAt(t), wo));
      if (!outline.length) return;
      s.updateDoc((d) => {
        const n = addWorldPath(d, outline, { fill: g.paint, stroke: noStroke(), name: 'Brush Stroke' });
        created.id = n?.id ?? null;
      }, label);
    }
  }
  if (created.id) {
    if (opts.keepSelected) s.setSelection([created.id]);
    else s.clearSelection();
  }
}

export const brushTool: Tool = {
  id: 'brush',
  name: 'Paintbrush Tool',
  shortcut: 'b',
  icon: Brush,
  group: 'draw',
  order: 201,
  cursor: BRUSH_CURSOR,
  hint: 'Drag to paint a brush stroke. [ and ] change the width. Pen pressure varies the width when enabled.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: BrushOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    ctx.setCursor(BRUSH_CURSOR);
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
    const s = ctx.state;
    const opts = ctx.options<BrushOptions>();
    const sampler = new StrokeSampler(1 / s.zoom);
    const pen = e.pointerType === 'pen';
    sampler.add(e.world, pen ? e.pressure : 1);
    gesture = { sampler, pen, paint: resolveBrushPaint(s, opts.paint) };
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    const g = gesture;
    if (!g) return;
    g.sampler.add(e.world, g.pen ? e.pressure : 1);
    ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    g.sampler.add(e.world, g.pen ? e.pressure : 1);
    ctx.requestOverlay();
    finish(ctx, g);
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture) {
      this.cancel!(ctx);
      return true;
    }
    if ((e.key === '[' || e.key === ']') && !e.primary) {
      const opts = ctx.options<BrushOptions>();
      ctx.setOptions({ width: stepSize(opts.width, e.key === ']' ? 1 : -1, 1, 200) });
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const g = gesture;
    if (!g) return null;
    const pts = g.sampler.points();
    if (!pts.length) return null;
    const opts = ctx.options<BrushOptions>();
    const z = ctx.zoom;
    const scr = toScreen(ctx, pts);
    // half widths along the raw stroke (screen space)
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = cum[cum.length - 1] || 1;
    const wo = widthOpts(opts, g.pen);
    const hw = pts.map((p, i) => (brushWidthAt(cum[i] / total, p.pressure, wo) * z) / 2);
    const ring = outlineRing(scr, hw);
    const fill = previewColor(g.paint, 0.55);
    if (opts.simple) {
      return <path d={ring.length ? ringPath(scr) : ''} fill="none" stroke={fill} strokeWidth={opts.width * z} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />;
    }
    return <PolygonPreview ring={ring} fill={fill} />;
  },
};

function ringPath(pts: Vec[]): string {
  if (!pts.length) return '';
  const p = pts.length === 1 ? [pts[0], { x: pts[0].x + 0.01, y: pts[0].y }] : pts;
  return p.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join('');
}

function BrushOptionsBar() {
  const [o, set] = useToolOptions<BrushOptions>('brush');
  return (
    <OptionsRow>
      <OptionSlider label="Width" value={o.width} min={1} max={200} unit="px" onChange={(v) => set({ width: Math.round(v) })} title="Brush width ([ and ] adjust it)" />
      <OptionCheck label="Pressure" checked={o.pressure} onChange={(v) => set({ pressure: v })} title="Vary the width with pen pressure (mouse strokes use a constant width)" />
      <OptionSlider label="Taper start" value={o.taperStart} min={0} max={100} unit="%" onChange={(v) => set({ taperStart: Math.round(v) })} title="Taper the beginning of the stroke over this fraction of its length" width={160} />
      <OptionSlider label="Taper end" value={o.taperEnd} min={0} max={100} unit="%" onChange={(v) => set({ taperEnd: Math.round(v) })} title="Taper the end of the stroke over this fraction of its length" width={160} />
      <OptionSlider label="Smoothing" value={o.smoothing} min={0} max={100} unit="%" onChange={(v) => set({ smoothing: Math.round(v) })} title="Smoothness of the stroke centerline" width={160} />
      <div className="divider" />
      <PaintSourceOption value={o.paint} onChange={(v) => set({ paint: v })} />
      <OptionCheck label="Simple stroke" checked={o.simple} onChange={(v) => set({ simple: v })} title="Create a stroked path with round caps instead of a filled outline" />
      <OptionCheck label="Keep selected" checked={o.keepSelected} onChange={(v) => set({ keepSelected: v })} title="Leave the stroke selected" />
    </OptionsRow>
  );
}

export const tool = brushTool;
void React;
