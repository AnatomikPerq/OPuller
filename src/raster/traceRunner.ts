/**
 * Runs Image Trace in a Web Worker (one shared worker, requests answered in
 * order). Falls back to the main thread when workers are unavailable.
 */
import { vectorize, type VectorizeOptions, type VectorizeResult } from './vectorize';
import type { RasterImage } from './quantize';

interface Pending {
  resolve: (r: VectorizeResult) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(message: string) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./traceWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; result?: VectorizeResult; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p.reject(new Error(e.data.error));
    else if (e.data.result) p.resolve(e.data.result);
    else p.reject(new Error('Image Trace failed'));
  };
  worker.onerror = (e) => {
    failAll(e.message || 'Image Trace worker failed');
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Trace pixels; resolves with subpaths in pixel coordinates. */
export function vectorizeAsync(img: RasterImage, options: Partial<VectorizeOptions>): Promise<VectorizeResult> {
  const w = getWorker();
  if (!w) return Promise.resolve(vectorize(img, options));
  const id = ++seq;
  const buffer = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength) as ArrayBuffer;
  return new Promise<VectorizeResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, width: img.width, height: img.height, buffer, options }, [buffer]);
    } catch (err) {
      pending.delete(id);
      // structured clone / transfer problems: run inline
      try {
        resolve(vectorize(img, options));
      } catch (e2) {
        reject(e2 as Error);
      }
      void err;
    }
  });
}

/** Number of trace requests still running (for tests / status). */
export function pendingTraces(): number {
  return pending.size;
}
