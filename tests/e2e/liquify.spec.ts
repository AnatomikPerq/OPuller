import { test, type Page } from '@playwright/test';
import { openApp, expect, getState, withStore, drawRect, drawEllipse, dragWorld, selectTool, nodeById, worldBounds, viewport, worldToScreen, press } from './helpers';

async function anchorCount(page: Page, id: string): Promise<number> {
  const n = await nodeById(page, id);
  return n.subpaths.reduce((s: number, sp: any) => s + sp.anchors.length, 0);
}

async function nodeArea(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const api = (window as any).__opuller;
    const doc = api.store.getState().doc;
    return api.api.paper.pathArea(api.api.document.worldSubPaths(doc, id), doc.nodes[id].fillRule);
  }, id);
}

async function setBrush(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((patch) => (window as any).__opuller.liquify.setGlobalBrush(patch), patch);
}

/** Press the mouse at a world point, hold, release (timed tools work while the button is down). */
async function holdWorld(page: Page, x: number, y: number, ms: number) {
  const box = await viewport(page).boundingBox();
  if (!box) throw new Error('viewport not found');
  const p = await worldToScreen(page, x, y);
  await page.mouse.move(box.x + p.x, box.y + p.y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.move(box.x + p.x + 1, box.y + p.y);
  await page.mouse.up();
}

test.describe('liquify tools', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('one wide warp stroke through a rectangle gives a smooth, simple outline with few anchors (plan item 9)', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 300, 200);
    await withStore(page, (st) => st.clearSelection());
    // a scripted stroke of two points: the engine must interpolate the whole way, not jump
    const r = await page.evaluate((id) => (window as any).__opuller.liquify.applyLiquify({ kind: 'warp', ids: [id], points: [{ x: 40, y: 200 }, { x: 460, y: 200 }], options: { width: 120, height: 120, intensity: 50, detail: 2, simplify: 50 } }), id);
    expect(r.changed).toBe(true);
    const n = await nodeById(page, id);
    expect(n.subpaths).toHaveLength(1);
    expect(n.subpaths[0].closed).toBe(true);
    const count = await anchorCount(page, id);
    expect(count).toBeLessThanOrEqual(40);
    expect(count).toBeGreaterThan(4);
    // the outline is simple: no two non-adjacent segments of the flattened polygon intersect
    const crossings = await page.evaluate((id) => {
      const api = (window as any).__opuller;
      const doc = api.store.getState().doc;
      const sps = api.api.document.worldSubPaths(doc, id);
      const pts: Array<{ x: number; y: number }> = api.api.path.flattenSubPath(sps[0], 0.2);
      const n = pts.length;
      const cross = (a: any, b: any, c: any) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue;
          const c = pts[j];
          const d = pts[(j + 1) % n];
          const d1 = cross(a, b, c);
          const d2 = cross(a, b, d);
          const d3 = cross(c, d, a);
          const d4 = cross(c, d, b);
          if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) hits++;
        }
      }
      return hits;
    }, id);
    expect(crossings).toBe(0);
    // the stroke pushed the right edge to the right and dented the left one; the rest of the box is intact
    const b = (await worldBounds(page, id))!;
    expect(b.x + b.width).toBeGreaterThan(410);
    expect(b.y).toBeCloseTo(100, 1);
    expect(b.y + b.height).toBeCloseTo(300, 1);
  });

  test('warp tool pushes an edge of the path under the brush in one undo step', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 300, 200);
    await withStore(page, (st) => st.clearSelection());
    await selectTool(page, 'warp');
    await setBrush(page, { width: 100, height: 100, intensity: 100 });
    await dragWorld(page, { x: 250, y: 300 }, { x: 250, y: 370 }, { steps: 14 });
    const n = await nodeById(page, id);
    expect(n.shape).toBeUndefined();
    const b = (await worldBounds(page, id))!;
    expect(b.y).toBeCloseTo(100, 0);
    expect(b.height).toBeGreaterThan(240);
    expect(b.height).toBeLessThan(275);
    expect(b.width).toBeCloseTo(300, 0);
    expect(await anchorCount(page, id)).toBeGreaterThan(4);
    const s = await getState(page);
    expect(s.past.map((p: any) => p.label)).toEqual(['Create Rectangle', 'Warp Tool']);
    await withStore(page, (st) => st.undo());
    const b2 = (await worldBounds(page, id))!;
    expect(Math.round(b2.height)).toBe(200);
    expect(await anchorCount(page, id)).toBe(4);
  });

  test('only the selection is reshaped when there is one; Escape cancels', async ({ page }) => {
    const a = await drawRect(page, 100, 100, 200, 200);
    const b = await drawRect(page, 400, 100, 200, 200);
    await withStore(page, (st) => st.setSelection([Object.keys(st.doc.nodes).filter((k) => st.doc.nodes[k].type === 'path')[0]]));
    const sel = await getState(page);
    const selected = sel.selection[0];
    const other = selected === a ? b : a;
    await selectTool(page, 'warp');
    await setBrush(page, { width: 120, height: 120, intensity: 100 });
    // drag over the unselected one: nothing happens
    const ob = (await worldBounds(page, other))!;
    await dragWorld(page, { x: ob.x + 100, y: ob.y + 200 }, { x: ob.x + 100, y: ob.y + 260 }, { steps: 10 });
    const ob2 = (await worldBounds(page, other))!;
    expect(Math.round(ob2.height)).toBe(200);
    expect((await getState(page)).past.length).toBe(2);
    // Escape during a drag on the selected one reverts
    const sb = (await worldBounds(page, selected))!;
    const box = (await viewport(page).boundingBox())!;
    const p0 = await worldToScreen(page, sb.x + 100, sb.y + 200);
    await page.mouse.move(box.x + p0.x, box.y + p0.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + p0.x, box.y + p0.y + i * 6);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const sb2 = (await worldBounds(page, selected))!;
    expect(Math.round(sb2.height)).toBe(200);
    expect((await getState(page)).past.length).toBe(2);
  });

  test('bloat and pucker keep working while the button is held; twirl turns the shape', async ({ page }) => {
    const c = await drawEllipse(page, 300, 300, 200, 200);
    await withStore(page, (st) => st.clearSelection());
    const area0 = await nodeArea(page, c);
    await selectTool(page, 'bloat');
    await setBrush(page, { width: 260, height: 260, intensity: 100 });
    await holdWorld(page, 400, 400, 500);
    const grown = await nodeArea(page, c);
    expect(grown).toBeGreaterThan(area0 * 1.15);
    let s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Bloat Tool');
    await selectTool(page, 'pucker');
    await holdWorld(page, 400, 400, 500);
    const shrunk = await nodeArea(page, c);
    expect(shrunk).toBeLessThan(grown * 0.9);
    s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Pucker Tool');
    // twirl (scripted engine, counter-clockwise on screen for a positive rate): the corners of a
    // square around the brush centre turn by 240° × falloff(0.57) ≈ 95°, so the top-left corner
    // travels to the lower left
    const sq = await drawRect(page, 300, 300, 200, 200);
    await withStore(page, (st) => st.clearSelection());
    await page.evaluate((id) => (window as any).__opuller.liquify.applyLiquify({ kind: 'twirl', ids: [id], points: [{ x: 400, y: 400 }], steps: 20, options: { width: 500, height: 500, intensity: 100, rate: 120, simplify: 0 } }), sq);
    const after = await nodeById(page, sq);
    const pts = after.subpaths[0].anchors.map((a: any) => a.point);
    const angleOf = (p: any) => (Math.atan2(p.y - 400, p.x - 400) * 180) / Math.PI;
    // every corner keeps its distance from the centre and turned by 80..110 degrees counter-clockwise on screen (negative screen angle change)
    const turned = pts.map((p: any) => ({ d: Math.hypot(p.x - 400, p.y - 400), a: angleOf(p) }));
    for (const t of turned) expect(Math.abs(t.d - 141.4)).toBeLessThan(3);
    const startAngles = [-135, -45, 45, 135];
    const deltas = turned.map((t: any) => startAngles.map((a0) => ((t.a - a0 + 540) % 360) - 180));
    // one of the four corner assignments explains every point with a turn of 80..110 degrees (CCW on screen = negative)
    const ok = deltas.every((ds: number[]) => ds.some((d) => d < -80 && d > -110));
    expect(ok).toBe(true);
    s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Twirl Tool');
  });

  test('scallop, crystallize and wrinkle add detail to an outline', async ({ page }) => {
    const c = await drawEllipse(page, 300, 300, 200, 200);
    await withStore(page, (st) => st.clearSelection());
    const initial = await anchorCount(page, c);
    for (const kind of ['scallop', 'crystallize', 'wrinkle']) {
      const before = JSON.stringify((await nodeById(page, c)).subpaths);
      const res = await page.evaluate(
        ({ id, kind }) => (window as any).__opuller.liquify.applyLiquify({ kind, ids: [id], points: [{ x: 500, y: 400 }], steps: 15, options: { width: 160, height: 160, intensity: 100, complexity: 3 } }),
        { id: c, kind },
      );
      expect(res.changed).toBe(true);
      // the outline moved (anchors are only added the first time the brush subdivides the edge)
      expect(JSON.stringify((await nodeById(page, c)).subpaths)).not.toBe(before);
    }
    expect(await anchorCount(page, c)).toBeGreaterThan(initial);
    const s = await getState(page);
    expect(s.past.slice(-3).map((p: any) => p.label)).toEqual(['Scallop Tool', 'Crystallize Tool', 'Wrinkle Tool']);
  });

  test('Alt-drag resizes the brush, [ and ] step the size, options bar and dialog edit the shared dimensions', async ({ page }) => {
    await selectTool(page, 'warp');
    await setBrush(page, { width: 100, height: 100 });
    await dragWorld(page, { x: 600, y: 600 }, { x: 660, y: 640 }, { modifiers: ['Alt'], steps: 6 });
    let s = await getState(page);
    expect(s.toolOptions.warp.width).toBe(120);
    expect(s.toolOptions.warp.height).toBe(80);
    expect(s.toolOptions.twirl.width).toBe(120);
    await viewport(page).hover({ position: { x: 300, y: 300 } });
    await press(page, ']');
    s = await getState(page);
    expect(s.toolOptions.warp.width).toBeGreaterThan(120);
    await expect(page.getByTestId('liquify-width')).toBeVisible();
    await page.getByTestId('liquify-width').fill('150');
    await page.getByTestId('liquify-width').press('Enter');
    s = await getState(page);
    expect(s.toolOptions.warp.width).toBe(150);
    expect(s.toolOptions.bloat.width).toBe(150);
    await page.getByTestId('liquify-options').click();
    await expect(page.getByTestId('liquify-dialog-ok')).toBeVisible();
    await page.getByTestId('liquify-dialog-width').fill('90');
    await page.getByTestId('liquify-dialog-width').press('Enter');
    await page.getByTestId('liquify-dialog-ok').click();
    s = await getState(page);
    expect(s.toolOptions.warp.width).toBe(90);
    expect(s.toolOptions.scallop.width).toBe(90);
    expect(s.dialog).toBeNull();
  });
});
