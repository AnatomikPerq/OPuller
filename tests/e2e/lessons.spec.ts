/**
 * Regression fixtures built from Illustrator lessons (plan item 18): each lesson is scripted
 * through the scripting API, rendered and compared with two references in tests/e2e/lessons/:
 *
 *  * baseline/<name>.png — OPuller's own render, pinning corner radii, live corners + warp,
 *    rotation direction, the pencil's paint, the new effects, blends and align so a later
 *    change cannot drift silently (`UPDATE_LESSONS=1` rewrites them after an intended change);
 *  * illustrator/<name>.png — Adobe Illustrator's render of the exported .ai file, written by
 *    lessons-illustrator.spec.ts on a machine with Illustrator; the real reference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openApp } from './helpers';
import { LESSONS, LESSON_SIZE, compareRenders, BASELINE_DIR, BASELINE_IOU, ILLUSTRATOR_DIR, ILLUSTRATOR_IOU, ILLUSTRATOR_COLOR } from './lessons/compare';

const UPDATE = !!process.env.UPDATE_LESSONS;
const asDataUrl = (file: string) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

test.describe('Illustrator lessons', () => {
  for (const [name, build] of Object.entries(LESSONS)) {
    test(`${name}: the scripted build matches its baseline (IoU ≥ ${BASELINE_IOU}) and Illustrator's render`, async ({ page }) => {
      await openApp(page);
      await page.evaluate(({ name, w, h }) => (window as any).__opuller.mcp.newDocument({ name, width: w, height: h }), { name, w: LESSON_SIZE[0], h: LESSON_SIZE[1] });
      await page.evaluate(() => (window as any).__opuller.mcp.projects({ op: 'home', open: false }));
      // the builders are plain functions: ship their source into the page
      await page.evaluate(`(${build.toString()})()`);
      const file = path.join(BASELINE_DIR, `${name}.png`);
      const baseline = !UPDATE && fs.existsSync(file) ? asDataUrl(file) : null;
      const cmp = await compareRenders(page, baseline);
      if (UPDATE || !baseline) {
        fs.mkdirSync(BASELINE_DIR, { recursive: true });
        fs.writeFileSync(file, Buffer.from(cmp.dataUrl.split(',')[1], 'base64'));
        test.info().annotations.push({ type: 'baseline', description: `written ${file}` });
      } else {
        expect(cmp.iou).toBeGreaterThanOrEqual(BASELINE_IOU);
        expect(cmp.colorMatch).toBeGreaterThanOrEqual(BASELINE_IOU);
      }
      const ref = path.join(ILLUSTRATOR_DIR, `${name}.png`);
      if (fs.existsSync(ref)) {
        const ai = await compareRenders(page, asDataUrl(ref));
        test.info().annotations.push({ type: 'illustrator', description: `IoU ${ai.iou.toFixed(3)}, colour match ${ai.colorMatch.toFixed(3)}` });
        expect(ai.iou).toBeGreaterThanOrEqual(ILLUSTRATOR_IOU);
        expect(ai.colorMatch).toBeGreaterThanOrEqual(ILLUSTRATOR_COLOR);
      }
    });
  }
});
