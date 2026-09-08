import { test, expect, type Page } from '@playwright/test';
import { openApp, drawRect, selectTool, dragWorld, clickWorld, getState, withStore, runCommand, nodeById, worldBounds, press, setView, viewport, worldToScreen, selection } from './helpers';

async function showTransformPanel(page: Page): Promise<void> {
  const tab = page.getByTestId('panel-tab-transform');
  if (await tab.count()) await tab.click();
}

/** Type into a NumberField and commit it. Dialog fields commit on blur (Tab) because Enter applies the dialog. */
async function setField(page: Page, testId: string, value: string, commitKey: 'Enter' | 'Tab' = 'Tab') {
  const input = page.getByTestId(testId);
  await input.click();
  await input.fill(value);
  await input.press(commitKey);
}

/** Leave the focused input so that global shortcuts (Ctrl+Z) reach the editor. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

async function pastLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__opuller.store.getState().past.map((p: any) => p.label));
}

async function undoCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__opuller.store.getState().past.length);
}

/** Drag in world coordinates with a callback between move and release. */
async function dragWorldWith(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, between: () => Promise<void>, modifiers: string[] = []) {
  const box = await viewport(page).boundingBox();
  const a = await worldToScreen(page, from.x, from.y);
  const b = await worldToScreen(page, to.x, to.y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(box!.x + a.x, box!.y + a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box!.x + a.x + ((b.x - a.x) * i) / 8, box!.y + a.y + ((b.y - a.y) * i) / 8);
  await between();
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
}

test.describe('transform module', () => {
  test('rotate dialog rotates a rectangle by 90° (bounds swap) and undo restores it', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    const before = await undoCount(page);
    await runCommand(page, 'object.rotateDialog');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await setField(page, 'rotate-angle', '90');
    // preview is live (uncommitted)
    let b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(120);
    expect(Math.round(b!.height)).toBe(200);
    await page.getByTestId('transform-ok').click();
    await expect(page.getByTestId('dialog')).toBeHidden();
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(120);
    expect(Math.round(b!.height)).toBe(200);
    expect(Math.round(b!.x + b!.width / 2)).toBe(200);
    expect(Math.round(b!.y + b!.height / 2)).toBe(160);
    expect(await undoCount(page)).toBe(before + 1);
    // live shape survives a rotation
    const n = await nodeById(page, id);
    expect(n.shape.kind).toBe('rect');
    await press(page, 'Control+z');
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(200);
    expect(Math.round(b!.height)).toBe(120);
  });

  test('dialog Cancel reverts the preview, Copy keeps the original', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    await runCommand(page, 'object.moveDialog');
    await setField(page, 'move-dx', '50');
    expect(Math.round((await worldBounds(page, id))!.x)).toBe(150);
    await page.getByTestId('transform-cancel').click();
    expect(Math.round((await worldBounds(page, id))!.x)).toBe(100);
    // copy
    await runCommand(page, 'object.moveDialog');
    await setField(page, 'move-dx', '50');
    await page.getByTestId('transform-copy').click();
    const sel = await selection(page);
    expect(sel).toHaveLength(1);
    expect(sel[0]).not.toBe(id);
    expect(Math.round((await worldBounds(page, id))!.x)).toBe(100);
    expect(Math.round((await worldBounds(page, sel[0]))!.x)).toBe(150);
    const labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Move Copy');
    // Transform Again repeats the copy → a third rectangle at x=200
    await runCommand(page, 'object.transformAgain');
    const sel2 = await selection(page);
    expect(sel2[0]).not.toBe(sel[0]);
    expect(Math.round((await worldBounds(page, sel2[0]))!.x)).toBe(200);
  });

  test('Transform panel X/Y/W/H move and resize the selection relative to the artboard', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    // reference point = center by default → X shows 200
    await expect(page.getByTestId('tp-x')).toHaveValue('200');
    await expect(page.getByTestId('tp-y')).toHaveValue('160');
    await setField(page, 'tp-x', '300', 'Enter');
    let b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(200);
    expect(Math.round(b!.y)).toBe(100);
    // switch the reference point to top-left and set Y with an expression in another unit
    await page.getByTestId('ref-nw').click();
    await expect(page.getByTestId('tp-x')).toHaveValue('200');
    await setField(page, 'tp-y', '1in', 'Enter');
    b = await worldBounds(page, id);
    expect(Math.round(b!.y)).toBe(96);
    // width with the lock: proportional
    await page.getByTestId('tp-lock').click();
    await setField(page, 'tp-w', '400', 'Enter');
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(400);
    expect(Math.round(b!.height)).toBe(240);
    expect(Math.round(b!.x)).toBe(200); // nw reference point stays
    const n = await nodeById(page, id);
    expect(n.shape.kind).toBe('rect');
    // three history steps: move, move, scale
    const labels = await pastLabels(page);
    expect(labels.slice(-3)).toEqual(['Move', 'Move', 'Scale']);
    await blur(page);
    await press(page, 'Control+z');
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(200);
  });

  test('Transform panel rotation field and flip / rotate buttons', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    await setField(page, 'tp-rotate', '90', 'Enter');
    let b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(120);
    expect(Math.round(b!.height)).toBe(200);
    await expect(page.getByTestId('tp-rotate')).toHaveValue('90');
    await page.getByTestId('tp-rot-cw').click();
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(200);
    await expect(page.getByTestId('tp-rotate')).toHaveValue('0');
    // flip horizontal keeps the bounds of a symmetric rect
    await page.getByTestId('tp-flip-h').click();
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(100);
    expect(Math.round(b!.width)).toBe(200);
    const labels = await pastLabels(page);
    expect(labels.slice(-3)).toEqual(['Rotate', 'Rotate 90° CW', 'Flip Horizontal']);
  });

  test('Align to artboard centers the object; align/distribute selection', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const a = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    await page.getByTestId('panel-tab-align').click();
    // align buttons disabled for a single object in selection mode
    await expect(page.getByTestId('align-hcenter')).toBeDisabled();
    await page.locator('[data-testid="align-panel"] select').nth(1).selectOption('artboard');
    await expect(page.getByTestId('align-hcenter')).toBeEnabled();
    await page.getByTestId('align-hcenter').click();
    await page.getByTestId('align-vcenter').click();
    let b = await worldBounds(page, a);
    expect(Math.round(b!.x + b!.width / 2)).toBe(960);
    expect(Math.round(b!.y + b!.height / 2)).toBe(540);
    // three objects: align left edges & distribute centers
    const b2 = await drawRect(page, 400, 300, 50, 50);
    const c = await drawRect(page, 700, 500, 80, 30);
    await withStore(page, (s) => s.setSelection([]));
    await page.evaluate(([x, y, z]) => (window as any).__opuller.store.getState().setSelection([x, y, z]), [a, b2, c]);
    await page.locator('[data-testid="align-panel"] select').nth(1).selectOption('selection');
    await page.getByTestId('align-left').click();
    const xs = [await worldBounds(page, a), await worldBounds(page, b2), await worldBounds(page, c)].map((r) => Math.round(r!.x));
    expect(xs).toEqual([400, 400, 400]);
    await page.getByTestId('distribute-vcenter').click();
    const ys = [await worldBounds(page, a), await worldBounds(page, b2), await worldBounds(page, c)].map((r) => r!.y + r!.height / 2).sort((p, q) => p - q);
    expect(Math.round(ys[1] - ys[0])).toBe(Math.round(ys[2] - ys[1]));
    // distribute spacing (auto)
    await page.getByTestId('space-h').click();
    const labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Distribute horizontal spacing');
    await press(page, 'Control+z');
  });

  test('align to key object: clicking a selected object sets the key (outlined) and others align to it', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawRect(page, 400, 300, 60, 60);
    await selectTool(page, 'select');
    await page.evaluate(([x, y]) => (window as any).__opuller.store.getState().setSelection([x, y]), [a, b]);
    await page.getByTestId('panel-tab-align').click();
    await page.locator('[data-testid="align-panel"] select').nth(1).selectOption('key');
    await clickWorld(page, 430, 330); // pick b
    await expect(page.locator('.align-key-object')).toHaveAttribute('data-key-object', b);
    await page.getByTestId('align-top').click();
    expect(Math.round((await worldBounds(page, a))!.y)).toBe(300);
    expect(Math.round((await worldBounds(page, b))!.y)).toBe(300);
  });

  test('Transform Again repeats a move (Ctrl+D) on another object', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const a = await drawRect(page, 100, 100, 100, 100);
    const b = await drawRect(page, 400, 100, 100, 100);
    await selectTool(page, 'select');
    await withStore(page, (s) => s.setSelection([]));
    await page.evaluate((id) => (window as any).__opuller.store.getState().setSelection([id]), a);
    await runCommand(page, 'object.moveDialog');
    await setField(page, 'move-dx', '30');
    await setField(page, 'move-dy', '-10');
    await page.getByTestId('transform-ok').click();
    expect(Math.round((await worldBounds(page, a))!.x)).toBe(130);
    await clickWorld(page, 150, 150); // focus the canvas (click on the selected object)
    await press(page, 'Control+d');
    expect(Math.round((await worldBounds(page, a))!.x)).toBe(160);
    expect(Math.round((await worldBounds(page, a))!.y)).toBe(80);
    await page.evaluate((id) => (window as any).__opuller.store.getState().setSelection([id]), b);
    await press(page, 'Control+d');
    expect(Math.round((await worldBounds(page, b))!.x)).toBe(430);
    const labels = await pastLabels(page);
    expect(labels.slice(-2)).toEqual(['Transform Again', 'Transform Again']);
    // a Transform panel edit is also remembered: X 450 → +20, then Ctrl+D moves by another 20
    await setField(page, 'tp-x', '500', 'Enter'); // center of b: 480 → 500
    await blur(page);
    expect(Math.round((await worldBounds(page, b))!.x)).toBe(450);
    await press(page, 'Control+d');
    expect(Math.round((await worldBounds(page, b))!.x)).toBe(470);
    expect(Math.round((await worldBounds(page, b))!.y)).toBe(90); // unchanged by the horizontal-only panel edit
  });

  test('rotate tool: drag rotates with Shift constraint, Alt-drag copies, Escape cancels', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'rotate');
    // click sets the reference point
    await clickWorld(page, 100, 100);
    await expect(page.getByTestId('pivot-info')).toContainText('100 px, 100 px');
    // drag around the pivot by ~90 deg clockwise with Shift (snaps to 45 deg steps)
    await dragWorld(page, { x: 300, y: 100 }, { x: 105, y: 300 }, { modifiers: ['Shift'], steps: 12 });
    let b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(-20);
    expect(Math.round(b!.y)).toBe(100);
    expect(Math.round(b!.width)).toBe(120);
    expect(Math.round(b!.height)).toBe(200);
    let labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Rotate');
    await press(page, 'Control+z');
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(100);
    // Escape during a drag cancels
    await dragWorldWith(page, { x: 300, y: 100 }, { x: 300, y: 250 }, async () => {
      const mid = await worldBounds(page, id);
      expect(Math.round(mid!.width)).not.toBe(200);
      await press(page, 'Escape');
    });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(200);
    expect(Math.round(b!.x)).toBe(100);
    labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Create Rectangle');
    // Alt-drag rotates a copy
    const count = await page.evaluate(() => Object.keys((window as any).__opuller.store.getState().doc.nodes).length);
    await dragWorld(page, { x: 300, y: 100 }, { x: 100, y: 300 }, { modifiers: ['Alt'], steps: 12 });
    const count2 = await page.evaluate(() => Object.keys((window as any).__opuller.store.getState().doc.nodes).length);
    expect(count2).toBe(count + 1);
    const sel = await selection(page);
    expect(sel[0]).not.toBe(id);
    expect(Math.round((await worldBounds(page, id))!.x)).toBe(100); // original untouched
    expect(Math.round((await worldBounds(page, sel[0]))!.width)).toBe(120);
    labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Rotate Copy');
    // Transform Again repeats the rotated copy around the same point
    await press(page, 'Control+d');
    const sel2 = await selection(page);
    expect(sel2[0]).not.toBe(sel[0]);
    const bb = await worldBounds(page, sel2[0]);
    expect(Math.round(bb!.width)).toBe(200);
    expect(Math.round(bb!.x)).toBe(-100);
    // undo the transform again + the copy → back to one object
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    const count3 = await page.evaluate(() => Object.keys((window as any).__opuller.store.getState().doc.nodes).length);
    expect(count3).toBe(count);
  });

  test('scale, reflect and shear tools', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 100);
    // scale tool: uniform with Shift from the center pivot (200,150)
    await selectTool(page, 'scale');
    await dragWorld(page, { x: 300, y: 200 }, { x: 400, y: 250 }, { modifiers: ['Shift'] });
    let b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(400);
    expect(Math.round(b!.height)).toBe(200);
    expect(Math.round(b!.x + b!.width / 2)).toBe(200);
    expect(Math.round(b!.y + b!.height / 2)).toBe(150);
    expect((await nodeById(page, id)).shape.kind).toBe('rect');
    await press(page, 'Control+z');
    // reflect tool: click sets the axis origin at the left edge, second click defines a vertical axis
    await selectTool(page, 'reflect');
    await clickWorld(page, 100, 300);
    await clickWorld(page, 100, 400);
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(-100);
    expect(Math.round(b!.width)).toBe(200);
    expect(Math.round(b!.y)).toBe(100);
    let labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Reflect');
    await press(page, 'Control+z');
    // reflect by dragging a horizontal axis through y=200 with Alt: copy below the original
    await clickWorld(page, 50, 200);
    await dragWorld(page, { x: 400, y: 200 }, { x: 600, y: 200 }, { modifiers: ['Alt'] });
    const sel = await selection(page);
    expect(sel[0]).not.toBe(id);
    expect(Math.round((await worldBounds(page, sel[0]))!.y)).toBe(200);
    expect(Math.round((await worldBounds(page, id))!.y)).toBe(100);
    await press(page, 'Control+z');
    // shear tool: horizontal shear around the center
    await selectTool(page, 'shear');
    await dragWorld(page, { x: 200, y: 100 }, { x: 250, y: 100 }, { modifiers: ['Shift'] });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(300);
    expect(Math.round(b!.height)).toBe(100);
    const n = await nodeById(page, id);
    expect(n.shape).toBeUndefined();
    labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Shear');
    await press(page, 'Control+z');
    expect(Math.round((await worldBounds(page, id))!.width)).toBe(200);
  });

  test('free transform: corner drag scales, Shift uniform, outside-corner rotate, Ctrl-drag edge shears, Escape cancels', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'freetransform');
    // SE corner → scale
    await dragWorld(page, { x: 300, y: 220 }, { x: 400, y: 280 });
    let b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(300);
    expect(Math.round(b!.height)).toBe(180);
    expect(Math.round(b!.x)).toBe(100);
    // Alt: scale from the center via the E edge
    await dragWorld(page, { x: 400, y: 190 }, { x: 450, y: 190 }, { modifiers: ['Alt'] });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(400);
    expect(Math.round(b!.x)).toBe(50);
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(200);
    // Shift uniform from the SE corner
    await dragWorld(page, { x: 300, y: 220 }, { x: 500, y: 240 }, { modifiers: ['Shift'] });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(400);
    expect(Math.round(b!.height)).toBe(240);
    await press(page, 'Control+z');
    // rotate: just outside the NE corner (in screen px) around the center with Shift → 45° steps
    const box = await viewport(page).boundingBox();
    const ne = await worldToScreen(page, 300, 100);
    const start = { x: box!.x + ne.x + 9, y: box!.y + ne.y - 9 };
    await page.keyboard.down('Shift');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const c = await worldToScreen(page, 200, 160);
    const r = Math.hypot(start.x - (box!.x + c.x), start.y - (box!.y + c.y));
    const a0 = Math.atan2(start.y - (box!.y + c.y), start.x - (box!.x + c.x));
    for (let i = 1; i <= 10; i++) {
      const a = a0 + (Math.PI / 2) * (i / 10) * 1.02;
      await page.mouse.move(box!.x + c.x + Math.cos(a) * r, box!.y + c.y + Math.sin(a) * r);
    }
    await page.mouse.up();
    await page.keyboard.up('Shift');
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(120);
    expect(Math.round(b!.height)).toBe(200);
    let labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Rotate');
    await press(page, 'Control+z');
    // Ctrl-drag the N edge → horizontal shear (bounds grow by the drag distance)
    await dragWorld(page, { x: 200, y: 100 }, { x: 260, y: 100 }, { modifiers: ['Control'] });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(260);
    expect(Math.round(b!.height)).toBe(120);
    labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Shear');
    await press(page, 'Control+z');
    // Escape cancels a corner drag
    await dragWorldWith(page, { x: 300, y: 220 }, { x: 400, y: 300 }, async () => {
      expect(Math.round((await worldBounds(page, id))!.width)).toBe(300);
      await press(page, 'Escape');
    });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(200);
    // drag inside moves
    await dragWorld(page, { x: 200, y: 160 }, { x: 250, y: 190 });
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(150);
    expect(Math.round(b!.y)).toBe(130);
  });

  test('objects inside a transformed group and zoomed views', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    await selectTool(page, 'select');
    await runCommand(page, 'object.group');
    const gid = (await selection(page))[0];
    expect(gid).not.toBe(id);
    // rotate the group by 30° through the dialog (with Enter)
    await runCommand(page, 'object.rotateDialog');
    await setField(page, 'rotate-angle', '30', 'Enter');
    await expect(page.getByTestId('dialog')).toBeHidden();
    const g = await nodeById(page, gid);
    // the group matrix was pushed down: the group stays at identity, the child holds the rotation
    expect(Math.abs(g.transform.b)).toBeLessThan(1e-9);
    const child = await nodeById(page, id);
    expect(Math.abs(child.transform.b)).toBeGreaterThan(0.4);
    expect(child.shape.kind).toBe('rect');
    // now scale the group 2x at zoom 0.25 with the scale tool via the Transform panel W field
    await setView(page, 0.25, { x: 100, y: 100 });
    const before = await worldBounds(page, gid);
    await page.getByTestId('tp-lock').click();
    await setField(page, 'tp-w', String(Math.round(before!.width * 2)), 'Enter');
    const after = await worldBounds(page, gid);
    expect(after!.width).toBeCloseTo(before!.width * 2, 0);
    expect(after!.height).toBeCloseTo(before!.height * 2, 0);
    expect(after!.x + after!.width / 2).toBeCloseTo(before!.x + before!.width / 2, 0);
    // at 4x zoom the free transform corner still hits and scales
    await blur(page);
    await press(page, 'Control+z');
    expect(Math.round((await worldBounds(page, gid))!.width)).toBe(Math.round(before!.width));
    await withStore(page, (s) => s.setSelection([]));
    await runCommand(page, 'select.all');
    await runCommand(page, 'object.resetTransform');
    const r = await worldBounds(page, gid);
    // put the SE corner in the middle of the viewport
    await setView(page, 4, { x: 600 - (r!.x + r!.width) * 4, y: 400 - (r!.y + r!.height) * 4 });
    await selectTool(page, 'freetransform');
    await dragWorld(page, { x: r!.x + r!.width, y: r!.y + r!.height }, { x: r!.x + r!.width + 20, y: r!.y + r!.height + 10 });
    const r2 = await worldBounds(page, gid);
    expect(Math.round(r2!.width)).toBe(Math.round(r!.width + 20));
    expect(Math.round(r2!.height)).toBe(Math.round(r!.height + 10));
  });

  test('Transform Each scales every object around its own center; flip/rotate commands; reset bounding box', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const a = await drawRect(page, 100, 100, 100, 50);
    const b = await drawRect(page, 500, 400, 100, 50);
    await selectTool(page, 'select');
    await page.evaluate(([x, y]) => (window as any).__opuller.store.getState().setSelection([x, y]), [a, b]);
    await runCommand(page, 'object.transformEach');
    await setField(page, 'each-scale-x', '50');
    await setField(page, 'each-scale-y', '50');
    await page.getByTestId('transform-ok').click();
    const ba = await worldBounds(page, a);
    const bb = await worldBounds(page, b);
    expect(Math.round(ba!.width)).toBe(50);
    expect(Math.round(ba!.x + ba!.width / 2)).toBe(150);
    expect(Math.round(bb!.width)).toBe(50);
    expect(Math.round(bb!.x + bb!.width / 2)).toBe(550);
    // Transform Again re-applies the transform-each
    await runCommand(page, 'object.transformAgain');
    expect(Math.round((await worldBounds(page, a))!.width)).toBe(25);
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    // rotate 90 CW with the reference point at the top-left corner
    await page.evaluate((x) => (window as any).__opuller.store.getState().setSelection([x]), a);
    await page.getByTestId('ref-nw').click();
    await runCommand(page, 'object.rotate90cw');
    let r = await worldBounds(page, a);
    expect(Math.round(r!.width)).toBe(50);
    expect(Math.round(r!.height)).toBe(100);
    expect(Math.round(r!.x + r!.width)).toBe(100);
    expect(Math.round(r!.y)).toBe(100);
    await runCommand(page, 'object.rotate90ccw');
    r = await worldBounds(page, a);
    // the reference point is the top-left of the *current* bounds (50,100)
    expect(Math.round(r!.x)).toBe(50);
    expect(Math.round(r!.y)).toBe(50);
    expect(Math.round(r!.width)).toBe(100);
    await page.getByTestId('ref-c').click();
    await runCommand(page, 'object.flipV');
    r = await worldBounds(page, a);
    expect(Math.round(r!.y)).toBe(50);
    // reset bounding box bakes a rotated live rect into plain geometry
    await runCommand(page, 'object.rotateDialog');
    await setField(page, 'rotate-angle', '30');
    await page.getByTestId('transform-ok').click();
    expect((await nodeById(page, a)).shape).toBeTruthy();
    await runCommand(page, 'object.resetTransform');
    const n = await nodeById(page, a);
    expect(n.shape).toBeUndefined();
    expect(n.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const labels = await pastLabels(page);
    expect(labels[labels.length - 1]).toBe('Reset Bounding Box');
  });

  test('scale strokes preference and the Scale dialog', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    const id = await drawRect(page, 100, 100, 200, 100);
    await selectTool(page, 'select');
    await withStore(page, (s) => s.setPrefs({ scaleStrokes: false }));
    await runCommand(page, 'object.scaleDialog');
    await setField(page, 'scale-uniform', '200');
    await page.getByTestId('transform-ok').click();
    let n = await nodeById(page, id);
    expect(Math.round((await worldBounds(page, id))!.width)).toBe(400);
    expect(n.stroke.width).toBeCloseTo(1);
    await press(page, 'Control+z');
    await withStore(page, (s) => s.setPrefs({ scaleStrokes: true }));
    await runCommand(page, 'object.scaleDialog');
    await page.locator('.transform-dialog input[type=radio]').nth(1).check();
    await setField(page, 'scale-x', '200');
    await setField(page, 'scale-y', '50');
    await page.getByTestId('transform-ok').click();
    n = await nodeById(page, id);
    const b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(400);
    expect(Math.round(b!.height)).toBe(50);
    expect(n.stroke.width).toBeCloseTo(1);
    await withStore(page, (s) => s.setPrefs({ scaleStrokes: false }));
  });

  test('tool shortcuts, menu entries and Enter opens the transform dialog from the selection tool', async ({ page }) => {
    await openApp(page);
    await showTransformPanel(page);
    await drawRect(page, 100, 100, 100, 100);
    await selectTool(page, 'select');
    await page.mouse.click(800, 700);
    for (const [key, id] of [
      ['r', 'rotate'],
      ['s', 'scale'],
      ['o', 'reflect'],
      ['e', 'freetransform'],
    ]) {
      await press(page, key);
      expect((await getState(page)).activeTool).toBe(id);
    }
    await press(page, 'v');
    await clickWorld(page, 150, 150);
    await press(page, 'Enter');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await expect(page.locator('.dialog-header')).toContainText('Transform');
    await page.locator('.tabs .tab', { hasText: 'Rotate' }).click();
    await expect(page.getByTestId('rotate-angle')).toBeVisible();
    await press(page, 'Escape');
    await expect(page.getByTestId('dialog')).toBeHidden();
    // Object menu has the Transform submenu
    await page.getByRole('button', { name: 'Object', exact: true }).dispatchEvent('pointerdown');
    await expect(page.locator('.menu')).toBeVisible();
    await expect(page.locator('.menu-item', { hasText: 'Transform' }).first()).toBeVisible();
    await expect(page.locator('.menu-item', { hasText: 'Align' }).first()).toBeVisible();
    await press(page, 'Escape');
  });
});
