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
    await expect.poll(async () => (await getState(page)).selection.length).toBe(1);
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
