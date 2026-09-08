/**
 * Unit tests for the path operations (pathfinder, faces, join/average/anchor
 * helpers). paper.js needs a 2D context at import time; jsdom has none, so a
 * no-op context is stubbed before the modules are loaded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { SubPath, Document, PathNode, Vec } from '@/model/types';

function fakeContext(canvas: HTMLCanvasElement) {
  const store: Record<string, unknown> = { canvas };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k as string];
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (k === 'measureText') return () => ({ width: 0 });
      return () => undefined;
    },
    set(t, k, v) {
      t[k as string] = v;
      return true;
    },
  });
}
(HTMLCanvasElement.prototype as any).getContext = function () {
  return fakeContext(this);
};

type Geometry = typeof import('@/pathops/geometry');
type Pathfinder = typeof import('@/pathops/pathfinder');
type Faces = typeof import('@/pathops/faces');
type PathEdit = typeof import('@/pathops/pathEdit');
type Apply = typeof import('@/pathops/apply');
type Shapes = typeof import('@/geometry/shapes');
type PathApi = typeof import('@/geometry/path');
type Nodes = typeof import('@/model/nodes');
type DocApi = typeof import('@/model/document');
type MatrixApi = typeof import('@/geometry/matrix');

let G: Geometry;
let PF: Pathfinder;
let F: Faces;
let PE: PathEdit;
let AP: Apply;
let SH: Shapes;
let P: PathApi;
let N: Nodes;
let D: DocApi;
let M: MatrixApi;

beforeAll(async () => {
  G = await import('@/pathops/geometry');
  PF = await import('@/pathops/pathfinder');
  F = await import('@/pathops/faces');
  PE = await import('@/pathops/pathEdit');
  AP = await import('@/pathops/apply');
  SH = await import('@/geometry/shapes');
  P = await import('@/geometry/path');
  N = await import('@/model/nodes');
  D = await import('@/model/document');
  M = await import('@/geometry/matrix');
});

function rectAt(x: number, y: number, w: number, h: number): SubPath {
  const sp = SH.rectSubPath(w, h);
  return { closed: true, anchors: sp.anchors.map((a) => P.anchor({ x: a.point.x + x, y: a.point.y + y })) };
}

function circleAt(cx: number, cy: number, r: number): SubPath {
  return P.transformSubPath(SH.ellipseSubPath(r, r), M.translate(cx, cy));
}

/** Build a document with the given world-space paths (optionally inside a translated group). */
function makeDoc(paths: Array<{ sps: SubPath[]; fill?: string; group?: { x: number; y: number } }>): { doc: Document; ids: string[] } {
  const doc = N.createDocument();
  const layer = doc.layers[0];
  const ids: string[] = [];
  for (const p of paths) {
    const node = N.makePath(p.sps, { fill: { type: 'solid', color: p.fill ?? '#ff0000', opacity: 1 } });
    if (p.group) {
      const g = N.makeGroup([], { transform: M.translate(p.group.x, p.group.y) });
      D.addNode(doc, g, layer);
      // express the world geometry in the group's space
      node.subpaths = P.transformSubPaths(p.sps, M.invert(g.transform));
      D.addNode(doc, node, g.id);
    } else D.addNode(doc, node, layer);
    ids.push(node.id);
  }
  return { doc, ids };
}

function geomsOf(doc: Document, ids: string[]) {
  return AP.targetGeoms(doc, ids);
}

const A = () => rectAt(0, 0, 100, 100);
const B = () => rectAt(50, 0, 100, 100);

describe('geometry helpers', () => {
  it('measures areas and bounds of unions', () => {
    const u = G.safeUnion([{ subpaths: [A()], fillRule: 'nonzero' }, { subpaths: [B()], fillRule: 'nonzero' }]);
    expect(u).toHaveLength(1);
    expect(P.pathBounds(u)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    expect(G.faceArea(u)).toBeCloseTo(15000, 3);
  });

  it('groups contours into islands and finds interior points of rings', () => {
    const ring = [rectAt(0, 0, 100, 100), rectAt(25, 25, 50, 50)];
    const isl = G.islands(ring);
    expect(isl).toHaveLength(1);
    expect(isl[0]).toHaveLength(2);
    expect(G.faceArea(ring)).toBeCloseTo(7500, 3);
    const p = G.interiorPoint(ring, 'evenodd');
    expect(P.pointInPath(ring, p, 'evenodd')).toBe(true);
    // the centroid (50,50) lies in the hole, so a scanline point must have been used
    expect(Math.abs(p.x - 50) > 20 || Math.abs(p.y - 50) > 20).toBe(true);
    expect(G.islands([rectAt(0, 0, 10, 10), rectAt(50, 0, 10, 10)])).toHaveLength(2);
  });

  it('builds a planar partition of overlapping shapes', () => {
    const faces = G.planarFaces([{ subpaths: [A()], fillRule: 'nonzero' }, { subpaths: [B()], fillRule: 'nonzero' }]);
    expect(faces).toHaveLength(3);
    const areas = faces.map((f) => Math.round(G.faceArea(f))).sort();
    expect(areas).toEqual([5000, 5000, 5000]);
    const three = G.planarFaces([
      { subpaths: [A()], fillRule: 'nonzero' },
      { subpaths: [B()], fillRule: 'nonzero' },
      { subpaths: [rectAt(25, 50, 100, 100)], fillRule: 'nonzero' },
    ]);
    expect(three.length).toBe(7);
    const total = three.reduce((s, f) => s + G.faceArea(f), 0);
    expect(total).toBeCloseTo(G.faceArea(G.safeUnion([{ subpaths: [A()], fillRule: 'nonzero' }, { subpaths: [B()], fillRule: 'nonzero' }, { subpaths: [rectAt(25, 50, 100, 100)], fillRule: 'nonzero' }])), 1);
  });

  it('partitions two overlapping circles into three faces', () => {
    const c1 = [circleAt(100, 100, 50)];
    const c2 = [circleAt(160, 100, 50)];
    const faces = G.planarFaces([{ subpaths: c1, fillRule: 'nonzero' }, { subpaths: c2, fillRule: 'nonzero' }]);
    expect(faces).toHaveLength(3);
    const union = G.safeUnion([{ subpaths: c1, fillRule: 'nonzero' }, { subpaths: c2, fillRule: 'nonzero' }]);
    const total = faces.reduce((s, f) => s + G.faceArea(f), 0);
    expect(total).toBeCloseTo(G.faceArea(union), 0);
  });
});

describe('pathfinder', () => {
  it('unite → one path with the top appearance and the union bounds', () => {
    const { doc, ids } = makeDoc([{ sps: [A()], fill: '#ff0000' }, { sps: [B()], fill: '#00ff00' }]);
    const out = PF.runPathfinder('unite', geomsOf(doc, ids));
    expect(out.group).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].source).toBe(ids[1]);
    expect(P.pathBounds(out.results[0].subpaths)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    expect(G.faceArea(out.results[0].subpaths)).toBeCloseTo(15000, 2);
  });

  it('minus front / minus back / intersect / exclude', () => {
    const { doc, ids } = makeDoc([{ sps: [A()] }, { sps: [B()] }]);
    const geoms = geomsOf(doc, ids);
    const mf = PF.runPathfinder('minusFront', geoms).results;
    expect(mf).toHaveLength(1);
    expect(mf[0].source).toBe(ids[0]);
    expect(P.pathBounds(mf[0].subpaths)).toEqual({ x: 0, y: 0, width: 50, height: 100 });
    const mb = PF.runPathfinder('minusBack', geoms).results;
    expect(mb[0].source).toBe(ids[1]);
    expect(P.pathBounds(mb[0].subpaths)).toEqual({ x: 100, y: 0, width: 50, height: 100 });
    const it2 = PF.runPathfinder('intersect', geoms).results;
    expect(P.pathBounds(it2[0].subpaths)).toEqual({ x: 50, y: 0, width: 50, height: 100 });
    const ex = PF.runPathfinder('exclude', geoms).results;
    expect(ex).toHaveLength(1);
    expect(ex[0].fillRule).toBe('evenodd');
    expect(ex[0].subpaths).toHaveLength(2);
    expect(G.faceArea(ex[0].subpaths)).toBeCloseTo(10000, 2);
  });

  it('returns no result for disjoint intersections', () => {
    const { doc, ids } = makeDoc([{ sps: [rectAt(0, 0, 10, 10)] }, { sps: [rectAt(50, 50, 10, 10)] }]);
    expect(PF.runPathfinder('intersect', geomsOf(doc, ids)).results).toHaveLength(0);
  });

  it('divide → grouped faces with the appearance of the top-most covering original', () => {
    const { doc, ids } = makeDoc([{ sps: [A()], fill: '#ff0000' }, { sps: [B()], fill: '#00ff00' }]);
    const out = PF.runPathfinder('divide', geomsOf(doc, ids));
    expect(out.group).toBe(true);
    expect(out.results).toHaveLength(3);
    const bySource = out.results.map((r) => ({ src: r.source, b: P.pathBounds(r.subpaths)! }));
    const left = bySource.find((r) => r.b.x === 0)!;
    const mid = bySource.find((r) => r.b.x === 50)!;
    const right = bySource.find((r) => r.b.x === 100)!;
    expect(left.src).toBe(ids[0]);
    expect(mid.src).toBe(ids[1]);
    expect(right.src).toBe(ids[1]);
  });

  it('trim drops hidden parts and strokes, merge unites same fills, crop keeps the inside', () => {
    const { doc, ids } = makeDoc([{ sps: [A()], fill: '#ff0000' }, { sps: [B()], fill: '#ff0000' }]);
    const geoms = geomsOf(doc, ids);
    const trim = PF.runPathfinder('trim', geoms).results;
    expect(trim).toHaveLength(2);
    expect(P.pathBounds(trim[0].subpaths)).toEqual({ x: 0, y: 0, width: 50, height: 100 });
    expect(trim[0].stroke?.paint.type).toBe('none');
    const merge = PF.runPathfinder('merge', geoms).results;
    expect(merge).toHaveLength(1);
    expect(G.faceArea(merge[0].subpaths)).toBeCloseTo(15000, 2);
    const { doc: d2, ids: i2 } = makeDoc([{ sps: [A()], fill: '#ff0000' }, { sps: [B()], fill: '#0000ff' }]);
    expect(PF.runPathfinder('merge', geomsOf(d2, i2)).results).toHaveLength(2);
    const crop = PF.runPathfinder('crop', geoms).results;
    expect(crop).toHaveLength(1);
    expect(crop[0].source).toBe(ids[0]);
    expect(P.pathBounds(crop[0].subpaths)).toEqual({ x: 50, y: 0, width: 50, height: 100 });
  });

  it('outline splits edges at intersections into open stroked segments', () => {
    // B pokes into A's right edge: every outline is cut twice → 2 pieces per rect
    const { doc, ids } = makeDoc([{ sps: [A()], fill: '#ff0000' }, { sps: [rectAt(50, 25, 100, 50)], fill: '#00ff00' }]);
    const out = PF.runPathfinder('outline', geomsOf(doc, ids));
    expect(out.group).toBe(true);
    expect(out.results).toHaveLength(4);
    for (const r of out.results) {
      expect(r.subpaths[0].closed).toBe(false);
      expect(r.fill?.type).toBe('none');
      expect(r.stroke?.paint.type).toBe('solid');
      expect(r.stroke?.width).toBe(1);
    }
    const colors = out.results.map((r) => (r.stroke!.paint as any).color).sort();
    expect(colors).toEqual(['#00ff00', '#00ff00', '#ff0000', '#ff0000']);
  });

  it('works on paths inside transformed groups (world space)', () => {
    const { doc, ids } = makeDoc([{ sps: [A()], group: { x: 300, y: 200 } }, { sps: [B()] }]);
    const wb = D.worldBounds(doc, ids[0]);
    expect(wb).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    const out = PF.runPathfinder('unite', geomsOf(doc, ids));
    expect(P.pathBounds(out.results[0].subpaths)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    // replacing inside the document keeps world geometry
    AP.replaceWithResults(doc, ids, out.results, { group: false });
    const layer = doc.nodes[doc.layers[0]] as any;
    expect(layer.children).toHaveLength(1);
    expect(D.worldBounds(doc, layer.children[0])).toEqual({ x: 0, y: 0, width: 150, height: 100 });
    // the emptied group was removed
    expect(Object.values(doc.nodes).filter((n) => n.type === 'group')).toHaveLength(0);
  });
});

describe('shape builder faces', () => {
  it('computes faces with their source objects and merges/deletes them', () => {
    const { doc, ids } = makeDoc([{ sps: [circleAt(100, 100, 50)], fill: '#ff0000' }, { sps: [circleAt(160, 100, 50)], fill: '#0000ff' }]);
    const set = F.computeFaceSet(doc, ids);
    expect(set.faces).toHaveLength(3);
    const left = F.faceAt(set, { x: 70, y: 100 })!;
    const mid = F.faceAt(set, { x: 130, y: 100 })!;
    const right = F.faceAt(set, { x: 190, y: 100 })!;
    expect(left.source).toBe(ids[0]);
    expect(mid.source).toBe(ids[1]);
    expect(right.source).toBe(ids[1]);
    expect(F.faceAt(set, { x: 400, y: 400 })).toBeNull();
    expect(F.facesAlong(set, { x: 70, y: 100 }, { x: 190, y: 100 }, 5)).toEqual([left.index, mid.index, right.index]);
    expect(F.facesInRect(set, { x: 60, y: 90, width: 20, height: 20 })).toEqual([left.index]);

    // merge left + middle → new path above the top involved source; sources rebuilt
    const merged = F.applyShapeBuilder(doc, set, { mode: 'merge', faces: [left.index, mid.index], fill: { type: 'solid', color: '#00ff00', opacity: 1 }, stroke: N.makePath([]).stroke });
    expect(merged.created).toHaveLength(1);
    expect(merged.removed).toContain(ids[0]); // the left circle lost all of its faces
    expect(merged.modified).toContain(ids[1]);
    const created = doc.nodes[merged.created[0]] as PathNode;
    expect((created.fill as any).color).toBe('#00ff00');
    // left face + lens = the whole left circle (x 50..150)
    const cb = D.worldBounds(doc, created.id)!;
    expect(Math.round(cb.x)).toBe(50);
    expect(Math.round(cb.width)).toBe(100);
    const ref = G.faceArea([circleAt(100, 100, 50)]);
    expect(Math.abs(G.faceArea(D.worldSubPaths(doc, created.id)) - ref) / ref).toBeLessThan(0.002);
    // the right circle now only keeps its crescent
    const rb = D.worldBounds(doc, ids[1])!;
    expect(Math.round(rb.x)).toBeGreaterThan(100);
    expect(Math.round(rb.x + rb.width)).toBe(210);
  });

  it('delete removes faces from their sources without creating paths', () => {
    const { doc, ids } = makeDoc([{ sps: [A()] }, { sps: [B()] }]);
    const set = F.computeFaceSet(doc, ids);
    const mid = F.faceAt(set, { x: 75, y: 50 })!;
    const r = F.applyShapeBuilder(doc, set, { mode: 'delete', faces: [mid.index], fill: { type: 'none' }, stroke: N.makePath([]).stroke });
    expect(r.created).toHaveLength(0);
    // the region is removed from every object covering it
    expect(r.modified).toEqual([ids[0], ids[1]]);
    expect(D.worldBounds(doc, ids[0])).toEqual({ x: 0, y: 0, width: 50, height: 100 });
    expect(D.worldBounds(doc, ids[1])).toEqual({ x: 100, y: 0, width: 50, height: 100 });
    // an object not covering the region is left alone
    const { doc: d3, ids: i3 } = makeDoc([{ sps: [A()] }, { sps: [B()] }, { sps: [rectAt(300, 300, 10, 10)] }]);
    const set3 = F.computeFaceSet(d3, i3);
    const left = F.faceAt(set3, { x: 25, y: 50 })!;
    const r3 = F.applyShapeBuilder(d3, set3, { mode: 'merge', faces: [left.index], fill: { type: 'none' }, stroke: N.makePath([]).stroke });
    expect(r3.modified).toEqual([i3[0]]);
    expect(D.worldBounds(d3, i3[0])).toEqual({ x: 50, y: 0, width: 50, height: 100 }); // hidden part under B survives
    expect(D.worldBounds(d3, i3[2])).toEqual({ x: 300, y: 300, width: 10, height: 10 });
  });
});

describe('path editing helpers', () => {
  const line = (pts: Vec[]): SubPath => P.polylineSubPath(pts, false);

  it('joins open subpaths end to start, reversing as needed', () => {
    const a = line([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const b = line([{ x: 20, y: 0 }, { x: 30, y: 0 }]);
    const j = PE.joinOpenSubPaths(a, 'end', b, 'start');
    expect(j.anchors.map((p) => p.point.x)).toEqual([0, 10, 20, 30]);
    const j2 = PE.joinOpenSubPaths(a, 'start', b, 'end');
    expect(j2.anchors.map((p) => p.point.x)).toEqual([10, 0, 30, 20]);
    // coincident ends are merged into one anchor
    const c = line([{ x: 10, y: 0 }, { x: 10, y: 10 }]);
    const j3 = PE.joinOpenSubPaths(a, 'end', c, 'start');
    expect(j3.anchors).toHaveLength(3);
  });

  it('adds midpoint anchors and removes redundant ones again', () => {
    const rect = A();
    const more = PE.addMidAnchors(rect);
    expect(more.anchors).toHaveLength(8);
    const back = PE.removeRedundantAnchors(more);
    expect(back.removed).toBe(4);
    expect(back.subpath.anchors).toHaveLength(4);
    // a real corner is never removed
    expect(PE.removeRedundantAnchors(rect).removed).toBe(0);
    // curves: split circle segments are merged back within tolerance
    const circle = circleAt(0, 0, 50);
    const split = PE.addMidAnchors(circle);
    expect(split.anchors).toHaveLength(8);
    const merged = PE.removeRedundantAnchors(split, 0.5);
    expect(merged.subpath.anchors).toHaveLength(4);
    const open = line([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
    expect(PE.removeRedundantAnchors(open).subpath.anchors).toHaveLength(2);
  });

  it('averages points horizontally, vertically and to one point', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
    ];
    expect(PE.averagePoints(pts, 'h')).toEqual([
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ]);
    expect(PE.averagePoints(pts, 'v')).toEqual([
      { x: 5, y: 0 },
      { x: 5, y: 20 },
    ]);
    expect(PE.averagePoints(pts, 'both')).toEqual([
      { x: 5, y: 10 },
      { x: 5, y: 10 },
    ]);
  });

  it('simplify keeps corners, straightens straight runs and refits curves', () => {
    const rect = PE.addMidAnchors(A());
    const simple = PE.simplifySubPaths([rect], 2.5)[0];
    expect(simple.anchors).toHaveLength(4);
    expect(simple.closed).toBe(true);
    expect(P.pathBounds([simple])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(PE.cornerIndices(rect)).toEqual([0, 2, 4, 6]);
    // a circle with extra anchors is refitted to a few smooth anchors within tolerance
    const circle = PE.addMidAnchors(PE.addMidAnchors(circleAt(0, 0, 50)));
    expect(circle.anchors).toHaveLength(16);
    expect(PE.cornerIndices(circle)).toEqual([]);
    const fit = PE.simplifySubPaths([circle], 1)[0];
    expect(fit.anchors.length).toBeLessThan(16);
    expect(fit.anchors.length).toBeGreaterThanOrEqual(3);
    for (const a of fit.anchors) expect(Math.abs(Math.hypot(a.point.x, a.point.y) - 50)).toBeLessThan(1.5);
    // open polyline with a corner
    const open = P.polylineSubPath([{ x: 0, y: 0 }, { x: 50, y: 1 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }], false);
    const o = PE.simplifySubPaths([open], 2.5)[0];
    expect(o.anchors.map((a) => a.point)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  });

  it('outlines strokes and offsets paths in world space', () => {
    const { doc, ids } = makeDoc([{ sps: [A()], group: { x: 40, y: 40 } }]);
    const n = doc.nodes[ids[0]] as PathNode;
    n.stroke = { ...n.stroke, paint: { type: 'solid', color: '#123456', opacity: 1 }, width: 10 };
    const r = PE.outlineStrokes(doc, ids);
    expect(r.converted).toBe(1);
    const g = doc.nodes[r.results[0]];
    expect(g.type).toBe('group');
    const wb = D.worldBounds(doc, g.id)!;
    expect(Math.round(wb.x)).toBe(-5);
    expect(Math.round(wb.width)).toBe(110);
    const { doc: d2, ids: i2 } = makeDoc([{ sps: [A()] }]);
    const created = PE.offsetNodes(d2, i2, { offset: 10, join: 'miter', miterLimit: 4, mode: 'new' });
    expect(created).toHaveLength(1);
    expect(created[0]).not.toBe(i2[0]);
    expect(D.worldBounds(d2, created[0])).toEqual({ x: -10, y: -10, width: 120, height: 120 });
    expect(D.worldBounds(d2, i2[0])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});
