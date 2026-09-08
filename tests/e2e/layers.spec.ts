import { test, expect, type Page } from '@playwright/test';
import { openApp, drawRect, drawEllipse, selectTool, getState, nodeById, selection, press, runCommand, worldBounds, clickWorld } from './helpers';

const SHOT_DIR = 'C:/Users/BADAB/AppData/Local/Temp/claude/C--Users-BADAB--------------OPuller/9538e8e9-28f5-4b8d-9cb3-a9e066e10c8b/scratchpad';

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function layerIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__opuller.store.getState().doc.layers);
}

async function childrenOf(page: Page, id: string): Promise<string[]> {
  return page.evaluate((id) => (window as any).__opuller.store.getState().doc.nodes[id].children, id);
}

/** Leave any focused input so global shortcuts reach the editor. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

async function undoCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__opuller.store.getState().past.length);
}

async function dragRow(page: Page, fromId: string, toId: string, where: 'top' | 'bottom' | 'center', steps = 6) {
  const from = page.getByTestId(`layer-row-${fromId}`);
  const to = page.getByTestId(`layer-row-${toId}`);
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  const ty = where === 'top' ? b.y + 3 : where === 'bottom' ? b.y + b.height - 3 : b.y + b.height / 2;
  const tx = b.x + 120;
  await page.mouse.move(a.x + 120, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + 120 + ((tx - a.x - 120) * i) / steps, a.y + a.height / 2 + ((ty - a.y - a.height / 2) * i) / steps);
  await page.mouse.up();
}

test.describe('layers panel', () => {
  test.beforeEach(async ({ page }) => {
    // other agents editing the shared tree trigger Vite reloads; keep HMR away from these pages
    await page.routeWebSocket(/.*/, () => {});
  });

  test('shows created objects, toggles visibility and lock with undo', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    const row = page.getByTestId(`layer-row-${id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Rectangle');
    // the new object is selected → row highlighted
    await expect(row).toHaveClass(/selected/);
    // layer row exists and is the active layer
    const [layer] = await layerIds(page);
    await expect(page.getByTestId(`layer-row-${layer}`)).toHaveClass(/active-layer/);

    const before = await undoCount(page);
    await page.getByTestId(`layer-eye-${id}`).click();
    expect((await nodeById(page, id)).visible).toBe(false);
    await expect(row).toHaveClass(/is-hidden/);
    await page.getByTestId(`layer-eye-${id}`).click();
    expect((await nodeById(page, id)).visible).toBe(true);

    await page.getByTestId(`layer-lock-${id}`).click();
    expect((await nodeById(page, id)).locked).toBe(true);
    // locking deselects the object
    expect(await selection(page)).toEqual([]);
    expect(await undoCount(page)).toBe(before + 3);
    await blur(page);
    await press(page, 'Control+z');
    expect((await nodeById(page, id)).locked).toBe(false);
    await page.screenshot({ path: `${SHOT_DIR}/layers-basic.png` });
    expect(errors).toEqual([]);
  });

  test('drag and drop reorders objects and nests into groups', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawEllipse(page, 300, 100, 100, 100);
    const [layer] = await layerIds(page);
    expect(await childrenOf(page, layer)).toEqual([a, b]);
    // rows are top-most first: b above a
    const rowsBefore = await page.locator('[data-row-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.rowId));
    expect(rowsBefore).toEqual([layer, b, a]);
    // drag b below a → a becomes top-most
    await dragRow(page, b, a, 'bottom');
    expect(await childrenOf(page, layer)).toEqual([b, a]);
    const rowsAfter = await page.locator('[data-row-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.rowId));
    expect(rowsAfter).toEqual([layer, a, b]);
    // one history step
    await blur(page);
    await press(page, 'Control+z');
    expect(await childrenOf(page, layer)).toEqual([a, b]);
    await press(page, 'Control+Shift+z');
    expect(await childrenOf(page, layer)).toEqual([b, a]);

    // group a and drop b inside the group: world position must not change
    await selectTool(page, 'select');
    await clickWorld(page, 150, 150);
    await runCommand(page, 'object.group');
    const g = (await selection(page))[0];
    expect((await nodeById(page, g)).type).toBe('group');
    const bBounds = await worldBounds(page, b);
    await dragRow(page, b, g, 'center');
    expect((await nodeById(page, b)).parent).toBe(g);
    const bAfter = await worldBounds(page, b);
    expect(Math.round(bAfter!.x)).toBe(Math.round(bBounds!.x));
    expect(Math.round(bAfter!.y)).toBe(Math.round(bBounds!.y));
    // the group row got expanded to reveal the drop
    await expect(page.getByTestId(`layer-row-${b}`)).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/layers-dnd.png` });
  });

  test('renames via double-click, layer buttons and context menu', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 100, 100);
    const row = page.getByTestId(`layer-row-${id}`);
    await row.locator('.lr-name').dblclick();
    const input = page.getByTestId(`layer-rename-${id}`);
    await expect(input).toBeVisible();
    await input.fill('Hero box');
    await input.press('Enter');
    expect((await nodeById(page, id)).name).toBe('Hero box');
    await expect(row).toContainText('Hero box');

    // new layer via footer: becomes active and is placed on top
    await page.getByTestId('layers-new-layer').click();
    const layers = await layerIds(page);
    expect(layers).toHaveLength(2);
    const s = await getState(page);
    expect(s.activeLayerId).toBe(layers[1]);
    await expect(page.getByTestId(`layer-row-${layers[1]}`)).toHaveClass(/active-layer/);
    // new objects go to the active layer
    const id2 = await drawEllipse(page, 300, 300, 50, 50);
    expect((await nodeById(page, id2)).parent).toBe(layers[1]);

    // context menu on the object row → Move to New Layer
    await page.getByTestId(`layer-row-${id}`).click({ button: 'right' });
    await expect(page.locator('.context-menu')).toBeVisible();
    await page.locator('.menu-item', { hasText: 'Move to New Layer' }).click();
    const layers3 = await layerIds(page);
    expect(layers3).toHaveLength(3);
    expect((await nodeById(page, id)).parent).toBe(layers3[1]);

    // filter box
    await page.getByTestId('layers-filter').fill('hero');
    await expect(page.getByTestId(`layer-row-${id}`)).toBeVisible();
    await expect(page.getByTestId(`layer-row-${id2}`)).toHaveCount(0);
    await page.getByTestId('layers-filter').fill('');

    // layer options dialog via double-click on the layer row thumbnail area
    await page.getByTestId(`layer-row-${layers3[0]}`).locator('.lr-thumb').dblclick();
    await expect(page.getByTestId('dialog')).toBeVisible();
    await page.locator('#layer-options-name').fill('Background');
    await page.getByTestId('layer-options-ok').click();
    expect((await nodeById(page, layers3[0])).name).toBe('Background');
    await page.screenshot({ path: `${SHOT_DIR}/layers-rename.png` });
  });

  test('clicking rows selects objects; target circle and shift add', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawEllipse(page, 300, 100, 100, 100);
    await selectTool(page, 'select');
    await page.getByTestId(`layer-row-${a}`).click();
    expect(await selection(page)).toEqual([a]);
    await page.getByTestId(`layer-target-${b}`).click({ modifiers: ['Shift'] });
    expect((await selection(page)).sort()).toEqual([a, b].sort());
    await page.getByTestId(`layer-row-${b}`).click({ modifiers: ['Control'] });
    expect(await selection(page)).toEqual([a]);
    // selection from the canvas is reflected in the panel
    await clickWorld(page, 350, 150);
    await expect(page.getByTestId(`layer-row-${b}`)).toHaveClass(/selected/);
    await expect(page.getByTestId(`layer-row-${a}`)).not.toHaveClass(/selected/);
  });
});
