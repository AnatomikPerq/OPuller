import { describe, it, expect } from 'vitest';
import { makeMesh, evalPatch, patchColorHex, insertRow, insertCol, removeRow, removeCol, locate, moveNode, nodeIndex, nearestNode, nodeRC, baseColorOf } from '@/gradients/mesh';
import { freeformColorAt, defaultFreeform, addFreeformPoint, removeFreeformPoint, setFreeformMode, rgbaToHex } from '@/gradients/freeform';
import { validateDocument } from '@/io/project';
import { createDocument, makeShape, clonePaint } from '@/model/nodes';
import { addNode } from '@/model/document';
import type { FreeformGradientPaint } from '@/model/types';

describe('gradient mesh', () => {
  it('builds a regular mesh with handles and evaluates Coons patches', () => {
    const m = makeMesh('#ff0000', { rows: 2, cols: 3, appearance: 'flat', highlight: 100 });
    expect(m.nodes).toHaveLength(12);
    expect(m.nodes[0]).toMatchObject({ x: 0, y: 0, color: '#ff0000', up: null, left: null });
    expect(m.nodes[nodeIndex(m, 2, 3)]).toMatchObject({ x: 1, y: 1, down: null, right: null });
    expect(m.nodes[nodeIndex(m, 1, 1)].right).toEqual({ x: 1 / 9, y: 0 });
    const p = evalPatch(m, 0, 0, 0.5, 0.5);
    expect(p.x).toBeCloseTo(1 / 6, 6);
    expect(p.y).toBeCloseTo(0.25, 6);
    expect(patchColorHex(m, 0, 0, 0.3, 0.7)).toBe('#ff0000');
  });

  it('appearance to centre / edge mixes white; base colour follows the paint', () => {
    const c = makeMesh('#0000ff', { rows: 2, cols: 2, appearance: 'toCenter', highlight: 100 });
    expect(c.nodes[nodeIndex(c, 1, 1)].color).toBe('#ffffff');
    expect(c.nodes[0].color).toBe('#0000ff');
    const e = makeMesh('#0000ff', { rows: 2, cols: 2, appearance: 'toEdge', highlight: 50 });
    expect(e.nodes[nodeIndex(e, 1, 1)].color).toBe('#0000ff');
    expect(e.nodes[0.0].color).toBe('#8080ff');
    expect(baseColorOf({ type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, spread: 'pad', stops: [{ offset: 0, color: '#123456', opacity: 0.5 }, { offset: 1, color: '#000000', opacity: 1 }] })).toEqual({ color: '#123456', opacity: 0.5 });
  });

  it('inserts and removes mesh lines; locates points; moves nodes', () => {
    let m = makeMesh('#00ff00', { rows: 1, cols: 1, appearance: 'flat', highlight: 100 });
    m = insertRow(m, 0, 0.5);
    expect(m.rows).toBe(2);
    expect(m.nodes).toHaveLength(6);
    expect(m.nodes[nodeIndex(m, 1, 0)].y).toBeCloseTo(0.5, 6);
    m = insertCol(m, 0, 0.25);
    expect(m.cols).toBe(2);
    expect(m.nodes).toHaveLength(9);
    expect(m.nodes[nodeIndex(m, 0, 1)].x).toBeCloseTo(0.25, 6);
    const loc = locate(m, { x: 0.6, y: 0.8 });
    expect(loc.r).toBe(1);
    expect(loc.c).toBe(1);
    expect(loc.distance).toBeLessThan(0.02);
    const moved = moveNode(m, nodeIndex(m, 1, 1), { x: 0.3, y: 0.6 });
    expect(nearestNode(moved, { x: 0.31, y: 0.61 }).index).toBe(nodeIndex(m, 1, 1));
    expect(nodeRC(m, 5)).toEqual({ r: 1, c: 2 });
    const r1 = removeRow(m, 1);
    expect(r1.rows).toBe(1);
    expect(removeRow(r1, 1)).toBe(r1); // cannot go below one row
    const c1 = removeCol(m, 1);
    expect(c1.cols).toBe(1);
  });
});

describe('freeform gradient', () => {
  it('blends point colours by distance and spread', () => {
    const p: FreeformGradientPaint = { type: 'freeform', mode: 'points', points: [{ x: 0, y: 0.5, color: '#ff0000', opacity: 1, spread: 0.5 }, { x: 1, y: 0.5, color: '#0000ff', opacity: 1, spread: 0.5 }] };
    expect(rgbaToHex(freeformColorAt(p, 0, 0.5))).toBe('#ff0000');
    expect(rgbaToHex(freeformColorAt(p, 1, 0.5))).toBe('#0000ff');
    const mid = freeformColorAt(p, 0.5, 0.5);
    expect(Math.abs(mid.r - mid.b)).toBeLessThan(2);
    const near = freeformColorAt(p, 0.2, 0.5);
    expect(near.r).toBeGreaterThan(near.b);
  });

  it('lines mode interpolates along the line; points can be added and removed', () => {
    let p: FreeformGradientPaint = { type: 'freeform', mode: 'points', points: [{ x: 0, y: 0, color: '#ff0000', opacity: 1, spread: 0.5 }, { x: 1, y: 0, color: '#00ff00', opacity: 1, spread: 0.5 }] };
    p = setFreeformMode(p, 'lines');
    expect(p.lines).toEqual([[0, 1]]);
    const c = freeformColorAt(p, 0.5, 0.4);
    expect(Math.abs(c.r - c.g)).toBeLessThan(2);
    const added = addFreeformPoint(p, { x: 0.5, y: 0.5 });
    expect(added.index).toBe(2);
    expect(added.paint.lines).toEqual([[0, 1, 2]]);
    const removed = removeFreeformPoint(added.paint, 1);
    expect(removed.points).toHaveLength(2);
    expect(removed.lines).toEqual([[0, 1]]);
    const d = defaultFreeform({ type: 'solid', color: '#123456', opacity: 1 });
    expect(d.points).toHaveLength(3);
    expect(d.points[0].color).toBe('#123456');
  });

  it('new paints survive cloning and the project file', () => {
    const doc = createDocument();
    const a = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] });
    a.fill = makeMesh('#ff0000', { rows: 2, cols: 2, appearance: 'flat', highlight: 100 });
    const b = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] });
    b.fill = defaultFreeform({ type: 'solid', color: '#00ff00', opacity: 1 });
    addNode(doc, a, doc.layers[0]);
    addNode(doc, b, doc.layers[0]);
    const copy = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect((copy.nodes[a.id] as any).fill.type).toBe('mesh');
    expect((copy.nodes[a.id] as any).fill.nodes).toHaveLength(9);
    expect((copy.nodes[b.id] as any).fill.type).toBe('freeform');
    expect((copy.nodes[b.id] as any).fill.points).toHaveLength(3);
    const cl = clonePaint(a.fill);
    expect(cl).toEqual(a.fill);
    expect(cl).not.toBe(a.fill);
  });
});
