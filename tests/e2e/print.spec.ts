/**
 * Colour & print features: document colour mode, global / spot swatches with
 * tints, Edit Colors commands, Recolor Artwork, bleed and printer's marks.
 */
import { test, type Page } from '@playwright/test';
import { openApp, expect, getState, runCommand, nodeById } from './helpers';

async function addRect(page: Page, x: number, y: number, fill: string): Promise<string> {
  return page.evaluate(
    ({ x, y, fill }: { x: number; y: number; fill: string }) => {
      const s = (window as any).__opuller.store.getState();
      const api = (window as any).__opuller.api;
      const node = api.nodes.makeShape({ kind: 'rect', width: 120, height: 80, radii: [0, 0, 0, 0] }, { transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y }, fill: { type: 'solid', color: fill, opacity: 1 } });
      s.updateDoc((d: any) => api.document.addNode(d, node, d.layers[0]), 'Create');
      return node.id as string;
    },
    { x, y, fill },
  );
}

test.describe('colour and print', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('global swatch: apply, edit propagates, tint slider, spot conversion', async ({ page }) => {
    const a = await addRect(page, 100, 100, '#c8102e');
    const b = await addRect(page, 300, 100, '#c8102e');
    // make a global swatch from the colour and link the objects using it
    const swId = await page.evaluate(() => {
      const o = (window as any).__opuller;
      const sw = o.color.addSwatch({ type: 'solid', color: '#c8102e', opacity: 1 }, 'Brand red', { kind: 'process' });
      o.color.setSwatchKind(sw.id, 'global');
      return sw.id as string;
    });
    let n = await nodeById(page, a);
    expect(n.fill.swatchId).toBe(swId);
    expect(n.fill.tint).toBe(100);
    // the Swatches panel marks it as global; double-click opens the options with the kind row
    await page.getByTestId('panel-tab-swatches').click();
    const cell = page.getByTestId(`swatch-${swId}`);
    await expect(cell).toHaveClass(/global/);
    await cell.dblclick();
    await expect(page.getByTestId('swatch-kind-row')).toBeVisible();
    await page.keyboard.press('Escape');
    // editing the swatch colour recolours both objects
    await page.evaluate((id) => (window as any).__opuller.store.getState().updateDoc((d: any) => {
      const sw = d.swatches.find((x: any) => x.id === id);
      sw.paint = { type: 'solid', color: '#0000ff', opacity: 1 };
      (window as any).__opuller.color.propagateSwatch(d, sw);
    }, 'Edit Swatch'), swId);
    n = await nodeById(page, b);
    expect(n.fill.color).toBe('#0000ff');
    // tint through the Color panel
    await page.evaluate((id) => (window as any).__opuller.store.getState().setSelection([id]), a);
    await page.getByTestId('panel-tab-color').click();
    await expect(page.getByTestId('color-tint')).toBeVisible();
    await expect(page.getByTestId('color-channels')).toHaveCount(0);
    await page.evaluate(() => (window as any).__opuller.color.setActiveTint(50, true));
    n = await nodeById(page, a);
    expect(n.fill.tint).toBe(50);
    expect(n.fill.color).toBe('#8080ff');
    // spot conversion keeps the link and stores inks; process conversion unlinks
    await page.evaluate((id) => (window as any).__opuller.color.setSwatchKind(id, 'spot'), swId);
    let s = await getState(page);
    let sw = s.doc.swatches.find((x: any) => x.id === swId);
    expect(sw.kind).toBe('spot');
    expect(sw.cmyk).toEqual({ c: 100, m: 100, y: 0, k: 0 });
    await page.evaluate((id) => (window as any).__opuller.color.setSwatchKind(id, 'process'), swId);
    n = await nodeById(page, a);
    expect(n.fill.swatchId).toBeUndefined();
    expect(n.fill.color).toBe('#8080ff');
    s = await getState(page);
    sw = s.doc.swatches.find((x: any) => x.id === swId);
    expect(sw.kind).toBeUndefined();
  });

  test('document colour mode switches the Color panel to CMYK and names swatches with inks', async ({ page }) => {
    await page.getByTestId('panel-tab-color').click();
    await runCommand(page, 'file.colorMode.cmyk');
    expect((await getState(page)).doc.colorMode).toBe('cmyk');
    await expect(page.locator('#color-mode')).toHaveValue('cmyk');
    await expect(page.getByTestId('color-slider-k')).toBeVisible();
    const swId = await page.evaluate(() => (window as any).__opuller.color.addSwatch({ type: 'solid', color: '#00ffff', opacity: 1 }).id as string);
    const sw = (await getState(page)).doc.swatches.find((x: any) => x.id === swId);
    expect(sw.name).toBe('C=100 M=0 Y=0 K=0');
    expect(sw.cmyk).toEqual({ c: 100, m: 0, y: 0, k: 0 });
    await runCommand(page, 'file.colorMode.rgb');
    await expect(page.locator('#color-mode')).toHaveValue('hsb');
  });

  test('Edit Colors: invert, grayscale, saturate dialog, blend front to back', async ({ page }) => {
    const a = await addRect(page, 100, 100, '#ff0000');
    const b = await addRect(page, 300, 100, '#123456');
    const c = await addRect(page, 500, 100, '#ffffff');
    await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), [a, b, c]);
    await runCommand(page, 'edit.colors.blendFrontBack');
    expect((await nodeById(page, b)).fill.color).toBe('#ff8080');
    await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), [a]);
    await runCommand(page, 'edit.colors.invert');
    expect((await nodeById(page, a)).fill.color).toBe('#00ffff');
    await runCommand(page, 'edit.colors.grayscale');
    expect((await nodeById(page, a)).fill.color).toBe('#b3b3b3');
    await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), [b]);
    await runCommand(page, 'edit.colors.saturate');
    await expect(page.getByTestId('saturate-ok')).toBeVisible();
    const slider = page.locator('.dialog .slider-field input[type="range"]');
    await slider.fill('-100');
    await page.getByTestId('saturate-ok').click();
    expect((await nodeById(page, b)).fill.color).toBe('#ffffff');
    const labels = (await getState(page)).past.map((p: any) => p.label);
    expect(labels.slice(-4)).toEqual(['Blend Front to Back', 'Invert Colors', 'Convert to Grayscale', 'Saturate']);
  });

  test('Recolor Artwork: assignments, harmony, hue shift, cancel restores, OK commits one step', async ({ page }) => {
    const a = await addRect(page, 100, 100, '#ff0000');
    const b = await addRect(page, 300, 100, '#0000ff');
    await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), [a, b]);
    const steps0 = (await getState(page)).past.length;
    await runCommand(page, 'edit.colors.recolor');
    await expect(page.getByTestId('recolor-dialog')).toBeVisible();
    await expect(page.locator('.recolor-row')).toHaveCount(3); // red, blue, black stroke
    // hue shift previews live
    const hue = page.locator('.recolor-sliders .slider-field').first().locator('input[type="range"]');
    await hue.fill('120');
    await expect.poll(async () => (await nodeById(page, a)).fill.color).toBe('#00ff00');
    // cancel restores the artwork
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('recolor-dialog')).toHaveCount(0);
    expect((await nodeById(page, a)).fill.color).toBe('#ff0000');
    expect((await getState(page)).past.length).toBe(steps0);
    // harmony + OK
    await runCommand(page, 'edit.colors.recolor');
    await page.locator('#recolor-reduce').selectOption('0');
    await page.locator('#recolor-harmony').selectOption('complementary');
    await expect.poll(async () => (await nodeById(page, b)).fill.color).not.toBe('#0000ff');
    await page.getByTestId('recolor-ok').click();
    const s = await getState(page);
    expect(s.past.length).toBe(steps0 + 1);
    expect(s.past[s.past.length - 1].label).toBe('Recolor Artwork');
    expect(s.doc.nodes[b].fill.color).not.toBe('#0000ff');
  });

  test('bleed guides, Document Setup bleed, export with bleed and printer marks', async ({ page }) => {
    await runCommand(page, 'file.documentSetup');
    await page.getByTestId('doc-setup-bleed-top').fill('10');
    await page.getByTestId('doc-setup-bleed-top').press('Enter');
    await page.getByTestId('doc-setup-ok').click();
    const s = await getState(page);
    expect(s.doc.bleed).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
    await expect(page.getByTestId('bleed-guides')).toBeVisible();
    await runCommand(page, 'view.showBleed');
    await expect(page.getByTestId('bleed-guides')).toHaveCount(0);
    await runCommand(page, 'view.showBleed');
    const out = await page.evaluate(() => {
      const st = (window as any).__opuller.store.getState();
      const io = (window as any).__opullerIO;
      const marks = { trimMarks: true, registrationMarks: true, colorBars: true, pageInfo: true };
      const plain = io.exportSvg(st.doc, { scope: 'artboard' });
      const bled = io.exportSvg(st.doc, { scope: 'artboard', bleed: true });
      const marked = io.exportSvg(st.doc, { scope: 'artboard', bleed: true, marks });
      return { plain: [plain.width, plain.height], bled: [bled.x, bled.width, bled.height], marked: [marked.x, marked.width], hasMarks: marked.svg.includes('printer-marks'), clipped: marked.svg.includes('bleed-clip'), plainMarks: plain.svg.includes('printer-marks') };
    });
    expect(out.plain).toEqual([1920, 1080]);
    expect(out.bled).toEqual([-10, 1940, 1100]);
    expect(out.marked[1]).toBeGreaterThan(1940);
    expect(out.hasMarks).toBe(true);
    expect(out.clipped).toBe(true);
    expect(out.plainMarks).toBe(false);
    // export dialog shows the print options for artboard scopes
    await runCommand(page, 'file.export');
    await expect(page.getByText("Printer's marks")).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
