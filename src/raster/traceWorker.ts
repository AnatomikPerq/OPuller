/**
 * Web Worker entry for Image Trace: runs the pure vectorize pipeline off the
 * main thread. Messages: { id, width, height, buffer, options } →
 * { id, result } | { id, error }.
 */
import { vectorize, type VectorizeOptions } from './vectorize';

interface Request {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  options: Partial<VectorizeOptions>;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage: (m: unknown) => void };

ctx.onmessage = (e: MessageEvent<Request>) => {
  const { id, width, height, buffer, options } = e.data;
  try {
    const result = vectorize({ width, height, data: new Uint8ClampedArray(buffer) }, options);
    ctx.postMessage({ id, result });
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
