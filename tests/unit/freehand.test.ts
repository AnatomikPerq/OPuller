import { describe, it, expect } from 'vitest';
import { polylineSubPath, segmentCount, pointAt, anchor, pathBounds } from '@/geometry/path';
import { rectSubPath, ellipseSubPath } from '@/geometry/shapes';
import type { SubPath, Vec } from '@/model/types';
import {
  StrokeSampler,
  resampleByDistance,
  smoothSamples,
  endsNearStart,
  brushWidthAt,
  pressureLookup,
  outlineRing,
  constrainTo45,
  polylineLength,
} from '@/tools/freehand/sampling';
import { cutAt, eraseIntervals, normalizeIntervals, replacePortion, extendSubPath, closeIfNear, offsetU, touchIntervals, insideIntervals, touchedAnchorRange, islands, distanceToPolyline } from '@/tools/freehand/cut';

// Paper.js cannot run under vitest (no canvas), so these tests cover the pure
// sampling / cutting logic; fitting and booleans are covered by the e2e suite.

const P = (x: number, y: number): Vec => ({ x, y });

function rectAt(x: number, y: number, w: number, h: number): SubPath {
  const sp = rectSubPath(w, h);
  return { closed: true, anchors: sp.anchors.map((a) => anchor({ x: a.point.x + x, y: a.point.y + y })) };
}

describe('sampling', () => {
  it('drops samples closer than minDist and keeps runs for straight segments', () => {
    const s = new StrokeSampler(2);
    expect(s.add(P(0, 0))).toBe(true);
    expect(s.add(P(1, 0))).toBe(false);
    expect(s.add(P(5, 0))).toBe(true);
    s.beginStraight(P(5, 0));
    s.add(P(20, 0));
    s.add(P(30, 0));
    expect(s.inStraight).toBe(true);
    expect(s.points().length).toBe(3); // pending straight end included
    s.endStraight();
    expect(s.inStraight).toBe(false);
    s.add(P(35, 5));
    const runs = s.runs();
    expect(runs.map((r) => r.straight)).toEqual([false, true, false]);
    expect(runs[1].points.map((p) => p.x)).toEqual([5, 30]);
    // runs share their end points
    expect(runs[0].points[runs[0].points.length - 1].x).toBe(5);
    expect(runs[2].points[0].x).toBe(30);
  });

  it('resamples evenly and interpolates pressure', () => {
    const pts = [
      { x: 0, y: 0, pressure: 0 },
      { x: 10, y: 0, pressure: 1 },
    ];
    const r = resampleByDistance(pts, 2.5);
    expect(r.map((p) => p.x)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(r[2].pressure).toBeCloseTo(0.5);
    expect(polylineLength(r)).toBeCloseTo(10);
  });

  it('smooths interior samples and keeps the ends', () => {
    const pts = [0, 10, 0, 10, 0].map((y, i) => ({ x: i * 5, y, pressure: 1 }));
    const s = smoothSamples(pts, 2);
    expect(s[0].y).toBe(0);
    expect(s[4].y).toBe(0);
    expect(Math.abs(s[1].y - s[2].y)).toBeLessThan(Math.abs(pts[1].y - pts[2].y));
  });

  it('detects a closing gesture only for long enough strokes', () => {
    const circle = [] as Vec[];
    for (let i = 0; i <= 20; i++) circle.push(P(Math.cos((i / 20) * Math.PI * 2) * 50, Math.sin((i / 20) * Math.PI * 2) * 50));
    circle[circle.length - 1].x += 5;
    expect(endsNearStart(circle, 10)).toBe(true);
    expect(endsNearStart([P(0, 0), P(3, 0), P(1, 1)], 10)).toBe(false);
  });

  it('computes brush widths with pressure and taper', () => {
    const o = { width: 20, usePressure: true, taperStart: 50, taperEnd: 0 };
    expect(brushWidthAt(0.5, 1, o)).toBeCloseTo(20);
    expect(brushWidthAt(0.5, 0, o)).toBeCloseTo(3);
    expect(brushWidthAt(0, 1, o)).toBeCloseTo(0);
    expect(brushWidthAt(0.25, 1, o)).toBeCloseTo(10);
    expect(brushWidthAt(0.25, 1, { ...o, usePressure: false, taperStart: 0 })).toBeCloseTo(20);
    const look = pressureLookup([
      { x: 0, y: 0, pressure: 0.2 },
      { x: 10, y: 0, pressure: 0.8 },
    ]);
    expect(look(0.5)).toBeCloseTo(0.5);
  });

  it('builds a closed outline ring with round caps', () => {
    const ring = outlineRing([P(0, 0), P(10, 0), P(20, 0)], [5, 5, 5]);
    const b = pathBounds([polylineSubPath(ring, true)])!;
    expect(b.x).toBeCloseTo(-5, 0);
    expect(b.x + b.width).toBeCloseTo(25, 0);
    expect(b.y).toBeCloseTo(-5, 0);
    expect(b.height).toBeCloseTo(10, 0);
    expect(ring.length).toBeGreaterThan(10);
  });

  it('constrains to 45 degree steps', () => {
    const c = constrainTo45(P(0, 0), P(10, 1));
    expect(c.y).toBeCloseTo(0);
    expect(c.x).toBeCloseTo(Math.hypot(10, 1));
    const d = constrainTo45(P(0, 0), P(10, 9));
    expect(d.x).toBeCloseTo(d.y);
  });
});

describe('cutting', () => {
  it('inserts cut anchors at parametric locations on straight and curved segments', () => {
    const sp = polylineSubPath([P(0, 0), P(100, 0), P(100, 100)]);
    const { sp: cut, indices } = cutAt(sp, [0.5, 1.5, 0.25]);
    expect(cut.anchors.length).toBe(6);
    expect(indices).toEqual([2, 4, 1]);
    // cuts land on the geometry (straight segments have a non-linear parameterisation)
    expect(cut.anchors[1].point.y).toBe(0);
    expect(cut.anchors[2].point.y).toBe(0);
    expect(cut.anchors[1].point.x).toBeLessThan(cut.anchors[2].point.x);
    expect(cut.anchors[4].point.x).toBe(100);
    // anchor cuts do not insert
    const r = cutAt(sp, [1, 0]);
    expect(r.sp.anchors.length).toBe(3);
    expect(r.indices).toEqual([1, 0]);
  });

  it('erases an interval from an open path into two pieces', () => {
    const sp = polylineSubPath([P(0, 0), P(100, 0)]);
    const u1 = 0.3;
    const u2 = 0.7;
    const pieces = eraseIntervals(sp, [{ from: u1, to: u2 }]);
    expect(pieces).toHaveLength(2);
    const a = pointAt(sp, 0, u1);
    const b = pointAt(sp, 0, u2);
    expect(pieces[0].anchors[0].point.x).toBe(0);
    expect(pieces[0].anchors[1].point.x).toBeCloseTo(a.x, 5);
    expect(pieces[1].anchors[0].point.x).toBeCloseTo(b.x, 5);
    expect(pieces[1].anchors[1].point.x).toBe(100);
    expect(pieces.every((p) => !p.closed)).toBe(true);
    // erasing from the start keeps one piece; erasing everything keeps none
    expect(eraseIntervals(sp, [{ from: 0, to: 0.5 }])).toHaveLength(1);
    expect(eraseIntervals(sp, [{ from: 0, to: 1 }])).toHaveLength(0);
    // several intervals
    const many = eraseIntervals(polylineSubPath([P(0, 0), P(100, 0), P(200, 0), P(300, 0)]), [
      { from: 0.2, to: 0.4 },
      { from: 1.5, to: 2.5 },
    ]);
    expect(many).toHaveLength(3);
    expect(many[2].anchors[0].point.x).toBeGreaterThan(200);
  });

  it('opens a closed path when erasing, including wrapping intervals', () => {
    const rect = rectAt(0, 0, 200, 100);
    const pieces = eraseIntervals(rect, [{ from: 0.25, to: 0.75 }]);
    expect(pieces).toHaveLength(1);
    const p = pieces[0];
    expect(p.closed).toBe(false);
    expect(p.anchors.length).toBe(6);
    expect(p.anchors[0].point.x).toBeGreaterThan(p.anchors[p.anchors.length - 1].point.x);
    expect(p.anchors[0].point.y).toBe(0);
    // wrapping interval across the seam (u = 3.5 .. 0.5): the remaining arc is the right/bottom part
    const wrap = eraseIntervals(rect, [{ from: 3.5, to: 0.5 }]);
    expect(wrap).toHaveLength(1);
    expect(wrap[0].closed).toBe(false);
    expect(wrap[0].anchors[0].point.y).toBe(0);
    expect(wrap[0].anchors[wrap[0].anchors.length - 1].point.x).toBe(0);
    // two intervals on a closed path give two open pieces
    const two = eraseIntervals(rect, [
      { from: 0.4, to: 0.6 },
      { from: 2.4, to: 2.6 },
    ]);
    expect(two).toHaveLength(2);
    expect(two.every((s) => !s.closed)).toBe(true);
    expect(normalizeIntervals([{ from: 0, to: 4 }], 4, true)).toBe('all');
  });

  it('replaces a portion of open and closed paths with a stroke', () => {
    const line = polylineSubPath([P(0, 0), P(100, 0)]);
    const bump = polylineSubPath([P(25, 0), P(50, -40), P(75, 0)]);
    const r = replacePortion(line, 0.25, 0.75, bump, bump.anchors.map((a) => a.point));
    expect(r.closed).toBe(false);
    expect(r.anchors.map((a) => a.point.y)).toContain(-40);
    expect(r.anchors[0].point.x).toBe(0);
    expect(r.anchors[r.anchors.length - 1].point.x).toBe(100);
    // drawn backwards: same result
    const rb = replacePortion(line, 0.75, 0.25, polylineSubPath([P(75, 0), P(50, -40), P(25, 0)]), [P(75, 0), P(50, -40), P(25, 0)]);
    expect(rb.anchors.map((a) => a.point.y)).toContain(-40);
    expect(rb.anchors[0].point.x).toBe(0);
    // closed rect: replace the top edge portion with a bump upwards; the rest stays
    const rect = rectAt(0, 0, 200, 100);
    const top = polylineSubPath([P(50, 0), P(100, -50), P(150, 0)]);
    const rc = replacePortion(rect, 0.25, 0.75, top, top.anchors.map((a) => a.point));
    expect(rc.closed).toBe(true);
    const b = pathBounds([rc])!;
    expect(b.y).toBe(-50);
    expect(b.height).toBe(150);
    expect(b.width).toBe(200);
  });

  it('extends and closes paths', () => {
    const line = polylineSubPath([P(0, 0), P(100, 0)]);
    const more = polylineSubPath([P(100, 0), P(150, 50), P(200, 0)]);
    const ext = extendSubPath(line, more, false);
    expect(ext.anchors.length).toBe(4);
    expect(ext.anchors[3].point.x).toBe(200);
    const pre = extendSubPath(line, polylineSubPath([P(0, 0), P(-50, 50)]), true);
    expect(pre.anchors[0].point.x).toBe(-50);
    expect(pre.anchors[pre.anchors.length - 1].point.x).toBe(100);
    const loop = polylineSubPath([P(0, 0), P(100, 0), P(100, 100), P(2, 1)]);
    const closed = closeIfNear(loop, 5);
    expect(closed.closed).toBe(true);
    expect(closed.anchors.length).toBe(3);
    expect(closeIfNear(loop, 1).closed).toBe(false);
  });

  it('offsets locations by arc length (not by parameter)', () => {
    const line = polylineSubPath([P(0, 0), P(100, 0)]);
    const u = offsetU(line, 0, 25);
    expect(pointAt(line, 0, u).x).toBeCloseTo(25, 3);
    const back = offsetU(line, u, -10);
    expect(pointAt(line, 0, back).x).toBeCloseTo(15, 3);
    expect(offsetU(line, 0.5, 1000)).toBe(1);
    const rect = rectAt(0, 0, 100, 100);
    const w = offsetU(rect, 3.9, 50); // wraps through the seam onto the top edge
    expect(w).toBeLessThan(1);
    const p = pointAt(rect, Math.floor(w), w - Math.floor(w));
    expect(p.y).toBeCloseTo(0, 3);
  });

  it('finds touched intervals along a path from samples', () => {
    const rect = rectAt(0, 0, 200, 100);
    const samples = [P(50, 0), P(80, 0), P(110, 0), P(150, 0)];
    const iv = touchIntervals(rect, samples, 4, 0);
    expect(iv).toHaveLength(1);
    expect(pointAt(rect, 0, iv[0].from).x).toBeCloseTo(50, 3);
    expect(pointAt(rect, 0, iv[0].to).x).toBeCloseTo(150, 3);
    // padding widens the interval by arc length
    const pad = touchIntervals(rect, samples, 4, 10)[0];
    expect(pointAt(rect, 0, pad.from).x).toBeCloseTo(40, 3);
    expect(pointAt(rect, 0, pad.to).x).toBeCloseTo(160, 3);
    // samples far away touch nothing; a wrap across the seam is detected
    expect(touchIntervals(rect, [P(50, 50)], 4)).toHaveLength(0);
    const seam = touchIntervals(rect, [P(0, 30), P(0, 10), P(20, 0), P(40, 0)], 4);
    expect(seam).toHaveLength(1);
    expect(seam[0].from).toBeGreaterThan(seam[0].to);
  });

  it('finds the intervals of a path inside an area', () => {
    const line = polylineSubPath([P(0, 0), P(300, 0)]);
    const area = [rectAt(100, -10, 100, 20)];
    const iv = insideIntervals(line, area);
    expect(iv).toHaveLength(1);
    expect(pointAt(line, 0, iv[0].from).x).toBeCloseTo(100, 1);
    expect(pointAt(line, 0, iv[0].to).x).toBeCloseTo(200, 1);
    const pieces = eraseIntervals(line, iv);
    expect(pieces).toHaveLength(2);
    // a circle crossing the seam of a closed path yields one wrapping interval
    const rect = rectAt(0, 0, 200, 100);
    const circle = [ellipseSubPath(15, 15, 0, 0)];
    const w = insideIntervals(rect, circle);
    expect(w).toHaveLength(1);
    expect(w[0].from).toBeGreaterThan(w[0].to);
    const open = eraseIntervals(rect, w);
    expect(open).toHaveLength(1);
    expect(open[0].closed).toBe(false);
  });

  it('finds the anchor range touched by a drag', () => {
    const zig = polylineSubPath([0, 1, 2, 3, 4, 5, 6].map((i) => P(i * 10, i % 2 ? 5 : 0)));
    const r = touchedAnchorRange(zig, [P(20, 2), P(30, 3), P(40, 2)], 6)!;
    expect(r.whole).toBe(false);
    expect(r.i).toBeLessThanOrEqual(2);
    expect(r.j).toBeGreaterThanOrEqual(4);
    expect(touchedAnchorRange(zig, [P(20, 40)], 6)).toBeNull();
    const rect = rectAt(0, 0, 100, 100);
    const wrap = touchedAnchorRange(rect, [P(20, 100), P(0, 80), P(0, 20), P(20, 0)], 4)!;
    expect(wrap.i).toBe(2);
    expect(wrap.j).toBe(1);
    expect(touchedAnchorRange(rect, [P(50, 0), P(100, 50), P(50, 100), P(0, 50)], 4)!.whole).toBe(true);
  });

  it('groups boolean results into islands (outer contours with their holes)', () => {
    const outerA = rectAt(0, 0, 100, 100);
    const holeA = rectAt(40, 40, 20, 20);
    const outerB = rectAt(200, 0, 50, 50);
    const inHole = rectAt(45, 45, 5, 5);
    const groups = islands([holeA, outerB, outerA, inHole]);
    expect(groups).toHaveLength(3);
    const withHole = groups.find((g) => g.includes(outerA))!;
    expect(withHole).toContain(holeA);
    expect(withHole).not.toContain(inHole);
    expect(groups.find((g) => g.includes(outerB))!.length).toBe(1);
    expect(groups.find((g) => g.includes(inHole))!.length).toBe(1);
  });

  it('measures distance to a polyline', () => {
    expect(distanceToPolyline(P(5, 3), [P(0, 0), P(10, 0)])).toBeCloseTo(3);
    expect(distanceToPolyline(P(-4, 0), [P(0, 0), P(10, 0)])).toBeCloseTo(4);
    expect(segmentCount(polylineSubPath([P(0, 0), P(1, 1)], true))).toBe(2);
  });
});
