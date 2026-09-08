import { describe, it, expect } from 'vitest';
import { applyToPoint, translate, scale, rotate } from '@/geometry/matrix';
import { createDocument, makeShape, makeGroup, makePath } from '@/model/nodes';
import { addNode, worldBounds, worldMatrix, groupNodes } from '@/model/document';
import { rectSubPath } from '@/geometry/shapes';
import type { Document, PathNode, GroupNode } from '@/model/types';
import { refPointOf } from '@/transform/refPoint';
import { rotationAbout, reflectAbout, shearAbout, scaleAbout, normalizeAngle, snapAngle, aboutPoint, linearPart } from '@/transform/matrices';
import { recordFromMatrix, matrixForRecord } from '@/transform/again';
import { alignDeltas, distributeDeltas, distributeSpacingDeltas } from '@/transform/align';
import { transformDocument, previewDocument, resetBoundingBoxDocument, bakeSubtree, nodeRotation } from '@/transform/apply';
import { eachMatrixSource, makeRandom } from '@/transform/each';

function docWithRect(x = 100, y = 100, w = 200, h = 120, strokeWidth = 4): { doc: Document; id: string; layer: string } {
  const doc = createDocument({ width: 800, height: 600 });
  const layer = doc.layers[0];
  const rect = makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform: translate(x, y) });
  rect.stroke = { ...rect.stroke, paint: { type: 'solid', color: '#000000', opacity: 1 }, width: strokeWidth };
  addNode(doc, rect, layer);
  return { doc, id: rect.id, layer };
}

describe('reference points', () => {
  it('maps the 9-grid onto a rect', () => {
    const r = { x: 10, y: 20, width: 100, height: 50 };
    expect(refPointOf(r, 'nw')).toEqual({ x: 10, y: 20 });
    expect(refPointOf(r, 'c')).toEqual({ x: 60, y: 45 });
    expect(refPointOf(r, 'se')).toEqual({ x: 110, y: 70 });
    expect(refPointOf(r, 'e')).toEqual({ x: 110, y: 45 });
    expect(refPointOf(r, 's')).toEqual({ x: 60, y: 70 });
  });
});

describe('matrices (Illustrator angle convention)', () => {
  it('rotates counter-clockwise for positive angles', () => {
    // a point to the right of the pivot moves up (smaller y) for +90
    const p = applyToPoint(rotationAbout(90, { x: 0, y: 0 }), { x: 10, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-10);
  });
  it('reflects across horizontal / vertical axes', () => {
    const h = applyToPoint(reflectAbout(0, { x: 0, y: 0 }), { x: 3, y: 4 });
    expect(h).toEqual({ x: 3, y: -4 });
    const v = applyToPoint(reflectAbout(90, { x: 0, y: 0 }), { x: 3, y: 4 });
    expect(v.x).toBeCloseTo(-3);
    expect(v.y).toBeCloseTo(4);
  });
  it('shears the top to the right along the horizontal axis', () => {
    const m = shearAbout(45, 0, { x: 0, y: 0 });
    const top = applyToPoint(m, { x: 0, y: -10 });
    expect(top.x).toBeCloseTo(10);
    expect(top.y).toBeCloseTo(-10);
    const onAxis = applyToPoint(m, { x: 5, y: 0 });
    expect(onAxis).toEqual({ x: 5, y: 0 });
  });
  it('scales about a point', () => {
    const m = scaleAbout(2, 3, { x: 10, y: 10 });
    expect(applyToPoint(m, { x: 10, y: 10 })).toEqual({ x: 10, y: 10 });
    expect(applyToPoint(m, { x: 11, y: 11 })).toEqual({ x: 12, y: 13 });
  });
  it('normalizes and snaps angles', () => {
    expect(normalizeAngle(270)).toBe(-90);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(360)).toBe(0);
    expect(snapAngle(44, 45)).toBe(45);
    expect(Math.abs(snapAngle(-20, 45))).toBe(0);
  });
  it('aboutPoint keeps the pivot fixed', () => {
    const m = aboutPoint(linearPart(rotate(30)), { x: 50, y: 60 });
    const p = applyToPoint(m, { x: 50, y: 60 });
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(60);
  });
});

describe('transform again records', () => {
  it('round-trips an absolute-pivot rotation', () => {
    const pivot = { x: 30, y: 40 };
    const m = rotationAbout(30, pivot);
    const rec = recordFromMatrix('Rotate', m, { kind: 'absolute', point: pivot }, false, null);
    expect(rec.translate.x).toBeCloseTo(0);
    expect(rec.translate.y).toBeCloseTo(0);
    const again = matrixForRecord(rec, null);
    for (const p of [{ x: 0, y: 0 }, { x: 100, y: -20 }]) {
      const a = applyToPoint(m, p);
      const b = applyToPoint(again, p);
      expect(b.x).toBeCloseTo(a.x);
      expect(b.y).toBeCloseTo(a.y);
    }
  });
  it('re-targets a reference-point rotation to another selection', () => {
    const b1 = { x: 0, y: 0, width: 100, height: 100 };
    const m = rotationAbout(90, refPointOf(b1, 'c'));
    const rec = recordFromMatrix('Rotate', m, { kind: 'ref', ref: 'c' }, false, b1);
    const b2 = { x: 500, y: 500, width: 40, height: 40 };
    const m2 = matrixForRecord(rec, b2);
    const c2 = applyToPoint(m2, { x: 520, y: 520 });
    expect(c2.x).toBeCloseTo(520);
    expect(c2.y).toBeCloseTo(520);
    const corner = applyToPoint(m2, { x: 540, y: 520 });
    expect(corner.x).toBeCloseTo(520);
    expect(corner.y).toBeCloseTo(500);
  });
  it('records moves as translations', () => {
    const rec = recordFromMatrix('Move', translate(10, -5), { kind: 'ref', ref: 'c' }, true, { x: 0, y: 0, width: 10, height: 10 });
    expect(rec.translate).toEqual({ x: 10, y: -5 });
    expect(rec.copy).toBe(true);
    const m = matrixForRecord(rec, { x: 900, y: 900, width: 1, height: 1 });
    expect(applyToPoint(m, { x: 1, y: 1 })).toEqual({ x: 11, y: -4 });
  });
});

describe('align & distribute', () => {
  const items = [
    { id: 'a', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', bounds: { x: 50, y: 20, width: 20, height: 40 } },
    { id: 'c', bounds: { x: 200, y: 5, width: 10, height: 10 } },
  ];
  it('aligns edges and centers to a target', () => {
    const target = { x: 0, y: 0, width: 210, height: 60 };
    const left = alignDeltas(items, 'left', target);
    expect(left.get('a')).toBeUndefined();
    expect(left.get('b')).toEqual({ x: -50, y: 0 });
    const hc = alignDeltas(items, 'hcenter', target);
    expect(hc.get('a')).toEqual({ x: 100, y: 0 });
    const bottom = alignDeltas(items, 'bottom', target);
    expect(bottom.get('a')).toEqual({ x: 0, y: 50 });
    expect(bottom.get('b')).toBeUndefined();
  });
  it('distributes centers keeping the outer objects', () => {
    const d = distributeDeltas(items, 'hcenter');
    expect(d.get('a')).toBeUndefined();
    expect(d.get('c')).toBeUndefined();
    // centers: a=5, c=205 → b center should be 105 (currently 60)
    expect(d.get('b')!.x).toBeCloseTo(45);
  });
  it('needs 3 objects without a target and fills a target with 2+', () => {
    expect(distributeDeltas(items.slice(0, 2), 'left').size).toBe(0);
    const d = distributeDeltas(items.slice(0, 2), 'left', { x: 0, y: 0, width: 100, height: 100 });
    // b flush with the right edge: x = 80
    expect(d.get('b')!.x).toBeCloseTo(30);
  });
  it('distributes spacing automatically and with a fixed gap', () => {
    const auto = distributeSpacingDeltas(items, 'h', null);
    // span 0..210, total widths 40 → gaps 85: b at 95
    expect(auto.get('b')!.x).toBeCloseTo(45);
    const fixed = distributeSpacingDeltas(items, 'h', 5, 'a');
    expect(fixed.get('b')!.x).toBeCloseTo(15 - 50);
    expect(fixed.get('c')!.x).toBeCloseTo(40 - 200);
    // anchored at the key object 'b'
    const key = distributeSpacingDeltas(items, 'h', 5, 'b');
    expect(key.get('b')).toBeUndefined();
    expect(key.get('a')!.x).toBeCloseTo(35);
    expect(key.get('c')!.x).toBeCloseTo(75 - 200);
  });
});

describe('transformDocument', () => {
  it('moves a live rectangle and keeps its parameters', () => {
    const { doc, id } = docWithRect();
    const { doc: next } = transformDocument(doc, [id], translate(10, 20), { scaleStrokes: false });
    const n = next.nodes[id] as PathNode;
    expect(n.shape?.kind).toBe('rect');
    expect(worldBounds(next, id)).toEqual({ x: 110, y: 120, width: 200, height: 120 });
    expect(n.stroke.width).toBe(4);
    // original untouched
    expect(worldBounds(doc, id)!.x).toBe(100);
  });
  it('scales geometry without scaling strokes unless asked', () => {
    const { doc, id } = docWithRect();
    const m = scale(2, 2, 100, 100);
    const a = transformDocument(doc, [id], m, { scaleStrokes: false }).doc;
    expect(worldBounds(a, id)).toEqual({ x: 100, y: 100, width: 400, height: 240 });
    expect((a.nodes[id] as PathNode).stroke.width).toBeCloseTo(4);
    const b = transformDocument(doc, [id], m, { scaleStrokes: true }).doc;
    expect((b.nodes[id] as PathNode).stroke.width).toBeCloseTo(8);
    expect((b.nodes[id] as PathNode).shape?.kind).toBe('rect');
    expect((b.nodes[id] as PathNode).shape).toMatchObject({ width: 400, height: 240 });
  });
  it('rotates by 90° and swaps the bounds', () => {
    const { doc, id } = docWithRect();
    const c = { x: 200, y: 160 };
    const next = transformDocument(doc, [id], rotationAbout(90, c), { scaleStrokes: false }).doc;
    const b = worldBounds(next, id)!;
    expect(b.width).toBeCloseTo(120);
    expect(b.height).toBeCloseTo(200);
    expect(b.x + b.width / 2).toBeCloseTo(200);
    expect(b.y + b.height / 2).toBeCloseTo(160);
    expect(nodeRotation(next, id)).toBeCloseTo(90);
  });
  it('transforms copies when asked and leaves originals', () => {
    const { doc, id, layer } = docWithRect();
    const { doc: next, ids } = transformDocument(doc, [id], translate(50, 0), { copy: true });
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(id);
    expect(worldBounds(next, id)!.x).toBe(100);
    expect(worldBounds(next, ids[0])!.x).toBe(150);
    expect((next.nodes[layer] as GroupNode).children).toEqual([id, ids[0]]);
  });
  it('pushes group matrices down and bakes children; visual stroke stays', () => {
    const { doc, id, layer } = docWithRect();
    const g = makeGroup();
    groupNodes(doc, [id], g);
    const gm = doc.nodes[g.id] as GroupNode;
    gm.transform = scale(2, 2);
    // the child renders with a 2x world scale → stroke appears 8px wide
    const next = transformDocument(doc, [g.id], translate(5, 5), { scaleStrokes: false }).doc;
    const gn = next.nodes[g.id] as GroupNode;
    expect(gn.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const child = next.nodes[id] as PathNode;
    expect(worldBounds(next, id)).toEqual({ x: 205, y: 205, width: 400, height: 240 });
    // baked stroke keeps the visual width (8px)
    expect(child.stroke.width).toBeCloseTo(8);
    expect(next.nodes[layer]).toBeTruthy();
  });
  it('works for objects inside a rotated group', () => {
    const { doc, id } = docWithRect();
    const g = makeGroup();
    groupNodes(doc, [id], g);
    (doc.nodes[g.id] as GroupNode).transform = rotate(45, 200, 160);
    const before = worldBounds(doc, id)!;
    const next = transformDocument(doc, [id], translate(10, 0), { scaleStrokes: false }).doc;
    const after = worldBounds(next, id)!;
    expect(after.x).toBeCloseTo(before.x + 10);
    expect(after.y).toBeCloseTo(before.y);
    expect(after.width).toBeCloseTo(before.width);
    // the parent group keeps its matrix (it was not a target)
    expect(worldMatrix(next, g.id).a).toBeCloseTo(Math.cos(Math.PI / 4));
  });
  it('preview only touches matrices', () => {
    const { doc, id } = docWithRect();
    const p = previewDocument(doc, [id], rotationAbout(30, { x: 0, y: 0 }));
    const n = p.nodes[id] as PathNode;
    expect(n.shape?.kind).toBe('rect');
    expect(n.transform.b).not.toBe(0);
  });
  it('per-object matrices (transform each) rotate around each center', () => {
    const doc = createDocument({ width: 800, height: 600 });
    const layer = doc.layers[0];
    const a = makeShape({ kind: 'rect', width: 100, height: 50, radii: [0, 0, 0, 0] }, { transform: translate(0, 0) });
    const b = makeShape({ kind: 'rect', width: 100, height: 50, radii: [0, 0, 0, 0] }, { transform: translate(500, 500) });
    addNode(doc, a, layer);
    addNode(doc, b, layer);
    const src = eachMatrixSource({ scaleX: 50, scaleY: 50, moveX: 0, moveY: 0, angle: 90, reflectX: false, reflectY: false, random: false, ref: 'c' });
    const next = transformDocument(doc, [a.id, b.id], src, { scaleStrokes: false }).doc;
    const ba = worldBounds(next, a.id)!;
    const bb = worldBounds(next, b.id)!;
    expect(ba.width).toBeCloseTo(25);
    expect(ba.height).toBeCloseTo(50);
    expect(ba.x + ba.width / 2).toBeCloseTo(50);
    expect(bb.x + bb.width / 2).toBeCloseTo(550);
    expect(bb.y + bb.height / 2).toBeCloseTo(525);
  });
  it('random values are deterministic per seed', () => {
    const r1 = makeRandom(42);
    const r2 = makeRandom(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
    expect(r1()).toBeGreaterThanOrEqual(0);
    expect(r1()).toBeLessThan(1);
  });
  it('reset bounding box bakes rotations into plain geometry', () => {
    const { doc, id } = docWithRect();
    const rotated = transformDocument(doc, [id], rotationAbout(30, { x: 200, y: 160 }), { scaleStrokes: false }).doc;
    expect((rotated.nodes[id] as PathNode).shape).toBeTruthy();
    const b1 = worldBounds(rotated, id)!;
    const reset = resetBoundingBoxDocument(rotated, [id]);
    const n = reset.nodes[id] as PathNode;
    expect(n.shape).toBeUndefined();
    expect(n.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const b2 = worldBounds(reset, id)!;
    expect(b2.x).toBeCloseTo(b1.x);
    expect(b2.width).toBeCloseTo(b1.width);
  });
  it('bakeSubtree drops the live shape under a skew', () => {
    const { doc, id } = docWithRect();
    const plain = makePath([rectSubPath(50, 50)], { transform: shearAbout(20, 0, { x: 0, y: 0 }) });
    addNode(doc, plain, doc.layers[0]);
    bakeSubtree(doc, plain.id);
    expect(plain.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(doc.nodes[id]).toBeTruthy();
  });
});
