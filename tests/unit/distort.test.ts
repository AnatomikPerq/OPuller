import { describe, it, expect } from 'vitest';
import { warpUnit, warpSubPaths, warpMap } from '@/distort/warp';
import { squareToQuad, applyHomography, freeDistortSubPaths, makeMeshDistort, meshDistortMap, coonsFromPath, coonsMap } from '@/distort/envelope';
import { mapSubPaths } from '@/distort/map';
import { extrudeFaces, revolveFaces, rotate3dSubPaths, shade, makeProjection } from '@/effects3d/geometry';
import { rectSubPath, ellipseSubPath } from '@/geometry/shapes';
import { pathBounds } from '@/geometry/path';
import type { WarpEffect, Extrude3DEffect, Revolve3DEffect, SubPath } from '@/model/types';

const frame = { x: 0, y: 0, width: 200, height: 100 };

describe('warp', () => {
  it('arch lifts the middle and keeps the sides; zero bend is identity', () => {
    const top = warpUnit('arch', 100, 0.5, 0, 200, 100);
    expect(top.y).toBeLessThan(0);
    const side = warpUnit('arch', 100, 0, 0, 200, 100);
    expect(side.y).toBeCloseTo(0, 6);
    expect(warpUnit('arch', 0, 0.3, 0.7, 200, 100)).toEqual({ x: 60, y: 70 });
    for (const style of ['arc', 'flag', 'fish', 'twist', 'fisheye', 'squeeze', 'rise', 'bulge'] as const) {
      const p = warpUnit(style, 0, 0.25, 0.75, 200, 100);
      expect(p.x, style).toBeCloseTo(50, 6);
      expect(p.y, style).toBeCloseTo(75, 6);
    }
  });

  it('warps subpaths smoothly with subdivision and honours the vertical axis', () => {
    const e: WarpEffect = { type: 'warp', enabled: true, style: 'arc', bend: 60, horizontal: true, hDistort: 0, vDistort: 0 };
    const out = warpSubPaths([rectSubPath(200, 100)], e, frame);
    expect(out[0].anchors.length).toBeGreaterThan(8);
    expect(out[0].closed).toBe(true);
    const b = pathBounds(out)!;
    expect(b.height).toBeGreaterThan(100);
    const vertical = warpMap({ ...e, horizontal: false }, frame)({ x: 100, y: 50 });
    expect(Number.isFinite(vertical.x)).toBe(true);
    const distorted = warpMap({ ...e, bend: 0, hDistort: 50 }, frame)({ x: 200, y: 100 });
    expect(distorted.x).toBeGreaterThan(200);
  });
});

describe('envelopes', () => {
  it('homography maps the unit square onto a quad', () => {
    const H = squareToQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 8 }, { x: -2, y: 8 }]);
    expect(applyHomography(H, 0, 0)).toEqual({ x: 0, y: 0 });
    const br = applyHomography(H, 1, 1);
    expect(br.x).toBeCloseTo(12, 6);
    expect(br.y).toBeCloseTo(8, 6);
    const mid = applyHomography(H, 0.5, 0.5);
    expect(mid.x).toBeCloseTo(5, 6);
    const out = freeDistortSubPaths([rectSubPath(200, 100)], { type: 'freeDistort', enabled: true, corners: [{ x: 0.2, y: 0 }, { x: 0.8, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, frame);
    const b = pathBounds(out)!;
    expect(b.width).toBeCloseTo(200, 3);
    expect(out[0].anchors[0].point.x).toBeCloseTo(40, 3);
  });

  it('mesh distort is identity for a regular grid and follows moved points', () => {
    const m = makeMeshDistort(2, 2);
    expect(m.points).toHaveLength(9);
    const id = meshDistortMap(m, frame)({ x: 50, y: 25 });
    expect(id.x).toBeCloseTo(50, 6);
    expect(id.y).toBeCloseTo(25, 6);
    const moved = { ...m, points: m.points.map((p, i) => (i === 4 ? { x: 0.7, y: 0.5 } : p)) };
    const c = meshDistortMap(moved, frame)({ x: 100, y: 50 });
    expect(c.x).toBeCloseTo(140, 6);
  });

  it('builds a Coons envelope from a path and maps the frame onto it', () => {
    const circle = ellipseSubPath(100, 50, 100, 50);
    const eff = coonsFromPath(circle, frame)!;
    expect(eff).toBeTruthy();
    expect(eff.top.length).toBeGreaterThan(10);
    const map = coonsMap(eff, frame);
    const centre = map({ x: 100, y: 50 });
    expect(centre.x).toBeCloseTo(100, 0);
    expect(centre.y).toBeCloseTo(50, 0);
    const corner = map({ x: 0, y: 0 });
    // the frame corner lands on the envelope outline, inside the original box
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.y).toBeGreaterThan(0);
  });

  it('mapSubPaths subdivides long segments', () => {
    const sp: SubPath = rectSubPath(100, 100);
    const out = mapSubPaths([sp], (p) => ({ x: p.x, y: p.y + Math.sin(p.x / 10) }), { x: 0, y: 0, width: 100, height: 100 }, 10);
    expect(out[0].anchors.length).toBeGreaterThan(20);
  });
});

describe('3D', () => {
  const ext: Extrude3DEffect = { type: 'extrude', enabled: true, depth: 40, rotX: -18, rotY: -26, rotZ: 8, perspective: 0, bevel: 'none', bevelHeight: 0, shading: 'plastic', lightAngle: 135, lightAltitude: 45, ambient: 50, capped: true };

  it('extrudes a rectangle into visible faces sorted far to near', () => {
    const faces = extrudeFaces([rectSubPath(100, 60)], { x: 0, y: 0, width: 100, height: 60 }, ext, '#ff0000');
    expect(faces.length).toBeGreaterThanOrEqual(3);
    const kinds = new Set(faces.map((f) => f.kind));
    expect(kinds.has('front')).toBe(true);
    expect(kinds.has('side')).toBe(true);
    for (let i = 1; i < faces.length; i++) expect(faces[i].depth).toBeGreaterThanOrEqual(faces[i - 1].depth);
    // shading darkens sides facing away from the light
    const front = faces.find((f) => f.kind === 'front')!;
    expect(front.rings[0]).toHaveLength(4);
    expect(front.color).not.toBe('#ff0000');
    const flat = extrudeFaces([rectSubPath(100, 60)], { x: 0, y: 0, width: 100, height: 60 }, { ...ext, shading: 'none' }, '#ff0000');
    expect(flat.every((f) => f.color === '#ff0000')).toBe(true);
    const bev = extrudeFaces([rectSubPath(100, 60)], { x: 0, y: 0, width: 100, height: 60 }, { ...ext, bevel: 'classic', bevelHeight: 5 }, '#ff0000');
    expect(bev.some((f) => f.kind === 'bevel')).toBe(true);
  });

  it('front view has no side faces; perspective changes projection; revolve makes bands', () => {
    const front = extrudeFaces([rectSubPath(100, 60)], { x: 0, y: 0, width: 100, height: 60 }, { ...ext, rotX: 0, rotY: 0, rotZ: 0 }, '#00ff00');
    expect(front.filter((f) => f.kind === 'side')).toHaveLength(0);
    const p0 = makeProjection({ x: 0, y: 0, width: 100, height: 100 }, 0, 0, 0, 0).project({ x: 50, y: 0, z: 30 });
    const p1 = makeProjection({ x: 0, y: 0, width: 100, height: 100 }, 0, 0, 0, 60).project({ x: 50, y: 0, z: 30 });
    expect(p1.x).toBeGreaterThan(p0.x);
    const rev: Revolve3DEffect = { type: 'revolve', enabled: true, angle: 360, offset: 0, axis: 'left', rotX: -18, rotY: -26, rotZ: 8, perspective: 0, shading: 'flat', lightAngle: 135, lightAltitude: 45, ambient: 50, steps: 12 };
    const profile: SubPath = { anchors: [{ point: { x: 0, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' }, { point: { x: 40, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' }, { point: { x: 40, y: 80 }, handleIn: null, handleOut: null, kind: 'corner' }], closed: false };
    const bands = revolveFaces([profile], { x: 0, y: 0, width: 40, height: 80 }, rev, '#0000ff');
    expect(bands).toHaveLength(24);
    const rot = rotate3dSubPaths([rectSubPath(100, 100)], { type: 'rotate3d', enabled: true, rotX: 0, rotY: 60, rotZ: 0, perspective: 0 }, { x: 0, y: 0, width: 100, height: 100 });
    expect(pathBounds(rot)!.width).toBeCloseTo(50, 0);
    expect(shade('#808080', { x: 0, y: 0, z: 1 }, 'flat', { x: 0, y: 0, z: 1 }, 0)).toBe('#808080');
  });
});
