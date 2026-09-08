import { describe, it, expect } from 'vitest';
import { createDocument, makeShape } from '@/model/nodes';
import { addNode } from '@/model/document';
import { defaultStroke } from '@/model/defaults';
import { Spine, bendPoint, bendSubPath } from '@/brushes/spine';
import { brushItems, brushPad, colorizeHex, flattenArtwork, itemsBounds, sampleSpine } from '@/brushes/geometry';
import { BRUSH_LIBRARY } from '@/brushes/library';
import { applyBrushToNode, expandBrushStroke, artworkFromNodes, addBrushDef, deleteBrush } from '@/brushes/ops';
import { validateDocument } from '@/io/project';
import type { SubPath } from '@/model/types';

const line = (x0: number, y0: number, x1: number, y1: number): SubPath => ({ anchors: [{ point: { x: x0, y: y0 }, handleIn: null, handleOut: null, kind: 'corner' }, { point: { x: x1, y: y1 }, handleIn: null, handleOut: null, kind: 'corner' }], closed: false });
const stroke = (w = 1) => defaultStroke({ paint: { type: 'solid', color: '#ff0000', opacity: 1 }, width: w, brush: { id: 'x' } });

describe('spine', () => {
  it('samples arc length and bends points', () => {
    const sp = new Spine(line(0, 0, 100, 0));
    expect(sp.length).toBeCloseTo(100, 6);
    const p = sp.at(25);
    expect(p.point.x).toBeCloseTo(25, 6);
    expect(p.tangent).toEqual({ x: 1, y: 0 });
    expect(p.normal).toEqual({ x: -0, y: 1 });
    const bent = bendPoint(sp, { x: 5, y: 3 }, { box: { x: 0, y: -5, width: 10, height: 10 }, s0: 0, s1: 100, widthScale: 2 });
    expect(bent.x).toBeCloseTo(50, 6);
    expect(bent.y).toBeCloseTo(6, 6);
    const out = bendSubPath(sp, line(0, 0, 10, 0), { box: { x: 0, y: -5, width: 10, height: 10 }, s0: 20, s1: 60, widthScale: 1 });
    expect(out.anchors[0].point.x).toBeCloseTo(20, 6);
    expect(out.anchors[out.anchors.length - 1].point.x).toBeCloseTo(60, 6);
  });
});

describe('brush geometry', () => {
  it('calligraphic width follows the angle between the tip and the stroke', () => {
    const flat = { id: 'c', name: 'c', kind: 'calligraphic' as const, size: 20, angle: 0, roundness: 10 };
    const horizontal = brushItems(flat, [line(0, 0, 100, 0)], stroke());
    const vertical = brushItems(flat, [line(0, 0, 0, 100)], stroke());
    const bh = itemsBounds(horizontal)!;
    const bv = itemsBounds(vertical)!;
    // tip along x: a horizontal stroke is thin (minor axis), a vertical stroke is wide (major axis)
    expect(bh.height).toBeLessThan(4);
    expect(bv.width).toBeGreaterThan(18);
    expect(horizontal[0].fill).toEqual({ type: 'solid', color: '#ff0000', opacity: 1 });
    // stroke weight scales the brush
    expect(itemsBounds(brushItems(flat, [line(0, 0, 0, 100)], stroke(2)))!.width).toBeGreaterThan(36);
    expect(brushPad(flat, stroke())).toBe(10);
  });

  it('library brushes produce artwork on a sample spine', () => {
    for (const e of BRUSH_LIBRARY) {
      const def = e.build();
      const items = brushItems(def, [sampleSpine(200, 60)], stroke());
      expect(items.length, e.id).toBeGreaterThan(0);
      const b = itemsBounds(items)!;
      expect(b.width, e.id).toBeGreaterThan(50);
    }
  });

  it('art brushes stretch along the path; pattern brushes repeat tiles; scatter is deterministic', () => {
    const art = BRUSH_LIBRARY.find((e) => e.id === 'art-arrow')!.build();
    const items = brushItems(art, [line(0, 0, 300, 0)], stroke());
    const b = itemsBounds(items)!;
    expect(b.x).toBeCloseTo(0, 0);
    expect(b.width).toBeCloseTo(300, 0);
    const pat = BRUSH_LIBRARY.find((e) => e.id === 'pat-dashes')!.build();
    const tiles = brushItems(pat, [line(0, 0, 200, 0)], stroke());
    expect(tiles.length).toBeGreaterThan(5);
    const sc = BRUSH_LIBRARY.find((e) => e.id === 'sc-dots')!.build();
    const a = brushItems(sc, [line(0, 0, 200, 0)], stroke(), 'seed');
    const b2 = brushItems(sc, [line(0, 0, 200, 0)], stroke(), 'seed');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b2));
    expect(flattenArtwork((sc as any).art)!.paths).toHaveLength(1);
  });

  it('colorization maps artwork colours to the stroke colour', () => {
    expect(colorizeHex('#000000', '#ff0000', 'tints')).toBe('#ff0000');
    expect(colorizeHex('#ffffff', '#ff0000', 'tints')).toBe('#ffffff');
    expect(colorizeHex('#000000', '#ff0000', 'tintsShades')).toBe('#000000');
    expect(colorizeHex('#00ff00', '#ff0000', 'hue')).toBe('#ff0000');
    expect(colorizeHex('#123456', '#ff0000', 'none')).toBe('#123456');
  });
});

describe('brush document ops', () => {
  it('applies, expands and deletes brushes; artwork brushes come from nodes; files round trip', () => {
    const doc = createDocument();
    const def = addBrushDef(doc, BRUSH_LIBRARY.find((e) => e.id === 'cal-5-flat')!.build());
    const p = makeShape({ kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0 });
    addNode(doc, p, doc.layers[0]);
    expect(applyBrushToNode(doc, p.id, { id: def.id })).toBe(true);
    expect((doc.nodes[p.id] as any).stroke.brush.id).toBe(def.id);
    const star = makeShape({ kind: 'star', points: 5, outerRadius: 10, innerRadius: 4 }, { fill: { type: 'solid', color: '#ffcc00', opacity: 1 } });
    addNode(doc, star, doc.layers[0]);
    const art = artworkFromNodes(doc, [star.id], 'Star')!;
    expect(Object.keys(art.nodes)).toHaveLength(2);
    const sc = addBrushDef(doc, { id: '', name: 'Stars', kind: 'scatter', art, size: [100, 100], spacing: [100, 100], scatter: [0, 0], rotation: [0, 0], rotationRelativeTo: 'page', colorization: 'none' });
    const copy = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(copy.brushes).toHaveLength(2);
    expect((copy.nodes[p.id] as any).stroke.brush.id).toBe(def.id);
    expect(copy.brushes[1].kind).toBe('scatter');
    const gid = expandBrushStroke(doc, p.id)!;
    expect(doc.nodes[gid].type).toBe('group');
    expect((doc.nodes[gid] as any).children.length).toBe(1);
    expect(doc.nodes[p.id]).toBeUndefined();
    expect(deleteBrush(doc, sc.id)).toBe(0);
    expect(doc.brushes).toHaveLength(1);
  });
});
