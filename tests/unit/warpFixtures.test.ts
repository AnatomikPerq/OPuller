/**
 * The warp effect against Adobe Illustrator: `tests/fixtures/warp/*.json` hold, for every style,
 * bend, axis and distortion, the image of a lattice of points and the expanded outline of the
 * frame square as Illustrator 2026 produces them (`scripts/illustrator/warp-fixtures.mjs`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { warpMap, warpSubPaths } from '@/distort/warp';
import { rectSubPath } from '@/geometry/shapes';
import type { WarpEffect, WarpStyle } from '@/model/types';

interface Fixture {
  frame: { width: number; height: number };
  lattice: number;
  cases: Array<{ style: WarpStyle; bend: number; horizontal: boolean; hDistort: number; vDistort: number; outline: number[][]; grid: number[][][] }>;
}

const load = (name: string): Fixture => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/warp', name), 'utf8'));
const FIXTURES = ['illustrator.json', 'illustrator-300x100.json'].map((name) => ({ name, fx: load(name) }));

const effectOf = (c: Fixture['cases'][number]): WarpEffect => ({ type: 'warp', enabled: true, style: c.style, bend: c.bend, horizontal: c.horizontal, hDistort: c.hDistort, vDistort: c.vDistort });
const label = (c: Fixture['cases'][number]) => `${c.style} bend ${c.bend}${c.horizontal ? '' : ' vertical'} h${c.hDistort} v${c.vDistort}`;

describe('warp effect matches Illustrator', () => {
  for (const { name, fx } of FIXTURES) {
    const frame = { x: 0, y: 0, width: fx.frame.width, height: fx.frame.height };
    const N = fx.lattice;

    it(`${name}: every lattice point lands where Illustrator puts it (${fx.cases.length} cases)`, () => {
      const failures: string[] = [];
      for (const c of fx.cases) {
        const map = warpMap(effectOf(c), frame);
        let worst = 0;
        for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
          const p = map({ x: (i / N) * frame.width, y: (j / N) * frame.height });
          const [gx, gy] = c.grid[j][i];
          worst = Math.max(worst, Math.hypot(p.x - gx, p.y - gy));
        }
        if (worst > 0.1) failures.push(`${label(c)}: ${worst.toFixed(3)} px`);
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });

    it(`${name}: the frame square expands to the same four anchors and handles`, () => {
      const failures: string[] = [];
      for (const c of fx.cases) {
        const out = warpSubPaths([rectSubPath(frame.width, frame.height)], effectOf(c), frame);
        const anchors = out[0].anchors;
        if (anchors.length !== 4) {
          failures.push(`${label(c)}: ${anchors.length} anchors`);
          continue;
        }
        // the orientation of the two paths may differ, so compare unordered {in, out} pairs
        for (const [x, y, inX, inY, outX, outY] of c.outline) {
          const a = anchors.reduce((best, cand) => (Math.hypot(cand.point.x - x, cand.point.y - y) < Math.hypot(best.point.x - x, best.point.y - y) ? cand : best));
          const hin = a.handleIn ? { x: a.point.x + a.handleIn.x, y: a.point.y + a.handleIn.y } : a.point;
          const hout = a.handleOut ? { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y } : a.point;
          const d = (p: { x: number; y: number }, qx: number, qy: number) => Math.hypot(p.x - qx, p.y - qy);
          const direct = Math.max(d(hin, inX, inY), d(hout, outX, outY));
          const swapped = Math.max(d(hin, outX, outY), d(hout, inX, inY));
          const err = Math.max(d(a.point, x, y), Math.min(direct, swapped));
          if (err > 0.1) failures.push(`${label(c)}: anchor (${x}, ${y}) off by ${err.toFixed(3)} px`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});
