/**
 * Pixel Brush: paints raster strokes into an image node (the selected image,
 * the image under the cursor, or a new transparent image covering the active
 * artboard). Alt = eraser. Size with [ and ]. One undo step per stroke.
 */
import React, { useEffect, useRef } from 'react';
import { Brush } from 'lucide-react';
import { create } from 'zustand';
import type { Tool, ToolContext } from '../types';
import type { ID, Vec, ImageNode } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { makeImage } from '@/model/nodes';
import { addNode, worldMatrix } from '@/model/document';
import { translate, invert, applyToPoint, scaleFactor } from '@/geometry/matrix';
import { insertionParent } from '@/tools/shapes/tool';
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { loadImage } from '@/util/files';
import { useToolOptions } from '@/canvas/toolContext';
import { NumberField, Slider, Checkbox, Row, Select } from '@/ui/widgets';
import { getArtboard } from '@/artboards/ops';
import '@/raster/raster.css';

interface BrushOptions extends Record<string, unknown> {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  eraser: boolean;
  /** pixels per document unit for new raster layers */
  resolution: number;
}

interface Stroke {
  nodeId: ID;
  /** offscreen canvas holding the image pixels (natural size) */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** natural px per local unit */
  kx: number;
  ky: number;
  /** crop origin in natural px */
  cropX: number;
  cropY: number;
  last: Vec | null;
  eraser: boolean;
  color: string;
  /** dirty rect in natural px */
  dirty: { x1: number; y1: number; x2: number; y2: number } | null;
  /** live preview canvas (natural size, only this stroke) */
  preview: HTMLCanvasElement;
  pctx: CanvasRenderingContext2D;
}

let stroke: Stroke | null = null;
let cursorWorld: Vec | null = null;

export const useBrushPreview = create<{ nodeId: ID | null; tick: number; bump: (id: ID | null) => void }>((set) => ({ nodeId: null, tick: 0, bump: (nodeId) => set((s) => ({ nodeId, tick: s.tick + 1 })) }));

const canvasCache = new Map<ID, { src: string; canvas: HTMLCanvasElement }>();

async function canvasFor(n: ImageNode): Promise<HTMLCanvasElement> {
  const cached = canvasCache.get(n.id);
  if (cached && cached.src === n.src) return cached.canvas;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(n.naturalWidth));
  c.height = Math.max(1, Math.round(n.naturalHeight));
  const ctx = c.getContext('2d')!;
  try {
    const img = await loadImage(n.src);
    ctx.drawImage(img, 0, 0, c.width, c.height);
  } catch {
    /* blank */
  }
  canvasCache.set(n.id, { src: n.src, canvas: c });
  return c;
}

function currentColor(): string {
  const s = getState();
  const f = s.appearance.fill;
  if (f.type === 'solid') return f.color;
  if (f.type === 'linear' || f.type === 'radial') return f.stops[0]?.color ?? '#000000';
  const st = s.appearance.stroke.paint;
  return st.type === 'solid' ? st.color : '#000000';
}

/** The image to paint on: selected image → image under the cursor → a new raster layer. */
function targetImage(ctx: ToolContext, world: Vec): ID | null {
  const s = ctx.state;
  const sel = s.selection.find((id) => s.doc.nodes[id]?.type === 'image');
  if (sel) return sel;
  const hit = ctx.hitTest(world, { enterGroups: true, fills: true });
  if (hit && s.doc.nodes[hit.id]?.type === 'image') return hit.id;
  return null;
}

function createRasterLayer(ctx: ToolContext, resolution: number): ID | null {
  const s = ctx.state;
  const ab = getArtboard(s.doc, s.activeArtboardId) ?? s.doc.artboards[0];
  if (!ab) return null;
  const w = Math.max(1, Math.round(ab.width * resolution));
  const h = Math.max(1, Math.round(ab.height * resolution));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const node = makeImage(c.toDataURL('image/png'), w, h, { name: 'Raster layer', width: ab.width, height: ab.height, transform: translate(ab.x, ab.y) });
  const parent = insertionParent();
  if (!parent) return null;
  s.updateDoc((d) => addNode(d, node, parent), 'New Raster Layer');
  canvasCache.set(node.id, { src: node.src, canvas: c });
  return node.id;
}

function dab(st: Stroke, p: Vec, opts: BrushOptions, pressure: number) {
  const r = Math.max(0.5, (opts.size / 2) * st.kx * (0.4 + 0.6 * pressure));
  const hard = Math.max(0, Math.min(1, opts.hardness));
  const g = st.pctx.createRadialGradient(p.x, p.y, r * hard, p.x, p.y, r);
  const alpha = Math.max(0.01, Math.min(1, opts.flow));
  const rgb = st.color;
  g.addColorStop(0, rgbaOf(rgb, alpha));
  g.addColorStop(1, rgbaOf(rgb, 0));
  st.pctx.fillStyle = g;
  st.pctx.beginPath();
  st.pctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  st.pctx.fill();
  const d = st.dirty ?? { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  st.dirty = { x1: Math.min(d.x1, p.x - r), y1: Math.min(d.y1, p.y - r), x2: Math.max(d.x2, p.x + r), y2: Math.max(d.y2, p.y + r) };
}

function rgbaOf(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

function paintTo(st: Stroke, p: Vec, opts: BrushOptions, pressure: number) {
  if (!st.last) {
    dab(st, p, opts, pressure);
    st.last = p;
    return;
  }
  const dist = Math.hypot(p.x - st.last.x, p.y - st.last.y);
  const spacing = Math.max(0.5, (opts.size * st.kx) / 6);
  const n = Math.max(1, Math.ceil(dist / spacing));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    dab(st, { x: st.last.x + (p.x - st.last.x) * t, y: st.last.y + (p.y - st.last.y) * t }, opts, pressure);
  }
  st.last = p;
}

function localPoint(ctx: ToolContext, id: ID, world: Vec): Vec {
  const m = invert(worldMatrix(ctx.doc, id));
  return applyToPoint(m, world);
}

export const tool: Tool = {
  id: 'pixelbrush',
  name: 'Pixel Brush',
  icon: Brush,
  group: 'draw',
  order: 205,
  cursor: 'crosshair',
  hint: 'Paint pixels on the selected image (or a new raster layer). Alt: erase. [ ]: brush size.',
  showSelectionOverlay: false,
  defaults: { size: 24, hardness: 0.7, opacity: 1, flow: 0.8, eraser: false, resolution: 1 } satisfies BrushOptions,
  Options: BrushOptionsBar,

  deactivate(ctx) {
    stroke = null;
    useBrushPreview.getState().bump(null);
    ctx.requestOverlay();
  },
  onPointerMove(e, ctx) {
    cursorWorld = e.world;
    if (!stroke) {
      ctx.requestOverlay();
      return;
    }
    const opts = ctx.options<BrushOptions>();
    const lp = localPoint(ctx, stroke.nodeId, e.world);
    paintTo(stroke, { x: stroke.cropX + lp.x * stroke.kx, y: stroke.cropY + lp.y * stroke.ky }, opts, e.pointerType === 'pen' ? e.pressure || 0.5 : 1);
    useBrushPreview.getState().bump(stroke.nodeId);
    ctx.requestOverlay();
  },
  async onPointerDown(e, ctx) {
    if (e.button !== 0 || stroke) return;
    const opts = ctx.options<BrushOptions>();
    let id = targetImage(ctx, e.world);
    if (!id) id = createRasterLayer(ctx, opts.resolution);
    if (!id) return;
    ctx.capture(e.pointerId);
    const s = getState();
    const n = s.doc.nodes[id] as ImageNode;
    s.setSelection([id]);
    const canvas = await canvasFor(n);
    if (getState().doc.nodes[id] !== n && getState().doc.nodes[id]?.type !== 'image') return;
    const preview = document.createElement('canvas');
    preview.width = canvas.width;
    preview.height = canvas.height;
    const crop = n.crop ?? { x: 0, y: 0, width: n.naturalWidth, height: n.naturalHeight };
    stroke = {
      nodeId: id,
      canvas,
      ctx: canvas.getContext('2d')!,
      kx: crop.width / n.width,
      ky: crop.height / n.height,
      cropX: crop.x,
      cropY: crop.y,
      last: null,
      eraser: e.alt || opts.eraser,
      color: currentColor(),
      dirty: null,
      preview,
      pctx: preview.getContext('2d')!,
    };
    const lp = localPoint(ctx, id, e.world);
    paintTo(stroke, { x: crop.x + lp.x * stroke.kx, y: crop.y + lp.y * stroke.ky }, opts, e.pointerType === 'pen' ? e.pressure || 0.5 : 1);
    useBrushPreview.getState().bump(id);
    ctx.requestOverlay();
  },
  onPointerUp(_e, ctx) {
    const st = stroke;
    stroke = null;
    useBrushPreview.getState().bump(null);
    if (!st) return;
    const opts = ctx.options<BrushOptions>();
    // composite the stroke onto the image pixels
    st.ctx.save();
    st.ctx.globalAlpha = Math.max(0.01, Math.min(1, opts.opacity));
    st.ctx.globalCompositeOperation = st.eraser ? 'destination-out' : 'source-over';
    st.ctx.drawImage(st.preview, 0, 0);
    st.ctx.restore();
    const src = st.canvas.toDataURL('image/png');
    canvasCache.set(st.nodeId, { src, canvas: st.canvas });
    getState().updateDoc((d) => {
      const n = d.nodes[st.nodeId] as ImageNode | undefined;
      if (n && n.type === 'image') n.src = src;
    }, st.eraser ? 'Erase Pixels' : 'Paint Pixels');
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    const opts = ctx.options<BrushOptions>();
    if (e.key === '[') {
      ctx.setOptions({ size: Math.max(1, Math.round(opts.size / 1.25)) });
      ctx.requestOverlay();
      return true;
    }
    if (e.key === ']') {
      ctx.setOptions({ size: Math.min(500, Math.round(opts.size * 1.25)) });
      ctx.requestOverlay();
      return true;
    }
    if (e.key === 'Escape' && stroke) {
      stroke = null;
      useBrushPreview.getState().bump(null);
      ctx.requestOverlay();
      return true;
    }
    return false;
  },
  renderOverlay(ctx) {
    if (!cursorWorld) return null;
    const opts = ctx.options<BrushOptions>();
    const p = ctx.worldToScreen(cursorWorld);
    const r = (opts.size / 2) * ctx.zoom;
    return (
      <g pointerEvents="none" className="pixel-brush-cursor">
        <circle cx={p.x} cy={p.y} r={r} fill="none" stroke="#000" strokeWidth={1} opacity={0.6} />
        <circle cx={p.x} cy={p.y} r={r + 1} fill="none" stroke="#fff" strokeWidth={1} opacity={0.6} />
      </g>
    );
  },
  isBusy: () => !!stroke,
  cancel(ctx) {
    stroke = null;
    useBrushPreview.getState().bump(null);
    ctx.requestOverlay();
  },
};

/** Live preview of the stroke in progress, drawn over the image in screen space. */
function PixelBrushPreview() {
  const nodeId = useBrushPreview((s) => s.nodeId);
  const tick = useBrushPreview((s) => s.tick);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const doc = useStore((s) => s.doc);
  const ref = useRef<HTMLCanvasElement>(null);
  const st = stroke;
  useEffect(() => {
    const c = ref.current;
    if (!c || !st || !nodeId) return;
    const n = doc.nodes[nodeId] as ImageNode | undefined;
    if (!n || n.type !== 'image') return;
    const m = worldMatrix(doc, nodeId);
    const tl = applyToPoint(m, { x: 0, y: 0 });
    const w = n.width * scaleFactor(m) * zoom;
    const h = n.height * scaleFactor(m) * zoom;
    c.style.left = `${tl.x * zoom + pan.x}px`;
    c.style.top = `${tl.y * zoom + pan.y}px`;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const crop = n.crop ?? { x: 0, y: 0, width: n.naturalWidth, height: n.naturalHeight };
    g.globalAlpha = Math.max(0.01, Math.min(1, Number(getState().toolOptions.pixelbrush?.opacity ?? 1)));
    if (st.eraser) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha *= 0.5;
    }
    g.drawImage(st.preview, crop.x, crop.y, crop.width, crop.height, 0, 0, c.width, c.height);
  }, [nodeId, tick, zoom, pan, doc, st]);
  if (!nodeId || !st) return null;
  return <canvas ref={ref} className="pixel-brush-overlay" data-viewport-html />;
}

registerViewportSlot('html', 'pixel-brush-preview', PixelBrushPreview);

function BrushOptionsBar() {
  const [opts, set] = useToolOptions<BrushOptions>('pixelbrush');
  const units = useStore((s) => s.prefs.units);
  return (
    <Row gap={10}>
      <NumberField label="Size" value={opts.size} onChange={(v) => set({ size: Math.max(1, Math.min(500, v)) })} min={1} max={500} unit={units} width={110} />
      <Slider label="Hardness" value={Math.round(opts.hardness * 100)} min={0} max={100} onChange={(v) => set({ hardness: v / 100 })} width={140} unit="%" />
      <Slider label="Opacity" value={Math.round(opts.opacity * 100)} min={1} max={100} onChange={(v) => set({ opacity: v / 100 })} width={140} unit="%" />
      <Slider label="Flow" value={Math.round(opts.flow * 100)} min={1} max={100} onChange={(v) => set({ flow: v / 100 })} width={120} unit="%" />
      <Checkbox checked={!!opts.eraser} onChange={(v) => set({ eraser: v })} label="Eraser (Alt)" />
      <Select
        label="New layer"
        value={String(opts.resolution)}
        options={[
          { value: '0.5', label: '0.5× (fast)' },
          { value: '1', label: '1× (72 ppi)' },
          { value: '2', label: '2× (retina)' },
        ]}
        onChange={(v) => set({ resolution: Number(v) })}
        width={130}
        title="Resolution of a raster layer created when painting on empty canvas"
      />
    </Row>
  );
}

void React;
