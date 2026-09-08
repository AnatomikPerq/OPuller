/**
 * Rasterises freeform and mesh gradients into data URLs (browser only). The
 * image covers the object bounding box extended by `PAD` on every side (in
 * bbox units) so strokes and slightly overshooting geometry stay painted.
 */
import type { RasterGradientPaint, MeshGradientPaint, FreeformGradientPaint } from '@/model/types';
import { freeformColorAt, freeformSources } from './freeform';
import { evalPatch, patchColor } from './mesh';

export const PAD = 0.25;

export interface RasterTile {
  dataUrl: string;
  /** pixel size */
  width: number;
  height: number;
}

const cache = new Map<string, RasterTile>();
const MAX_CACHE = 80;

function remember(key: string, tile: RasterTile): RasterTile {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, tile);
  return tile;
}

/** Pixel size of the raster for an object aspect ratio (longest side = `size`). */
export function rasterSize(aspect: number, size: number): { w: number; h: number } {
  const a = Math.max(0.05, Math.min(20, aspect || 1));
  const total = 1 + PAD * 2;
  if (a >= 1) return { w: Math.round(size), h: Math.max(8, Math.round((size / a) * 1)) };
  return { w: Math.max(8, Math.round(size * a)), h: Math.round(size) };
  void total;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function toDataUrl(canvas: HTMLCanvasElement | OffscreenCanvas): string {
  if ('toDataURL' in canvas) return canvas.toDataURL('image/png');
  return '';
}

function renderFreeform(paint: FreeformGradientPaint, w: number, h: number): RasterTile | null {
  const canvas = makeCanvas(w, h);
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null;
  if (!canvas || !ctx) return null;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const sources = freeformSources(paint);
  const span = 1 + PAD * 2;
  for (let y = 0; y < h; y++) {
    const v = -PAD + ((y + 0.5) / h) * span;
    for (let x = 0; x < w; x++) {
      const u = -PAD + ((x + 0.5) / w) * span;
      const c = freeformColorAt(paint, u, v, sources);
      const i = (y * w + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = Math.round(Math.max(0, Math.min(1, c.a)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { dataUrl: toDataUrl(canvas), width: w, height: h };
}

function renderMesh(paint: MeshGradientPaint, w: number, h: number): RasterTile | null {
  const canvas = makeCanvas(w, h);
  const ctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null;
  if (!canvas || !ctx) return null;
  const span = 1 + PAD * 2;
  const sx = w / span;
  const sy = h / span;
  const px = (u: number) => (u + PAD) * sx;
  const py = (v: number) => (v + PAD) * sy;
  ctx.clearRect(0, 0, w, h);
  // the mesh only covers its own area: fill the outside with the nearest boundary colour by
  // extending boundary patches outward (simple approach: paint the bbox background with the
  // average colour first so strokes outside the mesh still get paint)
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let aa = 0;
  for (const n of paint.nodes) {
    const c = parseInt(n.color.slice(1), 16);
    ar += (c >> 16) & 255;
    ag += (c >> 8) & 255;
    ab += c & 255;
    aa += n.opacity;
  }
  const cnt = Math.max(1, paint.nodes.length);
  ctx.fillStyle = `rgba(${Math.round(ar / cnt)}, ${Math.round(ag / cnt)}, ${Math.round(ab / cnt)}, ${(aa / cnt).toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
  const N = Math.max(4, Math.min(24, Math.round(160 / Math.max(paint.rows, paint.cols))));
  for (let r = 0; r < paint.rows; r++) {
    for (let c = 0; c < paint.cols; c++) {
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const u0 = i / N;
          const u1 = (i + 1) / N;
          const v0 = j / N;
          const v1 = (j + 1) / N;
          const p00 = evalPatch(paint, r, c, u0, v0);
          const p10 = evalPatch(paint, r, c, u1, v0);
          const p11 = evalPatch(paint, r, c, u1, v1);
          const p01 = evalPatch(paint, r, c, u0, v1);
          const col = patchColor(paint, r, c, (u0 + u1) / 2, (v0 + v1) / 2);
          ctx.fillStyle = `rgba(${Math.round(col[0])}, ${Math.round(col[1])}, ${Math.round(col[2])}, ${col[3].toFixed(3)})`;
          // expand each quad slightly to hide antialiasing seams
          const cx = (p00.x + p10.x + p11.x + p01.x) / 4;
          const cy = (p00.y + p10.y + p11.y + p01.y) / 4;
          const grow = (p: { x: number; y: number }) => ({ x: px(p.x + (p.x - cx) * 0.08), y: py(p.y + (p.y - cy) * 0.08) });
          const q0 = grow(p00);
          const q1 = grow(p10);
          const q2 = grow(p11);
          const q3 = grow(p01);
          ctx.beginPath();
          ctx.moveTo(q0.x, q0.y);
          ctx.lineTo(q1.x, q1.y);
          ctx.lineTo(q2.x, q2.y);
          ctx.lineTo(q3.x, q3.y);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }
  return { dataUrl: toDataUrl(canvas), width: w, height: h };
}

/**
 * Raster tile for a paint. `aspect` = object width / height, `size` = pixels
 * on the longest side. Results are cached by paint content.
 */
export function rasterGradientTile(paint: RasterGradientPaint, aspect: number, size = 320): RasterTile | null {
  const { w, h } = rasterSize(aspect, size);
  const key = `${w}x${h}:${JSON.stringify(paint)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tile = paint.type === 'freeform' ? renderFreeform(paint, w, h) : renderMesh(paint, w, h);
  return tile ? remember(key, tile) : null;
}

export function clearRasterCache(): void {
  cache.clear();
}
