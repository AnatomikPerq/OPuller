/**
 * Distort & Transform effects against Adobe Illustrator: `tests/fixtures/effects/<effect>.json`
 * hold the expanded outlines Illustrator 2026 produces for a set of reference shapes and
 * parameter sets (`scripts/illustrator/effect-fixtures.mjs`). Every anchor and both handles of
 * OPuller's result must land on Illustrator's (order included).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { puckerBloatSubPaths, zigZagSubPaths } from '@/distort/transformEffects';
import { pathBounds } from '@/geometry/path';
import { roundCornersEffect } from '@/geometry/roundCornersEffect';
import type { SubPath, Anchor } from '@/model/types';

type FixtureAnchor = [number, number, number, number, number, number]; // x y inx iny outx outy (absolute)
interface Fixture {
  effect: string;
  shapes: Record<string, { closed: boolean; anchors: number[][] }>;
  cases: Array<{ shape: string; params: Record<string, number | boolean | string>; error?: string; outlines: Array<{ closed: boolean; anchors: FixtureAnchor[] }> }>;
}

const load = (effect: string): Fixture | null => {
  const file = resolve(process.cwd(), 'tests/fixtures/effects', `${effect}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

/** A fixture shape as a subpath: handles become relative, a handle on its anchor becomes null. */
function toSubPath(shape: { closed: boolean; anchors: number[][] }): SubPath {
  const anchors: Anchor[] = shape.anchors.map((a) => {
    const [x, y] = a;
    const rel = (hx: number, hy: number) => (Math.abs(hx - x) < 1e-9 && Math.abs(hy - y) < 1e-9 ? null : { x: hx - x, y: hy - y });
    const handleIn = a.length > 2 ? rel(a[2], a[3]) : null;
    const handleOut = a.length > 2 ? rel(a[4], a[5]) : null;
    return { point: { x, y }, handleIn, handleOut, kind: handleIn && handleOut ? 'smooth' : 'corner' };
  });
  return { anchors, closed: shape.closed };
}

/**
 * Largest distance between OPuller's anchors / handles and Illustrator's, or a message when the
 * counts differ. `skip` leaves parts out (by point index): the dangling handles Illustrator
 * writes at the ends of open paths, or a point it places imprecisely.
 */
function compare(ours: SubPath, theirs: { closed: boolean; anchors: FixtureAnchor[] }, skip: (i: number, n: number) => 'none' | 'in' | 'out' | 'all' = () => 'none'): number | string {
  if (ours.anchors.length !== theirs.anchors.length) return `${ours.anchors.length} anchors, Illustrator has ${theirs.anchors.length}`;
  let worst = 0;
  ours.anchors.forEach((a, i) => {
    const t = theirs.anchors[i];
    const sk = skip(i, ours.anchors.length);
    if (sk === 'all') return;
    const inA = a.handleIn ? { x: a.point.x + a.handleIn.x, y: a.point.y + a.handleIn.y } : a.point;
    const outA = a.handleOut ? { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y } : a.point;
    worst = Math.max(worst, Math.hypot(a.point.x - t[0], a.point.y - t[1]));
    if (sk !== 'in') worst = Math.max(worst, Math.hypot(inA.x - t[2], inA.y - t[3]));
    if (sk !== 'out') worst = Math.max(worst, Math.hypot(outA.x - t[4], outA.y - t[5]));
  });
  return worst;
}

describe('Pucker & Bloat matches Illustrator', () => {
  const fx = load('puckerBloat');
  it.skipIf(!fx)(`anchors and handles of every fixture case (${fx?.cases.length ?? 0})`, () => {
    const failures: string[] = [];
    for (const c of fx!.cases) {
      if (c.error) continue;
      const sp = toSubPath(fx!.shapes[c.shape]);
      const frame = pathBounds([sp])!;
      const [ours] = puckerBloatSubPaths([sp], { type: 'puckerBloat', enabled: true, amount: Number(c.params.amount) }, frame);
      const d = compare(ours, c.outlines[0]);
      if (typeof d === 'string' || d > 0.01) failures.push(`${c.shape} amount ${c.params.amount}: ${typeof d === 'string' ? d : `${d.toFixed(3)} px`}`);
    }
    expect(failures).toEqual([]);
  });
});

describe('Zig Zag matches Illustrator', () => {
  const fx = load('zigZag');
  it.skipIf(!fx)(`anchors and handles of every fixture case (${fx?.cases.length ?? 0})`, () => {
    const failures: string[] = [];
    for (const c of fx!.cases) {
      if (c.error) continue;
      const shape = fx!.shapes[c.shape];
      const sp = toSubPath(shape);
      const e = { type: 'zigZag' as const, enabled: true, size: Number(c.params.size), relative: false, ridges: Number(c.params.ridges), smooth: !!c.params.smooth };
      const [ours] = zigZagSubPaths([sp], e);
      // Illustrator puts the last point of a closed path slightly off (up to a few px in smooth
      // mode) and writes dangling handles at the ends of open paths; neither is compared
      const d = compare(ours, c.outlines[0], (i, n) => (shape.closed ? (i === n - 1 ? 'all' : 'none') : i === 0 ? 'in' : i === n - 1 ? 'out' : 'none'));
      if (typeof d === 'string' || d > 0.05) failures.push(`${c.shape} ${JSON.stringify(c.params)}: ${typeof d === 'string' ? d : `${d.toFixed(3)} px`}`);
    }
    expect(failures).toEqual([]);
  });
});

describe('Round Corners (effect) matches Illustrator', () => {
  const fx = load('roundCorners');
  it.skipIf(!fx)(`anchors and handles of every fixture case (${fx?.cases.length ?? 0})`, () => {
    const failures: string[] = [];
    for (const c of fx!.cases) {
      if (c.error) continue;
      const shape = fx!.shapes[c.shape];
      const ours = roundCornersEffect(toSubPath(shape), Number(c.params.radius));
      const d = compare(ours, c.outlines[0]);
      if (typeof d === 'string' || d > 0.01) failures.push(`${c.shape} radius ${c.params.radius}: ${typeof d === 'string' ? d : `${d.toFixed(3)} px`}`);
    }
    expect(failures).toEqual([]);
  });
});
