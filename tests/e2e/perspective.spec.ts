/**
 * Perspective grid: View > Perspective Grid commands and overlay, drawing
 * shapes on the active plane, Object > Perspective attach / release / remove,
 * the Perspective Selection tool (move along the plane) and the Perspective
 * Grid tool (vanishing point handles), Define Grid dialog.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, drawRect, dragWorld, selectTool, nodeById, worldBounds, setView } from './helpers';

test.describe('perspective grid', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('show / hide, presets and the plane widget', async ({ page }) => {
    await expect(page.getByTestId('perspective-grid')).toHaveCount(0);
    await runCommand(page, 'view.perspective.toggle');
    await expect(page.getByTestId('perspective-grid')).toBeVisible();
    await expect(page.getByTestId('perspective-grid')).toHaveAttribute('data-type', '2');
    await expect(page.getByTestId('perspective-grid').locator('[data-plane]')).toHaveCount(3);
    let s = await getState(page);
    expect(s.doc.perspective.type).toBe(2);
    expect(s.past[s.past.length - 1].label).toBe('Define Perspective Grid');
    await runCommand(page, 'view.perspective.onePoint');
    await expect(page.getByTestId('perspective-grid')).toHaveAttribute('data-type', '1');
    s = await getState(page);
    expect(s.doc.perspective.vpLeft).toBe(s.doc.perspective.vpRight);
    await runCommand(page, 'view.perspective.threePoint');
    s = await getState(page);
    expect(s.doc.perspective.type).toBe(3);
    expect(typeof s.doc.perspective.vpVertical).toBe('number');
    // plane widget switches the active plane
    await page.getByTestId('perspective-plane-left').click();
    await expect(page.getByTestId('perspective-grid')).toHaveAttribute('data-active-plane', 'left');
    await runCommand(page, 'view.perspective.planeRight');
    await expect(page.getByTestId('perspective-grid')).toHaveAttribute('data-active-plane', 'right');
    await runCommand(page, 'view.perspective.toggle');
    await expect(page.getByTestId('perspective-grid')).toHaveCount(0);
  });

  test('shapes drawn while the grid is shown land on the active plane; release bakes, remove restores', async ({ page }) => {
    await runCommand(page, 'view.perspective.toggle');
    const g = (await getState(page)).doc.perspective;
    const x = g.corner + 20;
    const y = g.ground - 300;
    const id = await drawRect(page, x, y, 200, 120);
    await expect.poll(async () => (await nodeById(page, id)).effects.length).toBe(1);
    let n = await nodeById(page, id);
    expect(n.effects[0].type).toBe('freeDistort');
    expect(n.data.perspective.plane).toBe('right');
    expect(n.data.perspective.rect.x).toBeCloseTo(x, 3);
    expect(n.data.perspective.rect.y).toBeCloseTo(y, 3);
    expect(n.data.perspective.rect).toMatchObject({ width: 200, height: 120 });
    let b = (await worldBounds(page, id))!;
    expect(b.width).toBeLessThan(200);
    const D = g.vpRight - g.corner;
    expect(b.x).toBeCloseTo(g.corner + (D * 20) / (20 + D), 0);
    const rendered = await page.locator(`.document-layer g[data-id="${id}"] path`).first().getAttribute('d');
    expect(rendered).toBeTruthy();
    let s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Attach to Active Plane');
    // remove perspective: flat again
    await runCommand(page, 'perspective.remove');
    n = await nodeById(page, id);
    expect(n.effects).toHaveLength(0);
    expect(n.data?.perspective).toBeUndefined();
    b = (await worldBounds(page, id))!;
    expect(b.width).toBeCloseTo(200, 3);
    // undo brings the perspective back; release with perspective bakes it into plain geometry
    await runCommand(page, 'edit.undo');
    n = await nodeById(page, id);
    expect(n.effects).toHaveLength(1);
    await runCommand(page, 'perspective.release');
    n = await nodeById(page, id);
    expect(n.effects).toHaveLength(0);
    expect(n.shape).toBeUndefined();
    expect(n.data?.perspective).toBeUndefined();
    b = (await worldBounds(page, id))!;
    expect(b.width).toBeLessThan(200);
    s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Release with Perspective');
  });

  test('attach command, perspective selection tool moves along the plane, grid tool drags the vanishing point', async ({ page }) => {
    await runCommand(page, 'view.perspective.toggle');
    await runCommand(page, 'view.perspective.drawOn'); // turn automatic attachment off
    const g = (await getState(page)).doc.perspective;
    const id = await drawRect(page, g.corner + 40, g.ground - 260, 180, 120);
    let n = await nodeById(page, id);
    expect(n.effects).toHaveLength(0);
    await runCommand(page, 'view.perspective.planeLeft');
    await runCommand(page, 'perspective.attach');
    n = await nodeById(page, id);
    expect(n.data.perspective.plane).toBe('left');
    const rect0 = n.data.perspective.rect;
    const b0 = (await worldBounds(page, id))!;
    // move along the plane with the perspective selection tool
    await selectTool(page, 'perspectiveSelect');
    const cx = b0.x + b0.width / 2;
    const cy = b0.y + b0.height / 2;
    await dragWorld(page, { x: cx, y: cy }, { x: cx - 120, y: cy }, { steps: 8 });
    n = await nodeById(page, id);
    expect(n.data.perspective.plane).toBe('left');
    expect(n.data.perspective.rect.x).toBeLessThan(rect0.x - 20);
    expect(Math.abs(n.data.perspective.rect.y - rect0.y)).toBeLessThan(40);
    let s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Move in Perspective');
    expect(s.selection).toEqual([id]);
    // a flat object dropped with the tool joins the active plane (the object must be on screen: zoom 1, pan 100/100)
    const flat = await page.evaluate((gg) => (window as any).__opuller.mcp.createShape({ kind: 'rect', x: gg.corner - 260, y: gg.ground - 400, width: 100, height: 60, fill: '#0000ff' }), g);
    const fb = (await worldBounds(page, flat.id))!;
    await selectTool(page, 'perspectiveSelect');
    await dragWorld(page, { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 }, { x: fb.x + fb.width / 2 - 60, y: fb.y + fb.height / 2 }, { steps: 6 });
    n = await nodeById(page, flat.id);
    expect(n.data.perspective.plane).toBe('left');
    expect(n.effects[0].type).toBe('freeDistort');
    expect(n.data.perspective.rect.x).toBeCloseTo(g.corner - 260 - 60, 0);
    // grid tool: zoom out so the vanishing points are on screen, then drag the right one towards the corner
    await setView(page, 0.4, { x: 150, y: 50 });
    await selectTool(page, 'perspectiveGrid');
    await expect(page.getByTestId('perspective-handle-vpRight')).toBeVisible();
    await dragWorld(page, { x: g.vpRight, y: g.horizon }, { x: g.vpRight - 300, y: g.horizon }, { steps: 6 });
    s = await getState(page);
    expect(s.doc.perspective.vpRight).toBeCloseTo(g.vpRight - 300, -1);
    expect(s.past[s.past.length - 1].label).toBe('Edit Perspective Grid');
    // keys switch the active plane
    await page.keyboard.press('2');
    await expect(page.getByTestId('perspective-grid')).toHaveAttribute('data-active-plane', 'floor');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as any).__opuller.store.getState().activeTool)).not.toBe('perspectiveGrid');
  });

  test('Define Grid dialog previews live and commits one step; cancel reverts', async ({ page }) => {
    await runCommand(page, 'view.perspective.define');
    await expect(page.getByTestId('perspective-define-ok')).toBeVisible();
    const steps = (await getState(page)).past.length;
    await page.getByTestId('perspective-extent').fill('400');
    await page.getByTestId('perspective-extent').press('Enter');
    await expect.poll(async () => (await getState(page)).doc.perspective.extent).toBe(400);
    await page.getByTestId('perspective-define-ok').click();
    let s = await getState(page);
    expect(s.doc.perspective.extent).toBe(400);
    expect(s.past.length).toBe(steps + 1);
    expect(s.past[s.past.length - 1].label).toBe('Define Perspective Grid');
    await runCommand(page, 'view.perspective.define');
    await page.getByTestId('perspective-height').fill('123');
    await page.getByTestId('perspective-height').press('Enter');
    await expect.poll(async () => (await getState(page)).doc.perspective.height).toBe(123);
    await page.keyboard.press('Escape');
    s = await getState(page);
    expect(s.doc.perspective.height).not.toBe(123);
    expect(s.past.length).toBe(steps + 1);
  });
});
