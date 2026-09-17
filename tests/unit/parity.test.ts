/**
 * Unit coverage for the Illustrator-parity work that is not pure geometry: appearance
 * semantics of the store, align / distribute from parameters, pathfinder sliver cleanup,
 * curved-neighbour corner rounding and the MCP port registry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getState } from '@/store/store';
import { makeShape, makePath, makeText } from '@/model/nodes';
import { addNode, worldBounds } from '@/model/document';
import { alignFromParams } from '@/transform/align';
import { cleanupResults, SLIVER_AREA } from "@/pathops/cleanup";
import { rectSubPath, ellipseSubPath } from '@/geometry/shapes';
import { roundSubPathCorners, cornerAngle } from '@/geometry/corners';
import { subpathToCubics, pathBounds } from '@/geometry/path';
import { cubicPoint } from '@/geometry/bezier';
import type { SubPath } from '@/model/types';

function rect(x: number, y: number, w: number, h: number, fill = '#ff0000') {
  return makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y }, fill: { type: 'solid', color: fill, opacity: 1 } });
}

function fresh(): void {
  const s = getState();
  s.updateDoc((d) => {
    for (const layer of d.layers) {
      const l = d.nodes[layer];
      if (l && l.type === 'layer') {
        for (const c of l.children) delete d.nodes[c];
        l.children = [];
      }
    }
  });
  s.clearSelection();
}

describe('appearance follows the selection (plan item 3)', () => {
  beforeEach(fresh);

  it('selecting a path makes its fill / stroke current; an explicit default change wins while it stays selected', () => {
    const s = getState();
    const r = rect(0, 0, 10, 10, '#123456');
    s.updateDoc((d) => {
      addNode(d, r, d.layers[0]);
    }, 'add');
    s.setAppearance({ fill: { type: 'solid', color: '#ffffff', opacity: 1 } });
    s.setSelection([r.id]);
    expect(getState().appearance.fill).toEqual({ type: 'solid', color: '#123456', opacity: 1 });
    s.setAppearance({ fill: { type: 'solid', color: '#00ff00', opacity: 1 } });
    expect(getState().appearance.fill).toEqual({ type: 'solid', color: '#00ff00', opacity: 1 });
    expect((getState().doc.nodes[r.id] as any).fill.color).toBe('#123456'); // the object is untouched
    // deselecting keeps the last current appearance (Illustrator)
    s.clearSelection();
    expect(getState().appearance.fill).toEqual({ type: 'solid', color: '#00ff00', opacity: 1 });
    // toggle / add use the first path of the selection
    const t = makeText('Hi', { style: { ...getState().appearance.textStyle, fontFamily: 'Lora', fontSize: 33 }, fill: { type: 'solid', color: '#0000ff', opacity: 1 } });
    s.updateDoc((d) => {
      addNode(d, t, d.layers[0]);
    }, 'add text');
    s.toggleSelection(t.id);
    expect(getState().appearance.fill).toEqual({ type: 'solid', color: '#0000ff', opacity: 1 });
    expect(getState().appearance.textStyle.fontFamily).toBe('Lora');
    expect(getState().appearance.textStyle.fontSize).toBe(33);
    s.addToSelection([r.id]);
    expect(getState().appearance.fill).toEqual({ type: 'solid', color: '#0000ff', opacity: 1 }); // first selected stays first
  });
});

describe('align / distribute from parameters (plan item 12)', () => {
  beforeEach(fresh);

  it('aligns to the selection, the artboard and a key object; distributes with spacing', () => {
    const s = getState();
    const a = rect(100, 100, 50, 50);
    const b = rect(300, 200, 80, 30);
    const c = rect(700, 150, 40, 40);
    s.updateDoc((d) => {
      addNode(d, a, d.layers[0]);
      addNode(d, b, d.layers[0]);
      addNode(d, c, d.layers[0]);
    }, 'add');
    s.setSelection([a.id, b.id, c.id]);
    expect(alignFromParams({ v: 'middle' })).toEqual(['Align vertical centers']);
    const ya = worldBounds(getState().doc, a.id)!;
    const yb = worldBounds(getState().doc, b.id)!;
    expect(ya.y + ya.height / 2).toBeCloseTo(yb.y + yb.height / 2, 6);
    s.setSelection([a.id, b.id]);
    alignFromParams({ h: 'left', to: 'artboard' });
    expect(worldBounds(getState().doc, a.id)!.x).toBeCloseTo(getState().doc.artboards[0].x, 6);
    alignFromParams({ h: 'right', to: 'key', key: b.id });
    const bb = worldBounds(getState().doc, b.id)!;
    expect(worldBounds(getState().doc, a.id)!.x + 50).toBeCloseTo(bb.x + bb.width, 6);
    s.setSelection([a.id, b.id, c.id]);
    expect(alignFromParams({ distribute: 'h', spacing: 20 })).toEqual(['Distribute horizontal spacing']);
    const xs = [a, b, c].map((n) => worldBounds(getState().doc, n.id)!).sort((p, q) => p.x - q.x);
    expect(xs[1].x - (xs[0].x + xs[0].width)).toBeCloseTo(20, 6);
    expect(xs[2].x - (xs[1].x + xs[1].width)).toBeCloseTo(20, 6);
    expect(() => alignFromParams({ h: 'sideways' })).toThrow(/h must be/);
    expect(alignFromParams({})).toEqual([]);
  });
});

describe('pathfinder sliver cleanup (plan item 14)', () => {
  it('drops closed subpaths below the sliver area but never the last one', () => {
    const big = rectSubPath(100, 100);
    const sliver: SubPath = { closed: true, anchors: [{ point: { x: 0, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' }, { point: { x: 1, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' }, { point: { x: 1, y: 0.1 }, handleIn: null, handleOut: null, kind: 'corner' }] };
    const open: SubPath = { closed: false, anchors: [{ point: { x: 0, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' }, { point: { x: 5, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' }] };
    const dot: SubPath = { closed: true, anchors: [{ point: { x: 3, y: 3 }, handleIn: null, handleOut: null, kind: 'corner' }] };
    const out = cleanupResults([{ subpaths: [big, sliver, open, dot] }]);
    expect(out[0].subpaths).toEqual([big, open]);
    expect(SLIVER_AREA).toBeLessThan(1);
    // a result made only of slivers is kept as it is (the caller decides)
    expect(cleanupResults([{ subpaths: [sliver] }])[0].subpaths).toEqual([sliver]);
    expect(cleanupResults([{ subpaths: [] }])).toEqual([]);
  });
});

describe('corner rounding with curved neighbours', () => {
  it('trims along the curves: the arc end points lie on the original outline', () => {
    // an ellipse with one anchor pulled outward into a spike (no handles): the neighbouring segments stay curved
    const el = ellipseSubPath(60, 40);
    const i = 0;
    el.anchors[i] = { point: { x: el.anchors[i].point.x + 40, y: el.anchors[i].point.y }, handleIn: null, handleOut: null, kind: 'corner' };
    expect(cornerAngle(el, i)).toBeLessThan(Math.PI - 0.1);
    const out = roundSubPathCorners(el, (j) => (j === i ? 6 : 0));
    expect(out.anchors.length).toBe(el.anchors.length + 1);
    // the sharp anchor is gone, replaced by two points on the neighbouring curves
    const originals = subpathToCubics(el);
    const onOutline = (p: { x: number; y: number }) => originals.some((c) => Array.from({ length: 101 }, (_, k) => cubicPoint(c, k / 100)).some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.6));
    const arcEnds = out.anchors.filter((a) => !el.anchors.some((o) => Math.abs(o.point.x - a.point.x) < 1e-6 && Math.abs(o.point.y - a.point.y) < 1e-6));
    expect(arcEnds).toHaveLength(2);
    for (const a of arcEnds) expect(onOutline(a.point)).toBe(true);
    const b0 = pathBounds([el])!;
    const b1 = pathBounds([out])!;
    expect(b1.width).toBeLessThanOrEqual(b0.width + 1e-6);
  });
});

describe('MCP port registry', () => {
  it('records live servers, prunes dead pids and lists ports sorted', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opuller-reg-'));
    vi.spyOn(os.default ?? os, 'tmpdir').mockReturnValue(dir);
    const reg = await import('../../mcp/registry.ts');
    expect(reg.registryPath().startsWith(dir)).toBe(true);
    expect(reg.livePorts()).toEqual([]);
    reg.registerServer(5188);
    expect(reg.livePorts()).toEqual([5188]);
    // a stale entry from a process that no longer exists disappears on read
    fs.writeFileSync(reg.registryPath(), JSON.stringify({ servers: [{ port: 5190, pid: 999999999, startedAt: 1, cwd: '' }, { port: 5188, pid: process.pid, startedAt: 1, cwd: '' }] }));
    expect(reg.livePorts()).toEqual([5188]);
    reg.unregisterServer();
    expect(reg.livePorts()).toEqual([]);
    expect(reg.BRIDGE_PORTS[0]).toBe(reg.DEFAULT_BRIDGE_PORT);
    expect(reg.BRIDGE_PORTS).toHaveLength(11);
    // garbage in the file is ignored
    fs.writeFileSync(reg.registryPath(), 'not json');
    expect(reg.readRegistry()).toEqual([]);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
