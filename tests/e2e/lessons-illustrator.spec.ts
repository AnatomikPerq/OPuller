/**
 * Illustrator references for the lesson builds (plan item 18). With ILLUSTRATOR=1 and Adobe
 * Illustrator installed, every lesson is built, exported as an Illustrator 8 .ai file,
 * rendered by Illustrator itself (scripts/illustrator/render-file.mjs) into
 * tests/e2e/lessons/illustrator/<name>.png and compared with OPuller's own render. Without
 * the flag the spec is skipped; lessons.spec.ts compares against the references on every run.
 *
 *   ILLUSTRATOR=1 npx playwright test tests/e2e/lessons-illustrator.spec.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { openApp } from './helpers';
import { LESSONS, LESSON_SIZE, compareRenders, ILLUSTRATOR_DIR, ILLUSTRATOR_IOU, ILLUSTRATOR_COLOR } from './lessons/compare';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCALE = 0.5; // the baselines are half-size renders
const PX_PER_PT = 96 / 72; // .ai files are written in points

test.describe('Illustrator renders of the lessons', () => {
  test.skip(!process.env.ILLUSTRATOR, 'set ILLUSTRATOR=1 with Adobe Illustrator installed to (re)build the references');
  for (const [name, build] of Object.entries(LESSONS)) {
    test(`${name}: exported .ai rendered by Illustrator matches OPuller's render`, async ({ page }) => {
      test.setTimeout(180_000);
      await openApp(page);
      await page.evaluate(({ name, w, h }) => (window as any).__opuller.mcp.newDocument({ name, width: w, height: h }), { name, w: LESSON_SIZE[0], h: LESSON_SIZE[1] });
      await page.evaluate(() => (window as any).__opuller.mcp.projects({ op: 'home', open: false }));
      await page.evaluate(`(${build.toString()})()`);
      const ai = await page.evaluate(() => (window as any).__opuller.mcp.exportFile({ format: 'ai', scope: 'artboard' }));
      expect(ai.aiFormat).toBe('legacy');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opuller-lesson-'));
      const aiFile = path.join(tmp, `${name}.ai`);
      fs.writeFileSync(aiFile, ai.text, 'latin1');
      fs.mkdirSync(ILLUSTRATOR_DIR, { recursive: true });
      const ref = path.join(ILLUSTRATOR_DIR, `${name}.png`);
      execFileSync('node', [path.join(ROOT, 'scripts', 'illustrator', 'render-file.mjs'), aiFile, ref, '--scale', String(SCALE * PX_PER_PT)], { stdio: 'inherit', timeout: 150_000 });
      fs.rmSync(tmp, { recursive: true, force: true });
      const cmp = await compareRenders(page, `data:image/png;base64,${fs.readFileSync(ref).toString('base64')}`, SCALE);
      test.info().annotations.push({ type: 'illustrator', description: `${name}: IoU ${cmp.iou.toFixed(3)}, colour match ${cmp.colorMatch.toFixed(3)} (${cmp.width}×${cmp.height})` });
      expect(cmp.iou).toBeGreaterThanOrEqual(ILLUSTRATOR_IOU);
      expect(cmp.colorMatch).toBeGreaterThanOrEqual(ILLUSTRATOR_COLOR);
    });
  }
});
