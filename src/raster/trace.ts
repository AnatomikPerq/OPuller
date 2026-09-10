/**
 * Image Trace: convert a raster image node into vector paths. The tracing
 * itself (colour reduction + potrace) is pure and runs in a Web Worker
 * (vectorize.ts / traceRunner.ts); this file adapts it to the document.
 */
import type { Document, ID, ImageNode } from '@/model/types';
import { makeGroup, makePath } from '@/model/nodes';
import { noStroke } from '@/model/defaults';
import { addNode, worldMatrix, parentWorldMatrix, indexInParent, removeNode, descendants } from '@/model/document';
import { multiply, invert, scale as scaleM } from '@/geometry/matrix';
import { pathToSvgD } from '@/geometry/path';
import { loadImage } from '@/util/files';
import { vectorizeAsync } from './traceRunner';
import { DEFAULT_VECTORIZE, type VectorizeOptions, type VectorizeResult, type TraceMode, type TraceMethod } from './vectorize';

export type { TraceMode, TraceMethod };

export interface TraceOptions extends VectorizeOptions {
  /** trace at most this many pixels on the longer side (speed vs detail) */
  maxSize: number;
  /** what to do with the source image */
  source: 'replace' | 'keep' | 'hide';
}

export const DEFAULT_TRACE: TraceOptions = { ...DEFAULT_VECTORIZE, maxSize: 1024, source: 'replace' };

export const TRACE_PRESETS: Array<{ id: string; name: string; opts: Partial<TraceOptions> }> = [
  { id: 'hifi', name: 'High Fidelity Photo', opts: { mode: 'color', colors: 64, paths: 70, corners: 60, noise: 5, method: 'overlapping', ignoreWhite: false, snapLines: false, maxSize: 1200 } },
  { id: 'lofi', name: 'Low Fidelity Photo', opts: { mode: 'color', colors: 16, paths: 45, corners: 50, noise: 12, method: 'overlapping', ignoreWhite: false, snapLines: false, maxSize: 1024 } },
  { id: 'c3', name: '3 Colors', opts: { mode: 'color', colors: 3, paths: 50, corners: 75, noise: 25, method: 'overlapping', ignoreWhite: false, snapLines: false } },
  { id: 'c6', name: '6 Colors', opts: { mode: 'color', colors: 6, paths: 50, corners: 75, noise: 25, method: 'overlapping', ignoreWhite: false, snapLines: false } },
  { id: 'c16', name: '16 Colors', opts: { mode: 'color', colors: 16, paths: 50, corners: 75, noise: 25, method: 'overlapping', ignoreWhite: false, snapLines: false } },
  { id: 'gray', name: 'Shades of Gray', opts: { mode: 'gray', grays: 16, paths: 50, corners: 75, noise: 25, method: 'overlapping', ignoreWhite: false, snapLines: false } },
  { id: 'logo', name: 'Black and White Logo', opts: { mode: 'bw', threshold: 128, paths: 50, corners: 75, noise: 25, ignoreWhite: true, snapLines: false } },
  { id: 'sketch', name: 'Sketched Art', opts: { mode: 'bw', threshold: 200, paths: 90, corners: 90, noise: 4, ignoreWhite: true, snapLines: false } },
  { id: 'silhouette', name: 'Silhouettes', opts: { mode: 'bw', threshold: 200, paths: 40, corners: 60, noise: 40, ignoreWhite: true, snapLines: false } },
  { id: 'technical', name: 'Technical Drawing', opts: { mode: 'bw', threshold: 160, paths: 95, corners: 100, noise: 2, ignoreWhite: true, snapLines: true } },
];

export interface TraceResult extends VectorizeResult {
  /** source pixels per traced pixel (the bitmap may be downscaled) */
  pixelScaleX: number;
  pixelScaleY: number;
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

/** Trace an image node (subpaths in pixel coordinates of the traced bitmap). */
export async function traceImage(node: ImageNode, opts: TraceOptions): Promise<TraceResult> {
  const { data, scaleX, scaleY } = await imageDataOf(node, opts.maxSize);
  const r = await vectorizeAsync({ width: data.width, height: data.height, data: data.data }, opts);
  return { ...r, pixelScaleX: scaleX, pixelScaleY: scaleY };
}

/** SVG markup of a trace result (previews). */
export function traceSvg(r: VectorizeResult): string {
  const paths = r.layers.map((l) => `<path d="${pathToSvgD(l.subpaths)}" fill="${l.color}" fill-rule="nonzero"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.width} ${r.height}" width="${r.width}" height="${r.height}">${paths}</svg>`;
}

/**
 * Put a trace result into the document as a group of filled paths placed over
 * the image. Returns the group id (null when nothing was traced). Call inside
 * updateDoc with a pre-computed result (tracing itself is async).
 */
export function applyTrace(draft: Document, imageId: ID, traced: TraceResult, opts: TraceOptions): ID | null {
  const img = draft.nodes[imageId];
  if (!img || img.type !== 'image') return null;
  if (!traced.layers.length) return null;
  const parent = img.parent;
  const index = indexInParent(draft, imageId);
  const group = makeGroup([], { name: `${img.name} (traced)` });
  addNode(draft, group, parent, index + 1);
  for (const layer of traced.layers) {
    const node = makePath(layer.subpaths, { fill: { type: 'solid', color: layer.color, opacity: 1 }, stroke: noStroke(), name: `Fill ${layer.color}`, fillRule: 'nonzero' });
    addNode(draft, node, group.id);
  }
  // map traced pixels (cropped bitmap) onto the displayed image rectangle
  const crop = img.crop ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  const sx = (img.width / crop.width) * traced.pixelScaleX;
  const sy = (img.height / crop.height) * traced.pixelScaleY;
  const world = multiply(worldMatrix(draft, imageId), scaleM(sx, sy));
  group.transform = multiply(invert(parentWorldMatrix(draft, group.id)), world);
  if (opts.source === 'replace') removeNode(draft, imageId);
  else if (opts.source === 'hide') (draft.nodes[imageId] as ImageNode).visible = false;
  return group.id;
}

export function countTraced(draft: Document, groupId: ID): number {
  return descendants(draft, groupId).filter((id) => draft.nodes[id]?.type === 'path').length;
}
