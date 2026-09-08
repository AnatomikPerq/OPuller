import { test, expect, type Page } from '@playwright/test';
import { openApp, drawRect, drawEllipse, getState, selectTool, dragWorld, nodeById, selection, press, worldBounds, worldToScreen, viewport, withStore, setView, nodeCount } from './helpers';

/** Drag the mouse through a list of world points (pointer down at the first, up at the last). */
async function drawPolyline(page: Page, pts: Array<{ x: number; y: number }>, opts: { alt?: boolean; shift?: boolean; escapeBeforeUp?: boolean } = {}) {
  const box = await viewport(page).boundingBox();
  if (!box) throw new Error('viewport not found');
  const scr = [] as Array<{ x: number; y: number }>;
  for (const p of pts) {
    const s = await worldToScreen(page, p.x, p.y);
    scr.push({ x: box.x + s.x, y: box.y + s.y });
  }
  if (opts.alt) await page.keyboard.down('Alt');
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.move(scr[0].x, scr[0].y);
  await page.mouse.down();
  for (let i = 1; i < scr.length; i++) await page.mouse.move(scr[i].x, scr[i].y);
  if (opts.escapeBeforeUp) await page.keyboard.press('Escape');
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
  if (opts.alt) await page.keyboard.up('Alt');
}

function sineWave(x0: number, x1: number, y: number, amp: number, n: number) {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x0 + (x1 - x0) * t, y: y + Math.sin(t * Math.PI * 3) * amp });
  }
  return pts;
}

function circlePts(cx: number, cy: number, r: number, n: number, closeGap = 0) {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  if (closeGap) {
    const last = pts[pts.length - 1];
    last.x += closeGap;
  }
  return pts;
}

async function pathNodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const d = (window as any).__opuller.store.getState().doc;
    return Object.values(d.nodes)
      .filter((n: any) => n.type === 'path')
      .map((n: any) => n.id);
  });
}

async function nodeArea(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const api = (window as any).__opuller;
    const doc = api.store.getState().doc;
    const sps = api.api.document.worldSubPaths(doc, id);
    return api.api.paper.pathArea(sps, doc.nodes[id].fillRule);
  }, id);
}

async function anchorCount(page: Page, id: string): Promise<number> {
  const n = await nodeById(page, id);
  return n.subpaths.reduce((s: number, sp: any) => s + sp.anchors.length, 0);
}

async function setOptions(page: Page, tool: string, opts: Record<string, unknown>) {
  await page.evaluate(({ tool, opts }) => (window as any).__opuller.store.getState().setToolOptions(tool, opts), { tool, opts });
}

async function makePolylineNode(page: Page, pts: Array<{ x: number; y: number }>, closed = false, fillNone = true): Promise<string> {
  return page.evaluate(
    ({ pts, closed, fillNone }) => {
      const api = (window as any).__opuller;
      const s = api.store.getState();
      const node = api.api.nodes.makePath([api.api.path.polylineSubPath(pts, closed)], { fill: fillNone ? { type: 'none' } : undefined });
      s.updateDoc((d: any) => api.api.document.addNode(d, node, d.layers[0]), 'Test path');
      s.setSelection([node.id]);
      return node.id;
    },
    { pts, closed, fillNone },
  );
}

test.describe('freehand tools', () => {
  test('pencil fits a stroke to fewer anchors and closes near the start', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pencil');
    const before = await pathNodes(page);
    const wave = sineWave(100, 600, 300, 60, 60);
    await drawPolyline(page, wave);
    const after = await pathNodes(page);
    expect(after.length).toBe(before.length + 1);
    const id = after.find((x) => !before.includes(x))!;
    const n = await nodeById(page, id);
    expect(n.subpaths).toHaveLength(1);
    expect(n.subpaths[0].closed).toBe(false);
    expect(n.subpaths[0].anchors.length).toBeGreaterThanOrEqual(2);
    expect(n.subpaths[0].anchors.length).toBeLessThan(wave.length);
    expect(n.stroke.paint.type).not.toBe('none');
    expect(n.fill.type).toBe('none');
    expect(await selection(page)).toEqual([id]);
    const b = (await worldBounds(page, id))!;
    expect(Math.abs(b.x - 100)).toBeLessThan(6);
    expect(Math.abs(b.x + b.width - 600)).toBeLessThan(6);

    // closing gesture: end within the close distance of the start
    await page.keyboard.press('Escape'); // deselect so the new stroke does not edit the previous path
    await drawPolyline(page, circlePts(800, 300, 100, 40, 6));
    const ids = await pathNodes(page);
    const cid = ids.find((x) => !after.includes(x))!;
    const c = await nodeById(page, cid);
    expect(c.subpaths[0].closed).toBe(true);
    const cb = (await worldBounds(page, cid))!;
    expect(Math.abs(cb.width - 200)).toBeLessThan(10);

    // undo removes the circle, then the wave
    await press(page, 'Control+z');
    expect((await pathNodes(page)).includes(cid)).toBe(false);
    await press(page, 'Control+z');
    expect((await pathNodes(page)).includes(id)).toBe(false);
  });

  test('pencil draws straight segments with Alt and Escape cancels', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pencil');
    const box = (await viewport(page).boundingBox())!;
    const a = await worldToScreen(page, 100, 500);
    const b = await worldToScreen(page, 300, 500);
    const c = await worldToScreen(page, 300, 700);
    await page.keyboard.down('Alt');
    await page.mouse.move(box.x + a.x, box.y + a.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + a.x + ((b.x - a.x) * i) / 6, box.y + a.y + 3 * Math.sin(i));
    await page.mouse.move(box.x + b.x, box.y + b.y);
    await page.keyboard.up('Alt');
    await page.keyboard.down('Alt');
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + b.x + 3 * Math.sin(i), box.y + b.y + ((c.y - b.y) * i) / 6);
    await page.mouse.move(box.x + c.x, box.y + c.y);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const ids = await pathNodes(page);
    const n = await nodeById(page, ids[ids.length - 1]);
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].anchors.every((an: any) => an.handleIn === null && an.handleOut === null)).toBe(true);
    const pts = n.subpaths[0].anchors.map((an: any) => an.point);
    expect(Math.round(pts[1].x)).toBe(300);
    expect(Math.round(pts[2].y)).toBe(700);

    // Escape during a drag cancels: nothing is created
    const count = await nodeCount(page);
    await drawPolyline(page, sineWave(100, 400, 800, 30, 20), { escapeBeforeUp: true });
    expect(await nodeCount(page)).toBe(count);
  });

  test('pencil continues and redraws a selected path', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pencil');
    await drawPolyline(page, sineWave(100, 400, 300, 40, 40));
    const [id] = await selection(page);
    expect(id).toBeTruthy();
    const n1 = await nodeById(page, id);
    const end = n1.subpaths[0].anchors[n1.subpaths[0].anchors.length - 1].point;
    const anchorsBefore = n1.subpaths[0].anchors.length;
    const count = await nodeCount(page);
    // start exactly at the path end: the stroke continues the same path
    await drawPolyline(page, sineWave(end.x, end.x + 250, end.y, 40, 30).map((p, i) => (i === 0 ? { x: end.x, y: end.y } : p)));
    expect(await nodeCount(page)).toBe(count);
    const n2 = await nodeById(page, id);
    expect(n2.subpaths[0].anchors.length).toBeGreaterThan(anchorsBefore);
    const b = (await worldBounds(page, id))!;
    expect(b.x + b.width).toBeGreaterThan(600);
    expect(await selection(page)).toEqual([id]);

    // redraw a portion: start on the path, bulge upwards, end back on the path
    const lineId = await makePolylineNode(page, [
      { x: 100, y: 700 },
      { x: 600, y: 700 },
    ]);
    await selectTool(page, 'pencil');
    await drawPolyline(page, [
      { x: 200, y: 700 },
      { x: 230, y: 650 },
      { x: 260, y: 600 },
      { x: 300, y: 580 },
      { x: 340, y: 600 },
      { x: 370, y: 650 },
      { x: 400, y: 700 },
    ]);
    expect(await nodeCount(page)).toBe(count + 1);
    const ln = await nodeById(page, lineId);
    expect(ln.subpaths[0].anchors.length).toBeGreaterThan(2);
    expect(ln.subpaths[0].closed).toBe(false);
    const lb = (await worldBounds(page, lineId))!;
    expect(lb.y).toBeLessThan(600);
    expect(Math.round(lb.x)).toBe(100);
    expect(Math.round(lb.x + lb.width)).toBe(600);
    // undo restores the straight line
    await press(page, 'Control+z');
    const ln2 = await nodeById(page, lineId);
    expect(ln2.subpaths[0].anchors.length).toBe(2);
  });

  test('paintbrush paints a closed filled outline with area, and a simple stroke', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'brush');
    await setOptions(page, 'brush', { width: 24, taperStart: 30, taperEnd: 30, simple: false });
    const before = await pathNodes(page);
    await drawPolyline(page, sineWave(100, 500, 300, 50, 50));
    const after = await pathNodes(page);
    expect(after.length).toBe(before.length + 1);
    const id = after.find((x) => !before.includes(x))!;
    const n = await nodeById(page, id);
    expect(n.fill.type).toBe('solid');
    expect(n.stroke.paint.type).toBe('none');
    expect(n.subpaths.length).toBeGreaterThanOrEqual(1);
    expect(n.subpaths.every((sp: any) => sp.closed)).toBe(true);
    const area = await nodeArea(page, id);
    expect(area).toBeGreaterThan(400 * 10);
    const b = (await worldBounds(page, id))!;
    expect(b.height).toBeGreaterThan(100);
    expect(b.height).toBeLessThan(160);

    // simple stroke: open path with round caps and the brush width
    await setOptions(page, 'brush', { simple: true });
    await drawPolyline(page, sineWave(100, 500, 600, 50, 50));
    const ids = await pathNodes(page);
    const sid = ids.find((x) => !after.includes(x))!;
    const s = await nodeById(page, sid);
    expect(s.subpaths[0].closed).toBe(false);
    expect(s.fill.type).toBe('none');
    expect(s.stroke.width).toBe(24);
    expect(s.stroke.cap).toBe('round');
    await page.screenshot({ path: 'C:/Users/BADAB/AppData/Local/Temp/claude/C--Users-BADAB--------------OPuller/9538e8e9-28f5-4b8d-9cb3-a9e066e10c8b/scratchpad/brush.png' });
  });

  test('blob brush merges with a same-fill shape and Alt erases from it', async ({ page }) => {
    await openApp(page);
    const rect = await drawRect(page, 200, 200, 200, 120);
    const area0 = await nodeArea(page, rect);
    await selectTool(page, 'blob');
    // paint with the fill colour (white, same as the rectangle's default fill)
    await setOptions(page, 'blob', { size: 30, paint: 'fill', mergeSelectionOnly: false, keepSelected: true });
    const count = await nodeCount(page);
    await drawPolyline(page, [
      { x: 300, y: 260 },
      { x: 350, y: 260 },
      { x: 400, y: 260 },
      { x: 450, y: 260 },
      { x: 520, y: 260 },
    ]);
    expect(await nodeCount(page)).toBe(count); // merged, nothing new
    const n = await nodeById(page, rect);
    expect(n.shape).toBeUndefined();
    const b = (await worldBounds(page, rect))!;
    expect(b.x + b.width).toBeGreaterThan(520);
    expect(await nodeArea(page, rect)).toBeGreaterThan(area0);
    expect(await selection(page)).toEqual([rect]);

    // Alt-drag erases from the same shape
    const areaMerged = await nodeArea(page, rect);
    await drawPolyline(page, [
      { x: 250, y: 300 },
      { x: 300, y: 300 },
      { x: 350, y: 300 },
    ], { alt: true });
    expect(await nodeCount(page)).toBe(count);
    expect(await nodeArea(page, rect)).toBeLessThan(areaMerged);

    // a stroke away from any shape creates a new blob
    await drawPolyline(page, [
      { x: 700, y: 500 },
      { x: 760, y: 520 },
      { x: 820, y: 500 },
    ]);
    expect(await nodeCount(page)).toBe(count + 1);
    await page.screenshot({ path: 'C:/Users/BADAB/AppData/Local/Temp/claude/C--Users-BADAB--------------OPuller/9538e8e9-28f5-4b8d-9cb3-a9e066e10c8b/scratchpad/blob.png' });
  });

  test('smooth tool reduces anchors of a jagged selected path', async ({ page }) => {
    await openApp(page);
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: 100 + i * 12, y: 400 + (i % 2 ? 6 : -6) + Math.sin(i / 4) * 40 });
    const id = await makePolylineNode(page, pts);
    expect(await anchorCount(page, id)).toBe(41);
    await selectTool(page, 'smooth');
    await setOptions(page, 'smooth', { fidelity: 8 });
    await drawPolyline(page, pts.filter((_, i) => i % 2 === 0).map((p) => ({ x: p.x, y: p.y + 1 })));
    const after = await anchorCount(page, id);
    expect(after).toBeLessThan(20);
    const b = (await worldBounds(page, id))!;
    expect(Math.abs(b.x - 100)).toBeLessThan(2);
    expect(Math.abs(b.x + b.width - 580)).toBeLessThan(2);
    await press(page, 'Control+z');
    expect(await anchorCount(page, id)).toBe(41);

    // closed live shape: smoothing along part of it clears the live shape and keeps it closed
    const ell = await drawEllipse(page, 600, 300, 200, 200);
    await selectTool(page, 'smooth');
    const arc: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 12; i++) {
      const a = -Math.PI / 2 + (i / 12) * Math.PI; // right half, crossing the ellipse's start anchor
      arc.push({ x: 700 + Math.cos(a) * 100, y: 400 + Math.sin(a) * 100 });
    }
    await drawPolyline(page, arc);
    const e = await nodeById(page, ell);
    expect(e.shape).toBeUndefined();
    expect(e.subpaths[0].closed).toBe(true);
    const eb = (await worldBounds(page, ell))!;
    expect(Math.abs(eb.width - 200)).toBeLessThan(8);
    expect(Math.abs(eb.height - 200)).toBeLessThan(8);
  });

  test('path eraser opens a closed path and splits an open one', async ({ page }) => {
    await openApp(page);
    const rect = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'patheraser');
    await setOptions(page, 'patheraser', { width: 8 });
    const count = await nodeCount(page);
    await drawPolyline(page, [
      { x: 150, y: 100 },
      { x: 180, y: 100 },
      { x: 210, y: 100 },
      { x: 250, y: 100 },
    ]);
    expect(await nodeCount(page)).toBe(count);
    const n = await nodeById(page, rect);
    expect(n.subpaths).toHaveLength(1);
    expect(n.subpaths[0].closed).toBe(false);
    expect(n.shape).toBeUndefined();
    const b = (await worldBounds(page, rect))!;
    expect(Math.round(b.width)).toBe(200);
    // the gap: no anchor between x=155 and x=245 on the top edge
    const topAnchors = n.subpaths[0].anchors.filter((a: any) => Math.abs(a.point.y - 100) < 0.5).map((a: any) => a.point.x);
    expect(topAnchors.some((x: number) => x > 155 && x < 245)).toBe(false);
    await press(page, 'Control+z');
    expect((await nodeById(page, rect)).subpaths[0].closed).toBe(true);

    // open path: erasing the middle yields two path nodes
    const line = await makePolylineNode(page, [
      { x: 100, y: 500 },
      { x: 500, y: 500 },
    ]);
    await selectTool(page, 'patheraser');
    const c2 = await nodeCount(page);
    await drawPolyline(page, [
      { x: 250, y: 500 },
      { x: 300, y: 500 },
      { x: 350, y: 500 },
    ]);
    expect(await nodeCount(page)).toBe(c2 + 1);
    const l1 = await nodeById(page, line);
    const lb = (await worldBounds(page, line))!;
    expect(l1.subpaths[0].closed).toBe(false);
    expect(lb.x + lb.width).toBeLessThan(250);
    expect((await selection(page)).length).toBe(2);
  });

  test('eraser cuts a rectangle apart, cuts holes, erases with a marquee and undoes', async ({ page }) => {
    await openApp(page);
    const rect = await drawRect(page, 100, 100, 200, 120);
    const area0 = await nodeArea(page, rect);
    await selectTool(page, 'eraser');
    await setOptions(page, 'eraser', { diameter: 20, split: true });
    const count = await nodeCount(page);
    // vertical cut through the middle -> two pieces
    await drawPolyline(page, [
      { x: 200, y: 80 },
      { x: 200, y: 120 },
      { x: 200, y: 160 },
      { x: 200, y: 200 },
      { x: 200, y: 240 },
    ]);
    expect(await nodeCount(page)).toBe(count + 1);
    const sel = await selection(page);
    expect(sel.length).toBe(2);
    for (const id of sel) {
      const n = await nodeById(page, id);
      expect(n.subpaths[0].closed).toBe(true);
      expect(n.fill.type).toBe('solid');
      const a = await nodeArea(page, id);
      expect(a).toBeLessThan(area0 / 2);
      expect(a).toBeGreaterThan(area0 / 4);
    }
    await press(page, 'Control+z');
    expect(await nodeCount(page)).toBe(count);
    expect(Math.round(await nodeArea(page, rect))).toBe(Math.round(area0));

    // a short stroke inside cuts a hole: one node with two subpaths
    await drawPolyline(page, [
      { x: 180, y: 160 },
      { x: 200, y: 160 },
      { x: 220, y: 160 },
    ]);
    expect(await nodeCount(page)).toBe(count);
    const h = await nodeById(page, rect);
    expect(h.subpaths.length).toBe(2);
    expect(await nodeArea(page, rect)).toBeLessThan(area0);
    await press(page, 'Control+z');

    // Alt-drag erases a rectangular marquee (overlapping the top-left corner)
    await drawPolyline(page, [
      { x: 80, y: 80 },
      { x: 120, y: 120 },
      { x: 160, y: 160 },
    ], { alt: true });
    const m = await nodeById(page, rect);
    expect(m.subpaths.length).toBe(1);
    expect(Math.round(await nodeArea(page, rect))).toBe(Math.round(area0 - 60 * 60));
    await press(page, 'Control+z');
    expect(Math.round(await nodeArea(page, rect))).toBe(Math.round(area0));

    // open stroked path: erasing across it splits it in two nodes
    await page.keyboard.press('Escape');
    await withStore(page, (s) => s.clearSelection());
    const line = await makePolylineNode(page, [
      { x: 100, y: 500 },
      { x: 500, y: 500 },
    ]);
    await withStore(page, (s) => s.clearSelection());
    await selectTool(page, 'eraser');
    const c2 = await nodeCount(page);
    await drawPolyline(page, [
      { x: 300, y: 450 },
      { x: 300, y: 500 },
      { x: 300, y: 550 },
    ]);
    expect(await nodeCount(page)).toBe(c2 + 1);
    const lb = (await worldBounds(page, line))!;
    expect(lb.x + lb.width).toBeLessThan(295);
    await page.screenshot({ path: 'C:/Users/BADAB/AppData/Local/Temp/claude/C--Users-BADAB--------------OPuller/9538e8e9-28f5-4b8d-9cb3-a9e066e10c8b/scratchpad/eraser.png' });
  });

  test('tools work at 4x zoom and inside a transformed group', async ({ page }) => {
    await openApp(page);
    await setView(page, 4, { x: -200, y: -200 });
    await selectTool(page, 'pencil');
    await drawPolyline(page, sineWave(100, 250, 120, 10, 40));
    const [id] = await selection(page);
    const n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBeLessThan(41);
    const b = (await worldBounds(page, id))!;
    expect(Math.abs(b.x - 100)).toBeLessThan(3);

    // rotate the path inside a group, then erase through it in world space
    await setView(page, 1, { x: 100, y: 100 });
    const rect = await drawRect(page, 300, 300, 200, 100);
    await withStore(page, (s) => {
      const api = (window as any).__opuller.api.document;
      const g = (window as any).__opuller.api.nodes.makeGroup();
      s.updateDoc((d: any) => {
        api.groupNodes(d, [s.selection[0]], g);
        d.nodes[g.id].transform = { a: 0.7071, b: 0.7071, c: -0.7071, d: 0.7071, e: 400, f: -150 };
      }, 'Group');
      s.setSelection([g.id]);
    });
    void rect;
    const gb = await withStore(page, (s) => (window as any).__opuller.worldBounds(s.doc, s.selection[0]));
    const cx = gb.x + gb.width / 2;
    const cy = gb.y + gb.height / 2;
    await selectTool(page, 'eraser');
    await setOptions(page, 'eraser', { diameter: 16, split: true });
    const paths = await pathNodes(page);
    await drawPolyline(page, [
      { x: cx, y: gb.y - 20 },
      { x: cx, y: cy },
      { x: cx, y: gb.y + gb.height + 20 },
    ]);
    const after = await pathNodes(page);
    expect(after.length).toBe(paths.length + 1);
  });
});
