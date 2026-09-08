import { describe, it, expect } from 'vitest';
import { createDocument, makeShape } from '@/model/nodes';
import { addNode, worldBounds } from '@/model/document';
import { patternCell, tilesCovering } from '@/patterns/tile';
import { patternFromNodes, makePattern, updatePatternOptions, expandPatternFill, createTileGroup, commitTileGroup, nodesUsingPattern, deletePattern } from '@/patterns/ops';
import { PATTERN_LIBRARY } from '@/patterns/library';
import { setPatternRenderer } from '@/patterns/refresh';
import { validateDocument } from '@/io/project';

// the real renderer needs a browser canvas (paper.js); a stub keeps the markup checks meaningful
setPatternRenderer((_doc, def) => `<stub layout="${def.layout}" bg="${def.background ?? ''}">${Object.values(def.nodes ?? {}).map((n: any) => (n.fill?.type === 'solid' ? n.fill.color : '')).join(' ')}</stub>`);

function rect(x: number, y: number, w: number, h: number, fill = '#ff0000') {
  return makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y }, fill: { type: 'solid', color: fill, opacity: 1 } });
}

describe('pattern tiling', () => {
  it('computes cells for every layout', () => {
    const base = { width: 20, height: 10, spacing: { x: 2, y: 4 } };
    expect(patternCell({ ...base, layout: 'grid' })).toEqual({ width: 22, height: 14, tiles: [{ x: 0, y: 0 }] });
    const brick = patternCell({ ...base, layout: 'brick-row', offset: 0.5 });
    expect(brick.width).toBe(22);
    expect(brick.height).toBe(28);
    expect(brick.tiles).toHaveLength(3);
    expect(brick.tiles[1]).toEqual({ x: 11, y: 14 });
    expect(patternCell({ ...base, layout: 'brick-col' }).width).toBe(44);
    expect(patternCell({ ...base, layout: 'hex-row' }).tiles.length).toBe(6);
    expect(patternCell({ ...base, layout: 'hex-col' }).width).toBeCloseTo(44 * 0.866, 3);
    const tiles = tilesCovering({ width: 10, height: 10, layout: 'grid' }, { x: 0, y: 0, width: 25, height: 15 });
    expect(tiles.length).toBeGreaterThanOrEqual(6);
  });
});

describe('patterns', () => {
  it('builds a pattern from artwork in tile space and renders the cell', () => {
    const doc = createDocument();
    const a = rect(100, 100, 20, 20);
    const b = rect(130, 110, 10, 10, '#00ff00');
    addNode(doc, a, doc.layers[0]);
    addNode(doc, b, doc.layers[0]);
    const def = patternFromNodes(doc, [a.id, b.id], { name: 'P' })!;
    expect(def.width).toBe(40);
    expect(def.height).toBe(20);
    expect(def.nodes && Object.keys(def.nodes).length).toBe(3);
    const root = def.nodes![def.root!] as any;
    const first = def.nodes![root.children[0]] as any;
    expect(first.transform.e).toBe(0);
    expect(first.transform.f).toBe(0);
    expect(def.svg).toContain('#ff0000');
    const r = makePattern(doc, [a.id, b.id], { name: 'P2', consume: true })!;
    expect(doc.patterns).toHaveLength(1);
    expect(doc.swatches.some((s) => s.paint.type === 'pattern' && s.paint.patternId === r.def.id)).toBe(true);
    expect(doc.nodes[a.id]).toBeUndefined();
  });

  it('options regenerate the markup and expand creates clipped tiles', () => {
    const doc = createDocument();
    const a = rect(0, 0, 10, 10);
    addNode(doc, a, doc.layers[0]);
    const { def } = makePattern(doc, [a.id], { name: 'Dots', consume: true })!;
    updatePatternOptions(doc, def.id, { layout: 'brick-row', spacing: { x: 5, y: 5 }, background: '#ffffff' });
    expect(def.layout).toBe('brick-row');
    expect(def.svg).toContain('bg="#ffffff"');
    const big = rect(100, 100, 60, 40, '#ffffff');
    big.fill = { type: 'pattern', patternId: def.id, scale: 1, angle: 0 };
    addNode(doc, big, doc.layers[0]);
    expect(nodesUsingPattern(doc, def.id)).toEqual([big.id]);
    const gid = expandPatternFill(doc, big.id)!;
    const g = doc.nodes[gid] as any;
    expect(g.type).toBe('group');
    expect(g.clipId).toBeTruthy();
    expect(g.children.length).toBeGreaterThan(10);
    expect(doc.nodes[big.id]).toBeUndefined();
    const wb = worldBounds(doc, gid)!;
    expect(Math.round(wb.x)).toBe(100);
    expect(Math.round(wb.width)).toBe(60);
    deletePattern(doc, def.id);
    expect(doc.patterns).toHaveLength(0);
  });

  it('tile group round trip: edit the artwork and resize the tile', () => {
    const doc = createDocument();
    const a = rect(0, 0, 10, 10);
    addNode(doc, a, doc.layers[0]);
    const { def } = makePattern(doc, [a.id], { name: 'T', consume: true })!;
    const gid = createTileGroup(doc, def, { x: 500, y: 500 }, doc.layers[0])!;
    const g = doc.nodes[gid] as any;
    expect(g.children).toHaveLength(2);
    const tile = doc.nodes[g.children[0]] as any;
    tile.shape = { ...tile.shape, width: 30, height: 20 };
    const art = doc.nodes[g.children[1]] as any;
    art.fill = { type: 'solid', color: '#0000ff', opacity: 1 };
    const updated = commitTileGroup(doc, gid)!;
    expect(updated.width).toBe(30);
    expect(updated.height).toBe(20);
    expect(doc.nodes[gid]).toBeUndefined();
    const root = updated.nodes![updated.root!] as any;
    expect((updated.nodes![root.children[0]] as any).fill.color).toBe('#0000ff');
    expect(updated.svg).toContain('#0000ff');
  });

  it('library patterns build and survive the project file', () => {
    const doc = createDocument();
    for (const e of PATTERN_LIBRARY) {
      const def = e.build();
      expect(def.nodes && Object.keys(def.nodes).length).toBeGreaterThan(1);
      doc.patterns.push(def);
      updatePatternOptions(doc, def.id, {});
      expect(def.svg.length).toBeGreaterThan(20);
    }
    const copy = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(copy.patterns).toHaveLength(PATTERN_LIBRARY.length);
    expect(copy.patterns[0].nodes).toBeTruthy();
    expect(copy.patterns[0].layout).toBe('grid');
  });
});
