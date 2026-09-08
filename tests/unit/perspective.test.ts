import { describe, it, expect } from 'vitest';
import { defaultGrid, depth, inverseDepth, wallPoint, floorPoint, planePoint, planeCoords, projectRect, attachCorners, flatToPlane, planeToFlat, projectPoint, unprojectPoint, planeLines, gridHandles, dragHandle, withType } from '@/perspective/grid';
import { attachToPlane, attachmentOf, moveAttached, removePerspective, flatRectOf, pointInPolygon } from '@/perspective/ops';
import { createDocument, makeShape } from '@/model/nodes';
import { addNode, worldBounds } from '@/model/document';
import { freeDistortSubPaths } from '@/distort/envelope';
import { registerGeometryEffect } from '@/canvas/effectiveGeometry';
import type { FreeDistortEffect } from '@/model/types';

registerGeometryEffect('freeDistort', (sps, e, frame) => freeDistortSubPaths(sps, e as FreeDistortEffect, frame));

const ab = { x: 0, y: 0, width: 1920, height: 1080 };
const g = defaultGrid(ab, 2);

describe('perspective grid maths', () => {
  it('foreshortening is monotonic, 1:1 near the origin and invertible', () => {
    expect(depth(0, 500, 1000)).toBe(0);
    expect(depth(1, 500, 500)).toBeCloseTo(0.5, 9);
    expect(depth(3, 500, 500)).toBeCloseTo(0.75, 9);
    // a flat distance of 10 with the VP 1000 away moves the point ≈ 10 px
    expect(depth(10 / 500, 500, 1000) * 1000).toBeCloseTo(9.9, 1);
    for (const a of [0, 0.3, 1, 2.5]) expect(inverseDepth(depth(a, 500, 1200), 500, 1200)).toBeCloseTo(a, 9);
  });

  it('wall points recede towards the vanishing point and shrink with depth', () => {
    const near = wallPoint(g, 'right', 0, 0);
    const far = wallPoint(g, 'right', 1, 0);
    const farther = wallPoint(g, 'right', 3, 0);
    expect(near).toEqual({ x: g.corner, y: g.ground });
    expect(far.x).toBeGreaterThan(near.x);
    expect(farther.x).toBeGreaterThan(far.x);
    expect(farther.x).toBeLessThan(g.vpRight);
    // the ground line rises towards the horizon
    expect(far.y).toBeLessThan(near.y);
    expect(far.y).toBeGreaterThan(g.horizon);
    // wall height shrinks with depth
    const hNear = near.y - wallPoint(g, 'right', 0, 1).y;
    const hFar = far.y - wallPoint(g, 'right', 1, 1).y;
    expect(hNear).toBeCloseTo(g.height, 6);
    expect(hFar).toBeLessThan(hNear);
    // the left wall mirrors the right wall
    const left = wallPoint(g, 'left', 1, 0);
    expect(g.corner - left.x).toBeCloseTo(far.x - g.corner, 6);
    expect(left.y).toBeCloseTo(far.y, 6);
  });

  it('the floor meets both walls along their ground lines', () => {
    expect(floorPoint(g, 0, 0)).toEqual({ x: g.corner, y: g.ground });
    const r = floorPoint(g, 1, 0);
    expect(r.x).toBeCloseTo(wallPoint(g, 'right', 1, 0).x, 6);
    expect(r.y).toBeCloseTo(wallPoint(g, 'right', 1, 0).y, 6);
    const l = floorPoint(g, 0, 1);
    expect(l.x).toBeCloseTo(wallPoint(g, 'left', 1, 0).x, 6);
    const back = floorPoint(g, 1, 1);
    expect(back.y).toBeLessThan(r.y);
    expect(back.y).toBeGreaterThan(g.horizon);
    // one-point grids: the floor recedes straight ahead
    const one = withType(g, 1);
    const b1 = floorPoint(one, 1, 1);
    expect(b1.x).toBeCloseTo(one.corner, 6);
    expect(b1.y).toBeLessThan(one.ground);
  });

  it('planeCoords inverts planePoint on every plane and grid type', () => {
    for (const type of [1, 2, 3] as const) {
      const gg = withType(g, type);
      for (const plane of ['left', 'right', 'floor'] as const) {
        for (const [u, v] of [[0.2, 0.3], [0.8, 0.9], [1.4, 0.1], [0.5, 1.5]]) {
          const p = planePoint(gg, plane, u, v);
          const c = planeCoords(gg, plane, p);
          const q = planePoint(gg, plane, c.u, c.v);
          expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(0.5);
        }
      }
    }
  });

  it('flat ↔ plane coordinate conversions and projections round-trip', () => {
    const flat = { x: g.corner + 150, y: g.ground - 80 };
    const pc = flatToPlane(g, 'right', flat);
    expect(pc.u).toBeCloseTo(150 / g.extent, 9);
    expect(pc.v).toBeCloseTo(80 / g.height, 9);
    const back = planeToFlat(g, 'right', pc.u, pc.v);
    expect(back.x).toBeCloseTo(flat.x, 9);
    expect(back.y).toBeCloseTo(flat.y, 9);
    const projected = projectPoint(g, 'right', flat);
    const un = unprojectPoint(g, 'right', projected);
    expect(un.x).toBeCloseTo(flat.x, 1);
    expect(un.y).toBeCloseTo(flat.y, 1);
    // the left plane measures x leftwards from the corner
    const lp = flatToPlane(g, 'left', { x: g.corner - 100, y: g.ground });
    expect(lp.u).toBeCloseTo(100 / g.extent, 9);
    expect(lp.v).toBe(0);
    // the floor measures y (upwards) along the left wall
    const fp = flatToPlane(g, 'floor', { x: g.corner + 50, y: g.ground - 50 });
    expect(fp.u).toBeCloseTo(50 / g.extent, 9);
    expect(fp.v).toBeCloseTo(50 / g.extent, 9);
  });

  it('projects rectangles: a rectangle on the right wall keeps its near edge and shrinks its far edge', () => {
    const rect = { x: g.corner, y: g.ground - 200, width: 300, height: 200 };
    const [tl, tr, br, bl] = projectRect(g, 'right', rect);
    expect(tl.x).toBeCloseTo(g.corner, 6);
    expect(bl.x).toBeCloseTo(g.corner, 6);
    expect(bl.y).toBeCloseTo(g.ground, 6);
    expect(tl.y).toBeCloseTo(g.ground - 200, 6);
    expect(tr.x).toBeGreaterThan(tl.x);
    expect(tr.x).toBeLessThan(g.corner + 300);
    expect(br.y - tr.y).toBeLessThan(200);
    const corners = attachCorners(g, 'right', rect);
    expect(corners[0].x).toBeCloseTo(0, 6);
    expect(corners[3]).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(1, 6) });
    expect(corners[1].x).toBeLessThan(1);
    // the far edge is shorter than the near edge (and rises towards the horizon)
    expect(corners[2].y).toBeGreaterThan(corners[1].y);
    expect(corners[2].y - corners[1].y).toBeLessThan(1);
    expect(corners[2].y).toBeLessThan(1);
  });

  it('three-point grids converge vertical lines towards the vertical vanishing point', () => {
    const three = withType(g, 3);
    expect(three.vpVertical).toBeDefined();
    const bottom = wallPoint(three, 'right', 0.5, 0);
    const top = wallPoint(three, 'right', 0.5, 1);
    // the vertical VP is below the ground: lines diverge upwards (top is further from the corner)
    expect(Math.abs(top.x - three.corner)).toBeGreaterThan(Math.abs(bottom.x - three.corner));
    const lines = planeLines(three, 'right');
    expect(lines.lines.every((l) => l.length >= 2)).toBe(true);
    expect(lines.outline.length).toBeGreaterThan(4);
  });

  it('grid handles drag the grid parameters', () => {
    const handles = gridHandles(g).map((h) => h.id);
    expect(handles).toEqual(expect.arrayContaining(['origin', 'height', 'extentRight', 'extentLeft', 'horizon', 'vpLeft', 'vpRight']));
    expect(gridHandles(withType(g, 1)).map((h) => h.id)).not.toContain('vpLeft');
    expect(gridHandles(withType(g, 3)).map((h) => h.id)).toContain('vpVertical');
    const moved = dragHandle(g, 'vpRight', { x: g.vpRight - 300, y: g.horizon + 40 });
    expect(moved.vpRight).toBeCloseTo(g.vpRight - 300, 6);
    expect(moved.horizon).toBeCloseTo(g.horizon + 40, 6);
    const shifted = dragHandle(g, 'origin', { x: g.corner + 100, y: g.ground - 50 });
    expect(shifted.corner).toBe(g.corner + 100);
    expect(shifted.ground).toBe(g.ground - 50);
    expect(shifted.vpLeft).toBe(g.vpLeft + 100);
    expect(shifted.horizon).toBe(g.horizon - 50);
    const taller = dragHandle(g, 'height', { x: 0, y: g.ground - 600 });
    expect(taller.height).toBe(600);
    // dragging the extent handle to the point at u = 2 doubles the extent
    const far = wallPoint(g, 'right', 2, 0);
    const wider = dragHandle(g, 'extentRight', far);
    expect(wider.extent).toBeCloseTo(g.extent * 2, 0);
    const one = withType(g, 1);
    expect(one.vpLeft).toBe(one.vpRight);
    const two = withType(one, 2);
    expect(two.vpLeft).toBeLessThan(two.corner);
    expect(two.vpRight).toBeGreaterThan(two.corner);
  });

  it('pointInPolygon', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
  });
});

describe('attaching objects to a plane', () => {
  function docWithRect(x: number, y: number, w: number, h: number) {
    const doc = createDocument({ width: 1920, height: 1080 });
    const rect = makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: '#ff0000', opacity: 1 }, transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y } });
    addNode(doc, rect, doc.layers[0]);
    doc.perspective = g;
    return { doc, id: rect.id };
  }

  it('attach adds a free-distort effect whose world quad lies on the plane; remove restores the flat shape', () => {
    const { doc, id } = docWithRect(g.corner, g.ground - 200, 300, 200);
    expect(flatRectOf(doc, id)).toMatchObject({ x: g.corner, y: g.ground - 200, width: 300, height: 200 });
    expect(attachToPlane(doc, id, g, 'right')).toBe(true);
    const n = doc.nodes[id] as any;
    expect(n.effects).toHaveLength(1);
    expect(n.effects[0].type).toBe('freeDistort');
    const a = attachmentOf(doc, id)!;
    expect(a.plane).toBe('right');
    expect(a.rect).toMatchObject({ x: g.corner, width: 300 });
    // the projected object is narrower than the flat one and its left edge stays on the corner line
    const b = worldBounds(doc, id)!;
    expect(b.x).toBeCloseTo(g.corner, 3);
    expect(b.width).toBeLessThan(300);
    expect(b.width).toBeGreaterThan(100);
    expect(b.y + b.height).toBeCloseTo(g.ground, 3);
    // attaching again is idempotent
    const before = JSON.stringify(n.effects[0]);
    attachToPlane(doc, id, g, 'right');
    expect(JSON.stringify(n.effects[0])).toBe(before);
    expect(removePerspective(doc, id)).toBe(true);
    expect(n.effects).toHaveLength(0);
    expect(attachmentOf(doc, id)).toBeNull();
    expect(worldBounds(doc, id)).toMatchObject({ x: g.corner, width: 300 });
  });

  it('moveAttached slides the flat rectangle along the plane: deeper objects get smaller', () => {
    const { doc, id } = docWithRect(g.corner, g.ground - 200, 300, 200);
    attachToPlane(doc, id, g, 'right');
    const w0 = worldBounds(doc, id)!.width;
    expect(moveAttached(doc, id, g, 300, 0)).toBe(true);
    expect(attachmentOf(doc, id)!.rect.x).toBeCloseTo(g.corner + 300, 6);
    const b = worldBounds(doc, id)!;
    expect(b.x).toBeGreaterThan(g.corner);
    expect(b.width).toBeLessThan(w0);
  });

  it('a rotated object keeps its rotation relative to the plane (the effect is expressed in local space)', () => {
    const doc = createDocument({ width: 1920, height: 1080 });
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const rect = makeShape({ kind: 'rect', width: 200, height: 100, radii: [0, 0, 0, 0] }, { transform: { a: c, b: s, c: -s, d: c, e: g.corner + 50, f: g.ground - 300 } });
    addNode(doc, rect, doc.layers[0]);
    expect(attachToPlane(doc, rect.id, g, 'left')).toBe(true);
    const n = doc.nodes[rect.id] as any;
    const corners = n.effects[0].corners as { x: number; y: number }[];
    expect(corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    // the projected bounds sit left of the corner line (the flat rect starts at corner+50 and reaches left of it)
    const b = worldBounds(doc, rect.id)!;
    expect(b.x).toBeLessThan(g.corner);
  });
});
