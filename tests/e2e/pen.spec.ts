import { test, expect } from '@playwright/test';
import { openApp, selectTool, clickWorld, dragWorld, moveWorld, getState, nodeById, press, drawRect, withStore, setView } from './helpers';

async function selectedNode(page: any) {
  const s = await getState(page);
  return s.doc.nodes[s.selection[0]];
}

async function pastLabels(page: any): Promise<string[]> {
  const s = await getState(page);
  return s.past.map((p: any) => p.label);
}

test.describe('pen tool', () => {
  test('draws a closed triangle with 3 clicks + click on the first anchor, one undo step per click', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 200, 200);
    await clickWorld(page, 400, 200);
    await clickWorld(page, 300, 380);
    let n = await selectedNode(page);
    expect(n.type).toBe('path');
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].closed).toBe(false);
    // hover the first anchor: close cursor; click closes
    await moveWorld(page, 200, 200);
    await clickWorld(page, 200, 200);
    n = await selectedNode(page);
    expect(n.subpaths.length).toBe(1);
    expect(n.subpaths[0].closed).toBe(true);
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].anchors.map((a: any) => [a.point.x, a.point.y])).toEqual([
      [200, 200],
      [400, 200],
      [300, 380],
    ]);
    expect(await pastLabels(page)).toEqual(['Pen', 'Pen', 'Pen', 'Close Path']);
    // drawing ended: no anchor selection, path still selected
    let s = await getState(page);
    expect(s.selectedAnchors).toEqual([]);
    expect(s.selection.length).toBe(1);
    // undo step by step
    await press(page, 'Control+z');
    n = await nodeById(page, s.selection[0]);
    expect(n.subpaths[0].closed).toBe(false);
    await press(page, 'Control+z');
    n = await nodeById(page, s.selection[0]);
    expect(n.subpaths[0].anchors.length).toBe(2);
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    s = await getState(page);
    expect(Object.values(s.doc.nodes).filter((x: any) => x.type === 'path').length).toBe(0);
  });

  test('click-drag creates a smooth anchor with symmetric handles; Alt breaks the outgoing handle', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await dragWorld(page, { x: 600, y: 200 }, { x: 700, y: 150 });
    let n = await selectedNode(page);
    let a = n.subpaths[0].anchors[0];
    expect(a.kind).toBe('smooth');
    expect(a.handleOut).toEqual({ x: 100, y: -50 });
    expect(a.handleIn).toEqual({ x: -100, y: 50 });
    // second anchor dragged with Alt: only the outgoing handle follows the pointer
    await dragWorld(page, { x: 800, y: 300 }, { x: 900, y: 340 }, { modifiers: ['Alt'] });
    n = await selectedNode(page);
    a = n.subpaths[0].anchors[1];
    expect(a.handleOut).toEqual({ x: 100, y: 40 });
    expect(a.handleIn).toBeNull();
    expect(a.kind).toBe('corner');
    expect(await pastLabels(page)).toEqual(['Pen', 'Pen']);
    // rubber band preview is drawn while hovering
    await moveWorld(page, 950, 500);
    await expect(page.locator('.overlay-svg .pen-overlay path')).toHaveCount(1);
  });

  test('Shift constrains new anchors to 45 degrees and Enter/Escape finish the path', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 100, 100);
    await clickWorld(page, 300, 118, { modifiers: ['Shift'] });
    let n = await selectedNode(page);
    expect(n.subpaths[0].anchors[1].point.y).toBeCloseTo(100, 5);
    await clickWorld(page, 420, 230, { modifiers: ['Shift'] });
    n = await selectedNode(page);
    const p = n.subpaths[0].anchors[2].point;
    const prev = n.subpaths[0].anchors[1].point;
    expect(Math.abs(Math.abs(p.x - prev.x) - Math.abs(p.y - prev.y))).toBeLessThan(1e-6);
    await press(page, 'Enter');
    let s = await getState(page);
    expect(s.selectedAnchors).toEqual([]);
    // next click starts a NEW path
    await clickWorld(page, 600, 600);
    await clickWorld(page, 700, 600);
    s = await getState(page);
    expect(Object.values(s.doc.nodes).filter((x: any) => x.type === 'path').length).toBe(2);
    // Escape keeps what was drawn
    await press(page, 'Escape');
    s = await getState(page);
    expect(Object.values(s.doc.nodes).filter((x: any) => x.type === 'path').length).toBe(2);
    expect(s.selectedAnchors).toEqual([]);
    expect(s.selection.length).toBe(1);
  });

  test('continues an open path from either end and adds/deletes anchors on the drawn path', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 200, 200);
    await clickWorld(page, 400, 200);
    await press(page, 'Enter');
    let s = await getState(page);
    const id = s.selection[0];
    // continue from the last anchor
    await clickWorld(page, 400, 200);
    await clickWorld(page, 500, 300);
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].anchors[2].point).toEqual({ x: 500, y: 300 });
    await press(page, 'Enter');
    // continue from the FIRST anchor: the path is reversed so new anchors append
    await clickWorld(page, 200, 200);
    await clickWorld(page, 100, 300);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(4);
    expect(n.subpaths[0].anchors[0].point).toEqual({ x: 500, y: 300 });
    expect(n.subpaths[0].anchors[3].point).toEqual({ x: 100, y: 300 });
    // click on a segment of the path being drawn inserts an anchor
    await clickWorld(page, 300, 200);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(5);
    // click on an interior anchor deletes it
    await clickWorld(page, 300, 200);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(4);
    s = await getState(page);
    expect(s.past.map((p: any) => p.label).slice(-2)).toEqual(['Add Anchor', 'Delete Anchor']);
  });

  test('clicking the last anchor retracts its handle; Delete removes the last anchor while drawing', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 200, 200);
    await dragWorld(page, { x: 400, y: 200 }, { x: 500, y: 150 });
    let n = await selectedNode(page);
    expect(n.subpaths[0].anchors[1].handleOut).toEqual({ x: 100, y: -50 });
    // click on the last anchor: outgoing handle retracted so the next segment starts straight
    await clickWorld(page, 400, 200);
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors[1].handleOut).toBeNull();
    expect(n.subpaths[0].anchors[1].handleIn).toEqual({ x: -100, y: 50 });
    await clickWorld(page, 600, 300);
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors.length).toBe(3);
    // Delete removes the last placed anchor, drawing continues
    await press(page, 'Delete');
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors.length).toBe(2);
    await clickWorld(page, 600, 400);
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].anchors[2].point).toEqual({ x: 600, y: 400 });
    // Escape while dragging cancels the anchor being placed but keeps the path
    const box = (await page.locator('[data-testid="viewport"]').boundingBox())!;
    const st = await getState(page);
    const toS = (x: number, y: number) => ({ x: box.x + x * st.zoom + st.pan.x, y: box.y + y * st.zoom + st.pan.y });
    let q = toS(800, 400);
    await page.mouse.move(q.x, q.y);
    await page.mouse.down();
    q = toS(850, 350);
    await page.mouse.move(q.x, q.y, { steps: 4 });
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors.length).toBe(4);
    await press(page, 'Escape');
    await page.mouse.up();
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors.length).toBe(3);
    const s = await getState(page);
    expect(s.selectedAnchors).toEqual([]);
  });

  test('pen joins the drawn path to the end of another open path', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 600, 500);
    await clickWorld(page, 700, 500);
    await press(page, 'Enter');
    const s0 = await getState(page);
    const other = s0.selection[0];
    await clickWorld(page, 900, 700);
    await clickWorld(page, 900, 600);
    // click on the end anchor of the other (unselected) open path: join
    await clickWorld(page, 700, 500);
    const s = await getState(page);
    const paths = Object.values(s.doc.nodes).filter((x: any) => x.type === 'path') as any[];
    expect(paths.length).toBe(1);
    expect(s.doc.nodes[other]).toBeUndefined();
    const sp = paths[0].subpaths[0];
    expect(sp.anchors.length).toBe(4);
    expect(sp.anchors.map((a: any) => [a.point.x, a.point.y])).toEqual([
      [900, 700],
      [900, 600],
      [700, 500],
      [600, 500],
    ]);
    expect(s.past[s.past.length - 1].label).toBe('Join');
  });

  test('Ctrl temporarily acts as direct selection while drawing', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 200, 200);
    await clickWorld(page, 400, 200);
    await clickWorld(page, 400, 400);
    const s = await getState(page);
    const id = s.selection[0];
    await dragWorld(page, { x: 400, y: 200 }, { x: 450, y: 150 }, { modifiers: ['Control'] });
    const n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[1].point).toEqual({ x: 450, y: 150 });
    expect(n.subpaths[0].anchors.length).toBe(3);
    const s2 = await getState(page);
    expect(s2.past[s2.past.length - 1].label).toBe('Move Anchors');
  });

  test('add anchor and delete anchor tools', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'addAnchor');
    await moveWorld(page, 200, 100);
    await expect(page.locator('.overlay-svg .add-anchor-overlay')).toHaveCount(1);
    await clickWorld(page, 200, 100);
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(5);
    expect(n.shape).toBeUndefined();
    let s = await getState(page);
    expect(s.selectedAnchors.length).toBe(1);
    expect(s.past[s.past.length - 1].label).toBe('Add Anchor');
    // clicking away from a path does nothing
    await clickWorld(page, 600, 600);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(5);
    await selectTool(page, 'deleteAnchor');
    await clickWorld(page, 200, 100);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(4);
    s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Delete Anchor');
    // deleting an anchor of an unselected path works too (hit the path first)
    await clickWorld(page, 900, 900);
    await selectTool(page, 'select');
    await clickWorld(page, 900, 900);
    await selectTool(page, 'deleteAnchor');
    await clickWorld(page, 300, 220);
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(3);
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(4);
  });

  test('anchor point tool converts, pulls out handles and breaks pairs', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await dragWorld(page, { x: 300, y: 300 }, { x: 400, y: 250 });
    await clickWorld(page, 600, 300);
    await press(page, 'Enter');
    const s0 = await getState(page);
    const id = s0.selection[0];
    await selectTool(page, 'anchorPoint');
    // click on the smooth anchor: becomes a corner without handles
    await clickWorld(page, 300, 300);
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[0].kind).toBe('corner');
    expect(n.subpaths[0].anchors[0].handleIn).toBeNull();
    expect(n.subpaths[0].anchors[0].handleOut).toBeNull();
    // drag from the corner anchor at (600,300): symmetric handles
    await dragWorld(page, { x: 600, y: 300 }, { x: 650, y: 200 });
    n = await nodeById(page, id);
    const a = n.subpaths[0].anchors[1];
    expect(a.kind).toBe('smooth');
    expect(a.handleOut).toEqual({ x: 50, y: -100 });
    expect(a.handleIn).toEqual({ x: -50, y: 100 });
    // drag the incoming handle end: pair breaks, outgoing stays
    await dragWorld(page, { x: 550, y: 400 }, { x: 500, y: 300 });
    n = await nodeById(page, id);
    const b = n.subpaths[0].anchors[1];
    expect(b.kind).toBe('corner');
    expect(b.handleIn).toEqual({ x: -100, y: 0 });
    expect(b.handleOut).toEqual({ x: 50, y: -100 });
    const s = await getState(page);
    expect(s.past.map((p: any) => p.label).slice(-3)).toEqual(['Convert Anchor', 'Convert Anchor', 'Move Handle']);
    // drag the straight segment between the anchors: it becomes a curve
    await selectTool(page, 'anchorPoint');
    await withStore(page, (st) => st.setSelection([st.selection[0]], []));
    await dragWorld(page, { x: 450, y: 300 }, { x: 450, y: 380 });
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[0].handleOut).not.toBeNull();
  });

  test('curvature tool draws a smooth curve through points, corners on double-click, closes on the first point', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'curvature');
    await clickWorld(page, 200, 400);
    await clickWorld(page, 400, 200);
    await clickWorld(page, 600, 400);
    let n = await selectedNode(page);
    let sp = n.subpaths[0];
    expect(sp.anchors.length).toBe(3);
    // middle point is smooth with a horizontal tangent (neighbours are symmetric)
    const mid = sp.anchors[1];
    expect(mid.kind).toBe('smooth');
    expect(Math.abs(mid.handleOut.y)).toBeLessThan(1e-6);
    expect(mid.handleOut.x).toBeGreaterThan(0);
    expect(mid.handleIn.x).toBeLessThan(0);
    // end points have handles too (arc-like ends)
    expect(sp.anchors[0].handleOut).not.toBeNull();
    expect(sp.anchors[2].handleIn).not.toBeNull();
    // double-click the middle point: corner (no handles)
    await clickWorld(page, 400, 200, { clickCount: 2 });
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors[1].kind).toBe('corner');
    expect(n.subpaths[0].anchors[1].handleOut).toBeNull();
    // add another point and close on the first
    await clickWorld(page, 400, 600);
    await clickWorld(page, 200, 400);
    n = await selectedNode(page);
    sp = n.subpaths[0];
    expect(sp.closed).toBe(true);
    expect(sp.anchors.length).toBe(4);
    const s = await getState(page);
    expect(s.past[s.past.length - 1].label).toBe('Close Path');
    expect(s.selectedAnchors).toEqual([]);
    // drag an existing point of the (still selected) path reshapes it
    await dragWorld(page, { x: 400, y: 600 }, { x: 400, y: 700 });
    n = await selectedNode(page);
    expect(n.subpaths[0].anchors[3].point).toEqual({ x: 400, y: 700 });
  });

  test('pen works at 4x zoom and inside a transformed group', async ({ page }) => {
    await openApp(page);
    await setView(page, 4, { x: -300, y: -300 });
    await selectTool(page, 'pen');
    await clickWorld(page, 120, 120);
    await clickWorld(page, 160, 120);
    await clickWorld(page, 140, 150);
    await clickWorld(page, 120, 120);
    let n = await selectedNode(page);
    expect(n.subpaths[0].closed).toBe(true);
    expect(n.subpaths[0].anchors[1].point.x).toBeCloseTo(160, 4);
    await setView(page, 1, { x: 100, y: 100 });
    // continue an open path that lives inside a rotated group
    await selectTool(page, 'select');
    await clickWorld(page, 900, 900);
    const { pathId } = await withStore(page, (st) => {
      const api = (window as any).__opuller.api;
      const node = api.nodes.makePath([{ anchors: [api.path.anchor({ x: 0, y: 0 }), api.path.anchor({ x: 100, y: 0 })], closed: false }], { stroke: st.appearance.stroke, fill: { type: 'none' } });
      const group = api.nodes.makeGroup([], { transform: { a: 0, b: 1, c: -1, d: 0, e: 500, f: 500 } });
      st.updateDoc((d: any) => {
        api.document.addNode(d, group, d.layers[0]);
        api.document.addNode(d, node, group.id);
      }, 'Setup');
      return { pathId: node.id, groupId: group.id };
    });
    // world position of the second anchor: (500 - 0, 500 + 100) = (500, 600)
    await selectTool(page, 'pen');
    await clickWorld(page, 500, 600);
    await clickWorld(page, 600, 600);
    n = await nodeById(page, pathId);
    expect(n.subpaths[0].anchors.length).toBe(3);
    // local coords of world (600,600) under rotate90+translate(500,500): local = (100, -100)
    expect(n.subpaths[0].anchors[2].point.x).toBeCloseTo(100, 4);
    expect(n.subpaths[0].anchors[2].point.y).toBeCloseTo(-100, 4);
  });
});
