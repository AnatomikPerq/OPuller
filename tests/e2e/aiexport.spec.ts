/**
 * Illustrator (AI) export under realistic workloads: documents that imitate
 * real Illustrator / CorelDRAW jobs (a CMYK business card with a spot colour
 * and Cyrillic text, a logo with gradients / brushes / patterns / symbols /
 * warp, a multi-layer technical drawing with masks and two artboards, a
 * poster with a raster image and live effects). Every export is checked with
 * the strict AI 7 syntax validator, re-imported with the AI reader and
 * compared pixel-wise against the flattened original. The PDF-compatible
 * flavour, the scripting API and the Export dialog are covered too.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { openApp, runCommand } from './helpers';
import { validateAi } from '../aiValidator';

const OUT = path.resolve('test-results/ai');

interface RoundTrip {
  tree: unknown;
  /** PNG data URLs: the flattened original and the re-imported artwork */
  renders: string[];
  files: Array<{ name: string; ai: string; warnings: string[] }>;
  prepWarnings: string[];
  failed: string[];
  /** fraction of differing pixels between the flattened original and the re-imported artwork (first file) */
  diff: number;
  /** re-imported artwork summary */
  back: { paths: number; texts: number; images: number; clipGroups: number; gradients: number; layers: string[]; warnings: string[] };
  /** exported artwork summary (after preparation) */
  prepared: { paths: number; texts: number; images: number };
}

/** Export the current document as AI, validate nothing was lost in the round trip, and save the files for inspection. */
async function roundTrip(page: Page, name: string, opts: { textMode?: 'auto' | 'editable' | 'outlines'; cmyk?: boolean; scope?: 'artboard' | 'artboards'; encoding?: 'latin1' | 'cp1251' } = {}): Promise<RoundTrip> {
  const r = await page.evaluate(async (o) => {
    const io = (window as any).__opullerIO;
    const st = (window as any).__opuller.store.getState();
    const doc = st.doc;
    const prep = await io.prepareDocumentForAi(doc, { textMode: o.textMode ?? 'auto', encoding: o.encoding ?? 'latin1' });
    const files = io.exportAiAll(prep.doc, { scope: o.scope ?? 'artboard', cmyk: o.cmyk, encoding: o.encoding ?? 'latin1' });
    const count = (d: any) => {
      const nodes: any[] = Object.values(d.nodes);
      return { paths: nodes.filter((n) => n.type === 'path' && n.visible).length, texts: nodes.filter((n) => n.type === 'text' && n.visible).length, images: nodes.filter((n) => n.type === 'image').length };
    };
    // re-import the first file into a document of the same size
    const back = io.importAi(files[0].ai, { name: 'back' });
    const layers = io.itemsToLayers(back.items);
    const region = io.exportRegions(prep.doc, { scope: 'artboard' })[0];
    const d2: any = { ...prep.doc, nodes: {}, layers: [], swatches: [], patterns: [], symbols: [], brushes: [] };
    for (const item of layers) {
      for (const n of item.nodes) d2.nodes[n.id] = n;
      item.root.parent = null;
      d2.layers.push(item.root.id);
    }
    // the reader places artwork relative to the artboard's top-left: shift into world space
    for (const lid of d2.layers) d2.nodes[lid].transform = { a: 1, b: 0, c: 0, d: 1, e: region.rect.x, f: region.rect.y };
    // what the AI format cannot carry is stripped from the original before comparing
    const flat: any = { ...prep.doc, nodes: {} };
    for (const [id, n] of Object.entries<any>(prep.doc.nodes)) {
      const c: any = { ...n, opacity: 1, blendMode: 'normal', effects: [] };
      if (c.type === 'path' || c.type === 'text') {
        if (c.fill?.type === 'solid') c.fill = { ...c.fill, opacity: 1 };
        if (c.stroke?.paint?.type === 'solid') c.stroke = { ...c.stroke, paint: { ...c.stroke.paint, opacity: 1 }, markerStart: 'none', markerEnd: 'none', align: 'center' };
        if (c.fill?.type === 'linear' || c.fill?.type === 'radial') c.fill = { ...c.fill, spread: 'pad', stops: c.fill.stops.map((s: any) => ({ ...s, opacity: 1 })) };
      }
      flat.nodes[id] = c;
    }
    const scale = Math.min(1, 900 / Math.max(region.rect.width, region.rect.height));
    const a = await io.rasterizeRegion(flat, region, { scale, format: 'png', backgroundColor: '#ffffff', embedFonts: true });
    const b = await io.rasterizeRegion(d2, region, { scale, format: 'png', backgroundColor: '#ffffff', embedFonts: true });
    const pa = a.canvas.getContext('2d').getImageData(0, 0, a.canvas.width, a.canvas.height).data;
    const pb = b.canvas.getContext('2d').getImageData(0, 0, b.canvas.width, b.canvas.height).data;
    let bad = 0;
    const total = pa.length / 4;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      if (d > 48) bad++;
    }
    const nodes: any[] = Object.values(d2.nodes);
    // the prepared tree with world bounds, for the saved diagnostics
    (window as any).__opuller.store.getState().setDocument(prep.doc);
    const tree = (window as any).__opuller.mcp.getTree({ depth: 8 });
    return {
      tree,
      renders: [a.canvas.toDataURL('image/png'), b.canvas.toDataURL('image/png')],
      files: files.map((f: any) => ({ name: f.name, ai: f.ai, warnings: f.warnings })),
      prepWarnings: prep.warnings,
      failed: prep.failed,
      diff: bad / total,
      back: {
        paths: nodes.filter((n) => n.type === 'path').length,
        texts: nodes.filter((n) => n.type === 'text').length,
        images: nodes.filter((n) => n.type === 'image').length,
        clipGroups: nodes.filter((n) => n.type === 'group' && n.clipId).length,
        gradients: nodes.filter((n) => n.type === 'path' && (n.fill.type === 'linear' || n.fill.type === 'radial')).length,
        layers: d2.layers.map((id: string) => d2.nodes[id].name),
        warnings: back.warnings,
      },
      prepared: count(prep.doc),
    };
  }, opts);
  fs.mkdirSync(OUT, { recursive: true });
  r.files.forEach((f: { ai: string }, i: number) => fs.writeFileSync(path.join(OUT, `${name}${r.files.length > 1 ? `-${i + 1}` : ''}.ai`), f.ai, 'latin1'));
  r.renders.forEach((url: string, i: number) => fs.writeFileSync(path.join(OUT, `${name}-${i ? 'reimported' : 'original'}.png`), Buffer.from(url.split(',')[1], 'base64')));
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ diff: r.diff, back: r.back, prepared: r.prepared, prepWarnings: r.prepWarnings, failed: r.failed, warnings: r.files.map((f: { warnings: string[] }) => f.warnings), tree: r.tree }, null, 2));
  for (const f of r.files) {
    const v = validateAi(f.ai);
    expect(v.errors, `${name}: ${f.name}`).toEqual([]);
  }
  expect(r.back.warnings).toEqual([]);
  return r;
}

/** A layer with a name / colour / flags, created straight in the store. */
function addLayerScript(name: string, color: string, flags: { visible?: boolean; locked?: boolean } = {}): string {
  return `(() => {
    const s = window.__opuller.store.getState();
    const id = 'L' + Math.random().toString(36).slice(2, 8);
    s.updateDoc((d) => {
      d.nodes[id] = { id, type: 'layer', name: ${JSON.stringify(name)}, parent: null, visible: ${flags.visible !== false}, locked: ${!!flags.locked}, opacity: 1, blendMode: 'normal', transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, effects: [], children: [], color: ${JSON.stringify(color)} };
      d.layers.push(id);
    }, 'New Layer');
    return id;
  })()`;
}

async function addLayer(page: Page, name: string, color: string, flags: { visible?: boolean; locked?: boolean } = {}): Promise<string> {
  return page.evaluate(addLayerScript(name, color, flags)) as Promise<string>;
}

test.describe('AI export on realistic projects', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('business card: CMYK document, spot colour with tints, gradients, Cyrillic + Latin text, dashed rules, locked layer', async ({ page }) => {
    await page.evaluate(() => {
      const api = (window as any).__opuller.mcp;
      const s = (window as any).__opuller.store.getState();
      api.newDocument({ name: 'Business card', width: 340, height: 189, units: 'mm' });
      s.updateDoc((d: any) => {
        d.colorMode = 'cmyk';
        d.swatches.push({ id: 'spot-navy', name: 'PANTONE 2965 C', paint: { type: 'solid', color: '#003a5d', opacity: 1 }, kind: 'spot' });
        d.bleed = { top: 11, right: 11, bottom: 11, left: 11 };
      }, 'Setup');
    });
    const artId = await page.evaluate(() => (window as any).__opuller.store.getState().doc.layers[0]);
    await page.evaluate(({ artId }) => {
      const api = (window as any).__opuller.mcp;
      // full-bleed background in the spot colour at 15 %, a solid band at 100 %
      const bg = api.createShape({ kind: 'rect', x: -11, y: -11, width: 362, height: 211, fill: '#d9e3ea', stroke: 'none', name: 'Background', parent: artId });
      api.updateNodes({ ids: [bg.id], patch: { fill: { type: 'solid', color: '#d9e3ea', opacity: 1, swatchId: 'spot-navy', tint: 15 } } });
      const band = api.createShape({ kind: 'rect', x: -11, y: 140, width: 362, height: 60, fill: '#003a5d', stroke: 'none', name: 'Band' });
      api.updateNodes({ ids: [band.id], patch: { fill: { type: 'solid', color: '#003a5d', opacity: 1, swatchId: 'spot-navy', tint: 100 } } });
      // logo: compound ring + gradient circle
      api.createPath({ d: 'M40 40 m-26 0 a26 26 0 1 0 52 0 a26 26 0 1 0 -52 0 Z M40 40 m-14 0 a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0 Z', fill: '#c8102e', stroke: 'none', fillRule: 'evenodd', name: 'Ring', x: 30, y: 20 });
      const dot = api.createShape({ kind: 'circle', cx: 70, cy: 60, r: 10, fill: '#ffcc00', stroke: 'none', name: 'Dot' });
      api.updateNodes({ ids: [dot.id], patch: { fill: { type: 'radial', cx: 0.4, cy: 0.4, r: 0.6, stops: [{ offset: 0, color: '#fff3b0', opacity: 1 }, { offset: 1, color: '#e0a800', opacity: 1 }], spread: 'pad' } } });
      // text: Latin name (editable), Cyrillic title (outlined in auto mode), contacts
      api.createText({ x: 130, y: 62, text: 'Anna Petrova', fontFamily: 'Inter', fontSize: 22, fontWeight: 700, fill: '#003a5d', name: 'Name' });
      api.createText({ x: 130, y: 84, text: 'Графический дизайнер', fontFamily: 'Inter', fontSize: 12, fontWeight: 400, fill: '#333333', name: 'Title' });
      api.createText({ x: 130, y: 170, text: 'anna@example.com  ·  +7 900 000-00-00', fontFamily: 'Roboto', fontSize: 9, fill: '#ffffff', name: 'Contacts' });
      // dashed hairline rule and a solid rule
      api.createShape({ kind: 'line', x1: 130, y1: 95, x2: 320, y2: 95, stroke: { color: '#003a5d', width: 0.75, dash: [3, 2] }, fill: 'none', name: 'Rule' });
      api.createShape({ kind: 'line', x1: 130, y1: 100, x2: 320, y2: 100, stroke: { color: '#c8102e', width: 2, cap: 'round' }, fill: 'none', name: 'Rule 2' });
    }, { artId });
    // a locked layer with trim guides (thin strokes)
    const guides = await addLayer(page, 'Guides (locked)', '#40c040', { locked: true });
    await page.evaluate(({ guides }) => {
      const api = (window as any).__opuller.mcp;
      api.createShape({ kind: 'rect', x: 0, y: 0, width: 340, height: 189, fill: 'none', stroke: { color: '#00a0ff', width: 0.5 }, name: 'Trim', parent: guides });
    }, { guides });
    const r = await roundTrip(page, 'business-card', { cmyk: true });
    const ai = r.files[0].ai;
    expect(ai).toContain('%%DocumentCustomColors: (PANTONE 2965 C)');
    expect(ai).toContain('%%CMYKCustomColor: 1 0.3763 0 0.6353 (PANTONE 2965 C)'); // derived from #003a5d
    expect(ai).toContain('(PANTONE 2965 C) 0.85 x'); // 15 % tint
    expect(ai).toContain('(PANTONE 2965 C) 0 x'); // 100 %
    expect(ai).toContain(' k\n'); // process colours as inks
    expect(ai).toContain('(Anna Petrova) Tx 1 0 Tk');
    expect(ai).toContain('/_Inter-Bold 16.5 Tf');
    expect(ai).not.toContain('????'); // Cyrillic was outlined, not mangled
    expect(ai).toContain('%AI5_RulerUnits: 1'); // mm
    expect(ai).toMatch(/\[2\.25 1\.5\] 0 d/); // dash 3/2 px → pt
    expect(r.prepWarnings.some((w) => w.includes('converted to outlines'))).toBe(true);
    expect(ai).toContain('(Guides \\(locked\\)) Ln');
    expect(ai).toMatch(/1 1 0 1 0 0 \d+ \d+ \d+ \d+ Lb\n\(Guides \\\(locked\\\)\) Ln/); // enabled = 0 for the locked layer
    expect(r.back.layers).toEqual(['Layer 1', 'Guides (locked)']);
    expect(r.back.texts).toBe(1); // the ASCII name stays editable; the contacts line has a middle dot (·) and is outlined in auto mode
    expect(r.back.gradients).toBe(1);
    expect(r.diff).toBeLessThan(0.02);
  });

  test('logo: linear / radial gradients, calligraphic + art brushes, pattern fill, symbols, warp effect, text on a path', async ({ page }) => {
    await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      api.newDocument({ name: 'Logo', width: 600, height: 400 });
      const disc = api.createShape({ kind: 'circle', cx: 300, cy: 200, r: 120, fill: '#3366ff', stroke: 'none', name: 'Disc' });
      api.updateNodes({ ids: [disc.id], patch: { fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#66ccff', opacity: 1 }, { offset: 0.5, color: '#3366ff', opacity: 1 }, { offset: 1, color: '#001a66', opacity: 1 }], spread: 'pad' } } });
      const glow = api.createShape({ kind: 'circle', cx: 260, cy: 160, r: 40, fill: '#ffffff', stroke: 'none', name: 'Glow' });
      api.updateNodes({ ids: [glow.id], patch: { fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#66ccff', opacity: 1 }], spread: 'pad' } } });
      // calligraphic brush stroke
      const swoosh = api.createPath({ d: 'M120 300 C 200 120 400 120 480 300', fill: 'none', stroke: { color: '#ff6600', width: 6 }, name: 'Swoosh' });
      const calli = await api.brushes({ op: 'calligraphic', name: 'Flat 12', size: 12, angle: 40, roundness: 30 });
      await api.brushes({ op: 'apply', id: calli.id, ids: [swoosh.id] });
      // art brush from the library
      const lib = await api.brushes({ op: 'library' });
      const artEntry = lib.available.find((b: any) => b.kind === 'art');
      if (artEntry) {
        const added = await api.brushes({ op: 'library', name: artEntry.id });
        const stroke2 = api.createPath({ d: 'M120 340 C 200 380 400 380 480 340', fill: 'none', stroke: { color: '#009966', width: 4 }, name: 'Art stroke' });
        await api.brushes({ op: 'apply', id: added.id, ids: [stroke2.id] });
      }
      // pattern fill from the library on a rounded rectangle
      const pl = await api.patterns({ op: 'library' });
      const first = pl.available[0];
      const pat = await api.patterns({ op: 'library', name: first });
      const tile = api.createShape({ kind: 'rect', x: 40, y: 40, width: 120, height: 80, radius: 12, fill: '#cccccc', stroke: { color: '#333333', width: 1 }, name: 'Patterned' });
      await api.patterns({ op: 'apply', id: pat.id, ids: [tile.id], scale: 0.5 });
      // a symbol placed three times
      const leaf = api.createShape({ kind: 'star', cx: 500, cy: 80, points: 6, outerRadius: 24, innerRadius: 12, fill: '#33aa33', stroke: 'none', name: 'Leaf' });
      const sym = await api.symbols({ op: 'make', ids: [leaf.id], name: 'Leaf' });
      await api.symbols({ op: 'place', id: sym.id, x: 540, y: 140, scale: 0.7 });
      await api.symbols({ op: 'place', id: sym.id, x: 460, y: 140, rotation: 30 });
      // warped headline (geometry effect) and text on a path
      const head = api.createText({ x: 300, y: 370, text: 'OPULLER', fontFamily: 'Inter', fontSize: 48, fontWeight: 800, fill: '#001a66', textAlign: 'center', name: 'Headline' });
      api.updateNodes({ ids: [head.id], patch: { effects: [{ type: 'warp', enabled: true, style: 'arc', bend: 25, horizontal: true, hDistort: 0, vDistort: 0 }] } });
      const arc = api.createPath({ d: 'M160 200 A 140 140 0 0 1 440 200', fill: 'none', stroke: 'none', name: 'Text path' });
      const tp = api.createText({ x: 0, y: 0, text: 'vector editor for the web', fontFamily: 'Inter', fontSize: 16, fill: '#ffffff', name: 'Path text' });
      api.updateNodes({ ids: [tp.id], patch: { kind: 'path', pathId: arc.id } });
    });
    const r = await roundTrip(page, 'logo');
    const ai = r.files[0].ai;
    expect(ai).toContain('Bn');
    expect((ai.match(/%AI5_BeginGradient/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(r.prepWarnings.join(' ')).toMatch(/brush stroke/);
    expect(r.prepWarnings.join(' ')).toMatch(/pattern fill/);
    expect(r.prepWarnings.join(' ')).toMatch(/converted to outlines/); // the text on a path
    expect(r.back.gradients).toBe(2);
    expect(r.back.clipGroups).toBeGreaterThanOrEqual(1); // the pattern tiles are clipped
    expect(r.back.paths).toBeGreaterThan(r.prepared.paths / 2);
    expect(r.diff).toBeLessThan(0.03);
  });

  test('technical drawing: eight layers (hidden / locked), dashed strokes, arrowheads, clipping mask, two artboards → two files', async ({ page }) => {
    await page.evaluate(() => {
      const api = (window as any).__opuller.mcp;
      api.newDocument({ name: 'Drawing', width: 842, height: 595 });
    });
    const names = ['Frame', 'Outline', 'Hidden lines', 'Centre lines', 'Dimensions', 'Hatching', 'Notes', 'Draft (hidden)'];
    const ids: Record<string, string> = {};
    for (const [i, n] of names.entries()) ids[n] = await addLayer(page, n, ['#4fa0ff', '#ff4040', '#40c040', '#4040ff', '#ffe040', '#ff40ff', '#40ffff', '#888888'][i], { visible: n !== 'Draft (hidden)', locked: n === 'Frame' });
    await page.evaluate(({ ids }) => {
      const api = (window as any).__opuller.mcp;
      const s = (window as any).__opuller.store.getState();
      // remove the default empty layer so the file has exactly our eight
      s.updateDoc((d: any) => {
        const first = d.layers[0];
        if (d.nodes[first].children.length === 0) {
          delete d.nodes[first];
          d.layers.shift();
        }
      }, 'Cleanup');
      api.createShape({ kind: 'rect', x: 20, y: 20, width: 802, height: 555, fill: 'none', stroke: { color: '#000000', width: 1.5 }, name: 'Sheet frame', parent: ids['Frame'] });
      api.createShape({ kind: 'rect', x: 600, y: 480, width: 222, height: 95, fill: 'none', stroke: { color: '#000000', width: 0.75 }, name: 'Title block', parent: ids['Frame'] });
      // outline: a bracket profile with holes (compound)
      api.createPath({ d: 'M100 100 L400 100 L400 160 L340 160 L340 400 L100 400 Z M150 180 m-20 0 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0 Z M150 350 m-20 0 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0 Z', fill: '#f0f0f0', stroke: { color: '#000000', width: 1.2, join: 'miter' }, fillRule: 'evenodd', name: 'Bracket', parent: ids['Outline'] });
      api.createShape({ kind: 'polygon', cx: 520, cy: 250, sides: 8, radius: 90, fill: 'none', stroke: { color: '#000000', width: 1 }, name: 'Nut', parent: ids['Outline'] });
      api.createShape({ kind: 'circle', cx: 520, cy: 250, r: 50, fill: 'none', stroke: { color: '#000000', width: 1 }, name: 'Bore', parent: ids['Outline'] });
      // hidden lines: dashed
      for (let i = 0; i < 4; i++) api.createShape({ kind: 'line', x1: 110 + i * 60, y1: 110, x2: 110 + i * 60, y2: 390, stroke: { color: '#000000', width: 0.5, dash: [6, 3] }, fill: 'none', name: `Hidden ${i}`, parent: ids['Hidden lines'] });
      // centre lines: dash-dot
      api.createShape({ kind: 'line', x1: 400, y1: 250, x2: 640, y2: 250, stroke: { color: '#cc0000', width: 0.35, dash: [12, 3, 2, 3] }, fill: 'none', name: 'CL h', parent: ids['Centre lines'] });
      api.createShape({ kind: 'line', x1: 520, y1: 130, x2: 520, y2: 370, stroke: { color: '#cc0000', width: 0.35, dash: [12, 3, 2, 3] }, fill: 'none', name: 'CL v', parent: ids['Centre lines'] });
      // dimensions with arrowheads (dropped with a warning) and labels
      const dim = api.createShape({ kind: 'line', x1: 100, y1: 440, x2: 400, y2: 440, stroke: { color: '#0000cc', width: 0.5 }, fill: 'none', name: 'Dim 300', parent: ids['Dimensions'] });
      api.updateNodes({ ids: [dim.id], patch: { stroke: { markerStart: 'arrow', markerEnd: 'arrow' } } });
      api.createText({ x: 250, y: 435, text: '300', fontFamily: 'Inter', fontSize: 11, textAlign: 'center', fill: '#0000cc', name: 'Dim label', parent: ids['Dimensions'] });
      api.createText({ x: 520, y: 340, text: 'Ø100', fontFamily: 'Inter', fontSize: 11, textAlign: 'center', fill: '#0000cc', name: 'Dia', parent: ids['Dimensions'] });
      // hatching: a clipping group of 45° lines masked by the bracket's left face
      const hatch: string[] = [];
      for (let i = 0; i < 30; i++) hatch.push(api.createShape({ kind: 'line', x1: 60 + i * 12, y1: 420, x2: 60 + i * 12 + 340, y2: 80, stroke: { color: '#000000', width: 0.4 }, fill: 'none', name: `Hatch ${i}`, parent: ids['Hatching'] }).id);
      const mask = api.createPath({ d: 'M100 100 L400 100 L400 160 L340 160 L340 400 L100 400 Z', fill: 'none', stroke: 'none', name: 'Hatch mask', parent: ids['Hatching'] });
      const g = api.group({ ids: [...hatch, mask.id] });
      s.updateDoc((d: any) => {
        const grp = d.nodes[g.selection[0]];
        grp.clipId = mask.id;
        grp.name = 'Hatching (clipped)';
      }, 'Clip');
      // notes: Latin and Cyrillic, plus an area text block
      api.createText({ x: 610, y: 500, text: 'BRACKET, STEEL S235', fontFamily: 'Inter', fontSize: 10, fontWeight: 700, fill: '#000000', name: 'Title', parent: ids['Notes'] });
      api.createText({ x: 610, y: 520, text: 'Масштаб 1:2   Лист 1 из 2', fontFamily: 'Inter', fontSize: 9, fill: '#000000', name: 'Scale', parent: ids['Notes'] });
      api.createText({ x: 610, y: 535, width: 200, height: 40, text: 'Unless otherwise specified all dimensions are in millimetres and tolerances ISO 2768-m.', fontFamily: 'Inter', fontSize: 7, fill: '#000000', name: 'Notes block', parent: ids['Notes'] });
      api.createShape({ kind: 'rect', x: 700, y: 60, width: 100, height: 60, fill: '#ffeeee', stroke: { color: '#ff0000', width: 1 }, name: 'Draft note', parent: ids['Draft (hidden)'] });
      // second artboard with a detail view
      api.artboards({ op: 'add', name: 'Detail A', width: 420, height: 297 });
      api.createShape({ kind: 'circle', cx: 942 + 210, cy: 148, r: 100, fill: '#ffffff', stroke: { color: '#000000', width: 2 }, name: 'Detail circle', parent: ids['Outline'] });
      api.createText({ x: 942 + 210, y: 280, text: 'DETAIL A (2:1)', fontFamily: 'Inter', fontSize: 14, fontWeight: 700, textAlign: 'center', fill: '#000000', name: 'Detail title', parent: ids['Notes'] });
    }, { ids });
    const r = await roundTrip(page, 'drawing', { scope: 'artboards' });
    expect(r.files).toHaveLength(2);
    const [sheet, detail] = r.files;
    expect(sheet.ai).toContain('%AI5_NumLayers: 7'); // the hidden layer is skipped
    expect(sheet.ai).toContain('%AI5_ArtSize: 631.5 446.25');
    expect(detail.ai).toContain('%AI5_ArtSize: 315 222.75');
    expect(detail.ai).toContain('(DETAIL A \\(2:1\\)) Tx 1 0 Tk');
    expect(sheet.ai).toMatch(/1 1 0 1 0 0 \d+ \d+ \d+ \d+ Lb\n\(Frame\) Ln/); // locked layer → enabled 0
    expect(sheet.ai).toMatch(/\[9 2\.25 1\.5 2\.25\] 0 d/); // dash-dot pattern in points
    expect(sheet.warnings.some((w) => w.startsWith('Arrowheads'))).toBe(true);
    expect(r.back.layers).toEqual(names.filter((n) => n !== 'Draft (hidden)'));
    expect(r.back.clipGroups).toBe(1);
    expect(r.back.texts).toBeGreaterThanOrEqual(4); // Latin labels + the area block stay editable
    expect(r.diff).toBeLessThan(0.02);
    // the exported files open again as documents through the vector import pipeline
    const reopened = await page.evaluate(async (ai) => {
      const io = (window as any).__opullerIO;
      const bytes = new TextEncoder().encode(ai).buffer;
      const res = await io.importVector(bytes, 'drawing.ai');
      return { kind: res.kind, width: Math.round(res.width), height: Math.round(res.height), objects: res.items.reduce((n: number, it: any) => n + it.nodes.length, 0) };
    }, sheet.ai);
    expect(reopened.kind).toBe('ai-ps');
    expect(reopened.width).toBe(842);
    expect(reopened.height).toBe(595);
    expect(reopened.objects).toBeGreaterThan(40);
  });

  test('poster: placed raster image, translucent shapes, blend modes, drop shadow, outlined headline; editable Cyrillic via Windows-1251', async ({ page }) => {
    await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      api.newDocument({ name: 'Poster', width: 480, height: 640 });
      // a generated photo-like raster
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 120;
      const ctx = c.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, 160, 120);
      g.addColorStop(0, '#ff8800');
      g.addColorStop(1, '#2200aa');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 160, 120);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(120, 40, 25, 0, Math.PI * 2);
      ctx.fill();
      await api.placeImage({ dataUrl: c.toDataURL('image/png'), x: 40, y: 60, width: 400, name: 'Photo' });
      const veil = api.createShape({ kind: 'rect', x: 0, y: 300, width: 480, height: 340, fill: '#000000', stroke: 'none', name: 'Veil' });
      api.updateNodes({ ids: [veil.id], patch: { opacity: 0.6, blendMode: 'multiply' } });
      const head = api.createText({ x: 240, y: 420, text: 'SUMMER', fontFamily: 'Inter', fontSize: 72, fontWeight: 900, textAlign: 'center', fill: '#ffffff', name: 'Headline' });
      api.updateNodes({ ids: [head.id], patch: { effects: [{ type: 'dropShadow', enabled: true, dx: 4, dy: 4, blur: 8, color: '#000000', opacity: 0.6 }] } });
      api.createText({ x: 240, y: 470, text: 'Фестиваль уличного искусства', fontFamily: 'Inter', fontSize: 20, textAlign: 'center', fill: '#ffcc00', name: 'Subtitle' });
      api.createText({ x: 240, y: 600, text: '12–14 July · Old Harbour', fontFamily: 'Inter', fontSize: 16, textAlign: 'center', fill: '#ffffff', name: 'Date' });
    });
    const r = await roundTrip(page, 'poster', { textMode: 'editable', encoding: 'cp1251' });
    const ai = r.files[0].ai;
    expect(ai).toContain('%AI5_BeginRaster');
    expect(ai).toMatch(/\] 0 0 160 120 160 120 8 3 0 0 0 0 XI/);
    expect(r.back.images).toBe(1);
    expect(r.back.texts).toBe(3); // all texts editable, Cyrillic as Windows-1251 bytes
    expect(ai).toContain('(\\324\\345\\361\\362\\350\\342\\340\\353\\374'); // "Фестиваль"
    expect(ai).toContain('(12\\226'); // en dash in Windows-1252/1251 (0x96)
    expect(r.files[0].warnings.some((w) => w.startsWith('Opacity'))).toBe(true);
    expect(r.files[0].warnings.some((w) => w.startsWith('Blend modes'))).toBe(true);
    expect(r.files[0].warnings.some((w) => w.startsWith('Live effects'))).toBe(true);
    expect(r.diff).toBeLessThan(0.03);
  });

  test('PDF-compatible .ai and the scripting API', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      const io = (window as any).__opullerIO;
      api.newDocument({ name: 'Api', width: 300, height: 200 });
      api.createShape({ kind: 'rect', x: 20, y: 20, width: 100, height: 60, fill: '#ff0000', stroke: 'none', name: 'Red' });
      api.createText({ x: 20, y: 150, text: 'Hello AI', fontFamily: 'Inter', fontSize: 24, fill: '#000000' });
      const legacy = await api.exportFile({ format: 'ai' });
      const pdf = await api.exportFile({ format: 'ai', aiFormat: 'pdf' });
      const bin = atob(pdf.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const back = await io.importVector(bytes.buffer, 'api.ai', { mode: 'objects' });
      const nodes = back.items.flatMap((it: any) => it.nodes);
      return { legacyName: legacy.name, legacyHead: legacy.text.slice(0, 60), legacyHasText: legacy.text.includes('(Hello AI) Tx'), pdfName: pdf.name, pdfHead: bin.slice(0, 8), kind: back.kind, red: nodes.some((n: any) => n.type === 'path' && n.fill.type === 'solid' && n.fill.color === '#ff0000'), texts: nodes.filter((n: any) => n.type === 'text').map((n: any) => n.text).join(' ') };
    });
    expect(res.legacyName).toBe('Api.ai');
    expect(res.legacyHead.startsWith('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator')).toBe(true);
    expect(res.legacyHasText).toBe(true);
    expect(res.pdfName).toBe('Api.ai');
    expect(res.pdfHead.startsWith('%PDF-')).toBe(true);
    expect(res.kind).toBe('ai-pdf');
    expect(res.red).toBe(true);
    expect(res.texts).toContain('Hello AI');
  });
});

test.describe('Export dialog: AI tab', () => {
  test('shows the AI options and downloads an Illustrator 8 file', async ({ page }) => {
    // no File System Access API → the dialog falls back to a download we can capture
    await page.addInitScript(() => {
      delete (window as any).showSaveFilePicker;
    });
    await openApp(page);
    await page.evaluate(() => {
      const api = (window as any).__opuller.mcp;
      api.newDocument({ name: 'Dialog', width: 200, height: 100 });
      api.createShape({ kind: 'rect', x: 10, y: 10, width: 80, height: 50, fill: '#00aa00', stroke: 'none', name: 'Green' });
      api.createText({ x: 100, y: 60, text: 'Tab', fontFamily: 'Inter', fontSize: 20, fill: '#000000' });
    });
    await runCommand(page, 'file.export');
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(page.getByText('Illustrator 8 (editable)')).toBeVisible();
    await expect(page.locator('#export-ai-text')).toBeVisible();
    await expect(page.getByText('CMYK colours (k / K)')).toBeVisible();
    await page.getByText('PDF compatible').click();
    await expect(page.getByText('Illustrator opens the file as PDF content')).toBeVisible();
    await page.getByText('Illustrator 8 (editable)').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('export-run').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Dialog.ai');
    const text = fs.readFileSync(await file.path(), 'latin1');
    expect(validateAi(text).errors).toEqual([]);
    expect(text).toContain('0 0.6667 0 Xa');
    expect(text).toContain('(Tab) Tx 1 0 Tk');
  });
});
