/**
 * Raster images decoded to 8-bit RGB hex for the PostScript-family exporters
 * (EPS `image`, Illustrator `XI`). Decoding needs a canvas, so it runs in the
 * browser ahead of the (synchronous, pure) exporters, which then read the cache.
 */
import type { Document, ID, Node } from '@/model/types';

export interface PreparedRaster {
  width: number;
  height: number;
  /** RGB samples, row-major from the top row, as hex lines of 72 characters */
  hex: string;
}

const cache = new Map<string, PreparedRaster>();

/** The decoded pixels of an image source (after prepareRasterImages), if any. */
export function preparedRaster(src: string): PreparedRaster | undefined {
  return cache.get(src);
}

/** Register decoded pixels (tests and non-browser callers). */
export function setPreparedRaster(src: string, raster: PreparedRaster): void {
  cache.set(src, raster);
}

/** Decode the raster images of the document (or of the given ids) into the cache. Browser only, async. */
export async function prepareRasterImages(doc: Document, ids?: ID[], maxSize = 1024): Promise<number> {
  const only = ids ? new Set(ids) : null;
  const nodes = Object.values(doc.nodes).filter((nd): nd is Extract<Node, { type: 'image' }> => nd.type === 'image' && (!only || only.has(nd.id)));
  let count = 0;
  for (const nd of nodes) {
    if (cache.has(nd.src)) continue;
    try {
      const img = await loadImage(nd.src);
      const k = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k));
      const h = Math.max(1, Math.round(img.height * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      cache.set(nd.src, { width: w, height: h, hex: rgbaToHexLines(data) });
      count++;
    } catch {
      /* skip undecodable images */
    }
  }
  return count;
}

/** RGBA bytes → RGB hex text in lines of 72 characters (24 pixels). */
export function rgbaToHexLines(data: Uint8ClampedArray | Uint8Array | number[]): string {
  const parts: string[] = [];
  let line = '';
  for (let i = 0; i < data.length; i += 4) {
    line += HEX[data[i]] + HEX[data[i + 1]] + HEX[data[i + 2]];
    if (line.length >= 72) {
      parts.push(line);
      line = '';
    }
  }
  if (line) parts.push(line);
  return parts.join('\n');
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}
