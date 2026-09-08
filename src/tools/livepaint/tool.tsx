/**
 * Live Paint Bucket (K) and Live Paint Selection (Shift+L).
 *
 * Bucket: hover highlights the face (or edge, near a stroke) of a Live Paint
 * group; click paints it with the current fill (edges: the current stroke);
 * drag paints every face crossed; Alt-click samples the colour; arrow keys
 * step through the document swatches. Clicking ordinary paths converts the
 * selection into a Live Paint group first.
 *
 * Selection: click selects faces / edges inside a Live Paint group, Shift
 * adds, Delete removes them.
 */
import React from 'react';
import { PaintBucket, MousePointer2 } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { ID, Vec, Paint, PathNode } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { currentAppearance, setActivePaint } from '@/commands/appearance';
import { clonePaint, cloneStroke } from '@/model/nodes';
import { nodeScreenOutline } from '@/canvas/SelectionOverlay';
import { useToolOptions } from '@/canvas/toolContext';
import { Checkbox, Row } from '@/ui/widgets';
import { paintCss } from '@/ui/ColorPicker';
import { isLivePaintGroup, livePaintGroupOf, isFace, isEdge } from '@/livepaint/ops';
import { makeLivePaintCommand } from '@/livepaint/register';
import { findSwatchByPaint } from '@/color/swatches';

interface Options extends Record<string, unknown> {
  paintFills: boolean;
  paintStrokes: boolean;
  highlight: boolean;
}

const DEFAULTS: Options = { paintFills: true, paintStrokes: true, highlight: true };

interface Target {
  id: ID;
  kind: 'face' | 'edge';
  group: ID;
}

let hover: Target | null = null;
let painting: { painted: Set<ID>; group: ID } | null = null;
let cursorScreen: Vec | null = null;

function targetAt(ctx: ToolContext, world: Vec, opts: Options): Target | null {
  const hit = ctx.hitTest(world, { enterGroups: true });
  if (!hit) return null;
  const doc = ctx.doc;
  const group = livePaintGroupOf(doc, hit.id);
  if (!group) return null;
  const n = doc.nodes[hit.id];
  if (isEdge(n) && opts.paintStrokes && hit.kind === 'stroke') return { id: hit.id, kind: 'edge', group };
  if (isFace(n) && opts.paintFills) return { id: hit.id, kind: 'face', group };
  // an edge hit while strokes are off: fall through to the face beneath
  if (isEdge(n) && !opts.paintStrokes) {
    const below = ctx.hitTest(world, { enterGroups: true, ignore: new Set([hit.id]) });
    if (below && isFace(doc.nodes[below.id]) && opts.paintFills) return { id: below.id, kind: 'face', group };
  }
  return null;
}

function paintTarget(t: Target, label: string): void {
  const s = getState();
  // the bucket paints with the default (toolbar) fill / stroke, like Illustrator
  const app = s.appearance;
  s.updateDoc((d) => {
    const n = d.nodes[t.id];
    if (!n || n.type !== 'path') return;
    if (t.kind === 'face') n.fill = clonePaint(app.fill);
    else {
      const stroke = cloneStroke(app.stroke);
      if (stroke.paint.type === 'none') stroke.paint = { type: 'solid', color: '#000000', opacity: 1 };
      if (stroke.width <= 0) stroke.width = 1;
      n.stroke = stroke;
    }
  });
  void label;
}

function sample(t: Target): void {
  const s = getState();
  const n = s.doc.nodes[t.id] as PathNode | undefined;
  if (!n) return;
  const paint: Paint = t.kind === 'face' ? n.fill : n.stroke.paint;
  setActivePaint(clonePaint(paint), false);
  s.setActivePaintTarget(t.kind === 'face' ? 'fill' : 'stroke');
}

function BucketOptions() {
  const [opts, set] = useToolOptions<Options>('livepaint');
  const fill = useStore((s) => s.appearance.fill);
  void currentAppearance;
  const swatches = useStore((s) => s.doc.swatches);
  const sw = findSwatchByPaint(swatches, fill);
  return (
    <Row gap={10}>
      <Checkbox checked={opts.paintFills} onChange={(v) => set({ paintFills: v })} label="Paint fills" />
      <Checkbox checked={opts.paintStrokes} onChange={(v) => set({ paintStrokes: v })} label="Paint strokes" />
      <Checkbox checked={opts.highlight} onChange={(v) => set({ highlight: v })} label="Highlight" />
      <span className="muted">Current fill: {sw ? sw.name : fill.type === 'solid' ? fill.color : fill.type}. ← → cycle swatches, Alt-click samples.</span>
    </Row>
  );
}

function stepSwatch(dir: number): void {
  const s = getState();
  const swatches = s.doc.swatches.filter((sw) => sw.paint.type !== 'none');
  if (!swatches.length) return;
  const cur = swatches.findIndex((sw) => findSwatchByPaint([sw], s.appearance.fill));
  const next = swatches[(cur + dir + swatches.length) % swatches.length];
  setActivePaint(clonePaint(next.paint), true);
}

export const bucketTool: Tool = {
  id: 'livepaint',
  name: 'Live Paint Bucket',
  shortcut: 'k',
  icon: PaintBucket,
  group: 'edit',
  order: 612,
  cursor: 'crosshair',
  hint: 'Click a region of a Live Paint group to fill it with the current colour; click a stroke to paint the edge. Alt-click samples. Arrow keys change the colour. Click ordinary paths to make a Live Paint group.',
  defaults: DEFAULTS,
  Options: BucketOptions,
  showSelectionOverlay: false,

  activate(ctx) {
    hover = null;
    painting = null;
    // the bucket works without a selection: colour edits then change the defaults it paints with
    ctx.state.clearSelection();
    ctx.setCursor('crosshair');
  },
  deactivate(ctx) {
    hover = null;
    painting = null;
    ctx.requestOverlay();
  },
  isBusy: () => !!painting,
  cancel(ctx) {
    painting = null;
    ctx.state.revert();
    ctx.requestOverlay();
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const opts = ctx.options<Options>();
    const t = targetAt(ctx, e.world, opts);
    if (t) {
      if (e.alt) {
        sample(t);
        return;
      }
      painting = { painted: new Set([t.id]), group: t.group };
      paintTarget(t, 'Live Paint');
      ctx.requestOverlay();
      return;
    }
    // ordinary paths: make a live paint group from the click target / selection
    const hit = ctx.hitTest(e.world);
    if (hit && !isLivePaintGroup(s.doc.nodes[hit.target])) {
      const sel = s.selection.includes(hit.target) ? s.selection : [hit.target];
      const gid = makeLivePaintCommand(sel);
      if (gid) getState().toast('Live Paint group created: click regions to paint them', 'info');
    }
  },
  onPointerMove(e, ctx) {
    cursorScreen = e.screen;
    const opts = ctx.options<Options>();
    const t = targetAt(ctx, e.world, opts);
    if (painting) {
      if (t && t.group === painting.group && !painting.painted.has(t.id)) {
        painting.painted.add(t.id);
        paintTarget(t, 'Live Paint');
      }
      hover = t;
      ctx.requestOverlay();
      return;
    }
    if ((t?.id ?? null) !== (hover?.id ?? null)) {
      hover = t;
      ctx.requestOverlay();
    }
    ctx.setCursor(t ? 'crosshair' : 'default');
    ctx.setStatus(t ? (t.kind === 'face' ? 'Click to fill this region' : 'Click to paint this edge') : 'Live Paint Bucket: hover a Live Paint group');
  },
  onPointerUp(_e, ctx) {
    if (!painting) return;
    const n = painting.painted.size;
    painting = null;
    ctx.commit(n > 1 ? 'Live Paint (several)' : 'Live Paint');
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && painting) {
      this.cancel!(ctx);
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      stepSwatch(e.key === 'ArrowRight' ? 1 : -1);
      return true;
    }
    return false;
  },
  renderOverlay(ctx) {
    const s = ctx.state;
    const opts = ctx.options<Options>();
    const app = s.appearance;
    const chip = cursorScreen ? <rect x={cursorScreen.x + 14} y={cursorScreen.y + 14} width={16} height={16} rx={3} fill={paintCss(app.fill)} stroke="#fff" strokeWidth={1.5} pointerEvents="none" /> : null;
    if (!hover || !opts.highlight) return chip;
    const d = nodeScreenOutline(s, hover.id);
    if (!d) return chip;
    return (
      <g pointerEvents="none" data-testid="livepaint-highlight">
        <path d={d} fill={hover.kind === 'face' ? 'rgba(229,72,77,0.18)' : 'none'} stroke="#e5484d" strokeWidth={hover.kind === 'edge' ? 4 : 2.5} strokeLinejoin="round" />
        {chip}
      </g>
    );
  },
};

let selectHover: ID | null = null;

export const selectionTool: Tool = {
  id: 'livepaintSelect',
  name: 'Live Paint Selection',
  shortcut: 'shift+l',
  icon: MousePointer2,
  group: 'edit',
  order: 613,
  cursor: 'default',
  hint: 'Click faces or edges of a Live Paint group to select them; Shift adds; Delete removes the selected parts.',
  showSelectionOverlay: true,

  onPointerMove(e, ctx) {
    const hit = ctx.hitTest(e.world, { enterGroups: true });
    const id = hit && livePaintGroupOf(ctx.doc, hit.id) ? hit.id : null;
    if (id !== selectHover) {
      selectHover = id;
      ctx.requestOverlay();
    }
    ctx.setCursor(id ? 'pointer' : 'default');
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const hit = ctx.hitTest(e.world, { enterGroups: true });
    const id = hit && livePaintGroupOf(ctx.doc, hit.id) ? hit.id : null;
    if (!id) {
      if (!e.shift) s.clearSelection();
      return;
    }
    if (e.shift) s.toggleSelection(id);
    else s.setSelection([id]);
  },
  renderOverlay(ctx) {
    if (!selectHover) return null;
    const d = nodeScreenOutline(ctx.state, selectHover);
    return d ? <path d={d} fill="none" stroke="#e5484d" strokeWidth={2} pointerEvents="none" /> : null;
  },
};

export const tools: Tool[] = [bucketTool, selectionTool];

export type { ToolPointerEvent };
