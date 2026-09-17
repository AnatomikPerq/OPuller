import { describe, it, expect } from 'vitest';
import { zigZagSubPath, puckerBloatSubPath, roughenSubPaths, transformEffectSubPaths, tweakSubPaths, seededRandom, transformStepMatrix } from '@/distort/transformEffects';
import { rectSubPath, ellipseSubPath } from '@/geometry/shapes';
import { polylineSubPath, pathBounds, subpathToCubics, segmentCount } from '@/geometry/path';
import { cubicPoint } from '@/geometry/bezier';
import { applyToPoint } from '@/geometry/matrix';
import type { ZigZagEffect, RoughenEffect, TransformEffect, TweakEffect } from '@/model/types';

const frame = { x: 0, y: 0, width: 100, height: 100 };

describe('Zig Zag', () => {
  it('a 100 px segment with size 4 and 3 ridges gives 7 anchors with peaks at ±4 (plan item 7)', () => {
    const line = polylineSubPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], false);
    const e: ZigZagEffect = { type: 'zigZag', enabled: true, size: 4, relative: false, ridges: 3, smooth: false };
    const out = zigZagSubPath(line, e);
    expect(out.anchors).toHaveLength(7);
    expect(out.closed).toBe(false);
    const ys = out.anchors.map((a) => a.point.y);
    expect(ys[0]).toBe(0);
    expect(ys[6]).toBe(0);
    expect(ys.slice(1, 6).map((y) => Math.round(y))).toEqual([4, -4, 4, -4, 4]);
    // peaks are evenly spaced along the segment
    expect(out.anchors.map((a) => Math.round(a.point.x * 100) / 100)).toEqual([0, 16.67, 33.33, 50, 66.67, 83.33, 100]);
    // corner points: no handles
    expect(out.anchors.every((a) => !a.handleIn && !a.handleOut)).toBe(true);
  });

  it('smooth points make a wave with handles along the path; relative size scales with the segment', () => {
    const line = polylineSubPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], false);
    const smooth = zigZagSubPath(line, { type: 'zigZag', enabled: true, size: 4, relative: false, ridges: 3, smooth: true });
    expect(smooth.anchors).toHaveLength(7);
    const peak = smooth.anchors[1];
    expect(peak.kind).toBe('smooth');
    expect(Math.abs(peak.handleOut!.y)).toBeLessThan(1e-9); // tangent parallel to the baseline at a peak
    expect(peak.handleOut!.x).toBeGreaterThan(0);
    const rel = zigZagSubPath(line, { type: 'zigZag', enabled: true, size: 10, relative: true, ridges: 1, smooth: false });
    expect(rel.anchors).toHaveLength(3);
    expect(Math.abs(rel.anchors[1].point.y)).toBeCloseTo(10, 6); // 10 % of 100
  });

  it('closed paths keep their anchors and get ridges on every segment', () => {
    const sq = rectSubPath(100, 100);
    const out = zigZagSubPath(sq, { type: 'zigZag', enabled: true, size: 5, relative: false, ridges: 2, smooth: false });
    expect(out.closed).toBe(true);
    expect(out.anchors).toHaveLength(4 + 4 * 3);
    expect(out.anchors[0].point).toEqual({ x: 0, y: 0 });
    const b = pathBounds([out])!;
    expect(b.width).toBeCloseTo(110, 6);
    expect(b.height).toBeCloseTo(110, 6);
    // zero ridges / size: untouched
    expect(zigZagSubPath(sq, { type: 'zigZag', enabled: true, size: 0, relative: false, ridges: 3, smooth: false })).toBe(sq);
  });
});

describe('Pucker & Bloat', () => {
  it('bloat 100 % turns a square into a four-petal flower: anchors at the centre, petals beyond the edges', () => {
    const sq = rectSubPath(100, 100);
    const out = puckerBloatSubPath(sq, 100, { x: 50, y: 50 });
    expect(out.anchors).toHaveLength(4);
    for (const a of out.anchors) {
      expect(a.point.x).toBeCloseTo(50, 6);
      expect(a.point.y).toBeCloseTo(50, 6);
    }
    // the top segment's midpoint reaches (50, −50): the original midpoint (50, 0) pushed away from the centre by 100 %
    const c = subpathToCubics(out)[0];
    const m = cubicPoint(c, 0.5);
    expect(m.x).toBeCloseTo(50, 6);
    expect(m.y).toBeCloseTo(-50, 6);
  });

  it('pucker pulls the segments in and pushes the anchors out; 0 % is identity', () => {
    const sq = rectSubPath(100, 100);
    const out = puckerBloatSubPath(sq, -50, { x: 50, y: 50 });
    expect(out.anchors[0].point.x).toBeCloseTo(-25, 6); // corner moved outward by 50 % of its distance
    const m = cubicPoint(subpathToCubics(out)[0], 0.5);
    expect(m.y).toBeCloseTo(25, 6); // top edge midpoint moved half way to the centre
    expect(puckerBloatSubPath(sq, 0, { x: 50, y: 50 })).toBe(sq);
  });
});

describe('Roughen', () => {
  it('adds points at the requested detail, moves them at most by size and is stable for a seed', () => {
    const sq = rectSubPath(96, 96); // 4 inch perimeter
    const e: RoughenEffect = { type: 'roughen', enabled: true, size: 3, relative: false, detail: 10, smooth: false, seed: 7 };
    const out = roughenSubPaths([sq], e, { x: 0, y: 0, width: 96, height: 96 })[0];
    // ~10 points per inch → about 40 points around
    expect(out.anchors.length).toBeGreaterThanOrEqual(36);
    expect(out.anchors.length).toBeLessThanOrEqual(44);
    const b = pathBounds([out])!;
    expect(b.x).toBeGreaterThanOrEqual(-3.5);
    expect(b.y).toBeGreaterThanOrEqual(-3.5);
    expect(b.x + b.width).toBeLessThanOrEqual(99.5);
    const again = roughenSubPaths([sq], e, { x: 0, y: 0, width: 96, height: 96 })[0];
    expect(again).toEqual(out);
    const other = roughenSubPaths([sq], { ...e, seed: 8 }, { x: 0, y: 0, width: 96, height: 96 })[0];
    expect(other).not.toEqual(out);
    const smooth = roughenSubPaths([sq], { ...e, smooth: true }, { x: 0, y: 0, width: 96, height: 96 })[0];
    expect(smooth.anchors.every((a) => a.kind === 'smooth')).toBe(true);
    // relative size: 10 % of the longer side
    const rel = roughenSubPaths([sq], { ...e, size: 10, relative: true, detail: 2 }, { x: 0, y: 0, width: 96, height: 96 })[0];
    const rb = pathBounds([rel])!;
    expect(rb.x).toBeGreaterThanOrEqual(-9.7);
  });

  it('seeded random is deterministic and uniform in [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs.map(() => b())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, v) => s + v, 0) / xs.length).toBeGreaterThan(0.4);
  });
});

describe('Transform effect', () => {
  it('adds copies that accumulate the step (move + rotate about the origin, counter-clockwise)', () => {
    const sq = rectSubPath(10, 10);
    const e: TransformEffect = { type: 'transform', enabled: true, copies: 3, dx: 20, dy: 0, scaleX: 100, scaleY: 100, angle: 0, reflectX: false, reflectY: false, origin: 'center' };
    const out = transformEffectSubPaths([sq], e, { x: 0, y: 0, width: 10, height: 10 });
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(sq);
    expect(pathBounds([out[3]])!.x).toBeCloseTo(60, 6);
    // rotation: +90 about the centre sends the point to the right of the centre upwards
    const rot = transformStepMatrix({ ...e, dx: 0, angle: 90 }, { x: 0, y: 0, width: 10, height: 10 });
    const p = applyToPoint(rot, { x: 10, y: 5 });
    expect(p.x).toBeCloseTo(5, 6);
    expect(p.y).toBeCloseTo(0, 6);
    // scale about the top-left reference point, reflect
    const sc = transformEffectSubPaths([sq], { ...e, copies: 0, dx: 0, scaleX: 200, scaleY: 50, origin: 'topLeft' }, { x: 0, y: 0, width: 10, height: 10 });
    const b = pathBounds(sc)!;
    expect(b).toEqual({ x: 0, y: 0, width: 20, height: 5 });
    const rf = transformEffectSubPaths([sq], { ...e, copies: 1, dx: 0, reflectX: true, origin: 'right' }, { x: 0, y: 0, width: 10, height: 10 });
    expect(pathBounds([rf[1]])!.x).toBeCloseTo(10, 6);
    // copies are capped
    expect(transformEffectSubPaths([sq], { ...e, copies: 5000 }, { x: 0, y: 0, width: 10, height: 10 })).toHaveLength(501);
  });
});

describe('Tweak', () => {
  it('moves anchors and control points within the amounts, stable for a seed', () => {
    const el = ellipseSubPath(50, 30);
    const e: TweakEffect = { type: 'tweak', enabled: true, horizontal: 5, vertical: 2, relative: false, anchors: true, inControl: false, outControl: false, seed: 3 };
    const out = tweakSubPaths([el], e, frame)[0];
    expect(out.anchors).toHaveLength(el.anchors.length);
    out.anchors.forEach((a, i) => {
      expect(Math.abs(a.point.x - el.anchors[i].point.x)).toBeLessThanOrEqual(5);
      expect(Math.abs(a.point.y - el.anchors[i].point.y)).toBeLessThanOrEqual(2);
      // handles kept their absolute positions
      const h0 = { x: el.anchors[i].point.x + el.anchors[i].handleOut!.x, y: el.anchors[i].point.y + el.anchors[i].handleOut!.y };
      const h1 = { x: a.point.x + a.handleOut!.x, y: a.point.y + a.handleOut!.y };
      expect(h1.x).toBeCloseTo(h0.x, 6);
      expect(h1.y).toBeCloseTo(h0.y, 6);
    });
    expect(tweakSubPaths([el], e, frame)[0]).toEqual(out);
    const rel = tweakSubPaths([el], { ...e, relative: true, horizontal: 10, vertical: 10, anchors: false, outControl: true }, frame)[0];
    rel.anchors.forEach((a, i) => {
      expect(a.point).toEqual(el.anchors[i].point);
      expect(Math.abs(a.handleOut!.x - el.anchors[i].handleOut!.x)).toBeLessThanOrEqual(10);
    });
    expect(segmentCount(rel)).toBe(segmentCount(el));
  });
});
