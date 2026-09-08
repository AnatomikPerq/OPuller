import { describe, it, expect } from 'vitest';
import { buildGraph, sampleSpec, parseTable, tableText, niceRange, DEFAULT_OPTIONS, type GraphSpec } from '@/graphs/build';
import { createGraph, regenerateGraph, isGraph, graphSpec, refitGraph } from '@/graphs/ops';
import { createDocument } from '@/model/nodes';
import { worldBounds } from '@/model/document';

const frame = { x: 0, y: 0, width: 400, height: 300 };

describe('graph builder', () => {
  it('nice ranges', () => {
    expect(niceRange(0, 22, 5)).toEqual({ min: 0, max: 25, step: 5 });
    expect(niceRange(-3, 7, 5)).toEqual({ min: -4, max: 8, step: 2 });
    expect(niceRange(5, 5, 5).max).toBeGreaterThan(5);
  });

  it('builds every graph type with bars / lines / slices and a legend', () => {
    const spec = sampleSpec();
    const col = buildGraph(spec, frame);
    const rects = col.filter((n) => n.type === 'path' && (n as any).shape?.kind === 'rect' && n.name.includes('·'));
    expect(rects).toHaveLength(8); // 4 categories × 2 series
    expect(col.some((n) => n.type === 'text' && n.name === 'Q1')).toBe(true);
    expect(col.some((n) => n.name === 'Legend Series 1')).toBe(true);
    for (const type of ['stackedColumn', 'bar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'radar'] as const) {
      const nodes = buildGraph({ ...spec, type }, frame);
      expect(nodes.length, type).toBeGreaterThan(5);
    }
    const pie = buildGraph({ ...spec, type: 'pie' }, frame);
    const slices = pie.filter((n) => n.type === 'path' && spec.categories.includes(n.name));
    expect(slices).toHaveLength(8);
    const line = buildGraph({ ...spec, type: 'line' }, frame);
    expect(line.filter((n) => n.name === 'Marker')).toHaveLength(8);
    const noLegend: GraphSpec = { ...spec, options: { ...DEFAULT_OPTIONS, legend: 'none', valueAxis: 'none', markers: false } };
    expect(buildGraph({ ...noLegend, type: 'line' }, frame).some((n) => n.name.startsWith('Legend'))).toBe(false);
  });

  it('parses pasted tables and round-trips text', () => {
    const t = parseTable('\tA\tB\nJan\t1\t2\nFeb\t3\t4');
    expect(t.series).toEqual(['A', 'B']);
    expect(t.categories).toEqual(['Jan', 'Feb']);
    expect(t.data).toEqual([[1, 2], [3, 4]]);
    const bare = parseTable('1,2\n3,4');
    expect(bare.categories).toEqual(['1', '2']);
    expect(bare.series).toEqual(['Series 1', 'Series 2']);
    const back = parseTable(tableText(t));
    expect(back).toEqual(t);
  });

  it('graph groups regenerate from their spec and refit after scaling', () => {
    const doc = createDocument();
    const id = createGraph(doc, doc.layers[0], { x: 100, y: 100, width: 300, height: 200 })!;
    const g = doc.nodes[id] as any;
    expect(isGraph(g)).toBe(true);
    expect(g.children.length).toBeGreaterThan(10);
    const wb = worldBounds(doc, id)!;
    expect(wb.x).toBeGreaterThanOrEqual(90);
    expect(wb.width).toBeLessThanOrEqual(320);
    regenerateGraph(doc, id, { type: 'pie' });
    expect(graphSpec(doc, id)!.type).toBe('pie');
    expect(doc.nodes[id].type).toBe('group');
    g.transform = { a: 2, b: 0, c: 0, d: 1, e: 100, f: 100 };
    refitGraph(doc, id);
    expect(g.data.frame.width).toBeGreaterThan(200);
  });
});
