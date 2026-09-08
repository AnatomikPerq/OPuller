import { test } from '@playwright/test';
import { openApp, expect, getState, withStore, dragWorld, clickWorld, selectTool, drawRect, drawEllipse, runCommand, nodeById, worldBounds } from './helpers';

async function pathNodes(page: any): Promise<any[]> {
  return page.evaluate(() => Object.values((window as any).__opuller.store.getState().doc.nodes).filter((n: any) => n.type === 'path'));
}

test.describe('cut, width, blend and measure tools', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('scissors: click on a segment opens a closed path, a second cut splits it in two', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'scissors');
    // top edge midpoint
    await clickWorld(page, 200, 100);
    let n = await nodeById(page, id);
    expect(n.subpaths.length).toBe(1);
    expect(n.subpaths[0].closed).toBe(false);
    expect(n.shape).toBeUndefined();
    let paths = await pathNodes(page);
    expect(paths.length).toBe(1);
    // bottom edge midpoint → two open paths
    await clickWorld(page, 200, 220);
    paths = await pathNodes(page);
    expect(paths.length).toBe(2);
    expect(paths.every((p) => !p.subpaths[0].closed)).toBe(true);
    const s = await getState(page);
    expect(s.selection.length).toBe(2);
    expect(s.past.length).toBe(3);
    await withStore(page, (st) => st.undo());
    paths = await pathNodes(page);
    expect(paths.length).toBe(1);
  });

  test('knife: a straight cut divides a filled shape into two pieces', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 200, 200);
    await withStore(page, (st) => st.clearSelection());
    await selectTool(page, 'knife');
    await dragWorld(page, { x: 60, y: 200 }, { x: 340, y: 200 }, { modifiers: ['Alt'] });
    const paths = await pathNodes(page);
    expect(paths.length).toBe(2);
    expect(await nodeById(page, id)).toBeTruthy();
    const areas = await Promise.all(paths.map(async (p) => worldBounds(page, p.id)));
    for (const b of areas) {
      expect(Math.round(b!.width)).toBe(200);
      expect(Math.round(b!.height)).toBeGreaterThan(95);
      expect(Math.round(b!.height)).toBeLessThan(105);
    }
    const s = await getState(page);
    expect(s.selection.length).toBe(2);
    // freehand knife across a stroked open line splits it at the crossing
    await selectTool(page, 'line');
    await dragWorld(page, { x: 400, y: 400 }, { x: 600, y: 400 });
    const lineId = (await getState(page)).selection[0];
    await selectTool(page, 'knife');
    await dragWorld(page, { x: 500, y: 350 }, { x: 500, y: 450 });
    const after = await pathNodes(page);
    expect(after.filter((p) => !p.subpaths[0].closed).length).toBe(2);
    expect(after.some((p) => p.id === lineId)).toBe(true);
  });

  test('width tool: drag on a stroked path adds a width point; delete removes it', async ({ page }) => {
    await selectTool(page, 'line');
    await dragWorld(page, { x: 100, y: 300 }, { x: 500, y: 300 });
    const id = (await getState(page)).selection[0];
    await withStore(page, (st) => st.updateDoc((d: any) => { d.nodes[st.selection[0]].stroke.width = 4; }, 'Stroke'));
    await selectTool(page, 'width');
    await dragWorld(page, { x: 300, y: 300 }, { x: 300, y: 330 });
    let n = await nodeById(page, id);
    expect(n.stroke.widthProfile).toBeTruthy();
    expect(n.stroke.widthProfile.length).toBe(1);
    expect(n.stroke.widthProfile[0].offset).toBeCloseTo(0.5, 1);
    expect(Math.round(n.stroke.widthProfile[0].width)).toBe(60);
    await expect(page.locator('[data-testid="width-overlay"]')).toBeVisible();
    // options bar shows the selected point
    await expect(page.getByTestId('width-total')).toHaveValue(/60/);
    await page.getByTestId('width-delete').click();
    n = await nodeById(page, id);
    expect(n.stroke.widthProfile).toBeUndefined();
    await withStore(page, (st) => st.undo());
    n = await nodeById(page, id);
    expect(n.stroke.widthProfile.length).toBe(1);
  });

  test('blend: make between two shapes, options change steps, release restores the sources', async ({ page }) => {
    const a = await drawEllipse(page, 100, 100, 80, 80);
    const b = await drawRect(page, 500, 400, 100, 60);
    await withStore(page, (st) => st.setSelection(Object.values(st.doc.nodes).filter((n: any) => n.type === 'path').map((n: any) => n.id)));
    await runCommand(page, 'blend.make');
    let s = await getState(page);
    const gid = s.selection[0];
    const g = s.doc.nodes[gid];
    expect(g.type).toBe('group');
    expect(g.data.blend).toBeTruthy();
    expect(g.children.length).toBe(2 + 8);
    expect(g.children[0]).toBe(a);
    expect(g.children[g.children.length - 1]).toBe(b);
    // steps interpolate position and colour
    const mid = s.doc.nodes[g.children[5]];
    expect(mid.data.blendStep).toBe(true);
    const mb = await worldBounds(page, mid.id);
    expect(mb!.x).toBeGreaterThan(100);
    expect(mb!.x).toBeLessThan(500);
    // moving a source regenerates the steps in the same undo step
    const before = s.past.length;
    await withStore(page, (st) => st.updateDoc((d: any) => { d.nodes[st.doc.nodes[st.selection[0]].children[0]].transform.e += 200; }, 'Move'));
    s = await getState(page);
    expect(s.past.length).toBe(before + 1);
    const mid2 = await worldBounds(page, s.doc.nodes[gid].children[5]);
    expect(mid2!.x).toBeGreaterThan(mb!.x + 50);
    // blend options dialog
    await runCommand(page, 'blend.options');
    await page.getByTestId('blend-steps').fill('3');
    await page.getByTestId('blend-steps').press('Enter');
    await page.getByTestId('blend-ok').click();
    s = await getState(page);
    expect(s.doc.nodes[gid].children.length).toBe(2 + 3);
    // release
    await runCommand(page, 'blend.release');
    s = await getState(page);
    expect(s.doc.nodes[gid]).toBeUndefined();
    expect(Object.values(s.doc.nodes).filter((n: any) => n.type === 'path').length).toBe(2);
    expect(s.selection.sort()).toEqual([a, b].sort());
  });

  test('blend tool: click two objects then a third to extend', async ({ page }) => {
    await drawEllipse(page, 100, 100, 60, 60);
    await drawEllipse(page, 400, 100, 60, 60);
    await drawEllipse(page, 700, 100, 60, 60);
    await withStore(page, (st) => st.clearSelection());
    await selectTool(page, 'blend');
    await clickWorld(page, 130, 130);
    await clickWorld(page, 430, 130);
    let s = await getState(page);
    let g = s.doc.nodes[s.selection[0]];
    expect(g.type).toBe('group');
    expect(g.data.blend.sources.length).toBe(2);
    await clickWorld(page, 730, 130);
    s = await getState(page);
    g = s.doc.nodes[s.selection[0]];
    expect(g.data.blend.sources.length).toBe(3);
    expect(g.children.length).toBe(3 + 2 * 8);
    await page.keyboard.press('Escape');
  });

  test('measure tool: drag shows distance and angle', async ({ page }) => {
    await selectTool(page, 'measure');
    await dragWorld(page, { x: 100, y: 100 }, { x: 400, y: 500 });
    await expect(page.locator('[data-testid="measure-overlay"]')).toBeVisible();
    const text = await page.getByTestId('measure-readout').textContent();
    expect(text).toContain('500');
    expect(text).toContain('300');
    expect(text).toContain('400');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="measure-overlay"]')).toHaveCount(0);
  });
});
