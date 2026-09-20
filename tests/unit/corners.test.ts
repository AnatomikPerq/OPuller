import { describe, it, expect } from 'vitest';
import { clampRectRadii, roundSubPathCorners, applyLiveCorners, cornerAngle, isRoundableCorner, maxCornerRadius, cornerBisector } from '@/geometry/corners';
import { rectSubPath, polygonSubPath, roundCorners } from '@/geometry/shapes';
import { polylineSubPath, subpathToCubics, pathBounds, flattenSubPath, segmentCount } from '@/geometry/path';
import { warpSubPaths } from '@/distort/warp';
import { cubicLength } from '@/geometry/bezier';
import type { SubPath, WarpEffect } from '@/model/types';
import { transformSubPath } from '@/geometry/path';
import { scale, rotate, multiply, translate } from '@/geometry/matrix';
import { createDocument, makeShape, makePath } from '@/model/nodes';
import { addNode, worldSubPaths, refreshLiveShape, localBounds } from '@/model/document';
import { validateDocument } from '@/io/project';

/** Length of the straight run of a rounded rectangle along x = 0 (between the two left-side arcs). */
function leftStraightEdge(sp: SubPath): number {
  const cubics = subpathToCubics(sp);
  const lines = cubics.filter((c) => Math.abs(c.p0.x) < 1e-6 && Math.abs(c.p3.x) < 1e-6 && Math.abs(c.p1.x) < 1e-6 && Math.abs(c.p2.x) < 1e-6);
  return lines.reduce((s, c) => s + Math.abs(c.p3.y - c.p0.y), 0);
}

function triangle(): SubPath {
  return polylineSubPath(
    [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 50, y: 0 },
    ],
    true,
  );
}

/** Maximum distance from the tip (50,0) that the flattened outline reaches upward: rounded tips stay below y = 0 by a margin. */
function tipY(sp: SubPath): number {
  return Math.min(...flattenSubPath(sp, 0.05).map((p) => p.y));
}

describe('rectangle corner radii (plan item 2)', () => {
  it('lets one corner use the whole edge minus its neighbour instead of half the smaller side', () => {
    // the owl body: 47×61 with a 37.3 bottom-left radius next to a 23.636 top-left one
    const r = clampRectRadii(47, 61, [23.636, 23.636, 0, 37.3]);
    expect(r[3]).toBeCloseTo(37.3, 6); // untouched: tl + bl = 60.936 ≤ 61
    expect(r[2]).toBe(0);
    // the top pair overlaps the 47 width by 0.27 → scaled proportionally, not capped at 23.5 for every corner
    expect(r[0]).toBeCloseTo(23.5, 3);
    expect(r[1]).toBeCloseTo(23.5, 3);
    const sp = rectSubPath(47, 61, [23.636, 23.636, 0, 37.3]);
    expect(leftStraightEdge(sp)).toBeCloseTo(61 - r[0] - r[3], 3);
    expect(leftStraightEdge(sp)).toBeGreaterThan(0);
    const b = pathBounds([sp])!;
    expect(b.width).toBeCloseTo(47);
    expect(b.height).toBeCloseTo(61);
  });

  it('keeps the old behaviour for uniform radii that fit and scales overlapping pairs', () => {
    expect(clampRectRadii(100, 50, [10, 10, 10, 10])).toEqual([10, 10, 10, 10]);
    expect(clampRectRadii(100, 50, [40, 40, 40, 40])).toEqual([25, 25, 25, 25]);
    expect(clampRectRadii(100, 50, [50, 0, 0, 0])).toEqual([50, 0, 0, 0]);
    expect(clampRectRadii(100, 50, [60, 0, 0, 0])).toEqual([50, 0, 0, 0]);
    expect(clampRectRadii(100, 50, [-5, 10, NaN, 10])).toEqual([0, 10, 0, 10]);
  });
});

describe('corner rounding by tangent break (plan item 6)', () => {
  it('detects corners by the tangent angle, not by the absence of handles', () => {
    const sq = rectSubPath(100, 100);
    expect(cornerAngle(sq, 0)).toBeCloseTo(Math.PI / 2);
    expect(isRoundableCorner(sq, 1)).toBe(true);
    // a smooth anchor with collinear handles is not a corner
    const smooth: SubPath = { closed: false, anchors: [{ point: { x: 0, y: 0 }, handleIn: null, handleOut: { x: 30, y: 0 }, kind: 'corner' }, { point: { x: 50, y: 20 }, handleIn: { x: -20, y: -10 }, handleOut: { x: 20, y: 10 }, kind: 'smooth' }, { point: { x: 100, y: 40 }, handleIn: { x: -30, y: 0 }, handleOut: null, kind: 'corner' }] };
    expect(isRoundableCorner(smooth, 1)).toBe(false);
    expect(isRoundableCorner(smooth, 0)).toBe(false); // open path ends are never rounded
    // an anchor with two handles that point in different directions is a corner
    const kink: SubPath = { ...smooth, anchors: [smooth.anchors[0], { ...smooth.anchors[1], handleIn: { x: -20, y: 10 }, handleOut: { x: 20, y: 10 }, kind: 'corner' }, smooth.anchors[2]] };
    expect(isRoundableCorner(kink, 1)).toBe(true);
    const b = cornerBisector(sq, 0); // top-left corner of a rect: bisector points into the shape (down-right)
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBeGreaterThan(0);
  });

  it('rounds a square into a rounded rectangle (r = 20 → tangent points 20 from the corners)', () => {
    const out = roundCorners(rectSubPath(100, 100), 20);
    expect(out.anchors).toHaveLength(8);
    expect(out.closed).toBe(true);
    const xs = out.anchors.map((a) => a.point.x);
    const ys = out.anchors.map((a) => a.point.y);
    expect(xs.filter((x) => Math.abs(x - 20) < 1e-6 || Math.abs(x - 80) < 1e-6)).toHaveLength(4);
    expect(ys.filter((y) => Math.abs(y - 20) < 1e-6 || Math.abs(y - 80) < 1e-6)).toHaveLength(4);
    const b = pathBounds([out])!;
    expect(b.width).toBeCloseTo(100, 3);
    expect(b.height).toBeCloseTo(100, 3);
    // the arc passes close to a true circle of radius 20: its midpoint is at distance 20 from the corner centre (20,20)
    const arc = subpathToCubics(out).find((c) => cubicLength(c) > 25 && cubicLength(c) < 35)!;
    expect(arc).toBeTruthy();
  });

  it('caps the radius at the available edge so neighbouring corners never overlap', () => {
    const out = roundCorners(rectSubPath(100, 40), 50);
    const b = pathBounds([out])!;
    expect(b.width).toBeCloseTo(100, 3);
    expect(b.height).toBeCloseTo(40, 3);
    // the neighbours keep their radius; the corner gets the room left on its edges
    expect(maxCornerRadius(rectSubPath(100, 40), 0, (j) => (j === 3 ? 10 : 0))).toBeCloseTo(30, 3);
    // a lone rounded corner next to sharp ones may use the whole edges (Illustrator): up to the shorter edge
    expect(maxCornerRadius(rectSubPath(100, 40), 0, () => 0)).toBeCloseTo(40, 3);
    expect(maxCornerRadius(rectSubPath(100, 100), 0, (j) => (j === 1 ? 30 : 0))).toBeCloseTo(70, 3);
    // two rounded corners that do not fit share the edge proportionally: 60 + 60 on a 100 edge → 50 + 50
    const sq = rectSubPath(100, 100);
    const shared = roundSubPathCorners(sq, (j) => (j === 0 || j === 1 ? 60 : 0));
    expect(shared.anchors.some((a) => Math.abs(a.point.x - 50) < 1e-3 && Math.abs(a.point.y) < 1e-3)).toBe(true);
    // an open polyline: the end anchors stay, the middle corner is rounded
    const open = roundCorners(polylineSubPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], false), 10);
    expect(open.closed).toBe(false);
    expect(open.anchors[0].point).toEqual({ x: 0, y: 0 });
    expect(open.anchors[open.anchors.length - 1].point).toEqual({ x: 100, y: 100 });
    expect(open.anchors).toHaveLength(4);
  });

  it('rounds the tip of a triangle after a warp (curved sides with a tangent break at the tip)', () => {
    const tri = triangle();
    const e: WarpEffect = { type: 'warp', enabled: true, style: 'bulge', bend: 40, horizontal: false, hDistort: -10, vDistort: 0 };
    const warped = warpSubPaths([tri], e, pathBounds([tri])!)[0];
    // the warp writes one cubic per side, like Illustrator's Expand (halved only where a cubic cannot follow)
    expect(segmentCount(warped)).toBeLessThanOrEqual(6);
    expect(segmentCount(warped)).toBeGreaterThanOrEqual(3);
    const sharpTip = tipY(warped);
    const rounded = roundCorners(warped, 9);
    // the tip moved down by roughly the sagitta of a 9 px circle in a ~53° corner (≈ 9 / sin(θ/2) − 9 ≈ 11 px)
    expect(tipY(rounded) - sharpTip).toBeGreaterThan(6);
    expect(tipY(rounded) - sharpTip).toBeLessThan(16);
    // three corners rounded: two anchors each
    expect(rounded.anchors.length).toBe(warped.anchors.length + 3);
    expect(rounded.closed).toBe(true);
    // no anchor coincides with the sharp tip any more
    expect(rounded.anchors.some((a) => Math.abs(a.point.x - 50) < 1e-6 && a.point.y < sharpTip + 1e-6)).toBe(false);
  });

  it('live corners round only the anchors that carry a radius and strip the radius from the result', () => {
    const tri = triangle();
    tri.anchors[2].cornerRadius = 9;
    const out = applyLiveCorners(tri);
    expect(out.anchors).toHaveLength(4);
    expect(out.anchors.every((a) => a.cornerRadius === undefined)).toBe(true);
    expect(out.anchors[0].point).toEqual({ x: 0, y: 100 });
    expect(tipY(out)).toBeGreaterThan(5);
    // no radius → same object back
    const plain = triangle();
    expect(applyLiveCorners(plain)).toBe(plain);
    // per-anchor radii
    const sq = rectSubPath(100, 100);
    sq.anchors[0].cornerRadius = 10;
    sq.anchors[2].cornerRadius = 30;
    const r = roundSubPathCorners(sq, (_, a) => a.cornerRadius ?? 0);
    expect(r.anchors).toHaveLength(6);
    expect(r.anchors.some((a) => Math.abs(a.point.x - 70) < 1e-3 && Math.abs(a.point.y - 100) < 1e-3)).toBe(true);
  });

  it('rounds a hexagon and a star without changing the bounds beyond the corners', () => {
    const hex = polygonSubPath(6, 50);
    const out = roundCorners(hex, 8);
    expect(out.anchors).toHaveLength(12);
    const b0 = pathBounds([hex])!;
    const b1 = pathBounds([out])!;
    expect(b1.width).toBeLessThan(b0.width + 1e-6);
    expect(b1.height).toBeLessThan(b0.height + 1e-6);
  });
});

describe('live corners in the model', () => {
  it('radii scale with transforms, survive live-shape refreshes, project validation and bake into worldSubPaths on request', () => {
    const tri = triangle();
    tri.anchors[2].cornerRadius = 9;
    const scaled = transformSubPath(tri, multiply(translate(5, 5), scale(2, 2)));
    expect(scaled.anchors[2].cornerRadius).toBeCloseTo(18, 9);
    expect(scaled.anchors[0].cornerRadius).toBeUndefined();
    const turned = transformSubPath(tri, rotate(30));
    expect(turned.anchors[2].cornerRadius).toBeCloseTo(9, 9);
    // a live polygon keeps per-anchor radii when its parameters change (same anchor count)
    const poly = makeShape({ kind: 'polygon', sides: 6, radius: 50 }, {});
    poly.subpaths[0].anchors[1].cornerRadius = 7;
    poly.shape = { kind: 'polygon', sides: 6, radius: 80 };
    refreshLiveShape(poly);
    expect(poly.subpaths[0].anchors[1].cornerRadius).toBe(7);
    expect(poly.subpaths[0].anchors[0].cornerRadius).toBeUndefined();
    poly.shape = { kind: 'polygon', sides: 5, radius: 80 };
    refreshLiveShape(poly);
    expect(poly.subpaths[0].anchors.every((a) => a.cornerRadius === undefined)).toBe(true);
    // document: raw vs baked world geometry, bounds use the rounded outline
    const doc = createDocument({ name: 'c', width: 400, height: 400 });
    const path = makePath([tri], { name: 'Ear' });
    addNode(doc, path, doc.layers[0]);
    expect(worldSubPaths(doc, path.id)[0].anchors).toHaveLength(3);
    expect(worldSubPaths(doc, path.id)[0].anchors[2].cornerRadius).toBe(9);
    const baked = worldSubPaths(doc, path.id, { liveCorners: true })[0];
    expect(baked.anchors).toHaveLength(4);
    expect(baked.anchors.every((a) => a.cornerRadius === undefined)).toBe(true);
    expect(localBounds(doc, path.id)!.y).toBeGreaterThan(5); // the rounded tip sits below y = 0
    // project files: positive finite radii survive validation, junk does not
    const copy = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect((copy.nodes[path.id] as any).subpaths[0].anchors[2].cornerRadius).toBe(9);
    const junk = JSON.parse(JSON.stringify(doc));
    junk.nodes[path.id].subpaths[0].anchors[0].cornerRadius = -3;
    junk.nodes[path.id].subpaths[0].anchors[1].cornerRadius = 'big';
    junk.nodes[path.id].subpaths[0].anchors[2].cornerRadius = NaN;
    const cleaned = validateDocument(junk);
    expect((cleaned.nodes[path.id] as any).subpaths[0].anchors.every((a: any) => a.cornerRadius === undefined)).toBe(true);
  });
});
