/**
 * Object > Path > Offset Path against Adobe Illustrator: tests/fixtures/effects/offsetPath.json
 * holds the outlines Illustrator 2026 produces for the reference shapes (sampled by
 * scripts/illustrator/effect-fixtures.mjs). paper.js does the offsetting, so this runs in the
 * browser; shapes are compared as outlines (largest distance between the two flattened
 * outlines, both ways) because the anchor structure of an offset curve is implementation-defined.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { openApp } from './helpers';

type FixtureAnchor = [number, number, number, number, number, number];
interface Fixture {
  shapes: Record<string, { closed: boolean; anchors: number[][] }>;
  cases: Array<{ shape: string; params: Record<string, number | string>; error?: string; outlines: Array<{ closed: boolean; anchors: FixtureAnchor[] }> }>;
}

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'effects', 'offsetPath.json');
const fx: Fixture | null = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;

/** SVG path data of a fixture outline (absolute handles). */
function outlineD(o: { closed: boolean; anchors: FixtureAnchor[] }): string {
  const a = o.anchors;
  let d = `M${a[0][0]} ${a[0][1]}`;
  const segs = o.closed ? a.length : a.length - 1;
  for (let i = 0; i < segs; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    d += `C${p[4]} ${p[5]} ${q[2]} ${q[3]} ${q[0]} ${q[1]}`;
  }
  return o.closed ? d + 'Z' : d;
}

test.describe('Offset Path matches Illustrator', () => {
  test.skip(!fx, 'no fixture');
  test('every fixture case: outlines within 0.5 px', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    const failures: string[] = [];
    for (const c of fx!.cases) {
      if (c.error) continue;
      const shape = fx!.shapes[c.shape];
      if (process.env.OFFSET_DEBUG) console.log('case', c.shape, JSON.stringify(c.params));
      const r = await page.evaluate(
        async ({ shape, params, theirs }) => {
          const api = (window as any).__opuller.mcp;
          api.newDocument({ name: 'offset', width: 800, height: 800 });
          api.projects({ op: 'home', open: false });
          const anchors = shape.anchors.map((a: number[]) => (a.length > 2 ? { x: a[0], y: a[1], handleIn: { x: a[2], y: a[3] }, handleOut: { x: a[4], y: a[5] } } : { x: a[0], y: a[1] }));
          const src = api.pen({ anchors, absoluteHandles: true, closed: shape.closed, fill: shape.closed ? '#000000' : 'none', stroke: shape.closed ? 'none' : { color: '#000000', width: 1 } });
          const res = api.offsetPath({ ids: [src.id], distance: params.offset, join: params.join, miterLimit: params.miterLimit ?? 4 });
          const ours: string = res.nodes.map((n: any) => api.getNode({ id: n.id }).d).join(' ');
          if (!ours.trim()) return { worst: Infinity, ours: '(empty)', nodes: res.nodes.length };
          // flatten both outlines with the browser's path sampling and measure the largest distance both ways
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          document.body.appendChild(svg);
          const sample = (d: string, step: number) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            el.setAttribute('d', d);
            svg.appendChild(el);
            const L = el.getTotalLength();
            const n = Math.max(8, Math.ceil(L / step));
            const pts: Array<[number, number]> = [];
            for (let i = 0; i <= n; i++) {
              const p = el.getPointAtLength((L * i) / n);
              pts.push([p.x, p.y]);
            }
            return pts;
          };
          const distToPolyline = (p: [number, number], poly: Array<[number, number]>) => {
            let best = Infinity;
            for (let i = 1; i < poly.length; i++) {
              const [ax, ay] = poly[i - 1];
              const [bx, by] = poly[i];
              const dx = bx - ax;
              const dy = by - ay;
              const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy))) : 0;
              best = Math.min(best, Math.hypot(p[0] - ax - dx * t, p[1] - ay - dy * t));
            }
            return best;
          };
          const A = sample(ours, 0.5);
          const B = sample(theirs, 0.5);
          let worst = 0;
          for (const p of A) worst = Math.max(worst, distToPolyline(p, B));
          for (const p of B) worst = Math.max(worst, distToPolyline(p, A));
          svg.remove();
          return { worst, ours: ours.slice(0, 80), nodes: res.nodes.length };
        },
        { shape, params: c.params, theirs: c.outlines.map(outlineD).join(' ') },
      );
      if (r.worst > 0.5) failures.push(`${c.shape} ${JSON.stringify(c.params)}: ${r.worst.toFixed(2)} px (${r.nodes} node(s), ${r.ours}…)`);
    }
    expect(failures).toEqual([]);
  });
});
