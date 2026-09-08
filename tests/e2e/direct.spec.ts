import { test, expect } from '@playwright/test';
import { openApp, selectTool, clickWorld, dragWorld, moveWorld, getState, nodeById, press, drawRect, withStore, setView, worldBounds, runCommand } from './helpers';

/** Draw a two-anchor smooth curve with the pen and return its id. */
async function drawCurve(page: any): Promise<string> {
  await selectTool(page, 'pen');
  await dragWorld(page, { x: 600, y: 200 }, { x: 700, y: 150 });
  await dragWorld(page, { x: 800, y: 300 }, { x: 900, y: 300 });
  await press(page, 'Enter');
  const s = await getState(page);
  return s.selection[0];
}

async function lastLabel(page: any): Promise<string> {
  const s = await getState(page);
  return s.past[s.past.length - 1]?.label;
}

test.describe('direct selection tool', () => {
  test('selects and moves an anchor of a live rectangle (shape is cleared), undo restores', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'direct');
    // click directly on the top-left anchor of the (already selected) rect
    await clickWorld(page, 100, 100);
    let s = await getState(page);
    expect(s.selectedAnchors).toEqual([{ nodeId: id, subpath: 0, index: 0 }]);
    await dragWorld(page, { x: 100, y: 100 }, { x: 60, y: 80 });
    let n = await nodeById(page, id);
    expect(n.shape).toBeUndefined();
    let b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(60);
    expect(Math.round(b!.y)).toBe(80);
    expect(Math.round(b!.width)).toBe(240);
    expect(await lastLabel(page)).toBe('Move Anchors');
    s = await getState(page);
    expect(s.past.filter((p: any) => p.label === 'Move Anchors').length).toBe(1);
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.shape.kind).toBe('rect');
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(100);
    // Escape clears the anchor selection first, then the object selection
    await clickWorld(page, 100, 100);
    await press(page, 'Escape');
    s = await getState(page);
    expect(s.selectedAnchors).toEqual([]);
    expect(s.selection).toEqual([id]);
    await press(page, 'Escape');
    s = await getState(page);
    expect(s.selection).toEqual([]);
  });

  test('clicking an anchor of an unselected path, shift-click adds, marquee selects anchors, Delete removes them', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    await clickWorld(page, 900, 900);
    await selectTool(page, 'direct');
    await clickWorld(page, 300, 100);
    let s = await getState(page);
    expect(s.selection).toEqual([id]);
    expect(s.selectedAnchors).toEqual([{ nodeId: id, subpath: 0, index: 1 }]);
    await clickWorld(page, 300, 220, { modifiers: ['Shift'] });
    s = await getState(page);
    expect(s.selectedAnchors.length).toBe(2);
    // shift-click a selected anchor removes it
    await clickWorld(page, 300, 220, { modifiers: ['Shift'] });
    s = await getState(page);
    expect(s.selectedAnchors.length).toBe(1);
    // marquee around the left edge anchors
    await dragWorld(page, { x: 60, y: 60 }, { x: 140, y: 260 });
    s = await getState(page);
    expect(s.selectedAnchors.map((a: any) => a.index).sort()).toEqual([0, 3]);
    // shift-marquee adds
    await dragWorld(page, { x: 260, y: 60 }, { x: 340, y: 140 }, { modifiers: ['Shift'] });
    s = await getState(page);
    expect(s.selectedAnchors.length).toBe(3);
    // delete one anchor -> triangle
    await clickWorld(page, 100, 100);
    await press(page, 'Delete');
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(3);
    expect(n.subpaths[0].closed).toBe(true);
    expect(await lastLabel(page)).toBe('Delete Anchor');
    s = await getState(page);
    expect(s.selectedAnchors).toEqual([]);
    expect(s.selection).toEqual([id]);
    // select all anchors and delete: the path disappears
    await runCommand(page, 'path.selectAllAnchors');
    s = await getState(page);
    expect(s.selectedAnchors.length).toBe(3);
    await press(page, 'Backspace');
    s = await getState(page);
    expect(s.doc.nodes[id]).toBeUndefined();
    expect(s.selection).toEqual([]);
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(3);
  });

  test('deleting an interior anchor of an open path splits it', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'pen');
    await clickWorld(page, 200, 200);
    await clickWorld(page, 300, 200);
    await clickWorld(page, 400, 200);
    await clickWorld(page, 500, 200);
    await clickWorld(page, 600, 200);
    await press(page, 'Enter');
    const s0 = await getState(page);
    const id = s0.selection[0];
    await selectTool(page, 'direct');
    await clickWorld(page, 400, 200);
    await press(page, 'Delete');
    let n = await nodeById(page, id);
    expect(n.subpaths.length).toBe(2);
    expect(n.subpaths[0].anchors.map((a: any) => a.point.x)).toEqual([200, 300]);
    expect(n.subpaths[1].anchors.map((a: any) => a.point.x)).toEqual([500, 600]);
    expect(n.subpaths[0].closed).toBe(false);
    // deleting an end anchor just shortens the piece; a lone anchor is dropped
    await clickWorld(page, 200, 200);
    await press(page, 'Delete');
    n = await nodeById(page, id);
    expect(n.subpaths.length).toBe(1);
    expect(n.subpaths[0].anchors.map((a: any) => a.point.x)).toEqual([500, 600]);
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.subpaths.length).toBe(2);
  });

  test('dragging a handle keeps the opposite handle collinear; Alt breaks the pair; Shift constrains', async ({ page }) => {
    await openApp(page);
    const id = await drawCurve(page);
    await selectTool(page, 'direct');
    await clickWorld(page, 600, 200);
    // out handle end is at (700,150); drag it to (700, 250)
    await dragWorld(page, { x: 700, y: 150 }, { x: 700, y: 250 });
    let n = await nodeById(page, id);
    let a = n.subpaths[0].anchors[0];
    expect(a.kind).toBe('smooth');
    expect(a.handleOut).toEqual({ x: 100, y: 50 });
    // opposite handle: same length (111.8), opposite direction
    const len = Math.hypot(a.handleIn.x, a.handleIn.y);
    expect(len).toBeCloseTo(Math.hypot(100, 50), 5);
    expect(a.handleIn.x / len).toBeCloseTo(-100 / Math.hypot(100, 50), 5);
    expect(a.handleIn.y / len).toBeCloseTo(-50 / Math.hypot(100, 50), 5);
    expect(await lastLabel(page)).toBe('Move Handle');
    // Alt-drag the out handle: only it moves, anchor becomes a corner
    const hin = { ...a.handleIn };
    await dragWorld(page, { x: 700, y: 250 }, { x: 750, y: 250 }, { modifiers: ['Alt'] });
    n = await nodeById(page, id);
    a = n.subpaths[0].anchors[0];
    expect(a.kind).toBe('corner');
    expect(a.handleOut).toEqual({ x: 150, y: 50 });
    expect(a.handleIn).toEqual(hin);
    // Shift-drag constrains the handle to 45deg
    await dragWorld(page, { x: 750, y: 250 }, { x: 700, y: 140 }, { modifiers: ['Shift'] });
    n = await nodeById(page, id);
    a = n.subpaths[0].anchors[0];
    const ang = (Math.atan2(a.handleOut.y, a.handleOut.x) * 180) / Math.PI;
    const rem = Math.abs(ang % 45);
    expect(Math.min(rem, 45 - rem)).toBeLessThan(1e-6);
    // undo three handle edits
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[0].handleOut).toEqual({ x: 100, y: -50 });
  });

  test('dragging a straight segment moves it, dragging a curved segment reshapes it', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'direct');
    // top edge midpoint
    await dragWorld(page, { x: 200, y: 100 }, { x: 200, y: 60 });
    let n = await nodeById(page, id);
    let b = await worldBounds(page, id);
    expect(Math.round(b!.y)).toBe(60);
    expect(Math.round(b!.height)).toBe(160);
    expect(n.subpaths[0].anchors[0].handleOut).toBeNull();
    expect(await lastLabel(page)).toBe('Move Segment');
    // curved segment: pen curve
    const cid = await drawCurve(page);
    await selectTool(page, 'direct');
    await withStore(page, (st) => st.clearSelection());
    // point on the curve at t=0.5: B(0.5) of (600,200) (700,150) (700,300) (800,300) = (700, 231.25)
    await clickWorld(page, 700, 231.25);
    let s = await getState(page);
    expect(s.selection).toEqual([cid]);
    expect(s.selectedAnchors).toEqual([]);
    await dragWorld(page, { x: 700, y: 231.25 }, { x: 700, y: 300 });
    n = await nodeById(page, cid);
    const a0 = n.subpaths[0].anchors[0];
    const a1 = n.subpaths[0].anchors[1];
    // anchors did not move, handles did, smooth anchors stay smooth
    expect(a0.point).toEqual({ x: 600, y: 200 });
    expect(a1.point).toEqual({ x: 800, y: 300 });
    expect(a0.handleOut).not.toEqual({ x: 100, y: -50 });
    expect(a0.kind).toBe('smooth');
    const dot = a0.handleIn.x * a0.handleOut.x + a0.handleIn.y * a0.handleOut.y;
    const cross = a0.handleIn.x * a0.handleOut.y - a0.handleIn.y * a0.handleOut.x;
    expect(dot).toBeLessThan(0);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    // the dragged point now lies on the curve near the target
    const p = await withStore(page, (st) => {
      const api = (window as any).__opuller.api;
      const node = st.doc.nodes[st.selection[0]];
      return api.path.nearestPointOnPath(node.subpaths, { x: 700, y: 300 }).distance;
    });
    expect(p).toBeLessThan(1);
    expect(await lastLabel(page)).toBe('Reshape Segment');
  });

  test('edits anchors of a path inside a rotated group in place, also at 0.25x zoom', async ({ page }) => {
    await openApp(page);
    const { pathId, groupId } = await withStore(page, (st) => {
      const api = (window as any).__opuller.api;
      const node = api.nodes.makeShape({ kind: 'rect', width: 100, height: 60, radii: [0, 0, 0, 0] }, { stroke: st.appearance.stroke, fill: { type: 'solid', color: '#ff0000', opacity: 1 } });
      // rotate 90deg + translate: local (x,y) -> world (500 - y, 500 + x)
      const group = api.nodes.makeGroup([], { transform: { a: 0, b: 1, c: -1, d: 0, e: 500, f: 500 } });
      st.updateDoc((d: any) => {
        api.document.addNode(d, group, d.layers[0]);
        api.document.addNode(d, node, group.id);
      }, 'Setup');
      return { pathId: node.id, groupId: group.id };
    });
    await selectTool(page, 'direct');
    // local anchor (100,0) is at world (500, 600); click it (path is unselected -> selects the leaf)
    await clickWorld(page, 500, 600);
    let s = await getState(page);
    expect(s.selection).toEqual([pathId]);
    expect(s.selectedAnchors).toEqual([{ nodeId: pathId, subpath: 0, index: 1 }]);
    await dragWorld(page, { x: 500, y: 600 }, { x: 480, y: 650 });
    let n = await nodeById(page, pathId);
    expect(n.shape).toBeUndefined();
    // world delta (-20, +50) => local delta (dx_local, dy_local): world = (500 - y, 500 + x) => x = wy - 500, y = 500 - wx
    expect(n.subpaths[0].anchors[1].point.x).toBeCloseTo(150, 4);
    expect(n.subpaths[0].anchors[1].point.y).toBeCloseTo(20, 4);
    const g = await nodeById(page, groupId);
    expect(g.transform).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 500, f: 500 });
    // nudge with arrow keys (world units)
    await press(page, 'ArrowRight');
    await press(page, 'Shift+ArrowDown');
    await page.waitForTimeout(500);
    n = await nodeById(page, pathId);
    expect(n.subpaths[0].anchors[1].point.x).toBeCloseTo(160, 4);
    expect(n.subpaths[0].anchors[1].point.y).toBeCloseTo(19, 4);
    // zoomed out editing: 0.25x
    await setView(page, 0.25, { x: 50, y: 50 });
    // anchor world position now: local (160,19) -> world (481, 660)
    await dragWorld(page, { x: 481, y: 660 }, { x: 401, y: 660 });
    n = await nodeById(page, pathId);
    expect(n.subpaths[0].anchors[1].point.y).toBeCloseTo(99, 3);
    expect(await lastLabel(page)).toBe('Move Anchors');
  });

  test('double-click on a segment adds an anchor, Alt-click toggles smooth/corner, control bar buttons convert', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'direct');
    await clickWorld(page, 200, 220, { clickCount: 2 });
    let n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(5);
    expect(await lastLabel(page)).toBe('Add Anchor');
    let s = await getState(page);
    expect(s.selectedAnchors.length).toBe(1);
    const newIdx = s.selectedAnchors[0].index;
    // Alt-click: corner -> smooth (handles appear)
    await clickWorld(page, 200, 220, { modifiers: ['Alt'] });
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[newIdx].kind).toBe('smooth');
    expect(n.subpaths[0].anchors[newIdx].handleOut).not.toBeNull();
    expect(await lastLabel(page)).toBe('Convert Anchor');
    await clickWorld(page, 200, 220, { modifiers: ['Alt'] });
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[newIdx].kind).toBe('corner');
    expect(n.subpaths[0].anchors[newIdx].handleOut).toBeNull();
    // control bar: convert to smooth
    await clickWorld(page, 200, 220);
    await page.getByTestId('direct-smooth').click();
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors[newIdx].kind).toBe('smooth');
    await page.getByTestId('direct-remove').click();
    n = await nodeById(page, id);
    expect(n.subpaths[0].anchors.length).toBe(4);
  });

  test('clicking inside a filled object selects all of its anchors and dragging moves the object', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'direct');
    await withStore(page, (st) => st.clearSelection());
    await clickWorld(page, 200, 160);
    let s = await getState(page);
    expect(s.selection).toEqual([id]);
    expect(s.selectedAnchors.length).toBe(4);
    await dragWorld(page, { x: 200, y: 160 }, { x: 250, y: 200 });
    const b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(150);
    expect(Math.round(b!.y)).toBe(140);
    const n = await nodeById(page, id);
    // whole-object move keeps the live shape
    expect(n.shape.kind).toBe('rect');
    expect(await lastLabel(page)).toBe('Move');
    // hover feedback over an anchor renders a highlight in the tool overlay
    await moveWorld(page, 150, 140);
    await expect(page.locator('.overlay-svg .direct-overlay rect')).toHaveCount(1);
  });

  test('lasso selects anchors of selected paths (shift adds, alt subtracts) and objects otherwise', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawRect(page, 400, 100, 100, 100);
    await selectTool(page, 'lasso');
    await withStore(page, (st) => st.clearSelection());
    // lasso around the first rect only (object mode)
    await dragWorld(page, { x: 80, y: 80 }, { x: 230, y: 80 }, { steps: 3 });
    // freehand polygon: draw a loop through several points with the mouse
    const box = await page.locator('[data-testid="viewport"]').boundingBox();
    const toScreen = async (x: number, y: number) => {
      const s = await getState(page);
      return { x: box!.x + x * s.zoom + s.pan.x, y: box!.y + y * s.zoom + s.pan.y };
    };
    const loop = async (pts: Array<[number, number]>, modifiers: string[] = []) => {
      for (const m of modifiers) await page.keyboard.down(m);
      const p0 = await toScreen(pts[0][0], pts[0][1]);
      await page.mouse.move(p0.x, p0.y);
      await page.mouse.down();
      for (const [x, y] of pts.slice(1)) {
        const p = await toScreen(x, y);
        await page.mouse.move(p.x, p.y, { steps: 3 });
      }
      await page.mouse.up();
      for (const m of modifiers) await page.keyboard.up(m);
    };
    await loop([
      [80, 80],
      [230, 80],
      [230, 230],
      [80, 230],
      [80, 90],
    ]);
    let s = await getState(page);
    expect(s.selection).toEqual([a]);
    expect(s.selectedAnchors).toEqual([]);
    // shift-lasso adds the second object
    await loop(
      [
        [380, 80],
        [530, 80],
        [530, 230],
        [380, 230],
        [380, 90],
      ],
      ['Shift'],
    );
    s = await getState(page);
    expect(s.selection.sort()).toEqual([a, b].sort());
    // with paths selected: lasso selects anchors inside (top-left anchors of both rects)
    await loop([
      [80, 80],
      [130, 80],
      [130, 130],
      [80, 130],
      [80, 90],
    ]);
    s = await getState(page);
    expect(s.selectedAnchors).toEqual([{ nodeId: a, subpath: 0, index: 0 }]);
    await loop(
      [
        [380, 80],
        [430, 80],
        [430, 130],
        [380, 130],
        [380, 90],
      ],
      ['Shift'],
    );
    s = await getState(page);
    expect(s.selectedAnchors.length).toBe(2);
    await loop(
      [
        [80, 80],
        [130, 80],
        [130, 130],
        [80, 130],
        [80, 90],
      ],
      ['Alt'],
    );
    s = await getState(page);
    expect(s.selectedAnchors).toEqual([{ nodeId: b, subpath: 0, index: 0 }]);
    // Delete removes the lassoed anchor
    await press(page, 'Delete');
    const n = await nodeById(page, b);
    expect(n.subpaths[0].anchors.length).toBe(3);
  });

  test('anchor drags snap to other anchors, Escape cancels a drag, segment hover is highlighted', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    await drawRect(page, 300, 100, 100, 100);
    await selectTool(page, 'direct');
    await withStore(page, (st) => st.clearSelection());
    // drag A's top-right anchor (200,100) close to B's top-left anchor (300,100): snaps exactly
    await dragWorld(page, { x: 200, y: 100 }, { x: 296, y: 103 });
    let n = await nodeById(page, a);
    const p = n.subpaths[0].anchors[1].point;
    const wm = await withStore(page, (st) => (window as any).__opuller.worldMatrix(st.doc, st.selection[0]));
    expect(p.x + wm.e).toBeCloseTo(300, 6);
    expect(p.y + wm.f).toBeCloseTo(100, 6);
    // Ctrl disables snapping
    await dragWorld(page, { x: 300, y: 100 }, { x: 296, y: 103 }, { modifiers: ['Control'] });
    n = await nodeById(page, a);
    expect(n.subpaths[0].anchors[1].point.x + wm.e).toBeCloseTo(296, 6);
    // Escape during a drag reverts the document
    const box = (await page.locator('[data-testid="viewport"]').boundingBox())!;
    const st = await getState(page);
    const toS = (x: number, y: number) => ({ x: box.x + x * st.zoom + st.pan.x, y: box.y + y * st.zoom + st.pan.y });
    let q = toS(296, 103);
    await page.mouse.move(q.x, q.y);
    await page.mouse.down();
    q = toS(250, 150);
    await page.mouse.move(q.x, q.y, { steps: 4 });
    let mid = await nodeById(page, a);
    expect(mid.subpaths[0].anchors[1].point.x + wm.e).toBeCloseTo(250, 6);
    await press(page, 'Escape');
    await page.mouse.up();
    n = await nodeById(page, a);
    expect(n.subpaths[0].anchors[1].point.x + wm.e).toBeCloseTo(296, 6);
    const labels = (await getState(page)).past.map((x: any) => x.label);
    expect(labels.filter((l: string) => l === 'Move Anchors').length).toBe(2);
    // hovering a segment draws a highlight in the tool overlay
    await moveWorld(page, 150, 200);
    await expect(page.locator('.overlay-svg .direct-overlay path')).toHaveCount(1);
    await moveWorld(page, 600, 600);
    await expect(page.locator('.overlay-svg .direct-overlay')).toHaveCount(0);
  });

  test('locked and hidden paths are not editable', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 100, 100);
    await withStore(page, (st) => {
      st.updateDoc((d: any) => {
        d.nodes[st.selection[0]].locked = true;
      }, 'Lock');
      st.clearSelection();
    });
    await selectTool(page, 'direct');
    await clickWorld(page, 100, 100);
    let s = await getState(page);
    expect(s.selection).toEqual([]);
    await dragWorld(page, { x: 60, y: 60 }, { x: 140, y: 140 });
    s = await getState(page);
    expect(s.selectedAnchors).toEqual([]);
    const n = await nodeById(page, id);
    expect(n.shape.kind).toBe('rect');
  });

  test('selection tool double-click on a path switches to direct selection with anchors shown', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    await clickWorld(page, 200, 160, { clickCount: 2 });
    const s = await getState(page);
    expect(s.activeTool).toBe('direct');
    expect(s.selection).toEqual([id]);
    await expect(page.locator('.overlay-svg .anchors rect')).toHaveCount(4);
  });
});
