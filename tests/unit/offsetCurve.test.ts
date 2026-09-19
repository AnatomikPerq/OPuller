import { describe, it, expect } from 'vitest';
import { offsetCubic, cubicTangent } from '@/geometry/offsetCurve';
import { cubicPoint, type Cubic } from '@/geometry/bezier';

const K = 0.5522847498;
/** quarter circle of radius r around the origin from (r,0) to (0,r), clockwise on screen */
const quarter = (r: number): Cubic => ({ p0: { x: r, y: 0 }, p1: { x: r, y: r * K }, p2: { x: r * K, y: r }, p3: { x: 0, y: r } });

describe('one-sided cubic offset', () => {
  it('offsets a quarter circle to a concentric arc within 0.1 px, ends exactly on the normals', () => {
    for (const d of [20, -20, 55]) {
      const pieces = offsetCubic(quarter(100), d);
      // the left normal of a clockwise (screen) arc points inward: radius shrinks by d
      const R = 100 - d;
      expect(pieces[0].p0.x).toBeCloseTo(R, 9);
      expect(pieces[0].p0.y).toBeCloseTo(0, 9);
      expect(pieces[pieces.length - 1].p3.x).toBeCloseTo(0, 9);
      expect(pieces[pieces.length - 1].p3.y).toBeCloseTo(R, 9);
      let worst = 0;
      for (const c of pieces) for (let i = 0; i <= 10; i++) worst = Math.max(worst, Math.abs(Math.hypot(cubicPoint(c, i / 10).x, cubicPoint(c, i / 10).y) - R));
      expect(worst).toBeLessThan(0.1);
      expect(pieces.length).toBeLessThan(8);
    }
  });

  it('translates straight segments and copes with a handle lying on its anchor', () => {
    const line = offsetCubic({ p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p3: { x: 100, y: 0 } }, 10);
    expect(line).toHaveLength(1);
    expect(line[0].p0).toEqual({ x: 0, y: 10 });
    expect(line[0].p3).toEqual({ x: 100, y: 10 });
    // degenerate start handle: the tangent comes from the next control point, so the offset start is exact
    const c: Cubic = { p0: { x: 100, y: 100 }, p1: { x: 100, y: 100 }, p2: { x: 100, y: 0 }, p3: { x: 200, y: 100 } };
    expect(cubicTangent(c, 0)).toEqual({ x: 0, y: -1 });
    const pieces = offsetCubic(c, 20);
    expect(pieces[0].p0.x).toBeCloseTo(120, 9);
    expect(pieces[0].p0.y).toBeCloseTo(100, 9);
    expect(pieces.length).toBeLessThan(40);
    for (const p of pieces) for (const q of [p.p0, p.p1, p.p2, p.p3]) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
  });

  it('stays bounded on the inner side of a bend tighter than the offset', () => {
    const hook: Cubic = { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 100, y: -200 }, p3: { x: 300, y: 0 } };
    expect(offsetCubic(hook, 20).length).toBeLessThan(600);
    expect(offsetCubic(hook, -20).length).toBeLessThan(60);
  });
});
