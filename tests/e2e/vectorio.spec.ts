/**
 * PDF / AI / EPS round trips through the browser: export PDF → import as
 * objects and as image, EPS export, AI (PostScript) import, scripting API.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState } from './helpers';

test.describe('vector document import / export', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('PDF export → import recovers paths and text; image mode places a raster', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      const io = (window as any).__opullerIO;
      api.createShape({ kind: 'rect', x: 100, y: 100, width: 200, height: 100, fill: '#ff0000', stroke: 'none', name: 'Red' });
      api.createShape({ kind: 'circle', cx: 500, cy: 300, r: 80, fill: '#0000ff', stroke: '#000000', name: 'Blue' });
      api.createText({ x: 120, y: 400, text: 'Hello PDF', fontSize: 40 });
      const st = (window as any).__opuller.store.getState();
      const pdf = await io.exportPdf(st.doc, { scope: 'artboard' });
      const bytes = await pdf.blob.arrayBuffer();
      const objects = await io.importVector(bytes, 'roundtrip.pdf', { mode: 'objects' });
      const image = await io.importVector(bytes, 'roundtrip.pdf', { mode: 'image', scale: 0.5 });
      const nodes = objects.items.flatMap((it: any) => it.nodes);
      return {
        pages: objects.pages,
        width: Math.round(objects.width),
        height: Math.round(objects.height),
        paths: nodes.filter((n: any) => n.type === 'path').map((n: any) => ({ fill: n.fill.type === 'solid' ? n.fill.color : n.fill.type, stroke: n.stroke.paint.type, anchors: n.subpaths[0]?.anchors.length })),
        texts: nodes.filter((n: any) => n.type === 'text').map((n: any) => n.text),
        imageMode: image.items[0]?.root.type,
        imageSize: image.items[0] ? [Math.round(image.items[0].root.width), Math.round(image.items[0].root.height)] : null,
      };
    });
    expect(res.pages).toBe(1);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    expect(res.paths.some((p: any) => p.fill === '#ff0000')).toBe(true);
    expect(res.paths.some((p: any) => p.fill === '#0000ff' && p.stroke === 'solid')).toBe(true);
    expect(res.texts.join(' ')).toContain('Hello PDF');
    expect(res.imageMode).toBe('image');
    expect(res.imageSize).toEqual([1920, 1080]);
  });

  test('placing an AI (PostScript) file adds its artwork; EPS export writes PostScript', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const io = (window as any).__opullerIO;
      const ai = `%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%BoundingBox: 0 0 300 200\n%%EndComments\n%%EndProlog\n%%EndSetup\n1 0 0 0 k\n20 20 m\n120 20 L\n120 120 L\n20 120 L\n20 20 l\nf\n0 To\n1 0 0 1 150 100 0 Tp\nTP\n/_Helvetica 24 Tf\n(Vector) Tx\nTO\n%%Trailer\n%%EOF\n`;
      const bytes = new TextEncoder().encode(ai).buffer;
      const r = await io.applyVectorImport(bytes, 'legacy.ai', { action: 'place' });
      const st = (window as any).__opuller.store.getState();
      const sel = st.selection;
      const eps = io.exportEps(st.doc, { scope: 'artboard' });
      return { kind: r.kind, warnings: r.warnings, selection: sel.length, names: sel.map((id: string) => st.doc.nodes[id].name), eps: eps.eps.slice(0, 40), hasCyan: eps.eps.includes('0 1 1 setrgbcolor') || eps.eps.includes('setcmykcolor') };
    });
    expect(res.kind).toBe('ai-ps');
    expect(res.selection).toBe(1);
    expect(res.eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0')).toBe(true);
    expect(res.hasCyan).toBe(true);
    const s = await getState(page);
    const texts = Object.values(s.doc.nodes).filter((n: any) => n.type === 'text').map((n: any) => n.text);
    expect(texts).toContain('Vector');
    const paths = Object.values(s.doc.nodes).filter((n: any) => n.type === 'path') as any[];
    expect(paths.some((p) => p.fill.color === '#00ffff')).toBe(true);
    // scripting: the mcp method accepts base64 bytes
    const api = await page.evaluate(async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>';
      return (window as any).__opuller.mcp.placeFile({ name: 'square.svg', base64: btoa(svg) });
    });
    expect(api.kind).toBe('svg');
    expect(api.ids).toHaveLength(1);
  });
});
