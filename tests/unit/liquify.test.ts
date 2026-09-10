import { describe, it, expect } from 'vitest';
import { rectSubPath, ellipseSubPath } from '@/geometry/shapes';
import { anchor, pathBounds, subpathArea, pointAt, segmentCount } from '@/geometry/path';
import type { SubPath } from '@/model/types';
import { brushFrame, brushDistance, falloff, brushOutline, brushBounds, spacingFor, subdivideUnderBrush, deformSubPaths, displacement, touchedRuns, simplifyTolerance, dropUnusedInserted } from '@/liquify/brush';

function rectAt(x: number, y: number, w: number, h: number): SubPath {
  const sp = rectSubPath(w, h);
  return { closed: true, anchors: sp.anchors.map((a) => anchor({ x: a.point.x + x, y: a.point.y + y })) };
}

describe('liquify brush frame', () => {
  it('measures normalised distances in a rotated ellipse', () => {
    const f = brushFrame({ x: 100, y: 100, rx: 50, ry: 25, angle: 0 });
    expect(brushDistance(f, { x: 150, y: 100 })).toBeCloseTo(1);
    expect(brushDistance(f, { x: 100, y: 125 })).toBeCloseTo(1);
    expect(brushDistance(f, { x: 100, y: 100 })).toBe(0);
    // 90° counter-clockwise: the width axis points up on screen
    const g = brushFrame({ x: 100, y: 100, rx: 50, ry: 25, angle: 90 });
    expect(brushDistance(g, { x: 100, y: 50 })).toBeCloseTo(1);
    expect(brushDistance(g, { x: 125, y: 100 })).toBeCloseTo(1);
    const b = brushBounds({ x: 100, y: 100, rx: 50, ry: 25, angle: 90 });
    expect(b.width).toBeCloseTo(50);
    expect(b.height).toBeCloseTo(100);
    expect(brushOutline({ x: 0, y: 0, rx: 10, ry: 10, angle: 0 }, 8).length).toBe(8);
  });

  it('falls off smoothly to zero at the edge', () => {
    expect(falloff(0)).toBe(1);
    expect(falloff(0.5)).toBeGreaterThan(0.4);
    expect(falloff(0.5)).toBeLessThan(0.7);
    expect(falloff(1)).toBe(0);
    expect(falloff(2)).toBe(0);
    expect(spacingFor(100, 100, 2)).toBe(25);
    expect(spacingFor(100, 100, 50)).toBe(1);
    expect(simplifyTolerance(50)).toBeCloseTo(1.5);
  });
});

describe('subdivision under the brush', () => {
  it('adds anchors only on segments that pass through the brush', () => {
    const sp = rectAt(0, 0, 200, 100);
    // brush over the middle of the top edge
    const r = subdivideUnderBrush(sp, { x: 100, y: 0, rx: 40, ry: 40, angle: 0 }, 10);
    expect(r.inserted).toBeGreaterThan(5);
    expect(r.touched.length).toBe(r.sp.anchors.length);
    expect(r.touched.filter((t) => t === 3).length).toBe(r.inserted);
    expect(r.touched.filter((t) => t === 0).length).toBe(4);
    // the shape is unchanged
    expect(pathBounds([r.sp])).toEqual(pathBounds([sp]));
    expect(Math.abs(subpathArea(r.sp))).toBeCloseTo(Math.abs(subpathArea(sp)), 6);
    // inserted anchors sit on the top edge with collinear handles
    for (let i = 0; i < r.sp.anchors.length; i++) {
      if (r.touched[i] !== 3) continue;
      const a = r.sp.anchors[i];
      expect(a.point.y).toBe(0);
      expect(a.handleIn!.y).toBe(0);
      expect(a.handleOut!.y).toBe(0);
    }
    // nothing moved: dropping the unused anchors restores the plain rectangle
    const back = dropUnusedInserted(r.sp, r.touched);
    expect(back.sp.anchors.length).toBe(4);
    expect(back.sp.anchors.every((a) => a.handleIn === null && a.handleOut === null)).toBe(true);
    expect(back.touched).toEqual([0, 0, 0, 0]);
    // far away: nothing happens
    const far = subdivideUnderBrush(sp, { x: 1000, y: 1000, rx: 40, ry: 40, angle: 0 }, 10);
    expect(far.inserted).toBe(0);
    expect(far.sp).toBe(sp);
  });

  it('keeps curved geometry when splitting curves', () => {
    const sp = ellipseSubPath(100, 60, 0, 0);
    const r = subdivideUnderBrush(sp, { x: 100, y: 0, rx: 50, ry: 50, angle: 0 }, 8);
    expect(r.inserted).toBeGreaterThan(3);
    const b0 = pathBounds([sp])!;
    const b1 = pathBounds([r.sp])!;
    expect(b1.x).toBeCloseTo(b0.x, 3);
    expect(b1.width).toBeCloseTo(b0.width, 3);
    expect(Math.abs(subpathArea(r.sp)) / Math.abs(subpathArea(sp))).toBeCloseTo(1, 3);
    // points along the subdivided path lie on the original ellipse
    const n = segmentCount(r.sp);
    for (let i = 0; i < n; i++) {
      const p = pointAt(r.sp, i, 0.5);
      const e = (p.x / 100) ** 2 + (p.y / 60) ** 2;
      expect(e).toBeCloseTo(1, 2);
    }
  });
});

describe('deformation fields', () => {
  const brush = { x: 0, y: 0, rx: 50, ry: 50, angle: 0 };
  const f = brushFrame(brush);

  it('warp moves points with the pointer, weighted by the falloff', () => {
    const d = displacement(f, { x: 0, y: 0 }, { kind: 'warp', brush, strength: 1, delta: { x: 10, y: 0 }, spacing: 5 })!;
    expect(d.x).toBeCloseTo(10);
    const d2 = displacement(f, { x: 25, y: 0 }, { kind: 'warp', brush, strength: 0.5, delta: { x: 10, y: 0 }, spacing: 5 })!;
    expect(d2.x).toBeCloseTo(10 * 0.5 * falloff(0.5));
    expect(displacement(f, { x: 60, y: 0 }, { kind: 'warp', brush, strength: 1, delta: { x: 10, y: 0 }, spacing: 5 })).toBeNull();
  });

  it('twirl rotates counter-clockwise for a positive rate, pucker pulls in, bloat pushes out', () => {
    const t = displacement(f, { x: 20, y: 0 }, { kind: 'twirl', brush, strength: 1, rate: 90, spacing: 5 })!;
    expect(t.y).toBeLessThan(0); // up on screen
    const tc = displacement(f, { x: 20, y: 0 }, { kind: 'twirl', brush, strength: 1, rate: -90, spacing: 5 })!;
    expect(tc.y).toBeGreaterThan(0);
    const p = displacement(f, { x: 20, y: 10 }, { kind: 'pucker', brush, strength: 1, spacing: 5 })!;
    expect(p.x).toBeLessThan(0);
    expect(p.y).toBeLessThan(0);
    const b = displacement(f, { x: 20, y: 10 }, { kind: 'bloat', brush, strength: 1, spacing: 5 })!;
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBeGreaterThan(0);
  });

  it('scallop pulls inward, crystallize pushes outward, wrinkle moves vertically by default', () => {
    let inward = 0;
    let outward = 0;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const p = { x: Math.cos(a) * 25, y: Math.sin(a) * 25 };
      const s = displacement(f, p, { kind: 'scallop', brush, strength: 1, complexity: 3, seed: 0.3, spacing: 5 });
      const c = displacement(f, p, { kind: 'crystallize', brush, strength: 1, complexity: 3, seed: 0.3, spacing: 5 });
      if (s) inward += -(s.x * p.x + s.y * p.y);
      if (c) outward += c.x * p.x + c.y * p.y;
    }
    expect(inward).toBeGreaterThan(0);
    expect(outward).toBeGreaterThan(0);
    const w = displacement(f, { x: 10, y: 5 }, { kind: 'wrinkle', brush, strength: 1, complexity: 4, horizontal: 0, vertical: 1, seed: 0.1, spacing: 5 })!;
    expect(w.x).toBe(0);
    expect(Math.abs(w.y)).toBeGreaterThan(0);
  });
});

describe('deformSubPaths', () => {
  it('warps a rectangle edge and flags the touched anchors', () => {
    const sp = rectAt(0, 0, 200, 100);
    const brush = { x: 100, y: 0, rx: 40, ry: 40, angle: 0 };
    const r = deformSubPaths([sp], { kind: 'warp', brush, strength: 1, delta: { x: 0, y: -10 }, spacing: 10 });
    expect(r.changed).toBe(true);
    const b = pathBounds(r.sps)!;
    expect(b.y).toBeLessThan(-5);
    expect(b.y).toBeGreaterThan(-11);
    // corners stay
    const corners = r.sps[0].anchors.filter((a) => (a.point.x === 0 || a.point.x === 200) && (a.point.y === 0 || a.point.y === 100));
    expect(corners.length).toBe(4);
    const touched = r.touched[0];
    expect(touched.length).toBe(r.sps[0].anchors.length);
    expect(touched.filter((t) => t === 2).length).toBeGreaterThan(3);
    expect(touched.filter((t) => t === 0).length).toBe(4);
    // inserted anchors that never moved are dropped again when they are collinear
    const dropped = dropUnusedInserted(r.sps[0], touched);
    expect(dropped.sp.anchors.length).toBeLessThan(r.sps[0].anchors.length);
    expect(dropped.touched.length).toBe(dropped.sp.anchors.length);
    expect(dropped.touched.filter((t) => t === 2).length).toBe(touched.filter((t) => t === 2).length);
    // the untouched edges are plain lines again
    const left = dropped.sp.anchors.findIndex((a) => a.point.x === 0 && a.point.y === 100);
    expect(dropped.sp.anchors[left].handleIn).toBeNull();
    expect(dropped.sp.anchors[left].handleOut).toBeNull();
    // a second step keeps the flags and moves further
    const r2 = deformSubPaths(r.sps, { kind: 'warp', brush, strength: 1, delta: { x: 0, y: -10 }, spacing: 10 }, r.touched);
    expect(pathBounds(r2.sps)!.y).toBeLessThan(b.y);
  });

  it('pucker shrinks, bloat grows a circle under the brush', () => {
    const circle = ellipseSubPath(30, 30, 0, 0);
    const brush = { x: 0, y: 0, rx: 60, ry: 60, angle: 0 };
    const area0 = Math.abs(subpathArea(circle));
    let cur = [circle];
    for (let i = 0; i < 10; i++) cur = deformSubPaths(cur, { kind: 'pucker', brush, strength: 1, spacing: 5 }).sps;
    expect(Math.abs(subpathArea(cur[0]))).toBeLessThan(area0 * 0.8);
    cur = [circle];
    for (let i = 0; i < 10; i++) cur = deformSubPaths(cur, { kind: 'bloat', brush, strength: 1, spacing: 5 }).sps;
    expect(Math.abs(subpathArea(cur[0]))).toBeGreaterThan(area0 * 1.2);
  });

  it('does nothing outside the brush and honours the handle switches', () => {
    const sp = ellipseSubPath(30, 30, 0, 0);
    const far = deformSubPaths([sp], { kind: 'warp', brush: { x: 500, y: 500, rx: 20, ry: 20, angle: 0 }, strength: 1, delta: { x: 5, y: 5 }, spacing: 5 });
    expect(far.changed).toBe(false);
    expect(far.sps[0]).toBe(sp);
    const anchorsOnly = deformSubPaths([sp], { kind: 'bloat', brush: { x: 0, y: 0, rx: 60, ry: 60, angle: 0 }, strength: 1, spacing: 100, affectIn: false, affectOut: false });
    expect(anchorsOnly.changed).toBe(true);
    // handles kept relative: same handle vectors as before
    anchorsOnly.sps[0].anchors.forEach((a, i) => {
      expect(a.handleIn).toEqual(sp.anchors[i].handleIn);
      expect(a.handleOut).toEqual(sp.anchors[i].handleOut);
    });
  });
});

describe('touchedRuns', () => {
  it('finds contiguous runs and rotates closed subpaths so no run wraps', () => {
    const sp = rectAt(0, 0, 10, 10);
    const r = touchedRuns(sp, [2, 0, 0, 1]);
    expect(r.whole).toBe(false);
    expect(r.runs).toEqual([{ i: 2, j: 3 }]);
    expect(r.sp.anchors[0].point).toEqual({ x: 10, y: 0 });
    const open = touchedRuns({ ...sp, closed: false }, [2, 2, 0, 2]);
    expect(open.runs).toEqual([
      { i: 0, j: 1 },
      { i: 3, j: 3 },
    ]);
    expect(touchedRuns(sp, [2, 1, 2, 2]).whole).toBe(true);
    expect(touchedRuns(sp, [0, 0, 0, 0]).runs).toEqual([]);
  });
});
