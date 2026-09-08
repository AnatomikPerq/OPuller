import { test, expect, type Page } from '@playwright/test';
import { openApp, drawRect, drawEllipse, selectTool, clickWorld, dragWorld, moveWorld, withStore, runCommand, nodeById, worldBounds, selection, press, setView, viewport, worldToScreen, nodeCount } from './helpers';

async function undoCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__opuller.store.getState().past.length);
}

async function pastLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__opuller.store.getState().past.map((p: any) => p.label));
}

async function pathIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const doc = (window as any).__opuller.store.getState().doc;
    return Object.values(doc.nodes)
      .filter((n: any) => n.type === 'path')
      .map((n: any) => n.id);
  });
}

async function faceArea(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const api = (window as any).__opuller;
    const s = api.store.getState();
    const sps = api.api.document.worldSubPaths(s.doc, id);
    return api.api.paper.pathArea(sps, 'evenodd');
  }, id);
}

async function select(page: Page, ids: string[]) {
  await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), ids);
}

async function setField(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.click();
  await input.fill(value);
  await input.press('Tab');
}

async function openPathfinderPanel(page: Page) {
  await page.getByTestId('panel-tab-pathfinder').click();
  await expect(page.getByTestId('pathfinder-panel')).toBeVisible();
}

test.describe('pathfinder', () => {
  test('unite two overlapping rectangles from the panel (one undo step, top appearance)', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 200, 120);
    const b = await drawRect(page, 200, 150, 200, 120);
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].fill = { type: 'solid', color: '#ff0000', opacity: 1 }; }, 'Fill'));
    await select(page, [a, b]);
    await openPathfinderPanel(page);
    await expect(page.getByTestId('pf-hint')).toHaveText('2 paths selected');
    const before = await undoCount(page);
    await page.getByTestId('pf-unite').click();
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    expect(sel[0]).not.toBe(a);
    expect(await nodeById(page, a)).toBeUndefined();
    expect(await nodeById(page, b)).toBeUndefined();
    const n = await nodeById(page, sel[0]);
    expect(n.type).toBe('path');
    expect(n.fill.color).toBe('#ff0000'); // appearance of the top-most original
    expect(n.subpaths).toHaveLength(1);
    expect(await worldBounds(page, sel[0])).toEqual({ x: 100, y: 100, width: 300, height: 170 });
    expect(Math.round(await faceArea(page, sel[0]))).toBe(200 * 120 + 200 * 120 - 100 * 70);
    expect(await undoCount(page)).toBe(before + 1);
    expect((await pastLabels(page)).pop()).toBe('Pathfinder Unite');
    await press(page, 'Control+z');
    expect(await nodeById(page, a)).toBeTruthy();
    expect(await nodeById(page, b)).toBeTruthy();
    expect((await selection(page)).sort()).toEqual([a, b].sort());
  });

  test('minus front keeps the back shape minus the front ones', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 200, 200);
    const b = await drawRect(page, 200, 200, 200, 200);
    await select(page, [a, b]);
    await runCommand(page, 'pathfinder.minusFront');
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    const n = await nodeById(page, sel[0]);
    expect(n.subpaths[0].anchors).toHaveLength(6);
    expect(await worldBounds(page, sel[0])).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    expect(Math.round(await faceArea(page, sel[0]))).toBe(40000 - 10000);
    expect(await nodeById(page, b)).toBeUndefined();
  });

  test('divide and crop group their results; disjoint intersect reports no result', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 200, 200);
    const b = await drawRect(page, 200, 200, 200, 200);
    await select(page, [a, b]);
    await runCommand(page, 'pathfinder.divide');
    let sel = await selection(page);
    expect(sel).toHaveLength(1);
    const g = await nodeById(page, sel[0]);
    expect(g.type).toBe('group');
    expect(g.children).toHaveLength(3);
    await press(page, 'Control+z');
    await select(page, [a, b]);
    await runCommand(page, 'pathfinder.crop');
    sel = await selection(page);
    const cg = await nodeById(page, sel[0]);
    expect(cg.type).toBe('group');
    expect(cg.children).toHaveLength(1);
    expect(await worldBounds(page, cg.children[0])).toEqual({ x: 200, y: 200, width: 100, height: 100 });
    await press(page, 'Control+z');
    // disjoint shapes: intersect has nothing to return and leaves the document alone
    const c = await drawRect(page, 600, 100, 50, 50);
    await select(page, [a, c]);
    const before = await undoCount(page);
    await runCommand(page, 'pathfinder.intersect');
    await expect(page.locator('.toast', { hasText: 'No result' })).toBeVisible();
    expect(await undoCount(page)).toBe(before);
    expect(await nodeById(page, a)).toBeTruthy();
  });

  test('pathfinder works on paths inside a transformed group', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawRect(page, 150, 100, 100, 100);
    await select(page, [a]);
    await runCommand(page, 'object.group');
    const gid = (await selection(page))[0];
    // move the group by translating its matrix (children stay in group space)
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].transform = { a: 1, b: 0, c: 0, d: 1, e: 30, f: 0 }; }, 'Move'));
    expect(await worldBounds(page, a)).toEqual({ x: 130, y: 100, width: 100, height: 100 });
    await select(page, [gid, b]);
    await runCommand(page, 'pathfinder.unite');
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    expect(await worldBounds(page, sel[0])).toEqual({ x: 130, y: 100, width: 120, height: 100 });
    expect(await nodeById(page, gid)).toBeUndefined(); // the emptied group is gone
  });
});

test.describe('shape builder', () => {
  async function twoCircles(page: Page) {
    const c1 = await drawEllipse(page, 100, 100, 100, 100); // centre 150,150
    const c2 = await drawEllipse(page, 160, 100, 100, 100); // centre 210,150
    await select(page, [c1, c2]);
    await selectTool(page, 'shapebuilder');
    await expect(page.getByTestId('shapebuilder-count')).toHaveText('3 regions from 2 paths');
    return { c1, c2 };
  }

  test('hover highlights a region; click extracts it; drag merges regions; undo per gesture', async ({ page }) => {
    await openApp(page);
    const { c1, c2 } = await twoCircles(page);
    await moveWorld(page, 180, 150);
    await expect(page.getByTestId('shapebuilder-overlay')).toHaveAttribute('data-faces', '1');
    await moveWorld(page, 500, 500);
    await expect(page.getByTestId('shapebuilder-overlay')).toHaveAttribute('data-faces', '0');

    // click the lens → three paths: two crescents + the lens (all selected)
    const before = await undoCount(page);
    await clickWorld(page, 180, 150);
    expect(await undoCount(page)).toBe(before + 1);
    let ids = await pathIds(page);
    expect(ids).toHaveLength(3);
    expect((await selection(page)).length).toBe(3);
    const lens = ids.find((id) => id !== c1 && id !== c2)!;
    const lb = (await worldBounds(page, lens))!;
    expect(Math.round(lb.x)).toBe(160);
    expect(Math.round(lb.x + lb.width)).toBe(200);
    // the lens took the appearance of the top circle, the crescents keep their bounds
    const lensNode = await nodeById(page, lens);
    const top = await nodeById(page, c2);
    expect(lensNode.fill).toEqual(top.fill);
    const b1 = (await worldBounds(page, c1))!;
    expect(Math.round(b1.x)).toBe(100);
    expect(Math.round(b1.x + b1.width)).toBeLessThan(200);
    await expect(page.getByTestId('shapebuilder-count')).toHaveText('3 regions from 3 paths');

    // drag across all three regions → one united path (the union of both circles)
    await dragWorld(page, { x: 120, y: 150 }, { x: 240, y: 150 }, { steps: 12 });
    expect(await undoCount(page)).toBe(before + 2);
    ids = await pathIds(page);
    expect(ids).toHaveLength(1);
    const ub = (await worldBounds(page, ids[0]))!;
    expect(Math.round(ub.x)).toBe(100);
    expect(Math.round(ub.width)).toBe(160);
    expect(Math.round(ub.height)).toBe(100);
    expect(await selection(page)).toEqual([ids[0]]);
    const area = await faceArea(page, ids[0]);
    expect(area).toBeGreaterThan(Math.PI * 2500 * 1.5);

    await press(page, 'Control+z');
    expect(await pathIds(page)).toHaveLength(3);
    await press(page, 'Control+z');
    expect((await pathIds(page)).sort()).toEqual([c1, c2].sort());
  });

  test('alt-click deletes a region, shift-drag marquee merges, Escape cancels', async ({ page }) => {
    await openApp(page);
    const { c1, c2 } = await twoCircles(page);
    // Escape during a drag cancels it
    const box = (await viewport(page).boundingBox())!;
    const p = await worldToScreen(page, 120, 150);
    await page.mouse.move(box.x + p.x, box.y + p.y);
    await page.mouse.down();
    await page.mouse.move(box.x + p.x + 60, box.y + p.y, { steps: 5 });
    await press(page, 'Escape');
    await page.mouse.up();
    expect(await pathIds(page)).toHaveLength(2);

    // Alt-click the lens: it is cut out of both circles (two crescents remain)
    const before = await undoCount(page);
    await clickWorld(page, 180, 150, { modifiers: ['Alt'] });
    expect(await undoCount(page)).toBe(before + 1);
    expect((await pathIds(page)).sort()).toEqual([c1, c2].sort());
    const b1 = (await worldBounds(page, c1))!;
    expect(Math.round(b1.x)).toBe(100);
    expect(Math.round(b1.x + b1.width)).toBe(180);
    const b2 = (await worldBounds(page, c2))!;
    expect(Math.round(b2.x)).toBe(180);
    expect(Math.round(b2.x + b2.width)).toBe(260);
    await press(page, 'Control+z');

    // Shift-drag marquee touching only the left crescent extracts it (the rest of c1 stays under c2)
    await select(page, [c1, c2]);
    await expect(page.getByTestId('shapebuilder-count')).toHaveText('3 regions from 2 paths');
    await dragWorld(page, { x: 90, y: 90 }, { x: 150, y: 210 }, { modifiers: ['Shift'] });
    const ids = await pathIds(page);
    expect(ids).toHaveLength(3);
    const crescent = ids.find((id) => id !== c1 && id !== c2)!;
    const mb = (await worldBounds(page, crescent))!;
    expect(Math.round(mb.x)).toBe(100);
    expect(Math.round(mb.x + mb.width)).toBe(180); // up to the intersection points
    expect(await worldBounds(page, c2)).toEqual({ x: 160, y: 100, width: 100, height: 100 });
  });

  test('works at 2x zoom and with the current appearance option', async ({ page }) => {
    await openApp(page);
    const { c1, c2 } = await twoCircles(page);
    await setView(page, 2, { x: 50, y: 50 });
    await withStore(page, (s) => {
      s.setToolOptions('shapebuilder', { pickFrom: 'appearance' });
      s.setAppearance({ fill: { type: 'solid', color: '#00ff00', opacity: 1 } });
    });
    await clickWorld(page, 180, 150);
    const ids = await pathIds(page);
    expect(ids).toHaveLength(3);
    const lens = ids.find((id) => id !== c1 && id !== c2)!;
    expect((await nodeById(page, lens)).fill.color).toBe('#00ff00');
    const lb = (await worldBounds(page, lens))!;
    expect(Math.round(lb.x)).toBe(160);
    expect(Math.round(lb.x + lb.width)).toBe(200);
  });
});

test.describe('object > path commands', () => {
  test('make and release compound path', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 200, 200);
    const b = await drawRect(page, 150, 150, 100, 100);
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].fill = { type: 'solid', color: '#0000ff', opacity: 1 }; }, 'Fill'));
    await select(page, [a, b]);
    await runCommand(page, 'path.compoundMake');
    let sel = await selection(page);
    expect(sel).toHaveLength(1);
    const cp = await nodeById(page, sel[0]);
    expect(cp.subpaths).toHaveLength(2);
    expect(cp.fillRule).toBe('evenodd');
    expect(cp.fill.color).toBe('#ffffff'); // appearance of the bottom-most
    expect(await pathIds(page)).toHaveLength(1);
    expect(await worldBounds(page, sel[0])).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    await runCommand(page, 'path.compoundRelease');
    sel = await selection(page);
    expect(sel).toHaveLength(2);
    expect(await pathIds(page)).toHaveLength(2);
    expect(await worldBounds(page, sel[1])).toEqual({ x: 150, y: 150, width: 100, height: 100 });
    await press(page, 'Control+z');
    expect(await pathIds(page)).toHaveLength(1);
  });

  test('make and release clipping mask', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 300, 300);
    const e = await drawEllipse(page, 150, 150, 100, 100);
    await select(page, [a, e]);
    await runCommand(page, 'object.clipMake');
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    const g = await nodeById(page, sel[0]);
    expect(g.type).toBe('group');
    expect(g.clipId).toBe(e);
    expect(g.children).toEqual([a, e]);
    expect((await nodeById(page, e)).fill.type).toBe('none');
    expect(await worldBounds(page, sel[0])).toEqual({ x: 150, y: 150, width: 100, height: 100 });
    await runCommand(page, 'object.clipRelease');
    expect(await nodeById(page, sel[0])).toBeUndefined();
    expect((await selection(page)).sort()).toEqual([a, e].sort());
    expect(await worldBounds(page, a)).toEqual({ x: 100, y: 100, width: 300, height: 300 });
  });

  test('offset path dialog previews, commits one step and cancels cleanly', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    const before = await undoCount(page);
    await runCommand(page, 'path.offset');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await setField(page, 'offset-value', '20');
    // preview creates the offset path (uncommitted)
    expect(await pathIds(page)).toHaveLength(2);
    expect(await undoCount(page)).toBe(before);
    await page.getByTestId('offset-ok').click();
    await expect(page.getByTestId('dialog')).toBeHidden();
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    expect(sel[0]).not.toBe(id);
    expect(await worldBounds(page, sel[0])).toEqual({ x: 80, y: 80, width: 240, height: 160 });
    expect(await worldBounds(page, id)).toEqual({ x: 100, y: 100, width: 200, height: 120 });
    expect(await undoCount(page)).toBe(before + 1);
    // cancel reverts the preview
    await select(page, [id]);
    await runCommand(page, 'path.offset');
    await setField(page, 'offset-value', '-10');
    expect(await pathIds(page)).toHaveLength(3);
    await page.getByTestId('offset-cancel').click();
    expect(await pathIds(page)).toHaveLength(2);
    expect(await undoCount(page)).toBe(before + 1);
  });

  test('outline stroke converts the stroke into a filled path', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].stroke.width = 10; d.nodes[s.selection[0]].stroke.paint = { type: 'solid', color: '#123456', opacity: 1 }; }, 'Stroke'));
    await runCommand(page, 'path.outlineStroke');
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    const g = await nodeById(page, sel[0]);
    expect(g.type).toBe('group');
    expect(g.children).toHaveLength(2);
    const outline = await nodeById(page, g.children[1]);
    expect(outline.fill.color).toBe('#123456');
    expect(outline.stroke.paint.type).toBe('none');
    expect(outline.subpaths).toHaveLength(2); // ring: outer + inner contour
    expect(await worldBounds(page, sel[0])).toEqual({ x: 95, y: 95, width: 210, height: 130 });
    expect((await nodeById(page, id)).stroke.paint.type).toBe('none');
    // a stroke-less path is left alone with a toast
    await press(page, 'Control+z');
    await select(page, [id]);
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].stroke.paint = { type: 'none' }; }, 'Stroke'));
    expect(await page.evaluate(() => (window as any).__opuller.allCommands().find((c: any) => c.id === 'path.outlineStroke').enabled((window as any).__opuller.store.getState()))).toBe(false);
  });

  test('join, add anchors, remove redundant points, reverse and simplify', async ({ page }) => {
    await openApp(page);
    // two open polylines
    const ids = await withStore(page, (s) => {
      const api = (window as any).__opuller.api;
      const mk = (pts: any[]) => api.nodes.makePath([api.path.polylineSubPath(pts, false)], { fill: { type: 'none' } });
      const a = mk([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
      const b = mk([{ x: 220, y: 120 }, { x: 300, y: 200 }]);
      s.updateDoc((d: any) => {
        api.document.addNode(d, a, d.layers[0]);
        api.document.addNode(d, b, d.layers[0]);
      }, 'Add');
      s.setSelection([a.id, b.id]);
      return [a.id, b.id];
    });
    await runCommand(page, 'path.join');
    let sel = await selection(page);
    expect(sel).toHaveLength(1);
    let n = await nodeById(page, sel[0]);
    expect(n.subpaths).toHaveLength(1);
    expect(n.subpaths[0].anchors).toHaveLength(4);
    expect(n.subpaths[0].closed).toBe(false);
    expect(await pathIds(page)).toHaveLength(1);
    // join again closes the single open path
    await runCommand(page, 'path.join');
    n = await nodeById(page, sel[0]);
    expect(n.subpaths[0].closed).toBe(true);
    void ids;

    // add anchors on a rectangle, then remove the redundant ones again
    const r = await drawRect(page, 400, 100, 100, 100);
    await runCommand(page, 'path.addAnchors');
    n = await nodeById(page, r);
    expect(n.subpaths[0].anchors).toHaveLength(8);
    expect(n.shape).toBeUndefined();
    await runCommand(page, 'path.removeRedundant');
    n = await nodeById(page, r);
    expect(n.subpaths[0].anchors).toHaveLength(4);
    const secondBefore = n.subpaths[0].anchors[1].point;
    await runCommand(page, 'path.reverse');
    n = await nodeById(page, r);
    expect(n.subpaths[0].anchors[n.subpaths[0].anchors.length - 2].point).toEqual(secondBefore);

    // simplify dialog shows the anchor counts and commits one step
    await runCommand(page, 'path.addAnchors');
    const before = await undoCount(page);
    await runCommand(page, 'path.simplify');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await expect(page.getByTestId('simplify-before')).toHaveText('8');
    const after = Number(await page.getByTestId('simplify-after').textContent());
    expect(after).toBeLessThanOrEqual(8);
    await page.getByTestId('simplify-ok').click();
    await expect(page.getByTestId('dialog')).toBeHidden();
    expect(await undoCount(page)).toBe(before + 1);
    n = await nodeById(page, r);
    expect(n.subpaths[0].anchors).toHaveLength(after);
  });

  test('average dialog aligns selected anchors', async ({ page }) => {
    await openApp(page);
    const r = await drawRect(page, 100, 100, 200, 100);
    await selectTool(page, 'direct');
    await withStore(page, (s) => s.setSelection([s.selection[0]], [{ nodeId: s.selection[0], subpath: 0, index: 0 }, { nodeId: s.selection[0], subpath: 0, index: 2 }]));
    const before = await undoCount(page);
    await runCommand(page, 'path.average');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await page.getByRole('radio', { name: 'Horizontal' }).click();
    await page.getByTestId('average-ok').click();
    await expect(page.getByTestId('dialog')).toBeHidden();
    const n = await nodeById(page, r);
    const p0 = n.subpaths[0].anchors[0].point;
    const p2 = n.subpaths[0].anchors[2].point;
    expect(n.shape).toBeUndefined();
    expect(Math.abs(p0.y - p2.y)).toBeLessThan(1e-6);
    expect(p0.x).not.toBe(p2.x);
    expect(await undoCount(page)).toBe(before + 1);
    // via keyboard shortcut with anchors still selected: both axes
    await withStore(page, (s) => s.setSelection([s.selection[0]], [{ nodeId: s.selection[0], subpath: 0, index: 1 }, { nodeId: s.selection[0], subpath: 0, index: 3 }]));
    await press(page, 'Control+Alt+j');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await page.getByRole('radio', { name: 'Both' }).click();
    await press(page, 'Enter');
    await expect(page.getByTestId('dialog')).toBeHidden();
    const m = await nodeById(page, r);
    expect(m.subpaths[0].anchors[1].point).toEqual(m.subpaths[0].anchors[3].point);
  });

  test('divide objects below, expand and clean up', async ({ page }) => {
    await openApp(page);
    const below = await drawRect(page, 100, 100, 200, 200);
    const knife = await drawRect(page, 200, 150, 200, 100);
    await select(page, [knife]);
    await runCommand(page, 'path.divideBelow');
    expect(await nodeById(page, knife)).toBeUndefined();
    const ids = await pathIds(page);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(below);
    const inside = ids.find((id) => id !== below)!;
    expect(await worldBounds(page, inside)).toEqual({ x: 200, y: 150, width: 100, height: 100 });
    // expand: live shape becomes a plain path, the stroke is outlined
    await select(page, [below]);
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].stroke.width = 4; d.nodes[s.selection[0]].stroke.paint = { type: 'solid', color: '#000000', opacity: 1 }; }, 'Stroke'));
    await runCommand(page, 'object.expand');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await page.getByTestId('expand-ok').click();
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    const g = await nodeById(page, sel[0]);
    expect(g.type).toBe('group');
    expect((await nodeById(page, g.children[0])).shape).toBeUndefined();
    // clean up removes stray points and empty text
    await withStore(page, (s) => {
      const api = (window as any).__opuller.api;
      const stray = api.nodes.makePath([{ anchors: [{ point: { x: 5, y: 5 }, handleIn: null, handleOut: null, kind: 'corner' }], closed: false }]);
      const empty = api.nodes.makeText('   ');
      s.updateDoc((d: any) => {
        api.document.addNode(d, stray, d.layers[0]);
        api.document.addNode(d, empty, d.layers[0]);
      }, 'Add');
    });
    const total = await nodeCount(page);
    await runCommand(page, 'path.cleanUp');
    expect(await nodeCount(page)).toBe(total - 2);
  });
});
