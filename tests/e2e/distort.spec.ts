/**
 * Warp / envelope distort / free distort and 3D effects: dialogs, live
 * rendering, envelope commands, Mesh tool point dragging, Expand Appearance.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, drawRect, dragWorld, selectTool, nodeById, worldBounds } from './helpers';

test.describe('distort and 3D effects', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('Distort & Transform effects: Zig Zag dialog, Pucker & Bloat, Roughen, Transform copies, Tweak; expand bakes them (plan item 7)', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 200, 100);
    const steps0 = (await getState(page)).past.length;
    // Zig Zag through its dialog: size 4, 3 ridges, corner points
    await runCommand(page, 'effect.zigZag');
    await expect(page.getByTestId('zigzag-ok')).toBeVisible();
    await page.getByTestId('zigzag-size').fill('4');
    await page.getByTestId('zigzag-size').press('Tab');
    await page.getByTestId('zigzag-ridges').fill('3');
    await page.getByTestId('zigzag-ridges').press('Tab');
    await expect.poll(async () => (await nodeById(page, id)).effects[0]?.ridges).toBe(3);
    await page.getByTestId('zigzag-ok').click();
    let s = await getState(page);
    expect(s.past.length).toBe(steps0 + 1);
    expect(s.past[s.past.length - 1].label).toBe('Zig Zag');
    let n = await nodeById(page, id);
    expect(n.effects[0]).toMatchObject({ type: 'zigZag', size: 4, ridges: 3, smooth: false });
    // rendered outline: 4 anchors + 4 segments × 5 peaks = 24 points; bounds grow by the peak size
    let d = (await page.locator(`.document-layer g[data-id="${id}"] path`).first().getAttribute('d')) ?? '';
    expect(d.split('L').length - 1).toBe(24); // 24 line segments around the closed outline
    let b = (await worldBounds(page, id))!;
    expect(b.x).toBeCloseTo(96, 3);
    expect(b.width).toBeCloseTo(208, 3);
    // the Effect menu lists the five effects
    const cmds = await page.evaluate(() => (window as any).__opuller.mcp.listCommands({ menu: 'Effect/Distort & Transform' }).map((c: any) => c.id));
    for (const t of ['zigZag', 'puckerBloat', 'roughen', 'transform', 'tweak', 'warp']) expect(cmds).toContain(`effect.${t}`);
    // stack the others through the scripting API (each replaces the effect list)
    const set = (effects: any[]) => page.evaluate(({ id, effects }) => (window as any).__opuller.mcp.updateNodes({ ids: [id], patch: { effects } }), { id, effects });
    await set([{ type: 'puckerBloat', enabled: true, amount: 100 }]);
    d = (await page.locator(`.document-layer g[data-id="${id}"] path`).first().getAttribute('d')) ?? '';
    expect(d).toContain('C');
    b = (await worldBounds(page, id))!;
    expect(b.y).toBeLessThan(60); // petals bulge beyond the original top edge (100)
    await set([{ type: 'roughen', enabled: true, size: 3, relative: false, detail: 10, smooth: false, seed: 5 }]);
    d = (await page.locator(`.document-layer g[data-id="${id}"] path`).first().getAttribute('d')) ?? '';
    expect(d.split('L').length).toBeGreaterThan(40);
    await set([{ type: 'transform', enabled: true, copies: 2, dx: 250, dy: 0, scaleX: 50, scaleY: 50, angle: 0, reflectX: false, reflectY: false, origin: 'center' }]);
    b = (await worldBounds(page, id))!;
    expect(b.x + b.width).toBeCloseTo(600, 3); // copies accumulate the step about the reference point: 400..500 and 550..600
    expect(b.x).toBeCloseTo(100, 3);
    await set([{ type: 'tweak', enabled: true, horizontal: 10, vertical: 10, relative: true, anchors: true, inControl: false, outControl: false, seed: 2 }]);
    n = await nodeById(page, id);
    expect(n.shape.kind).toBe('rect'); // still a live rect underneath
    // expand bakes the geometry and drops the effect
    await runCommand(page, 'object.expandAppearance');
    n = await nodeById(page, id);
    expect(n.effects).toHaveLength(0);
    expect(n.shape).toBeUndefined();
    expect(n.subpaths[0].anchors).toHaveLength(4);
    const moved = n.subpaths[0].anchors.filter((a: any) => Math.abs(a.point.x) > 1e-9 && Math.abs(a.point.x - 200) > 1e-9).length;
    expect(moved).toBeGreaterThan(0);
    // project round trip keeps the effect types
    await set([{ type: 'zigZag', enabled: true, size: 4, relative: true, ridges: 2, smooth: true }]);
    const json = await page.evaluate(async () => (await (window as any).__opuller.mcp.getProject({})).json as string);
    expect(json).toContain('"type":"zigZag"');
  });

  test('warp effect dialog previews live, commits one step and changes the bounds; expand bakes it', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 200, 100);
    const steps0 = (await getState(page)).past.length;
    await runCommand(page, 'effect.warp');
    await expect(page.getByTestId('warp-ok')).toBeVisible();
    await page.locator('#warp-style').selectOption('arch');
    const bend = page.locator('.dialog .slider-field input[type="range"]').first();
    await bend.fill('80');
    await expect.poll(async () => (await nodeById(page, id)).effects[0]?.bend).toBe(80);
    await page.getByTestId('warp-ok').click();
    let s = await getState(page);
    expect(s.past.length).toBe(steps0 + 1);
    expect(s.past[s.past.length - 1].label).toBe('Warp');
    let n = await nodeById(page, id);
    expect(n.effects[0]).toMatchObject({ type: 'warp', style: 'arch', bend: 80 });
    // an arch lifts the middle: the visual bounds grow upwards
    const b = (await worldBounds(page, id))!;
    expect(b.y).toBeLessThan(100);
    // the canvas path has many anchors (subdivided curve)
    const d = await page.locator(`.document-layer g[data-id="${id}"] path`).first().getAttribute('d');
    expect((d ?? '').split('C').length).toBeGreaterThan(8);
    // expand appearance bakes the geometry and drops the effect
    await runCommand(page, 'object.expandAppearance');
    n = await nodeById(page, id);
    expect(n.effects).toHaveLength(0);
    expect(n.shape).toBeUndefined();
    expect(n.subpaths[0].anchors.length).toBeGreaterThan(8);
  });

  test('envelope with mesh wraps the selection, Mesh tool drags a point, release restores', async ({ page }) => {
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawRect(page, 250, 100, 100, 100);
    await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), [a, b]);
    await runCommand(page, 'envelope.mesh');
    await expect(page.getByTestId('envelope-mesh-ok')).toBeVisible();
    await page.getByTestId('envelope-rows').fill('2');
    await page.getByTestId('envelope-rows').press('Enter');
    await page.getByTestId('envelope-cols').fill('2');
    await page.getByTestId('envelope-cols').press('Enter');
    await page.getByTestId('envelope-mesh-ok').click();
    let s = await getState(page);
    const gid = s.selection[0];
    const g = s.doc.nodes[gid];
    expect(g.type).toBe('group');
    expect(g.data.envelope).toBe('mesh');
    expect(g.effects[0]).toMatchObject({ type: 'meshDistort', rows: 2, cols: 2 });
    expect(g.effects[0].points).toHaveLength(9);
    // drag the centre point (bbox 0.5,0.5 → world 225,150) down by 40
    await selectTool(page, 'mesh');
    await expect(page.getByTestId('envelope-annotator')).toBeVisible();
    await dragWorld(page, { x: 225, y: 150 }, { x: 225, y: 190 }, { steps: 8 });
    s = await getState(page);
    expect(s.doc.nodes[gid].effects[0].points[4].y).toBeCloseTo(0.9, 1);
    expect(s.past[s.past.length - 1].label).toBe('Envelope Mesh');
    // release removes the wrapper and the effect
    await runCommand(page, 'envelope.release');
    s = await getState(page);
    expect(s.doc.nodes[gid]).toBeUndefined();
    expect(s.selection.sort()).toEqual([a, b].sort());
    expect((await nodeById(page, a)).effects).toHaveLength(0);
  });

  test('envelope with top object, free distort corners, 3D extrude renders shaded faces and expands', async ({ page }) => {
    const content = await drawRect(page, 100, 100, 200, 100);
    // envelope shape on top: an ellipse
    const env = await page.evaluate(() => (window as any).__opuller.mcp.createShape({ kind: 'ellipse', cx: 200, cy: 150, rx: 120, ry: 80, fill: '#ffffff', stroke: 'none' }).id as string);
    await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), [content, env]);
    await runCommand(page, 'envelope.top');
    let s = await getState(page);
    const gid = s.selection[0];
    expect(s.doc.nodes[gid].effects[0].type).toBe('coonsDistort');
    expect(s.doc.nodes[env]).toBeUndefined();
    await runCommand(page, 'envelope.expand');
    s = await getState(page);
    const baked = s.doc.nodes[content];
    expect(baked.effects).toHaveLength(0);
    expect(baked.subpaths[0].anchors.length).toBeGreaterThan(8);
    // free distort via the dialog
    const box = await drawRect(page, 500, 100, 100, 100);
    await runCommand(page, 'effect.freeDistort');
    await page.getByTestId('free-distort-x-0').fill('30');
    await page.getByTestId('free-distort-x-0').press('Enter');
    await page.getByTestId('free-distort-ok').click();
    let n = await nodeById(page, box);
    expect(n.effects[0].type).toBe('freeDistort');
    expect(n.effects[0].corners[0].x).toBeCloseTo(0.3, 5);
    // 3D extrude through the dialog
    const cube = await drawRect(page, 100, 400, 120, 120);
    await runCommand(page, 'effect.extrude');
    await expect(page.getByTestId('three-d-ok')).toBeVisible();
    await page.locator('#three-d-preset').selectOption('isoLeft');
    await page.getByTestId('three-d-depth').fill('60');
    await page.getByTestId('three-d-depth').press('Enter');
    await page.getByTestId('three-d-ok').click();
    n = await nodeById(page, cube);
    expect(n.effects[0]).toMatchObject({ type: 'extrude', depth: 60, rotX: 35 });
    // several shaded faces on the canvas
    await expect.poll(() => page.locator(`.document-layer g[data-id="${cube}"] path`).count()).toBeGreaterThanOrEqual(3);
    const fills = await page.locator(`.document-layer g[data-id="${cube}"] path`).evaluateAll((els) => els.map((e) => e.getAttribute('fill')));
    expect(new Set(fills).size).toBeGreaterThan(1);
    await runCommand(page, 'object.expandAppearance');
    s = await getState(page);
    const grp = s.doc.nodes[s.selection[0]];
    expect(grp.type).toBe('group');
    expect(grp.children.length).toBeGreaterThanOrEqual(3);
    expect(s.doc.nodes[cube]).toBeUndefined();
    void gid;
  });
});
