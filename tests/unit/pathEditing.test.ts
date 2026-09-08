import { describe, it, expect } from 'vitest';
import type { Document, PathNode, SubPath } from '@/model/types';
import { createDocument, makePath, makeGroup, makeShape } from '@/model/nodes';
import { addNode, worldMatrix } from '@/model/document';
import { applyToPoint } from '@/geometry/matrix';
import { anchor, hasHandle, nearestPointOnPath, transformSubPath } from '@/geometry/path';
import { cubicPoint } from '@/geometry/bezier';
import {
  translateAnchorsWorld,
  setHandleWorld,
  deleteAnchors,
  convertAnchor,
  toggleAnchorKind,
  insertAnchorWorld,
  removeAnchorJoin,
  anchorsInRect,
  anchorsInPolygon,
  pointInPolygon,
  fullySelectedNodes,
  anchorWorldPoint,
  handleWorldPoint,
  closeSubPath,
  reverseSubPathInPlace,
  appendAnchorWorld,
  allAnchorRefs,
} from '@/tools/pathEditing/anchors';
import { reshapeSegmentWorld, translateSegmentWorld, segmentWorldCubic, recomputeCurvatureHandles, curvaturePreview, constrainTo45, segmentIsStraight } from '@/tools/pathEditing/curves';

/** rotate 90deg + translate(500,500): local (x,y) -> world (500 - y, 500 + x) */
const ROT = { a: 0, b: 1, c: -1, d: 0, e: 500, f: 500 };

function docWithPath(subpaths: SubPath[], groupTransform = ROT): { doc: Document; id: string; groupId: string } {
  const doc = createDocument();
  const group = makeGroup([], { transform: groupTransform });
  const path = makePath(subpaths);
  addNode(doc, group, doc.layers[0]);
  addNode(doc, path, group.id);
  return { doc, id: path.id, groupId: group.id };
}

function openLine(xs: number[]): SubPath {
  return { anchors: xs.map((x) => anchor({ x, y: 0 })), closed: false };
}

describe('anchor editing in world space', () => {
  it('translates anchors through a rotated group transform', () => {
    const { doc, id } = docWithPath([openLine([0, 100])]);
    const ref = { nodeId: id, subpath: 0, index: 1 };
    expect(anchorWorldPoint(doc, ref)).toEqual({ x: 500, y: 600 });
    translateAnchorsWorld(doc, [ref], { x: -20, y: 50 });
    const n = doc.nodes[id] as PathNode;
    expect(n.subpaths[0].anchors[1].point.x).toBeCloseTo(150);
    expect(n.subpaths[0].anchors[1].point.y).toBeCloseTo(20);
    expect(anchorWorldPoint(doc, ref)!.x).toBeCloseTo(480);
    expect(anchorWorldPoint(doc, ref)!.y).toBeCloseTo(650);
    // group transform untouched
    expect(worldMatrix(doc, id)).toEqual(ROT);
  });

  it('clears the live shape when an anchor is edited', () => {
    const doc = createDocument();
    const rect = makeShape({ kind: 'rect', width: 100, height: 50, radii: [0, 0, 0, 0] });
    addNode(doc, rect, doc.layers[0]);
    expect(rect.shape).toBeDefined();
    translateAnchorsWorld(doc, [{ nodeId: rect.id, subpath: 0, index: 0 }], { x: 1, y: 1 });
    expect((doc.nodes[rect.id] as PathNode).shape).toBeUndefined();
  });

  it('keeps the opposite handle collinear for smooth anchors, breaks the pair on demand', () => {
    const sp: SubPath = { anchors: [anchor({ x: 0, y: 0 }, { x: -100, y: 50 }, { x: 100, y: -50 }, 'smooth'), anchor({ x: 200, y: 100 })], closed: false };
    const { doc, id } = docWithPath([sp], { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const ref = { nodeId: id, subpath: 0, index: 0, side: 'out' as const };
    setHandleWorld(doc, ref, { x: 100, y: 50 });
    let a = (doc.nodes[id] as PathNode).subpaths[0].anchors[0];
    expect(a.handleOut).toEqual({ x: 100, y: 50 });
    const l = Math.hypot(a.handleIn!.x, a.handleIn!.y);
    expect(l).toBeCloseTo(Math.hypot(100, 50));
    expect(a.handleIn!.x / l).toBeCloseTo(-100 / Math.hypot(100, 50));
    expect(a.kind).toBe('smooth');
    const before = { ...a.handleIn! };
    setHandleWorld(doc, ref, { x: 150, y: 50 }, { breakPair: true });
    a = (doc.nodes[id] as PathNode).subpaths[0].anchors[0];
    expect(a.handleOut).toEqual({ x: 150, y: 50 });
    expect(a.handleIn).toEqual(before);
    expect(a.kind).toBe('corner');
    // symmetric option mirrors the handle
    setHandleWorld(doc, ref, { x: 10, y: 20 }, { symmetric: true });
    a = (doc.nodes[id] as PathNode).subpaths[0].anchors[0];
    expect(a.handleIn).toEqual({ x: -10, y: -20 });
    expect(a.kind).toBe('smooth');
  });

  it('moves handles correctly inside a transformed group', () => {
    const sp: SubPath = { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: false };
    const { doc, id } = docWithPath([sp]);
    const ref = { nodeId: id, subpath: 0, index: 0, side: 'out' as const };
    // anchor 0 is at world (500,500); put the handle end at world (500, 560) => local vector (60, 0)
    setHandleWorld(doc, ref, { x: 500, y: 560 }, { symmetric: true });
    const a = (doc.nodes[id] as PathNode).subpaths[0].anchors[0];
    expect(a.handleOut!.x).toBeCloseTo(60);
    expect(a.handleOut!.y).toBeCloseTo(0);
    expect(handleWorldPoint(doc, ref)!.x).toBeCloseTo(500);
    expect(handleWorldPoint(doc, ref)!.y).toBeCloseTo(560);
  });

  it('deletes anchors: closed paths stay closed, open paths split, empty paths are removed', () => {
    const closed: SubPath = { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }), anchor({ x: 100, y: 100 }), anchor({ x: 0, y: 100 })], closed: true };
    const { doc, id } = docWithPath([closed, openLine([0, 100, 200, 300, 400])], { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    deleteAnchors(doc, [
      { nodeId: id, subpath: 0, index: 1 },
      { nodeId: id, subpath: 1, index: 2 },
    ]);
    const n = doc.nodes[id] as PathNode;
    expect(n.subpaths.length).toBe(3);
    expect(n.subpaths[0].closed).toBe(true);
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[1].anchors.map((a) => a.point.x)).toEqual([0, 100]);
    expect(n.subpaths[2].anchors.map((a) => a.point.x)).toEqual([300, 400]);
    // deleting everything removes the node
    const res = deleteAnchors(doc, allAnchorRefs(doc, [id]));
    expect(res.removedNodes).toEqual([id]);
    expect(doc.nodes[id]).toBeUndefined();
  });

  it('removeAnchorJoin keeps the path continuous and drops degenerate paths', () => {
    const { doc, id } = docWithPath([openLine([0, 100, 200])], { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(removeAnchorJoin(doc, { nodeId: id, subpath: 0, index: 1 })).toBe(true);
    expect((doc.nodes[id] as PathNode).subpaths[0].anchors.map((a) => a.point.x)).toEqual([0, 200]);
    expect(removeAnchorJoin(doc, { nodeId: id, subpath: 0, index: 0 })).toBe(false);
    expect(doc.nodes[id]).toBeUndefined();
  });

  it('converts anchors to smooth (tangent handles in world space) and back to corner', () => {
    const sp: SubPath = { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }), anchor({ x: 100, y: 100 })], closed: false };
    const { doc, id } = docWithPath([sp]);
    const ref = { nodeId: id, subpath: 0, index: 1 };
    convertAnchor(doc, ref, 'smooth');
    let a = (doc.nodes[id] as PathNode).subpaths[0].anchors[1];
    expect(a.kind).toBe('smooth');
    expect(hasHandle(a.handleIn)).toBe(true);
    expect(hasHandle(a.handleOut)).toBe(true);
    // collinear, opposite
    const cross = a.handleIn!.x * a.handleOut!.y - a.handleIn!.y * a.handleOut!.x;
    expect(Math.abs(cross)).toBeLessThan(1e-9);
    expect(a.handleIn!.x * a.handleOut!.x + a.handleIn!.y * a.handleOut!.y).toBeLessThan(0);
    expect(toggleAnchorKind(doc, ref)).toBe('corner');
    a = (doc.nodes[id] as PathNode).subpaths[0].anchors[1];
    expect(a.handleIn).toBeNull();
    expect(a.handleOut).toBeNull();
    expect(toggleAnchorKind(doc, ref)).toBe('smooth');
  });

  it('inserts an anchor at the closest point of the outline (world space)', () => {
    const { doc, id } = docWithPath([openLine([0, 100])]);
    // segment runs from world (500,500) to (500,600); click near its middle
    const ref = insertAnchorWorld(doc, id, { x: 503, y: 550 }, 10);
    expect(ref).toEqual({ nodeId: id, subpath: 0, index: 1 });
    const n = doc.nodes[id] as PathNode;
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].anchors[1].point.x).toBeCloseTo(50);
    expect(insertAnchorWorld(doc, id, { x: 900, y: 900 }, 10)).toBeNull();
  });

  it('closes, reverses and appends subpaths', () => {
    const { doc, id } = docWithPath([openLine([0, 100, 200])]);
    reverseSubPathInPlace(doc, id, 0);
    expect((doc.nodes[id] as PathNode).subpaths[0].anchors.map((a) => a.point.x)).toEqual([200, 100, 0]);
    const ref = appendAnchorWorld(doc, id, 0, { x: 400, y: 500 });
    expect(ref).toEqual({ nodeId: id, subpath: 0, index: 3 });
    // world (400,500) -> local (0, 100)
    const a = (doc.nodes[id] as PathNode).subpaths[0].anchors[3];
    expect(a.point.x).toBeCloseTo(0);
    expect(a.point.y).toBeCloseTo(100);
    expect(closeSubPath(doc, id, 0)).toBe(true);
    expect((doc.nodes[id] as PathNode).subpaths[0].closed).toBe(true);
    expect(closeSubPath(doc, id, 0)).toBe(false);
  });

  it('finds anchors inside rectangles and polygons in world space', () => {
    const { doc, id } = docWithPath([openLine([0, 100, 200])]);
    // world points: (500,500), (500,600), (500,700)
    expect(anchorsInRect(doc, [id], { x: 480, y: 580, width: 40, height: 40 })).toEqual([{ nodeId: id, subpath: 0, index: 1 }]);
    const poly = [
      { x: 480, y: 480 },
      { x: 520, y: 480 },
      { x: 520, y: 620 },
      { x: 480, y: 620 },
    ];
    expect(anchorsInPolygon(doc, [id], poly).map((r) => r.index)).toEqual([0, 1]);
    expect(pointInPolygon({ x: 500, y: 500 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 700, y: 500 }, poly)).toBe(false);
    expect(fullySelectedNodes(doc, allAnchorRefs(doc, [id]))).toEqual([id]);
    expect(fullySelectedNodes(doc, [{ nodeId: id, subpath: 0, index: 0 }])).toEqual([]);
  });
});

describe('segments', () => {
  it('reshapes a curved segment so the grabbed point follows the target and neighbours stay smooth', () => {
    const sp: SubPath = {
      anchors: [anchor({ x: 0, y: 0 }, { x: -50, y: 0 }, { x: 50, y: 0 }, 'smooth'), anchor({ x: 200, y: 0 }, { x: -50, y: 0 }, { x: 50, y: 0 }, 'smooth')],
      closed: false,
    };
    const { doc, id } = docWithPath([sp], { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const seg = { nodeId: id, subpath: 0, segment: 0 };
    const t = 0.5;
    const target = { x: 100, y: 60 };
    reshapeSegmentWorld(doc, seg, t, target);
    const c = segmentWorldCubic(doc, seg)!;
    const p = cubicPoint(c, t);
    expect(p.x).toBeCloseTo(target.x, 6);
    expect(p.y).toBeCloseTo(target.y, 6);
    const n = doc.nodes[id] as PathNode;
    for (const a of n.subpaths[0].anchors) {
      expect(a.point.y).toBe(0);
      expect(a.kind).toBe('smooth');
      const cross = a.handleIn!.x * a.handleOut!.y - a.handleIn!.y * a.handleOut!.x;
      expect(Math.abs(cross)).toBeLessThan(1e-9);
    }
    expect(segmentIsStraight(n.subpaths[0], 0)).toBe(false);
  });

  it('translates a straight segment through a group transform', () => {
    const { doc, id } = docWithPath([openLine([0, 100, 200])]);
    translateSegmentWorld(doc, { nodeId: id, subpath: 0, segment: 0 }, { x: 0, y: 10 });
    const n = doc.nodes[id] as PathNode;
    // world +y == local +x
    expect(n.subpaths[0].anchors[0].point.x).toBeCloseTo(10);
    expect(n.subpaths[0].anchors[1].point.x).toBeCloseTo(110);
    expect(n.subpaths[0].anchors[2].point.x).toBeCloseTo(200);
  });

  it('constrains points to 45 degree increments', () => {
    const p = constrainTo45({ x: 0, y: 0 }, { x: 100, y: 8 });
    expect(p.y).toBeCloseTo(0);
    const q = constrainTo45({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(Math.abs(q.x - q.y)).toBeLessThan(1e-9);
  });
});

describe('curvature handles', () => {
  it('produces a symmetric smooth curve through three points with a horizontal middle tangent', () => {
    const sp: SubPath = { anchors: [anchor({ x: 0, y: 200 }, null, null, 'smooth'), anchor({ x: 200, y: 0 }, null, null, 'smooth'), anchor({ x: 400, y: 200 }, null, null, 'smooth')], closed: false };
    recomputeCurvatureHandles(sp);
    const mid = sp.anchors[1];
    expect(Math.abs(mid.handleOut!.y)).toBeLessThan(1e-9);
    expect(mid.handleOut!.x).toBeGreaterThan(0);
    expect(mid.handleIn!.x).toBeCloseTo(-mid.handleOut!.x);
    // the ends get handles mirrored around the chord, so the curve looks like an arc
    expect(hasHandle(sp.anchors[0].handleOut)).toBe(true);
    expect(sp.anchors[0].handleIn).toBeNull();
    expect(sp.anchors[2].handleOut).toBeNull();
    expect(sp.anchors[0].handleOut!.x).toBeCloseTo(sp.anchors[2].handleIn!.x * -1, 6);
    expect(sp.anchors[0].handleOut!.y).toBeCloseTo(sp.anchors[2].handleIn!.y, 6);
    // the curve passes close to a circle through the three points (centre (200,200), r=200)
    for (let t = 0.1; t < 1; t += 0.2) {
      const c = { p0: sp.anchors[0].point, p1: { x: sp.anchors[0].point.x + sp.anchors[0].handleOut!.x, y: sp.anchors[0].point.y + sp.anchors[0].handleOut!.y }, p2: { x: mid.point.x + mid.handleIn!.x, y: mid.point.y + mid.handleIn!.y }, p3: mid.point };
      const p = cubicPoint(c, t);
      expect(Math.abs(Math.hypot(p.x - 200, p.y - 200) - 200)).toBeLessThan(6);
    }
  });

  it('corner points get no handles and neighbours still curve; closed paths wrap around', () => {
    const sp: SubPath = {
      anchors: [anchor({ x: 0, y: 0 }, null, null, 'smooth'), anchor({ x: 100, y: 0 }, null, null, 'corner'), anchor({ x: 100, y: 100 }, null, null, 'smooth'), anchor({ x: 0, y: 100 }, null, null, 'smooth')],
      closed: true,
    };
    recomputeCurvatureHandles(sp);
    expect(sp.anchors[1].handleIn).toBeNull();
    expect(sp.anchors[1].handleOut).toBeNull();
    for (const i of [0, 2, 3]) {
      expect(hasHandle(sp.anchors[i].handleIn)).toBe(true);
      expect(hasHandle(sp.anchors[i].handleOut)).toBe(true);
    }
    // partial update only touches the requested indices
    const before = JSON.stringify(sp.anchors[3]);
    sp.anchors[0].point = { x: -50, y: 0 };
    recomputeCurvatureHandles(sp, [0]);
    expect(JSON.stringify(sp.anchors[3])).toBe(before);
  });

  it('builds a preview with an extra point and a closing preview', () => {
    const sp: SubPath = { anchors: [anchor({ x: 0, y: 0 }, null, null, 'smooth'), anchor({ x: 100, y: 50 }, null, null, 'smooth')], closed: false };
    const p = curvaturePreview(sp, { x: 200, y: 0 }, false);
    expect(p.anchors.length).toBe(3);
    expect(p.closed).toBe(false);
    expect(hasHandle(p.anchors[2].handleIn)).toBe(true);
    const c = curvaturePreview({ ...sp, anchors: sp.anchors.concat([anchor({ x: 200, y: 0 }, null, null, 'smooth')]) }, null, true);
    expect(c.closed).toBe(true);
    expect(c.anchors.length).toBe(3);
  });
});

describe('sanity of helpers used by the tools', () => {
  it('nearestPointOnPath and transformSubPath agree with world conversions', () => {
    const { doc, id } = docWithPath([openLine([0, 100])]);
    const n = doc.nodes[id] as PathNode;
    const wsp = transformSubPath(n.subpaths[0], worldMatrix(doc, id));
    expect(wsp.anchors[1].point).toEqual(applyToPoint(ROT, { x: 100, y: 0 }));
    const loc = nearestPointOnPath([wsp], { x: 510, y: 550 });
    expect(loc!.distance).toBeCloseTo(10);
  });
});
