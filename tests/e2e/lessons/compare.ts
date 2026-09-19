/**
 * Shared bits of the lesson specs: the lesson list, where the reference images live and the
 * in-page comparison of OPuller's render with a reference PNG (both decoded on a canvas).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { LESSONS } from './lessons';

export { LESSONS };
export const LESSON_SIZE: [number, number] = [800, 600];

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** OPuller's own half-size renders (regression pins). */
export const BASELINE_DIR = path.join(HERE, 'baseline');
/** Illustrator's renders of the exported .ai files (lessons-illustrator.spec.ts). */
export const ILLUSTRATOR_DIR = path.join(HERE, 'illustrator');

/** Thresholds against OPuller's own baselines… */
export const BASELINE_IOU = 0.95;
/** …and against Illustrator (anti-aliasing, stroke joins and effect expansion differ a little). */
export const ILLUSTRATOR_IOU = 0.93;
export const ILLUSTRATOR_COLOR = 0.97;

export interface Compared {
  iou: number;
  colorMatch: number;
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * Render the artboard at `scale` and compare with a reference data URL. "Ink" = pixels that
 * differ from the artboard background (the top-left pixel); IoU is over ink, colorMatch the
 * share of shared interior ink pixels whose colours agree.
 */
export async function compareRenders(page: Page, reference: string | null, scale = 0.5): Promise<Compared> {
  return page.evaluate(
    async ({ reference, scale }) => {
      const r = await (window as any).__opuller.mcp.renderPng({ scope: 'artboard', scale });
      const load = (src: string) =>
        new Promise<ImageData>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, c.width, c.height));
          };
          img.onerror = reject;
          img.src = src;
        });
      const cur = await load(r.dataUrl);
      if (!reference) return { iou: 1, colorMatch: 1, width: cur.width, height: cur.height, dataUrl: r.dataUrl };
      const ref = await load(reference);
      if (ref.width !== cur.width || ref.height !== cur.height) return { iou: 0, colorMatch: 0, width: cur.width, height: cur.height, dataUrl: r.dataUrl };
      const bg = [cur.data[0], cur.data[1], cur.data[2]];
      const W = cur.width;
      const isInk = (d: Uint8ClampedArray, i: number) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40;
      // colours are compared away from the edges (all four neighbours inked in both images), so
      // anti-aliasing differences do not count against thin shapes
      const interior = (d: Uint8ClampedArray, i: number) => {
        const p = i / 4;
        const x = p % W;
        const y = (p - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === cur.height - 1) return false;
        return isInk(d, i - 4) && isInk(d, i + 4) && isInk(d, i - W * 4) && isInk(d, i + W * 4);
      };
      let inter = 0;
      let union = 0;
      let inside = 0;
      let same = 0;
      for (let i = 0; i < cur.data.length; i += 4) {
        const a = isInk(cur.data, i);
        const b = isInk(ref.data, i);
        if (a || b) union++;
        if (a && b) {
          inter++;
          if (interior(cur.data, i) && interior(ref.data, i)) {
            inside++;
            const dc = Math.abs(cur.data[i] - ref.data[i]) + Math.abs(cur.data[i + 1] - ref.data[i + 1]) + Math.abs(cur.data[i + 2] - ref.data[i + 2]);
            if (dc < 60) same++;
          }
        }
      }
      return { iou: union ? inter / union : 1, colorMatch: inside ? same / inside : 1, width: cur.width, height: cur.height, dataUrl: r.dataUrl };
    },
    { reference, scale },
  );
}
