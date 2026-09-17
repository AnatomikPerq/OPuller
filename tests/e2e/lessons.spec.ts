/**
 * Regression fixtures built from Illustrator lessons (plan item 18): each lesson is scripted
 * through the scripting API, rendered and compared with the baseline PNG in
 * tests/e2e/lessons/baseline/. The baselines are OPuller's own renders (not Illustrator's):
 * they pin the behaviour of corner radii, live corners + warp, rotation direction, the
 * pencil's paint, the new effects, blends and align so a later change cannot drift silently.
 *
 *   UPDATE_LESSONS=1 npx playwright test tests/e2e/lessons.spec.ts   # rewrite the baselines
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { openApp } from './helpers';
import { buildOwl, buildKitten, buildRowan } from './lessons/lessons';

const BASE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lessons', 'baseline');
const UPDATE = !!process.env.UPDATE_LESSONS;

interface Compared {
  iou: number;
  colorMatch: number;
  width: number;
  height: number;
}

/** Render the artboard at half size and compare with a baseline data URL (both decoded in the page). */
async function renderAndCompare(page: Page, baseline: string | null): Promise<{ dataUrl: string; cmp: Compared | null }> {
  return page.evaluate(async (baseline) => {
    const r = await (window as any).__opuller.mcp.renderPng({ scope: 'artboard', scale: 0.5 });
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
    if (!baseline) return { dataUrl: r.dataUrl, cmp: null };
    const ref = await load(baseline);
    if (ref.width !== cur.width || ref.height !== cur.height) return { dataUrl: r.dataUrl, cmp: { iou: 0, colorMatch: 0, width: cur.width, height: cur.height } };
    // "ink" = pixels that differ from the artboard background (the top-left pixel)
    const bg = [cur.data[0], cur.data[1], cur.data[2]];
    const isInk = (d: Uint8ClampedArray, i: number) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40;
    let inter = 0;
    let union = 0;
    let same = 0;
    for (let i = 0; i < cur.data.length; i += 4) {
      const a = isInk(cur.data, i);
      const b = isInk(ref.data, i);
      if (a || b) union++;
      if (a && b) {
        inter++;
        const dc = Math.abs(cur.data[i] - ref.data[i]) + Math.abs(cur.data[i + 1] - ref.data[i + 1]) + Math.abs(cur.data[i + 2] - ref.data[i + 2]);
        if (dc < 60) same++;
      }
    }
    return { dataUrl: r.dataUrl, cmp: { iou: union ? inter / union : 1, colorMatch: inter ? same / inter : 1, width: cur.width, height: cur.height } };
  }, baseline);
}

const LESSONS: Array<{ name: string; build: () => void; size: [number, number] }> = [
  { name: 'owl', build: buildOwl, size: [800, 600] },
  { name: 'kitten', build: buildKitten, size: [800, 600] },
  { name: 'rowan', build: buildRowan, size: [800, 600] },
];

test.describe('Illustrator lessons', () => {
  for (const lesson of LESSONS) {
    test(`${lesson.name}: the scripted build matches its baseline (IoU ≥ 0.95)`, async ({ page }) => {
      await openApp(page);
      await page.evaluate(({ name, w, h }) => (window as any).__opuller.mcp.newDocument({ name, width: w, height: h }), { name: lesson.name, w: lesson.size[0], h: lesson.size[1] });
      await page.evaluate(() => (window as any).__opuller.mcp.projects({ op: 'home', open: false }));
      // the builders are plain functions: ship their source into the page
      await page.evaluate(`(${lesson.build.toString()})()`);
      const file = path.join(BASE_DIR, `${lesson.name}.png`);
      const baseline = !UPDATE && fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null;
      const { dataUrl, cmp } = await renderAndCompare(page, baseline);
      if (UPDATE || !baseline) {
        fs.mkdirSync(BASE_DIR, { recursive: true });
        fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
        test.info().annotations.push({ type: 'baseline', description: `written ${file}` });
        return;
      }
      expect(cmp).not.toBeNull();
      expect(cmp!.iou).toBeGreaterThanOrEqual(0.95);
      expect(cmp!.colorMatch).toBeGreaterThanOrEqual(0.95);
    });
  }
});
