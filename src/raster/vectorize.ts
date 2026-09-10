/**
 * Image Trace pipeline (pure): RGBA pixels → colour reduction → despeckle →
 * one potrace layer per colour (stacked or cut out) → subpaths in pixel
 * coordinates. Runs in a Web Worker (traceWorker.ts) and in vitest.
 */
import type { SubPath, HexColor } from '@/model/types';
import { traceBitmap, type PotraceOptions } from './potrace';
import { thresholdLabels, grayLabels, colorLabels, removeSmallRegions, rgbToHex, type LabelMap, type RasterImage, type RGB } from './quantize';

export type TraceMode = 'bw' | 'gray' | 'color';
export type TraceMethod = 'abutting' | 'overlapping';

export interface VectorizeOptions {
  mode: TraceMode;
  /** black & white cut-off 0..255 */
  threshold: number;
  /** colour count (color mode) */
  colors: number;
  /** grey count (gray mode) */
  grays: number;
  /** 0..100: how closely the curves follow the pixels (more anchors) */
  paths: number;
  /** 0..100: emphasis on corners */
  corners: number;
  /** ignore regions smaller than this many pixels */
  noise: number;
  /** overlapping = stacked shapes (no gaps), abutting = cut-out regions sharing edges */
  method: TraceMethod;
  ignoreWhite: boolean;
  /** replace nearly straight curves with lines */
  snapLines: boolean;
}

export interface TracedLayer {
  color: HexColor;
  /** pixels of this colour (before stacking) */
  pixels: number;
  subpaths: SubPath[];
}

export interface VectorizeResult {
  width: number;
  height: number;
  layers: TracedLayer[];
  palette: HexColor[];
  anchors: number;
}

export const DEFAULT_VECTORIZE: VectorizeOptions = { mode: 'color', threshold: 128, colors: 16, grays: 16, paths: 50, corners: 75, noise: 20, method: 'overlapping', ignoreWhite: false, snapLines: false };

/** potrace parameters for the Paths / Corners / Noise sliders. */
export function potraceOptionsFor(o: VectorizeOptions): PotraceOptions {
  const paths = Math.max(0, Math.min(100, o.paths));
  const corners = Math.max(0, Math.min(100, o.corners));
  return {
    turnPolicy: 'minority',
    turdSize: Math.max(0, Math.round(o.noise)),
    alphaMax: 1.334 - (0.834 * corners) / 100,
    optCurve: true,
    optTolerance: 0.2 * Math.pow(4, (50 - paths) / 50),
  };
}

function isWhite(c: RGB): boolean {
  return c.r >= 235 && c.g >= 235 && c.b >= 235;
}

/** Replace curve segments that deviate from their chord by less than `tol` px with straight lines. */
export function snapCurvesToLines(sp: SubPath, tol = 0.6): SubPath {
  const n = sp.anchors.length;
  const anchors = sp.anchors.map((a) => ({ point: { ...a.point }, handleIn: a.handleIn ? { ...a.handleIn } : null, handleOut: a.handleOut ? { ...a.handleOut } : null, kind: a.kind }));
  const segs = sp.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    if (!a.handleOut && !b.handleIn) continue;
    const dx = b.point.x - a.point.x;
    const dy = b.point.y - a.point.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const dev = (h: { x: number; y: number } | null, base: { x: number; y: number }) => {
      if (!h) return 0;
      const px = base.x + h.x - a.point.x;
      const py = base.y + h.y - a.point.y;
      return Math.abs(px * dy - py * dx) / len;
    };
    if (dev(a.handleOut, a.point) <= tol && dev(b.handleIn, b.point) <= tol) {
      a.handleOut = null;
      b.handleIn = null;
    }
  }
  for (const a of anchors) if (!a.handleIn || !a.handleOut) a.kind = 'corner';
  return { anchors, closed: sp.closed };
}

function labelMapFor(img: RasterImage, o: VectorizeOptions): LabelMap {
  if (o.mode === 'bw') return thresholdLabels(img, o.threshold);
  if (o.mode === 'gray') return grayLabels(img, o.grays);
  return colorLabels(img, o.colors);
}

/**
 * Trace an RGBA image. Layers come back bottom to top; colours with the
 * largest area go to the bottom so that stacked shapes cover the whole image.
 */
export function vectorize(img: RasterImage, options: Partial<VectorizeOptions> = {}): VectorizeResult {
  const o: VectorizeOptions = { ...DEFAULT_VECTORIZE, ...options };
  const map = labelMapFor(img, o);
  const w = map.width;
  const h = map.height;
  const n = w * h;
  if (o.noise > 1) removeSmallRegions(map, Math.round(o.noise));
  const ignored = map.palette.map((c) => o.ignoreWhite && isWhite(c));
  // stacking order: largest area first (bottom)
  const order: number[] = [];
  for (let i = 0; i < map.palette.length; i++) if (map.counts[i] > 0 && !ignored[i]) order.push(i);
  order.sort((a, b) => map.counts[b] - map.counts[a]);
  const rank = new Int32Array(map.palette.length).fill(-1);
  order.forEach((label, i) => (rank[label] = i));
  const potraceOpts = potraceOptionsFor(o);
  const layers: TracedLayer[] = [];
  let anchors = 0;
  const bitmap = new Uint8Array(n);
  for (let li = 0; li < order.length; li++) {
    const label = order[li];
    let any = false;
    for (let i = 0; i < n; i++) {
      const l = map.labels[i];
      let on: boolean;
      if (l < 0 || ignored[l]) on = false;
      else if (o.method === 'overlapping') on = rank[l] >= li;
      else on = l === label;
      bitmap[i] = on ? 1 : 0;
      if (on) any = true;
    }
    if (!any) continue;
    let sps = traceBitmap({ width: w, height: h, data: bitmap }, potraceOpts);
    if (o.snapLines) sps = sps.map((sp) => snapCurvesToLines(sp));
    if (!sps.length) continue;
    for (const sp of sps) anchors += sp.anchors.length;
    layers.push({ color: rgbToHex(map.palette[label]), pixels: map.counts[label], subpaths: sps });
  }
  return { width: w, height: h, layers, palette: order.map((i) => rgbToHex(map.palette[i])), anchors };
}
