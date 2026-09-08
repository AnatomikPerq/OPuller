/**
 * Freeform and mesh gradients: panel type switch, gradient tool point editing,
 * Create Gradient Mesh dialog, Mesh tool node dragging, rendering and export.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, drawRect, dragWorld, selectTool, nodeById, clickWorld } from './helpers';

test.describe('freeform and mesh gradients', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('freeform gradient: panel switch, points in the panel, gradient tool drag / add / delete, export renders a raster tile', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 300, 200);
    await page.getByTestId('panel-tab-gradient').click();
    await page.locator('.gradient-type .segment', { hasText: 'Freeform' }).click();
    let n = await nodeById(page, id);
    expect(n.fill.type).toBe('freeform');
    expect(n.fill.points).toHaveLength(3);
    await expect(page.getByTestId('gradient-freeform')).toBeVisible();
    await page.getByTestId('freeform-add').click();
    n = await nodeById(page, id);
    expect(n.fill.points).toHaveLength(4);
    // the canvas renders a raster tile for the fill
    await expect(page.locator(`.document-layer g[data-id="${id}"] pattern image`)).toHaveCount(1);
    // gradient tool: drag point 0 (at 25 %, 25 % → world 175, 150) to the centre
    await selectTool(page, 'gradient');
    await expect(page.getByTestId('freeform-annotator')).toBeVisible();
    await dragWorld(page, { x: 175, y: 150 }, { x: 250, y: 200 }, { steps: 10 });
    n = await nodeById(page, id);
    expect(n.fill.points[0].x).toBeCloseTo(0.5, 1);
    expect(n.fill.points[0].y).toBeCloseTo(0.5, 1);
    // click inside the object adds a point
    await clickWorld(page, 120, 280);
    n = await nodeById(page, id);
    expect(n.fill.points).toHaveLength(5);
    // delete through the panel
    await page.getByTestId('freeform-delete').click();
    n = await nodeById(page, id);
    expect(n.fill.points).toHaveLength(4);
    const s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Fill');
    const svg = await page.evaluate((id) => (window as any).__opullerIO.exportSvg((window as any).__opuller.store.getState().doc, { scope: 'selection', ids: [id] }).svg, id);
    expect(svg).toContain('<pattern');
    expect(svg).toContain('data:image/png');
  });

  test('gradient mesh: dialog creates a mesh, Mesh tool drags nodes and adds lines, Color panel colours a node, release', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 200, 200);
    await runCommand(page, 'object.createMesh');
    await expect(page.getByTestId('mesh-dialog-ok')).toBeVisible();
    await page.getByTestId('mesh-dialog-rows').fill('2');
    await page.getByTestId('mesh-dialog-rows').press('Enter');
    await page.getByTestId('mesh-dialog-cols').fill('2');
    await page.getByTestId('mesh-dialog-cols').press('Enter');
    await page.locator('#mesh-dialog-appearance').selectOption('toCenter');
    await page.getByTestId('mesh-dialog-ok').click();
    let n = await nodeById(page, id);
    expect(n.fill.type).toBe('mesh');
    expect(n.fill.rows).toBe(2);
    expect(n.fill.nodes).toHaveLength(9);
    expect(n.fill.nodes[4].color).toBe('#ffffff');
    let s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Create Gradient Mesh');
    // mesh tool: drag the centre node (world 200,200) to (230,210)
    await selectTool(page, 'mesh');
    await expect(page.getByTestId('mesh-annotator')).toBeVisible();
    await dragWorld(page, { x: 200, y: 200 }, { x: 230, y: 210 }, { steps: 10 });
    n = await nodeById(page, id);
    expect(n.fill.nodes[4].x).toBeCloseTo(0.65, 1);
    expect(n.fill.nodes[4].y).toBeCloseTo(0.55, 1);
    // click inside a patch adds a row and a column
    await clickWorld(page, 150, 250);
    n = await nodeById(page, id);
    expect(n.fill.rows).toBe(3);
    expect(n.fill.cols).toBe(3);
    // colour the active node through the Color panel hex field
    await page.getByTestId('panel-tab-color').click();
    await page.locator('#color-hex').fill('ff00ff');
    await page.locator('#color-hex').press('Enter');
    n = await nodeById(page, id);
    s = await getState(page);
    expect(n.fill.nodes[s.activeGradientStop].color).toBe('#ff00ff');
    // release turns the mesh back into a solid
    await runCommand(page, 'object.releaseMesh');
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('solid');
    // scripting API
    const res = await page.evaluate(async (id) => {
      const api = (window as any).__opuller.mcp;
      const m = await api.gradients({ op: 'mesh', ids: [id], rows: 3, cols: 2 });
      const info = await api.gradients({ op: 'info' });
      const f = await api.gradients({ op: 'freeform', ids: [id], points: [{ x: 0.2, y: 0.2, color: '#ff0000' }, { x: 0.8, y: 0.8, color: '#0000ff' }] });
      return { m, info, f };
    }, id);
    expect(res.m.count).toBe(1);
    expect(res.info[0].fill).toBe('mesh');
    expect(res.info[0].rows).toBe(3);
    expect(res.f.points).toBe(2);
    n = await nodeById(page, id);
    expect(n.fill.type).toBe('freeform');
  });
});
