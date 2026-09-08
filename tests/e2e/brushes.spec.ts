/**
 * Brushes: library, apply to paths, Paintbrush with an active brush, options
 * dialog live update, expand appearance, scripting API.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, dragWorld, selectTool, nodeById } from './helpers';

test.describe('brushes', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('library brush applied to a path renders brush artwork; options update live; expand appearance', async ({ page }) => {
    // a line path through the API
    const id = await page.evaluate(() => (window as any).__opuller.mcp.createPath({ d: 'M100 300 C 200 100 400 500 600 300', stroke: '#c8102e', fill: 'none' }).id as string);
    await page.getByTestId('panel-tab-brushes').click();
    await page.getByTestId('brushes-libraries').click();
    await page.getByTestId('brushes-lib-art-arrow').click();
    let s = await getState(page);
    expect(s.doc.brushes).toHaveLength(1);
    const brushId = s.doc.brushes[0].id;
    // the click applied the brush to the selected path? (nothing selected yet) → select and apply
    await page.evaluate((id) => (window as any).__opuller.store.getState().setSelection([id]), id);
    await page.getByTestId(`brush-${brushId}`).click();
    let n = await nodeById(page, id);
    expect(n.stroke.brush.id).toBe(brushId);
    // the canvas renders more than one path element for the node (fill + brush items)
    await expect.poll(() => page.locator(`.document-layer g[data-id="${id}"] path`).count()).toBeGreaterThan(1);
    // options dialog: width slider updates the definition live and OK commits one step
    const steps0 = (await getState(page)).past.length;
    await page.getByTestId(`brush-${brushId}`).dblclick();
    await expect(page.getByTestId('brush-options-ok')).toBeVisible();
    const slider = page.locator('.dialog .slider-field input[type="range"]').first();
    await slider.fill('300');
    await expect.poll(async () => (await getState(page)).doc.brushes[0].width).toBe(300);
    await page.getByTestId('brush-options-ok').click();
    s = await getState(page);
    expect(s.past.length).toBe(steps0 + 1);
    expect(s.past[s.past.length - 1].label).toBe('Brush Options');
    // expand appearance turns the brush stroke into a group of plain paths
    await runCommand(page, 'object.expandAppearance');
    s = await getState(page);
    const g = s.doc.nodes[s.selection[0]];
    expect(g.type).toBe('group');
    expect(g.children.length).toBeGreaterThanOrEqual(1);
    expect(s.doc.nodes[id]).toBeUndefined();
    expect(s.past[s.past.length - 1].label).toBe('Expand Appearance');
  });

  test('Paintbrush paints with the selected brush; remove brush stroke; calligraphic brush from dialog', async ({ page }) => {
    await page.getByTestId('panel-tab-brushes').click();
    await page.getByTestId('brushes-new').click();
    await expect(page.getByTestId('brush-new-ok')).toBeVisible();
    await page.locator('#brush-new-name').fill('My flat');
    await page.getByTestId('brush-new-ok').click();
    await expect(page.getByTestId('brush-options-ok')).toBeVisible();
    await page.getByTestId('brush-options-ok').click();
    let s = await getState(page);
    expect(s.doc.brushes).toHaveLength(1);
    expect(s.doc.brushes[0].kind).toBe('calligraphic');
    expect(s.doc.brushes[0].name).toBe('My flat');
    const brushId = s.doc.brushes[0].id;
    await selectTool(page, 'brush');
    await dragWorld(page, { x: 100, y: 200 }, { x: 500, y: 260 }, { steps: 20 });
    s = await getState(page);
    const id = s.selection[0];
    const n = s.doc.nodes[id];
    expect(n.type).toBe('path');
    expect(n.stroke.brush.id).toBe(brushId);
    expect(n.stroke.width).toBe(1);
    expect(n.fill.type).toBe('none');
    // remove brush stroke → plain stroke
    await runCommand(page, 'brush.remove');
    expect((await nodeById(page, id)).stroke.brush).toBeUndefined();
    // scripting: library + apply + list
    const res = await page.evaluate(async (id) => {
      const api = (window as any).__opuller.mcp;
      const lib = await api.brushes({ op: 'library', name: 'pat-dashes' });
      const ap = await api.brushes({ op: 'apply', id: lib.id, ids: [id], scale: 2 });
      const list = await api.brushes({ op: 'list' });
      return { lib, ap, list };
    }, id);
    expect(res.ap.count).toBe(1);
    expect(res.list).toHaveLength(2);
    const n2 = await nodeById(page, id);
    expect(n2.stroke.brush.id).toBe(res.lib.id);
    expect(n2.stroke.brush.scale).toBe(2);
  });
});
