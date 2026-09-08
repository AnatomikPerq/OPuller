/**
 * Colour module e2e: Color / Swatches / Gradient / Stroke panels, Gradient tool
 * and Eyedropper tool.
 */
import { test, expect, type Page } from '@playwright/test';
import { openApp, withStore, drawRect, getState, selectTool, nodeById, press, setView, viewport, worldToScreen } from './helpers';

type Vec = { x: number; y: number };

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Add a rectangle through the store API with a given fill (deterministic). */
async function addRect(page: Page, x: number, y: number, w: number, h: number, fill: string, opts: { stroke?: Record<string, unknown>; select?: boolean } = {}): Promise<string> {
  return page.evaluate(
    ({ x, y, w, h, fill, opts }) => {
      const s = (window as any).__opuller.store.getState();
      const api = (window as any).__opuller.api;
      const node = api.nodes.makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y }, fill: { type: 'solid', color: fill, opacity: 1 } });
      if (opts.stroke) node.stroke = { ...node.stroke, ...opts.stroke };
      s.updateDoc((d: any) => api.document.addNode(d, node, d.layers[0]), 'Create');
      if (opts.select !== false) s.setSelection([node.id]);
      return node.id as string;
    },
    { x, y, w, h, fill, opts },
  );
}

async function showPanel(page: Page, id: string): Promise<void> {
  await page.getByTestId(`panel-tab-${id}`).click();
  await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
}

async function screenPoint(page: Page, world: Vec): Promise<Vec> {
  const box = await viewport(page).boundingBox();
  const p = await worldToScreen(page, world.x, world.y);
  return { x: box!.x + p.x, y: box!.y + p.y };
}

async function dragScreen(page: Page, from: Vec, to: Vec, opts: { steps?: number; modifiers?: string[]; escape?: boolean } = {}): Promise<void> {
  const steps = opts.steps ?? 8;
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  if (opts.escape) await page.keyboard.press('Escape');
  await page.mouse.up();
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
}

async function fillField(page: Page, testId: string, value: string): Promise<void> {
  const input = page.getByTestId(testId);
  await input.click();
  await input.fill(value);
  await input.press('Enter');
}

async function historyLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__opuller.store.getState().past.map((p: any) => p.label));
}

test.describe('colour module', () => {
  test.beforeEach(async ({ page }) => {
    // other agents editing the shared tree trigger Vite reloads; keep HMR away from these pages
    await page.routeWebSocket(/.*/, () => {});
  });

  test('Color panel: hex input, sliders and quick buttons edit the fill / stroke / defaults', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await showPanel(page, 'color');
    await expect(page.getByTestId('color-target-label')).toHaveText(/Fill/);

    const before = (await historyLabels(page)).length;
    await page.locator('#color-hex').fill('ff0000');
    await page.locator('#color-hex').press('Enter');
    let n = await nodeById(page, id);
    expect(n.fill).toEqual({ type: 'solid', color: '#ff0000', opacity: 1 });
    expect((await historyLabels(page)).length).toBe(before + 1);
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.fill.color).toBe('#ffffff');
    await press(page, 'Control+Shift+z');
    n = await nodeById(page, id);
    expect(n.fill.color).toBe('#ff0000');

    // HSB numeric field: saturation 0 -> white-ish based on current B
    await fillField(page, 'color-field-s', '0');
    n = await nodeById(page, id);
    expect(n.fill.color).toBe('#ffffff');
    // switch to RGB mode and set G through the field
    await page.locator('#color-mode').selectOption('rgb');
    await fillField(page, 'color-field-g', '0');
    await fillField(page, 'color-field-b', '0');
    n = await nodeById(page, id);
    expect(n.fill.color).toBe('#ff0000');
    // opacity field
    await fillField(page, 'color-opacity', '50');
    n = await nodeById(page, id);
    expect(n.fill.opacity).toBeCloseTo(0.5, 2);

    // stroke target
    await page.getByTestId('color-stroke-swatch').click();
    await expect(page.getByTestId('color-target-label')).toHaveText(/Stroke/);
    await page.locator('#color-hex').fill('00ff00');
    await page.locator('#color-hex').press('Enter');
    n = await nodeById(page, id);
    expect(n.stroke.paint.color).toBe('#00ff00');
    expect(n.fill.color).toBe('#ff0000');
    // quick None button removes the stroke paint
    await page.getByTestId('color-quick-none').click();
    n = await nodeById(page, id);
    expect(n.stroke.paint.type).toBe('none');
    await page.getByTestId('color-quick-black').click();
    n = await nodeById(page, id);
    expect(n.stroke.paint).toEqual({ type: 'solid', color: '#000000', opacity: 1 });

    // nothing selected: edits change the defaults for new objects
    await page.getByTestId('color-fill-swatch').click();
    await page.evaluate(() => (window as any).__opuller.store.getState().clearSelection());
    await expect(page.getByTestId('color-target-label')).toHaveText(/Fill/);
    await page.locator('#color-hex').fill('123456');
    await page.locator('#color-hex').press('Enter');
    const s = await getState(page);
    expect(s.appearance.fill.color).toBe('#123456');
    expect((await nodeById(page, id)).fill.color).toBe('#ff0000');

    // spectrum bar drag picks a colour (pure hue in the middle row)
    const spectrum = page.getByTestId('color-spectrum');
    const box = (await spectrum.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.up();
    const s2 = await getState(page);
    expect(s2.appearance.fill.color).not.toBe('#123456');
    expect(errors).toEqual([]);
  });

  test('Color panel edits the active gradient stop', async ({ page }) => {
    await openApp(page);
    const id = await addRect(page, 100, 100, 200, 120, '#ff9500');
    await page.evaluate(() => {
      const s = (window as any).__opuller.store.getState();
      s.updateDoc((d: any) => {
        d.nodes[s.selection[0]].fill = { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, spread: 'pad', stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] };
      }, 'Fill');
      s.setActiveGradientStop(1);
    });
    await showPanel(page, 'color');
    await expect(page.getByTestId('color-stop-note')).toHaveText(/stop 2 of 2/);
    await page.locator('#color-hex').fill('0000ff');
    await page.locator('#color-hex').press('Enter');
    const n = await nodeById(page, id);
    expect(n.fill.type).toBe('linear');
    expect(n.fill.stops[1].color).toBe('#0000ff');
    expect(n.fill.stops[0].color).toBe('#000000');
  });

  test('Swatches panel: apply, Alt-apply, add, libraries, context menu, list view', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await addRect(page, 100, 100, 200, 120, '#ffffff');
    await showPanel(page, 'swatches');
    // Crimson (#c8102e) is a default swatch
    await page.getByTestId('swatch-sw-3').click();
    let n = await nodeById(page, id);
    expect(n.fill.color).toBe('#c8102e');
    expect(page.getByTestId('swatch-sw-3')).toHaveClass(/in-use/);
    // Alt-click applies to the stroke
    await page.getByTestId('swatch-sw-13').click({ modifiers: ['Alt'] });
    n = await nodeById(page, id);
    expect(n.stroke.paint.color).toBe('#007aff');
    expect(n.fill.color).toBe('#c8102e');
    // None swatch
    await page.getByTestId('swatch-none').click();
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('none');
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.fill.color).toBe('#c8102e');

    // "Add to swatches" from the Color panel
    const count0 = (await getState(page)).doc.swatches.length;
    await showPanel(page, 'color');
    await page.locator('#color-hex').fill('123456');
    await page.locator('#color-hex').press('Enter');
    await page.getByTestId('color-add-swatch').click();
    let sw = (await getState(page)).doc.swatches;
    expect(sw.length).toBe(count0 + 1);
    expect(sw[sw.length - 1].paint).toEqual({ type: 'solid', color: '#123456', opacity: 1 });
    expect(sw[sw.length - 1].name).toBe('#123456');

    // New swatch dialog
    await showPanel(page, 'swatches');
    await page.getByTestId('swatches-new').click();
    await expect(page.getByTestId('dialog')).toBeVisible();
    await page.locator('#swatch-new-name').fill('My colour');
    await page.getByTestId('swatch-new-ok').click();
    sw = (await getState(page)).doc.swatches;
    expect(sw[sw.length - 1].name).toBe('My colour');
    expect(sw[sw.length - 1].paint.color).toBe('#123456');

    // library
    await page.getByTestId('swatches-libraries').click();
    await page.getByTestId('swatches-lib-neon').click();
    sw = (await getState(page)).doc.swatches;
    expect(sw.length).toBe(count0 + 2 + 10);
    expect(sw.some((s: any) => s.name === 'Neon Green')).toBe(true);

    // context menu: select objects using / delete
    const myId = sw.find((s: any) => s.name === 'My colour').id;
    await page.evaluate(() => (window as any).__opuller.store.getState().clearSelection());
    await page.getByTestId(`swatch-${myId}`).click({ button: 'right' });
    await expect(page.locator('.menu')).toBeVisible();
    await page.locator('.menu-item', { hasText: 'Select All Objects Using' }).click();
    expect((await getState(page)).selection).toEqual([id]);
    await page.getByTestId(`swatch-${myId}`).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Delete' }).click();
    sw = (await getState(page)).doc.swatches;
    expect(sw.some((s: any) => s.id === myId)).toBe(false);
    await press(page, 'Control+z');
    sw = (await getState(page)).doc.swatches;
    expect(sw.some((s: any) => s.id === myId)).toBe(true);

    // double-click opens the editor and updates objects using the swatch
    await page.getByTestId(`swatch-${myId}`).dblclick();
    await expect(page.getByTestId('swatch-editor')).toBeVisible();
    const hex = page.getByTestId('swatch-editor').locator('label.text-field', { has: page.locator('.field-label', { hasText: /^#$/ }) }).locator('input');
    await hex.fill('abcdef');
    await hex.press('Enter');
    sw = (await getState(page)).doc.swatches;
    expect(sw.find((s: any) => s.id === myId).paint.color).toBe('#abcdef');
    n = await nodeById(page, id);
    expect(n.fill.color).toBe('#abcdef');
    await page.keyboard.press('Escape');

    // drag to reorder: move the first swatch after the third
    const first = sw[0].id;
    const third = sw[2].id;
    const a = (await page.getByTestId(`swatch-${first}`).boundingBox())!;
    const b = (await page.getByTestId(`swatch-${third}`).boundingBox())!;
    await dragScreen(page, { x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width - 2, y: b.y + b.height / 2 }, { steps: 6 });
    sw = (await getState(page)).doc.swatches;
    expect(sw[2].id).toBe(first);
    expect(sw[0].id).not.toBe(first);

    // list view shows names
    await page.getByTestId('swatches-view-list').click();
    await expect(page.locator('.sw-row', { hasText: 'Crimson' })).toBeVisible();
    await page.getByTestId('swatches-view-grid').click();
    expect(errors).toEqual([]);
  });

  test('Gradient panel converts a solid fill to linear, reverses, rotates and adds stops', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await addRect(page, 100, 100, 200, 100, '#ff9500');
    await showPanel(page, 'gradient');
    await expect(page.getByTestId('gradient-hint')).toBeVisible();
    await page.getByTestId('panel-gradient').locator('.segment', { hasText: 'Linear' }).click();
    let n = await nodeById(page, id);
    expect(n.fill.type).toBe('linear');
    expect(n.fill.stops[0].color).toBe('#ff9500');
    expect(n.fill.stops[1].color).toBe('#ffffff');
    expect(n.fill.x1).toBe(0);
    expect(n.fill.x2).toBe(1);

    await page.getByTestId('gradient-reverse').click();
    n = await nodeById(page, id);
    expect(n.fill.stops[0].color).toBe('#ffffff');
    expect(n.fill.stops[0].offset).toBe(0);
    expect(n.fill.stops[1].color).toBe('#ff9500');
    expect(n.fill.stops[1].offset).toBe(1);

    // angle 90 = bottom to top (Illustrator convention)
    await fillField(page, 'gradient-angle', '90');
    n = await nodeById(page, id);
    expect(n.fill.x1).toBeCloseTo(0.5, 5);
    expect(n.fill.x2).toBeCloseTo(0.5, 5);
    expect(n.fill.y1).toBeGreaterThan(n.fill.y2);
    await expect(page.getByTestId('gradient-angle')).toHaveValue('90');

    // click the bar adds a stop
    const strip = page.getByTestId('gradient-bar-strip');
    const box = (await strip.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    n = await nodeById(page, id);
    expect(n.fill.stops.length).toBe(3);
    expect(n.fill.stops[2].offset).toBeCloseTo(0.5, 1);
    expect((await getState(page)).activeGradientStop).toBe(2);
    // stop position + opacity fields edit the selected stop
    await fillField(page, 'gradient-stop-position', '25');
    await fillField(page, 'gradient-stop-opacity', '40');
    n = await nodeById(page, id);
    expect(n.fill.stops[2].offset).toBeCloseTo(0.25, 5);
    expect(n.fill.stops[2].opacity).toBeCloseTo(0.4, 5);
    // delete the stop
    await page.getByTestId('gradient-stop-delete').click();
    n = await nodeById(page, id);
    expect(n.fill.stops.length).toBe(2);

    // radial
    await page.getByTestId('panel-gradient').locator('.segment', { hasText: 'Radial' }).click();
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('radial');
    await fillField(page, 'gradient-cx', '25');
    n = await nodeById(page, id);
    expect(n.fill.cx).toBeCloseTo(0.25, 5);
    await page.locator('#gradient-spread').selectOption('reflect');
    n = await nodeById(page, id);
    expect(n.fill.spread).toBe('reflect');

    // preset + none
    await page.getByTestId('gradient-preset-burgundy').click();
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('linear');
    expect(n.fill.stops[0].color).toBe('#a33660');
    await page.getByTestId('gradient-none').click();
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('none');
    // apply to the stroke target
    await page.getByTestId('gradient-stroke-swatch').click();
    await page.getByTestId('gradient-preset-ocean').click();
    n = await nodeById(page, id);
    expect(n.stroke.paint.type).toBe('linear');
    expect(errors).toEqual([]);
  });

  test('Gradient tool: drag sets the direction, handles and stops are editable, Escape cancels', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await addRect(page, 120, 120, 240, 160, '#7a1f3d');
    await selectTool(page, 'gradient');
    expect((await getState(page)).activeTool).toBe('gradient');
    const before = (await historyLabels(page)).length;
    await dragScreen(page, await screenPoint(page, { x: 150, y: 200 }), await screenPoint(page, { x: 330, y: 200 }));
    let n = await nodeById(page, id);
    expect(n.fill.type).toBe('linear');
    expect(n.fill.x1).toBeCloseTo(0.125, 3);
    expect(n.fill.x2).toBeCloseTo(0.875, 3);
    expect(n.fill.y1).toBeCloseTo(0.5, 3);
    expect(n.fill.stops[0].color).toBe('#7a1f3d');
    const labels = await historyLabels(page);
    expect(labels.length).toBe(before + 1);
    expect(labels[labels.length - 1]).toBe('Gradient Fill');
    await expect(page.getByTestId('gradient-annotator')).toBeVisible();

    // Escape during a drag reverts
    await dragScreen(page, await screenPoint(page, { x: 130, y: 250 }), await screenPoint(page, { x: 300, y: 130 }), { escape: true });
    n = await nodeById(page, id);
    expect(n.fill.x1).toBeCloseTo(0.125, 3);
    expect((await historyLabels(page)).length).toBe(before + 1);

    // drag the end handle with Shift (constrained to 45deg steps -> stays horizontal)
    await dragScreen(page, await screenPoint(page, { x: 330, y: 200 }), await screenPoint(page, { x: 372, y: 215 }), { modifiers: ['Shift'] });
    n = await nodeById(page, id);
    expect(n.fill.x2).toBeCloseTo(1.05, 2);
    expect(n.fill.y2).toBeCloseTo(0.5, 3);

    // click the line to add a stop, drag it
    await page.mouse.click(...(Object.values(await screenPoint(page, { x: 250, y: 200 })) as [number, number]));
    n = await nodeById(page, id);
    expect(n.fill.stops.length).toBe(3);
    const t0 = n.fill.stops[2].offset;
    await dragScreen(page, await screenPoint(page, { x: 250, y: 200 }), await screenPoint(page, { x: 200, y: 200 }));
    n = await nodeById(page, id);
    expect(n.fill.stops[2].offset).toBeLessThan(t0);
    // drag it far away from the line to delete it
    await dragScreen(page, await screenPoint(page, { x: 200, y: 200 }), await screenPoint(page, { x: 200, y: 330 }));
    n = await nodeById(page, id);
    expect(n.fill.stops.length).toBe(2);

    // double-click the start stop opens the colour popover
    await page.mouse.dblclick(...(Object.values(await screenPoint(page, { x: 150, y: 200 })) as [number, number]));
    await expect(page.locator('.solid-color-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.solid-color-popover')).toHaveCount(0);

    // zoomed view: bbox units stay consistent
    await setView(page, 2, { x: -100, y: -100 });
    await dragScreen(page, await screenPoint(page, { x: 120, y: 200 }), await screenPoint(page, { x: 360, y: 200 }));
    n = await nodeById(page, id);
    expect(n.fill.x1).toBeCloseTo(0, 2);
    expect(n.fill.x2).toBeCloseTo(1, 2);
    await setView(page, 1, { x: 100, y: 100 });

    // radial via the options bar, then drag the radius handle
    await page.getByTestId('controlbar').locator('.segment', { hasText: 'Radial' }).click();
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('radial');
    const r0 = n.fill.r;
    const center = { x: 120 + n.fill.cx * 240, y: 120 + n.fill.cy * 160 };
    const radiusHandle = { x: 120 + (n.fill.cx + n.fill.r) * 240, y: center.y };
    await dragScreen(page, await screenPoint(page, radiusHandle), await screenPoint(page, { x: radiusHandle.x - 60, y: radiusHandle.y }));
    n = await nodeById(page, id);
    expect(n.fill.r).toBeLessThan(r0);
    // Alt-drag the centre moves the focal point only
    await dragScreen(page, await screenPoint(page, center), await screenPoint(page, { x: center.x + 20, y: center.y }), { modifiers: ['Alt'] });
    n = await nodeById(page, id);
    expect(n.fill.fx).toBeGreaterThan(n.fill.cx);
    expect(n.fill.cx).toBeCloseTo(center.x / 240 - 0.5, 2);

    // object inside a transformed group: annotator follows the world matrix
    await selectTool(page, 'select');
    const gid = await page.evaluate(() => {
      const s = (window as any).__opuller.store.getState();
      const api = (window as any).__opuller.api;
      const rect = api.nodes.makeShape({ kind: 'rect', width: 100, height: 100, radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: '#34c759', opacity: 1 } });
      const g = api.nodes.makeGroup([], { transform: { a: 2, b: 0, c: 0, d: 2, e: 600, f: 300 } });
      s.updateDoc((d: any) => {
        api.document.addNode(d, g, d.layers[0]);
        api.document.addNode(d, rect, g.id);
      }, 'Create');
      s.setSelection([g.id]);
      return rect.id;
    });
    await selectTool(page, 'gradient');
    // the tool keeps the last used type (radial above); ask for linear again
    await withStore(page, (st) => st.setToolOptions('gradient', { type: 'linear' }));
    // group occupies world 600..800 x 300..500; drag across its middle
    await dragScreen(page, await screenPoint(page, { x: 600, y: 400 }), await screenPoint(page, { x: 800, y: 400 }));
    const inner = await nodeById(page, gid);
    expect(inner.fill.type).toBe('linear');
    expect(inner.fill.x1).toBeCloseTo(0, 2);
    expect(inner.fill.x2).toBeCloseTo(1, 2);
    expect(inner.fill.y1).toBeCloseTo(0.5, 2);
    expect(errors).toEqual([]);
  });

  test('Eyedropper copies the appearance between shapes, Alt applies, Shift samples a colour', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const a = await addRect(page, 100, 100, 200, 120, '#ff9500', { stroke: { width: 5, dash: [8, 4], paint: { type: 'solid', color: '#007aff', opacity: 1 } }, select: false });
    const b = await addRect(page, 500, 100, 120, 120, '#34c759');
    await selectTool(page, 'eyedropper');
    const before = (await historyLabels(page)).length;
    const pa = await screenPoint(page, { x: 200, y: 160 });
    await page.mouse.click(pa.x, pa.y);
    let nb = await nodeById(page, b);
    expect(nb.fill.color).toBe('#ff9500');
    expect(nb.stroke.paint.color).toBe('#007aff');
    expect(nb.stroke.width).toBe(5);
    expect(nb.stroke.dash).toEqual([8, 4]);
    expect((await historyLabels(page)).length).toBe(before + 1);
    await press(page, 'Control+z');
    nb = await nodeById(page, b);
    expect(nb.fill.color).toBe('#34c759');
    expect(nb.stroke.width).toBe(1);

    // options: stroke off -> only the fill is copied
    await page.getByTestId('controlbar').locator('.checkbox', { hasText: 'Stroke options' }).locator('.checkbox-box').click();
    await page.mouse.click(pa.x, pa.y);
    nb = await nodeById(page, b);
    expect(nb.fill.color).toBe('#ff9500');
    expect(nb.stroke.paint.color).toBe('#007aff');
    expect(nb.stroke.width).toBe(1);
    await press(page, 'Control+z');
    await page.getByTestId('controlbar').locator('.checkbox', { hasText: 'Stroke options' }).locator('.checkbox-box').click();

    // Alt-click applies the selection appearance (B) to A
    await page.keyboard.down('Alt');
    await page.mouse.click(pa.x, pa.y);
    await page.keyboard.up('Alt');
    let na = await nodeById(page, a);
    expect(na.fill.color).toBe('#34c759');
    expect(na.stroke.width).toBe(1);
    await press(page, 'Control+z');
    na = await nodeById(page, a);
    expect(na.fill.color).toBe('#ff9500');

    // Shift-click on A's stroke samples only the stroke colour into the active target (fill)
    const edge = await screenPoint(page, { x: 100, y: 160 });
    await page.keyboard.down('Shift');
    await page.mouse.click(edge.x, edge.y);
    await page.keyboard.up('Shift');
    nb = await nodeById(page, b);
    expect(nb.fill.color).toBe('#007aff');
    expect(nb.stroke.width).toBe(1);

    // nothing selected: sampling sets the defaults
    await page.evaluate(() => (window as any).__opuller.store.getState().clearSelection());
    await page.mouse.click(pa.x, pa.y);
    const s = await getState(page);
    expect(s.appearance.fill.color).toBe('#ff9500');
    expect(s.appearance.stroke.width).toBe(5);
    expect(errors).toEqual([]);
  });

  test('Stroke panel: weight, caps, dashes, arrowheads and width profiles; mixed values show empty', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await addRect(page, 100, 100, 200, 120, '#ffffff');
    await showPanel(page, 'stroke');
    await fillField(page, 'stroke-weight', '4');
    let n = await nodeById(page, id);
    expect(n.stroke.width).toBe(4);

    await page.getByTestId('panel-stroke').locator('[title="Round cap"]').click();
    await page.getByTestId('panel-stroke').locator('[title="Bevel join"]').click();
    await page.getByTestId('panel-stroke').locator('[title="Align stroke to inside"]').click();
    n = await nodeById(page, id);
    expect(n.stroke.cap).toBe('round');
    expect(n.stroke.join).toBe('bevel');
    expect(n.stroke.align).toBe('inside');

    // dashes
    await page.getByTestId('panel-stroke').locator('.stroke-dashed .checkbox-box').click();
    n = await nodeById(page, id);
    expect(n.stroke.dash).toEqual([12, 6]);
    await fillField(page, 'stroke-dash-0', '4');
    await fillField(page, 'stroke-dash-2', '2');
    await fillField(page, 'stroke-dash-3', '3');
    n = await nodeById(page, id);
    expect(n.stroke.dash).toEqual([4, 6, 2, 3]);
    await page.getByTestId('panel-stroke').locator('.stroke-dashed .checkbox-box').click();
    n = await nodeById(page, id);
    expect(n.stroke.dash).toEqual([]);

    // arrowheads
    await page.getByTestId('stroke-arrow-end').click();
    await page.getByTestId('stroke-arrow-end-arrow').click();
    n = await nodeById(page, id);
    expect(n.stroke.markerEnd).toBe('arrow');
    expect(n.stroke.markerStart).toBe('none');
    await page.getByTestId('stroke-arrow-swap').click();
    n = await nodeById(page, id);
    expect(n.stroke.markerStart).toBe('arrow');
    expect(n.stroke.markerEnd).toBe('none');
    await fillField(page, 'stroke-arrow-scale', '200');
    n = await nodeById(page, id);
    expect(n.stroke.markerScale).toBe(2);
    // the renderer draws a marker for the stroke
    await expect(page.locator(`.canvas-svg [data-id="${id}"] marker`)).toHaveCount(1);

    // width profile
    await page.getByTestId('stroke-profile').click();
    await page.getByTestId('stroke-profile-taperEnd').click();
    n = await nodeById(page, id);
    expect(n.stroke.widthProfile).toEqual([
      { offset: 0, width: 4 },
      { offset: 1, width: 0 },
    ]);
    await page.getByTestId('stroke-profile-flip').click();
    n = await nodeById(page, id);
    expect(n.stroke.widthProfile).toEqual([
      { offset: 0, width: 0 },
      { offset: 1, width: 4 },
    ]);
    await expect(page.getByTestId('stroke-profile')).toHaveText(/Taper start/);
    // weight change scales the profile
    await fillField(page, 'stroke-weight', '8');
    n = await nodeById(page, id);
    expect(n.stroke.widthProfile[1].width).toBe(8);
    await page.getByTestId('stroke-profile').click();
    await page.getByTestId('stroke-profile-uniform').click();
    n = await nodeById(page, id);
    expect(n.stroke.widthProfile).toBeUndefined();

    // mixed selection shows empty weight
    const other = await addRect(page, 400, 100, 100, 100, '#ffffff', { stroke: { width: 2 }, select: false });
    await page.evaluate(([a, b]) => (window as any).__opuller.store.getState().setSelection([a, b]), [id, other]);
    await expect(page.getByTestId('stroke-weight')).toHaveValue('');
    await fillField(page, 'stroke-weight', '3');
    expect((await nodeById(page, id)).stroke.width).toBe(3);
    expect((await nodeById(page, other)).stroke.width).toBe(3);
    expect(errors).toEqual([]);
  });
});
