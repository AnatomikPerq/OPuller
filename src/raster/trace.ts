/**
 * Image Trace: convert a raster image node into vector paths with imagetracerjs.
 */
import ImageTracer, { type ImageTracerOptions } from 'imagetracerjs';
import type { Document, ID, ImageNode, Node, PathNode } from '@/model/types';
import { makeGroup } from '@/model/nodes';
import { addNode, addSubtree, worldMatrix, parentWorldMatrix, indexInParent, removeNode, descendants } from '@/model/document';
import { multiply, invert, scale as scaleM, translate } from '@/geometry/matrix';
import { importSvg } from '@/io/svgImport';
import { loadImage } from '@/util/files';

export type TraceMode = 'bw' | 'gray' | 'color';

export interface TraceOptions {
  mode: TraceMode;
  /** number of colours (color / gray modes) */
  colors: number;
  /** path simplification 0..10 (higher = smoother, fewer anchors) */
  smoothness: number;
  /** ignore areas smaller than this many pixels */
  minArea: number;
  /** drop white (or the lightest) fills */
  ignoreWhite: boolean;
  /** blur radius before tracing (0..5) */
  blur: number;
  /** trace at most this many pixels on the longer side (performance) */
  maxSize: number;
  /** what to do with the source image */
  source: 'replace' | 'keep' | 'hide';
  /** add a thin stroke of the fill colour to close gaps */
  strokes: boolean;
}

export const DEFAULT_TRACE: TraceOptions = { mode: 'color', colors: 16, smoothness: 3, minArea: 8, ignoreWhite: false, blur: 0, maxSize: 1024, source: 'replace', strokes: false };

export const TRACE_PRESETS: Array<{ id: string; name: string; opts: Partial<TraceOptions> }> = [
  { id: 'logo', name: 'Black and White Logo', opts: { mode: 'bw', smoothness: 2, minArea: 12, ignoreWhite: true } },
  { id: 'sketch', name: 'Sketched Art', opts: { mode: 'bw', smoothness: 1, minArea: 4, ignoreWhite: true } },
  { id: 'gray', name: 'Shades of Gray', opts: { mode: 'gray', colors: 8, smoothness: 3, minArea: 8 } },
  { id: 'c3', name: '3 Colors', opts: { mode: 'color', colors: 3, smoothness: 4, minArea: 16 } },
  { id: 'c6', name: '6 Colors', opts: { mode: 'color', colors: 6, smoothness: 3, minArea: 12 } },
  { id: 'c16', name: '16 Colors', opts: { mode: 'color', colors: 16, smoothness: 3, minArea: 8 } },
  { id: 'hifi', name: 'High Fidelity Photo', opts: { mode: 'color', colors: 64, smoothness: 1, minArea: 2, maxSize: 1400 } },
  { id: 'lofi', name: 'Low Fidelity Photo', opts: { mode: 'color', colors: 12, smoothness: 5, minArea: 24, blur: 1 } },
  { id: 'silhouette', name: 'Silhouettes', opts: { mode: 'bw', smoothness: 5, minArea: 40, ignoreWhite: true } },
];

function tracerOptions(o: TraceOptions): ImageTracerOptions {
  const s = Math.max(0, Math.min(10, o.smoothness));
  const base: ImageTracerOptions = {
    ltres: 0.5 + s * 0.8,
    qtres: 0.5 + s * 0.8,
    pathomit: Math.max(0, Math.round(o.minArea)),
    rightangleenhance: s < 2,
    colorsampling: 2,
    numberofcolors: o.mode === 'bw' ? 2 : Math.max(2, Math.min(256, Math.round(o.colors))),
    mincolorratio: 0,
    colorquantcycles: o.mode === 'bw' ? 1 : 3,
    layering: 0,
    strokewidth: o.strokes ? 1 : 0,
    linefilter: false,
    scale: 1,
    roundcoords: 2,
    viewbox: true,
    desc: false,
    blurradius: Math.max(0, Math.min(5, o.blur)),
    blurdelta: 20,
  };
  if (o.mode === 'bw') base.pal = [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }];
  if (o.mode === 'gray') {
    const n = Math.max(2, Math.min(64, Math.round(o.colors)));
    base.pal = Array.from({ length: n }, (_, i) => {
      const v = Math.round((255 * i) / (n - 1));
      return { r: v, g: v, b: v, a: 255 };
    });
  }
  return base;
}

/** Pixel data of an image node's source (cropped, downscaled to maxSize). */
export async function imageDataOf(node: ImageNode, maxSize: number): Promise<{ data: ImageData; scaleX: number; scaleY: number }> {
  const img = await loadImage(node.src);
  const crop = node.crop ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  const longest = Math.max(crop.width, crop.height);
  const k = longest > maxSize ? maxSize / longest : 1;
  const w = Math.max(1, Math.round(crop.width * k));
  const h = Math.max(1, Math.round(crop.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), scaleX: crop.width / w, scaleY: crop.height / h };
}

/** Trace to SVG markup (pixel coordinates of the traced bitmap). */
export async function traceToSvg(node: ImageNode, opts: TraceOptions): Promise<{ svg: string; pixelScaleX: number; pixelScaleY: number; width: number; height: number }> {
  const { data, scaleX, scaleY } = await imageDataOf(node, opts.maxSize);
  const svg = ImageTracer.imagedataToSVG(data, tracerOptions(opts));
  return { svg, pixelScaleX: scaleX, pixelScaleY: scaleY, width: data.width, height: data.height };
}

function isWhite(n: Node): boolean {
  if (n.type !== 'path') return false;
  const f = n.fill;
  if (f.type !== 'solid') return false;
  const v = parseInt(f.color.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return r >= 245 && g >= 245 && b >= 245;
}

/**
 * Trace an image node in the document. Returns the id of the resulting group
 * (or null when nothing was traced). Must be called inside updateDoc with a
 * pre-computed SVG (tracing itself is async).
 */
export function applyTrace(draft: Document, imageId: ID, traced: Awaited<ReturnType<typeof traceToSvg>>, opts: TraceOptions): ID | null {
  const img = draft.nodes[imageId];
  if (!img || img.type !== 'image') return null;
  const res = importSvg(traced.svg, { name: 'Traced' });
  let items = res.items;
  if (opts.ignoreWhite) {
    items = items.filter((it) => !(it.root.type === 'path' && isWhite(it.root)));
    for (const it of items) {
      if (it.root.type !== 'group') continue;
      // drop white paths inside groups
      it.nodes = it.nodes.filter((n) => n === it.root || !isWhite(n));
      const keep = new Set(it.nodes.map((n) => n.id));
      for (const n of it.nodes) if (n.type === 'group' || n.type === 'layer') n.children = n.children.filter((c) => keep.has(c));
    }
  }
  if (!items.length) return null;
  const parent = img.parent;
  const index = indexInParent(draft, imageId);
  const group = makeGroup([], { name: `${img.name} (traced)` });
  addNode(draft, group, parent, index + 1);
  for (const it of items) addSubtree(draft, it.root, it.nodes, group.id);
  // map traced pixels (cropped bitmap) onto the displayed image rectangle
  const crop = img.crop ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  const sx = (img.width / crop.width) * traced.pixelScaleX;
  const sy = (img.height / crop.height) * traced.pixelScaleY;
  const world = multiply(worldMatrix(draft, imageId), scaleM(sx, sy));
  group.transform = multiply(invert(parentWorldMatrix(draft, group.id)), world);
  // name the paths by colour for the layers panel
  for (const id of descendants(draft, group.id)) {
    const n = draft.nodes[id] as PathNode;
    if (n.type === 'path' && n.fill.type === 'solid') n.name = `Fill ${n.fill.color}`;
  }
  if (opts.source === 'replace') removeNode(draft, imageId);
  else if (opts.source === 'hide') (draft.nodes[imageId] as ImageNode).visible = false;
  void translate;
  return group.id;
}

export function countTraced(draft: Document, groupId: ID): number {
  return descendants(draft, groupId).filter((id) => draft.nodes[id]?.type === 'path').length;
}
