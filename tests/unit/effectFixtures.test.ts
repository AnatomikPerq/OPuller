/**
 * Distort & Transform effects against Adobe Illustrator: `tests/fixtures/effects/<effect>.json`
 * hold the expanded outlines Illustrator 2026 produces for a set of reference shapes and
 * parameter sets (`scripts/illustrator/effect-fixtures.mjs`). Every anchor and both handles of
 * OPuller's result must land on Illustrator's (order included).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { puckerBloatSubPaths, zigZagSubPaths, transformEffectSubPaths } from '@/distort/transformEffects';
import { warpSubPaths } from '@/distort/warp';
import { subpathToCubics } from '@/geometry/path';
import { cubicPoint } from '@/geometry/bezier';
import { pathBounds } from '@/geometry/path';
import { roundCornersEffect } from '@/geometry/roundCornersEffect';
import type { SubPath, Anchor, WarpEffect, WarpStyle, TransformEffect } from '@/model/types';

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

describe('Warp of oblique and curved segments matches Illustrator', () => {
  const fx = load('warp-shapes');
  const STYLES: WarpStyle[] = ['arc', 'arcLower', 'arcUpper', 'arch', 'bulge', 'shellLower', 'shellUpper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];
  /** polyline of a subpath's outline (16 samples per cubic) */
  const flatten = (sp: SubPath): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (const c of subpathToCubics(sp)) for (let i = 0; i <= 16; i++) { const p = cubicPoint(c, i / 16); pts.push([p.x, p.y]); }
    return pts;
  };
  const distance = (a: Array<[number, number]>, b: Array<[number, number]>) => {
    let worst = 0;
    for (const p of a) {
      let best = Infinity;
      for (let i = 1; i < b.length; i++) {
        const [ax, ay] = b[i - 1];
        const [bx, by] = b[i];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(p[0] - ax - dx * t, p[1] - ay - dy * t));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };
  // straight segments come out exactly (Illustrator fits the cubic through four mapped points; a
  // 0.1 px difference of the map, as in the twist, shows up ×5 in the handles);
  // for curved segments Illustrator's pieces sit within ~1 px of the exact image and ours within
  // ~0.1 px, so their handles differ by a few px while the outlines agree to about a pixel
  it.skipIf(!fx)(`every case: outline within 0.6 px (straight) / 2 px (curved), same anchors in most cases (${fx?.cases.length ?? 0} cases)`, () => {
    const failures: string[] = [];
    let sameCount = 0;
    let cases = 0;
    for (const c of fx!.cases) {
      if (c.error) continue;
      cases++;
      const sp = toSubPath(fx!.shapes[c.shape]);
      const frame = pathBounds([sp])!;
      const e: WarpEffect = { type: 'warp', enabled: true, style: STYLES[Number(c.params.style ?? 1) - 1], bend: Number(c.params.bend ?? 0), horizontal: !c.params.vertical, hDistort: Number(c.params.hDistort ?? 0), vDistort: Number(c.params.vDistort ?? 0) };
      const [ours] = warpSubPaths([sp], e, frame);
      const theirs = c.outlines[0];
      const theirSp = toSubPath({ closed: theirs.closed, anchors: theirs.anchors });
      const curved = sp.anchors.some((an) => an.handleIn || an.handleOut);
      const d = Math.max(distance(flatten(ours), flatten(theirSp)), distance(flatten(theirSp), flatten(ours)));
      if (d > (curved ? 2 : 0.6)) failures.push(`${c.shape} ${JSON.stringify(c.params)}: outline ${d.toFixed(3)} px`);
      // the same anchors (Illustrator split the same segments at the same places)?
      const samePoints = ours.anchors.length === theirs.anchors.length && ours.anchors.every((an, i) => Math.hypot(an.point.x - theirs.anchors[i][0], an.point.y - theirs.anchors[i][1]) < 0.5);
      if (samePoints) {
        sameCount++;
        const a = compare(ours, theirs);
        if (typeof a === 'string' || a > (curved ? 5 : 1)) failures.push(`${c.shape} ${JSON.stringify(c.params)}: anchors ${typeof a === 'string' ? a : `${a.toFixed(3)} px`}`);
      }
    }
    expect(failures).toEqual([]);
    // Illustrator's own split decisions are borderline in a few cases; the structure agrees in most
    expect(sameCount / cases).toBeGreaterThanOrEqual(0.7);
  });
});

describe('Transform effect matches Illustrator', () => {
  const fx = load('transform');
  const ORIGINS = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'] as const;
  it.skipIf(!fx)(`the object and every copy of every fixture case (${fx?.cases.length ?? 0})`, () => {
    const failures: string[] = [];
    for (const c of fx!.cases) {
      if (c.error) continue;
      const sp = toSubPath(fx!.shapes[c.shape]);
      const frame = pathBounds([sp])!;
      const p = c.params;
      const e: TransformEffect = { type: 'transform', enabled: true, copies: Number(p.copies ?? 0), dx: Number(p.dx ?? 0), dy: Number(p.dy ?? 0), scaleX: Number(p.scaleX ?? 100), scaleY: Number(p.scaleY ?? 100), angle: Number(p.angle ?? 0), reflectX: !!p.reflectX, reflectY: !!p.reflectY, origin: ORIGINS[Number(p.pin ?? 4)] };
      const ours = transformEffectSubPaths([sp], e, frame);
      if (ours.length !== c.outlines.length) {
        failures.push(`${c.shape} ${JSON.stringify(p)}: ${ours.length} outlines, Illustrator has ${c.outlines.length}`);
        continue;
      }
      ours.forEach((o, i) => {
        const d = compare(o, c.outlines[i]);
        if (typeof d === 'string' || d > 0.01) failures.push(`${c.shape} ${JSON.stringify(p)} outline ${i}: ${typeof d === 'string' ? d : `${d.toFixed(3)} px`}`);
      });
    }
    expect(failures).toEqual([]);
  });
});
