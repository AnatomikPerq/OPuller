/**
 * Live corners (plan items 2 and 6): corner widgets of the Direct Selection tool, the
 * Corners dialog, per-corner rectangle radii, the scripting method and rounding after a warp.
 */
import { test, expect, type Page } from '@playwright/test';
import { openApp, selectTool, dragWorld, clickWorld, getState, nodeById, drawRect, withStore, worldBounds, runCommand, press } from './helpers';

/** A closed triangle path (base at y = 400, tip at (300, 200)) created through the scripting API. */
async function makeTriangle(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = (window as any).__opuller.mcp;
    const r = api.createPath({ d: 'M200 400 L400 400 L300 200 Z', fill: '#ffaa00', stroke: 'none', name: 'Ear' });
    return r.id as string;
  });
}

/** Topmost y of the rendered (effective) outline of a path, in world units. */
async function topY(page: Page, id: string): Promise<number> {
  const b = (await worldBounds(page, id))!;
  return b.y;
}

/** Screen position of a corner widget by key (nodeId/subpath/index or nodeId/rect/corner). */
async function widgetScreen(page: Page, key: string): Promise<{ x: number; y: number }> {
  const el = page.locator(`[data-corner="${key}"] circle`).first();
  await expect(el).toBeVisible();
  const box = (await el.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('live corners', () => {
  test('rectangle radii are clamped per corner: one corner may use the whole edge (plan item 2)', async ({ page }) => {
    await openApp(page);
    const id = await page.evaluate(() => (window as any).__opuller.mcp.createShape({ kind: 'rect', x: 100, y: 100, width: 47, height: 61, radii: [23.636, 23.636, 0, 37.3], fill: '#cccccc', stroke: 'none' }).id);
    const n = await nodeById(page, id);
    expect(n.shape.radii[3]).toBeCloseTo(37.3, 3);
    // the bottom-left arc really reaches 37.3 up the left edge: an anchor sits at (0, 61 − 37.3) locally
    const ys = n.subpaths[0].anchors.filter((a: any) => Math.abs(a.point.x) < 1e-6).map((a: any) => a.point.y);
    expect(ys.some((y: number) => Math.abs(y - (61 - 37.3)) < 1e-3)).toBe(true);
    const b = (await worldBounds(page, id))!;
    expect(b.width).toBeCloseTo(47, 3);
    expect(b.height).toBeCloseTo(61, 3);
  });

  test('scripting: opuller corners rounds every corner or chosen anchors; export uses the rounded outline', async ({ page }) => {
    await openApp(page);
    const id = await makeTriangle(page);
    const sharpTop = await topY(page, id);
    const r = await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 9, anchors: [2] }), id);
    expect(r.corners).toBe(1);
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[2].cornerRadius).toBe(9);
    expect(n.subpaths[0].anchors[0].cornerRadius).toBeUndefined();
    // the anchor stays the sharp vertex, the outline (bounds) is rounded
    expect(n.subpaths[0].anchors[2].point).toEqual({ x: 300, y: 200 });
    expect((await topY(page, id)) - sharpTop).toBeGreaterThan(6);
    // the SVG export and the node's "d" carry the rounded geometry
    const d = await page.evaluate((id) => (window as any).__opuller.mcp.getNode({ id }).d as string, id);
    expect(d).toContain('C');
    const svg = await page.evaluate(() => (window as any).__opuller.mcp.exportSvg({ scope: 'artboard' }).svg as string);
    expect(svg).toMatch(/<path[^>]*d="[^"]*C[^"]*"/);
    // all corners at once, then off again
    await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 12 }), id);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.every((a: any) => a.cornerRadius === 12)).toBe(true);
    await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 0 }), id);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.every((a: any) => a.cornerRadius === undefined)).toBe(true);
    expect(await topY(page, id)).toBeCloseTo(sharpTop, 3);
    // undo steps: three history entries
    await press(page, 'Control+z');
    expect((await nodeById(page, id)).subpaths[0].anchors[0].cornerRadius).toBe(12);
  });

  test('live corner 9 then warp bulge 40 keeps the tip rounded (corners apply before effects, plan item 6)', async ({ page }) => {
    await openApp(page);
    const id = await makeTriangle(page);
    await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 9, anchors: [2] }), id);
    const roundedTop = await topY(page, id);
    await page.evaluate((id) => (window as any).__opuller.mcp.updateNodes({ ids: [id], patch: { effects: [{ type: 'warp', enabled: true, style: 'bulge', bend: 40, horizontal: false, hDistort: -10, vDistort: 0 }] } }), id);
    // the warped outline still has no sharp apex at x = 300: sample the rendered path near the top
    const probe = await page.evaluate((id) => {
      const el = document.querySelector(`[data-id="${id}"] path, path[data-id="${id}"]`) as SVGPathElement | null;
      const path = el ?? (document.querySelector(`[data-id="${id}"]`) as SVGPathElement);
      const len = path.getTotalLength();
      let top = Infinity;
      let topX = 0;
      for (let i = 0; i <= 400; i++) {
        const p = path.getPointAtLength((len * i) / 400);
        if (p.y < top) {
          top = p.y;
          topX = p.x;
        }
      }
      // width of the outline 4 units below the top: a sharp tip would be ~4 units wide (53° apex), a rounded one much wider
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i <= 2000; i++) {
        const p = path.getPointAtLength((len * i) / 2000);
        if (Math.abs(p.y - (top + 4)) < 0.6) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
        }
      }
      return { top, topX, width: maxX - minX };
    }, id);
    expect(probe.width).toBeGreaterThan(9);
    expect(probe.top).toBeGreaterThan(roundedTop - 60); // still near the tip region after the bulge
    // and the Round Corners *effect* after the warp works too (tangent-break detection)
    await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 0 }), id);
    const sharpWarpedTop = await topY(page, id);
    await page.evaluate((id) => {
      const api = (window as any).__opuller.mcp;
      const n = api.getNode({ id });
      api.updateNodes({ ids: [id], patch: { effects: [...n.effects, { type: 'roundCorners', enabled: true, radius: 9 }] } });
    }, id);
    expect((await topY(page, id)) - sharpWarpedTop).toBeGreaterThan(5);
  });

  test('Direct Selection shows corner widgets; dragging one rounds the corner, double-click opens the Corners dialog', async ({ page }) => {
    await openApp(page);
    const id = await makeTriangle(page);
    await selectTool(page, 'direct');
    await withStore(page, (s) => s.setSelection([s.selection[0] ?? Object.keys(s.doc.nodes).find((k: string) => s.doc.nodes[k].name === 'Ear')]));
    await expect(page.locator('[data-testid="corner-widget"]')).toHaveCount(3);
    const w = await widgetScreen(page, `${id}/0/2`);
    // the widget of the tip sits on the bisector below the vertex
    const vertex = await page.evaluate(() => {
      const st = (window as any).__opuller.store.getState();
      return { x: 300 * st.zoom + st.pan.x, y: 200 * st.zoom + st.pan.y };
    });
    const vp = (await page.locator('[data-testid="viewport"]').boundingBox())!;
    expect(Math.abs(w.x - (vp.x + vertex.x))).toBeLessThan(2);
    expect(w.y).toBeGreaterThan(vp.y + vertex.y + 8);
    // drag the tip widget down: all three corners round (whole object selected), radius > 0
    await page.mouse.move(w.x, w.y);
    await page.mouse.down();
    await page.mouse.move(w.x, w.y + 20, { steps: 6 });
    await page.mouse.move(w.x, w.y + 40, { steps: 6 });
    await page.mouse.up();
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.every((a: any) => a.cornerRadius > 0)).toBe(true);
    const r1 = n.subpaths[0].anchors[2].cornerRadius;
    let s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Round Corners');
    // with a single anchor selected only that corner changes
    await clickWorld(page, 200, 400);
    s = await getState(page);
    expect(s.selectedAnchors).toEqual([{ nodeId: id, subpath: 0, index: 0 }]);
    await expect(page.locator('[data-testid="corner-widget"]')).toHaveCount(1);
    const w0 = await widgetScreen(page, `${id}/0/0`);
    await page.mouse.move(w0.x, w0.y);
    await page.mouse.down();
    await page.mouse.move(w0.x + 14, w0.y - 14, { steps: 8 });
    await page.mouse.up();
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[0].cornerRadius).toBeGreaterThan(r1);
    expect(n.subpaths[0].anchors[2].cornerRadius).toBeCloseTo(r1, 6);
    // double-click a widget: the Corners dialog; typing a radius previews and OK commits
    await page.mouse.dblclick(w0.x + 14, w0.y - 14);
    await expect(page.getByTestId('corners-radius')).toBeVisible();
    await page.getByTestId('corners-radius').fill('25');
    await page.getByTestId('corners-radius').press('Tab');
    await expect.poll(async () => (await nodeById(page, id)).subpaths[0].anchors[0].cornerRadius).toBeCloseTo(25, 3);
    await page.getByTestId('corners-ok').click();
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[0].cornerRadius).toBeCloseTo(25, 3);
    // Escape in the dialog reverts the preview
    await runCommand(page, 'path.corners');
    await page.getByTestId('corners-radius').fill('3');
    await page.getByTestId('corners-radius').press('Tab');
    await expect.poll(async () => (await nodeById(page, id)).subpaths[0].anchors[0].cornerRadius).toBeCloseTo(3, 3);
    await press(page, 'Escape');
    expect((await nodeById(page, id)).subpaths[0].anchors[0].cornerRadius).toBeCloseTo(25, 3);
  });

  test('a live rectangle gets rect widgets that edit shape.radii and survive a resize', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'direct');
    await expect(page.locator('[data-testid="corner-widget"]')).toHaveCount(4);
    const w = await widgetScreen(page, `${id}/rect/0`);
    await page.mouse.move(w.x, w.y);
    await page.mouse.down();
    await page.mouse.move(w.x + 20, w.y + 20, { steps: 8 });
    await page.mouse.up();
    let n = await nodeById(page, id);
    expect(n.shape.kind).toBe('rect'); // still live
    expect(n.shape.radii.every((r: number) => r > 5)).toBe(true);
    expect(n.subpaths[0].anchors).toHaveLength(8);
    // corners are capped at the edges: no radius can exceed half the short side when all four are equal
    await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 500 }), id);
    n = await nodeById(page, id);
    expect(n.shape.radii).toEqual([60, 60, 60, 60]);
    const b = (await worldBounds(page, id))!;
    expect(b.width).toBeCloseTo(200, 3);
    expect(b.height).toBeCloseTo(120, 3);
  });

  test('booleans and cutting use the rounded outline; project files keep the radii', async ({ page }) => {
    await openApp(page);
    const id = await makeTriangle(page);
    await page.evaluate((id) => (window as any).__opuller.mcp.corners({ ids: [id], radius: 20 }), id);
    const roundedTop = await topY(page, id);
    const other = await page.evaluate(() => (window as any).__opuller.mcp.createShape({ kind: 'rect', x: 150, y: 350, width: 300, height: 100, fill: '#0000ff', stroke: 'none' }).id);
    const pf = await page.evaluate(({ id, other }) => (window as any).__opuller.mcp.pathfinder({ op: 'unite', ids: [id, other] }), { id, other });
    const united = pf.selection[0];
    const un = await nodeById(page, united);
    expect(un.subpaths.flatMap((sp: any) => sp.anchors).every((a: any) => a.cornerRadius === undefined)).toBe(true);
    expect((await worldBounds(page, united))!.y).toBeCloseTo(roundedTop, 1);
    await press(page, 'Control+z');
    // project round trip
    const text = await page.evaluate(async () => (await (window as any).__opuller.mcp.getProject({})).json as string);
    expect(text).toContain('"cornerRadius":20');
    await page.evaluate((text) => (window as any).__opuller.mcp.loadProject({ json: text }), text);
    const back = await page.evaluate(() => {
      const st = (window as any).__opuller.store.getState();
      const n: any = Object.values(st.doc.nodes).find((x: any) => x.name === 'Ear');
      return n.subpaths[0].anchors.map((a: any) => a.cornerRadius);
    });
    expect(back).toEqual([20, 20, 20]);
  });
});
