import { test } from '@playwright/test';
import { openApp, expect, getState, withStore, drawRect, runCommand, nodeById, worldBounds } from './helpers';

/** Place a generated 80×60 test image (left half red, right half blue) and return its id. */
async function placeTestImage(page: any, x = 100, y = 100): Promise<string> {
  return page.evaluate(
    async ({ x, y }: { x: number; y: number }) => {
      const c = document.createElement('canvas');
      c.width = 80;
      c.height = 60;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 40, 60);
      g.fillStyle = '#0000ff';
      g.fillRect(40, 0, 40, 60);
      const r = await (window as any).__opuller.mcp.placeImage({ dataUrl: c.toDataURL('image/png'), x, y, width: 160 });
      return r.id;
    },
    { x, y },
  );
}

test.describe('raster module', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('image trace converts an image into filled paths', async ({ page }) => {
    const img = await placeTestImage(page);
    let n = await nodeById(page, img);
    expect(n.type).toBe('image');
    expect(Math.round(n.width)).toBe(160);
    expect(Math.round(n.height)).toBe(120);
    await withStore(page, (st) => st.setSelection(Object.keys(st.doc.nodes).filter((k) => st.doc.nodes[k].type === 'image')));
    await runCommand(page, 'image.trace');
    await expect(page.getByTestId('trace-ok')).toBeVisible();
    await page.getByTestId('trace-ok').click();
    // tracing runs in a worker: wait until the traced group is selected
    await expect
      .poll(async () => {
        const st = await getState(page);
        return st.doc.nodes[st.selection[0]]?.type;
      }, { timeout: 15000 })
      .toBe('group');
    const s = await getState(page);
    const gid = s.selection[0];
    const g = s.doc.nodes[gid];
    expect(g.type).toBe('group');
    const paths = Object.values(s.doc.nodes).filter((x: any) => x.type === 'path');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(s.doc.nodes[img]).toBeUndefined();
    const colors = new Set(paths.map((p: any) => p.fill.color));
    expect(colors.has('#ff0000') || [...colors].some((c) => (c as string).startsWith('#f'))).toBe(true);
    // traced group covers the image rectangle
    const b = await worldBounds(page, gid);
    expect(Math.round(b!.x)).toBeGreaterThanOrEqual(99);
    expect(Math.round(b!.width)).toBeGreaterThan(140);
    expect(Math.round(b!.width)).toBeLessThan(170);
  });

  test('image trace dialog previews the result, presets and the scripting API trace directly', async ({ page }) => {
    // a disc on white: black & white logo preset → one black path
    const img = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 120;
      c.height = 120;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 120, 120);
      g.fillStyle = '#000000';
      g.beginPath();
      g.arc(60, 60, 40, 0, Math.PI * 2);
      g.fill();
      const r = await (window as any).__opuller.mcp.placeImage({ dataUrl: c.toDataURL('image/png'), x: 100, y: 100, width: 240 });
      return r.id as string;
    });
    await withStore(page, (st) => st.setSelection(Object.keys(st.doc.nodes).filter((k) => st.doc.nodes[k].type === 'image')));
    await runCommand(page, 'image.trace');
    await expect(page.getByTestId('trace-ok')).toBeVisible();
    // the live preview runs in a worker and reports its statistics
    await expect(page.getByTestId('trace-info')).toContainText('paths', { timeout: 15000 });
    await page.locator('#trace-preset').selectOption('logo');
    await expect(page.getByTestId('trace-info')).toContainText('1 colour', { timeout: 15000 });
    await expect(page.locator('[data-testid="trace-preview"] svg path')).toHaveCount(1);
    await page.getByTestId('trace-ok').click();
    await expect
      .poll(async () => {
        const st = await getState(page);
        return st.doc.nodes[st.selection[0]]?.type;
      }, { timeout: 15000 })
      .toBe('group');
    let s = await getState(page);
    const gid = s.selection[0];
    const paths = s.doc.nodes[gid].children.map((id: string) => s.doc.nodes[id]);
    expect(paths.length).toBe(1);
    expect(paths[0].fill.color).toBe('#000000');
    expect(paths[0].subpaths[0].closed).toBe(true);
    expect(paths[0].subpaths[0].anchors.length).toBeLessThan(20);
    expect(paths[0].subpaths[0].anchors.some((a: any) => a.handleIn && a.handleOut)).toBe(true);
    expect(s.doc.nodes[img]).toBeUndefined();
    const b = (await worldBounds(page, gid))!;
    expect(Math.abs(b.x - 140)).toBeLessThan(2.5);
    expect(Math.abs(b.width - 160)).toBeLessThan(5);
    expect(s.past[s.past.length - 1].label).toBe('Image Trace');

    // scripting API with the 3 colour preset on a two colour image, keeping the source
    const img2 = await placeTestImage(page, 400, 100);
    const res = await page.evaluate((id) => (window as any).__opuller.mcp.imageTrace({ ids: [id], preset: 'c3', options: { source: 'keep', noise: 2 } }), img2);
    expect(res.groups.length).toBe(1);
    expect(res.paths).toBe(2);
    s = await getState(page);
    expect(s.doc.nodes[img2]).toBeTruthy();
    const colors = s.doc.nodes[res.groups[0]].children.map((id: string) => s.doc.nodes[id].fill.color).sort();
    expect(colors).toEqual(['#0000ff', '#ff0000']);
    // the preset commands trace with the preset's settings
    await withStore(page, (st) => st.setSelection(Object.keys(st.doc.nodes).filter((k) => st.doc.nodes[k].type === 'image')));
    const historyBefore = (await getState(page)).past.length;
    await runCommand(page, 'image.tracePreset.c6');
    await expect
      .poll(
        async () => {
          const st = await getState(page);
          return `${st.past.length > historyBefore ? 'traced' : 'pending'}: ${st.past.map((p: any) => p.label).slice(-2).join(', ')}`;
        },
        { timeout: 20000 },
      )
      .toBe('traced: Image Trace, Image Trace');
    const presets = await page.evaluate(() => (window as any).__opuller.mcp.imageTrace({ op: 'presets' }));
    expect(presets.map((p: any) => p.id)).toContain('hifi');
  });

  test('image trace Strokes mode turns thin lines into stroked centerlines', async ({ page }) => {
    // a thick disc plus a thin curve on white
    const img = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 120;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 200, 120);
      g.fillStyle = '#000000';
      g.beginPath();
      g.arc(50, 60, 30, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#000000';
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(100, 100);
      g.quadraticCurveTo(140, 10, 190, 100);
      g.stroke();
      const r = await (window as any).__opuller.mcp.placeImage({ dataUrl: c.toDataURL('image/png'), x: 100, y: 100, width: 400 });
      return r.id as string;
    });
    const res = await page.evaluate((id) => (window as any).__opuller.mcp.imageTrace({ ids: [id], preset: 'technical', options: { source: 'keep', noise: 2 } }), img);
    expect(res.groups.length).toBe(1);
    const s = await getState(page);
    const nodes = s.doc.nodes[res.groups[0]].children.map((id: string) => s.doc.nodes[id]);
    const fills = nodes.filter((n: any) => n.fill.type === 'solid');
    const strokes = nodes.filter((n: any) => n.fill.type === 'none' && n.stroke.paint.type === 'solid');
    expect(fills.length).toBe(1);
    expect(strokes.length).toBeGreaterThanOrEqual(1);
    const stroke = strokes[0];
    expect(stroke.stroke.width).toBeGreaterThan(1.5);
    expect(stroke.stroke.width).toBeLessThan(5);
    expect(stroke.stroke.cap).toBe('round');
    expect(stroke.subpaths[0].closed).toBe(false);
    // the fill is the disc (roughly 60 image px = 120 world units wide)
    const fb = (await worldBounds(page, fills[0].id))!;
    expect(Math.abs(fb.width - 120)).toBeLessThan(8);
    // the stroke spans the curve
    const sb = (await worldBounds(page, stroke.id))!;
    expect(sb.width).toBeGreaterThan(150);
    // strokes only (Line Art): no fills at all
    const only = await page.evaluate((id) => (window as any).__opuller.mcp.imageTrace({ ids: [id], preset: 'lineart', options: { source: 'keep', noise: 2 } }), img);
    const s2 = await getState(page);
    const nodes2 = s2.doc.nodes[only.groups[0]].children.map((id: string) => s2.doc.nodes[id]);
    expect(nodes2.every((n: any) => n.fill.type === 'none')).toBe(true);
    expect(nodes2.length).toBeGreaterThanOrEqual(1);
    // the dialog exposes the Fills / Strokes switches
    await withStore(page, (st) => st.setSelection([Object.keys(st.doc.nodes).find((k) => st.doc.nodes[k].type === 'image')!]));
    await runCommand(page, 'image.trace');
    await expect(page.getByTestId('trace-ok')).toBeVisible();
    await page.getByText('Strokes', { exact: true }).click();
    await expect(page.getByTestId('trace-max-stroke')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('rasterize replaces vector objects with an image; crop image to a rectangle', async ({ page }) => {
    const r = await drawRect(page, 100, 100, 200, 100);
    await runCommand(page, 'object.rasterize');
    await expect(page.getByTestId('rasterize-ok')).toBeVisible();
    await page.getByTestId('rasterize-ppi').fill('96');
    await page.getByTestId('rasterize-ppi').press('Enter');
    await page.getByTestId('rasterize-ok').click();
    await expect.poll(async () => (await getState(page)).doc.nodes[r]).toBeUndefined();
    let s = await getState(page);
    const img = s.selection[0];
    const n = s.doc.nodes[img];
    expect(n.type).toBe('image');
    expect(Math.round(n.width)).toBe(200);
    expect(Math.round(n.height)).toBe(100);
    expect(n.naturalWidth).toBeGreaterThanOrEqual(199);
    // crop with a rectangle drawn over the left half
    const c = await drawRect(page, 100, 100, 100, 100);
    await withStore(page, (st) => st.setSelection(Object.keys(st.doc.nodes).filter((k) => st.doc.nodes[k].type === 'image' || k === st.selection[0])));
    await runCommand(page, 'image.crop');
    s = await getState(page);
    expect(s.doc.nodes[c]).toBeUndefined();
    const cropped = s.doc.nodes[img];
    expect(cropped.crop).toBeTruthy();
    expect(Math.round(cropped.width)).toBe(100);
    const b = await worldBounds(page, img);
    expect(Math.round(b!.x)).toBe(100);
    expect(Math.round(b!.width)).toBe(100);
    await runCommand(page, 'image.resetCrop');
    s = await getState(page);
    expect(s.doc.nodes[img].crop).toBeUndefined();
    expect(Math.round(s.doc.nodes[img].width)).toBe(200);
  });

  test('pixel brush paints into a new raster layer', async ({ page }) => {
    await withStore(page, (st) => st.setTool('pixelbrush'));
    const box = await page.locator('[data-testid="viewport"]').boundingBox();
    // world (300,300) → screen (400,400) at zoom 1 / pan 100
    await page.mouse.move(box!.x + 400, box!.y + 400);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box!.x + 400 + i * 20, box!.y + 400 + i * 5);
    await page.mouse.up();
    await expect.poll(async () => Object.values((await getState(page)).doc.nodes).filter((n: any) => n.type === 'image').length).toBe(1);
    const s = await getState(page);
    const img: any = Object.values(s.doc.nodes).find((n: any) => n.type === 'image');
    expect(img.name).toBe('Raster layer');
    expect(img.src.length).toBeGreaterThan(200);
    expect(s.past.length).toBe(2); // new layer + paint
    // the painted pixels are not transparent at the stroke
    const alpha = await page.evaluate(async (src) => {
      const im = new Image();
      im.src = src;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(im, 0, 0);
      return g.getImageData(380, 320, 1, 1).data[3];
    }, img.src);
    expect(alpha).toBeGreaterThan(0);
  });
});
