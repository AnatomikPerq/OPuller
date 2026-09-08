import { test, expect, type Page } from '@playwright/test';
import { openApp, selectTool, clickWorld, dragWorld, getState, nodeById, withStore, runCommand, press, setView, viewport, worldToScreen } from './helpers';

async function textNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const s = (window as any).__opuller.store.getState();
    return Object.values(s.doc.nodes)
      .filter((n: any) => n.type === 'text')
      .map((n: any) => n.id);
  });
}

async function editingId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__opuller.store.getState().editingTextId);
}

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Create point text at a world position with the Type tool and type `text` (stays in editing mode). */
async function typeAt(page: Page, x: number, y: number, text: string): Promise<string> {
  await selectTool(page, 'text');
  await clickWorld(page, x, y);
  await expect.poll(() => editingId(page)).not.toBeNull();
  const id = (await editingId(page))!;
  await page.keyboard.type(text);
  return id;
}

test.describe('type tool', () => {
  // other agents editing the shared tree trigger Vite full reloads; keep HMR away from these pages
  test.beforeEach(async ({ page }) => {
    await page.routeWebSocket(/.*/, () => {});
  });

  test('creates point text by clicking and typing, Escape commits and selects it', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const before = (await getState(page)).past.length;
    const id = await typeAt(page, 300, 300, 'Hello');
    let n = await nodeById(page, id);
    expect(n.type).toBe('text');
    expect(n.kind).toBe('point');
    expect(n.text).toBe('Hello');
    expect(n.runs.map((r: any) => r.text).join('')).toBe('Hello');
    // caret overlay is visible while editing
    await expect(page.getByTestId('text-edit-overlay')).toBeVisible();
    await press(page, 'Escape');
    const s = await getState(page);
    expect(s.activeTool).toBe('select');
    expect(s.editingTextId).toBeNull();
    expect(s.selection).toEqual([id]);
    n = await nodeById(page, id);
    expect(n.name).toBe('Hello');
    expect(Math.round(n.transform.e)).toBe(300);
    expect(Math.round(n.transform.f)).toBe(300);
    // the whole session is one undo step
    expect(s.past.length).toBe(before + 1);
    await press(page, 'Control+z');
    expect(await nodeById(page, id)).toBeUndefined();
    await press(page, 'Control+Shift+z');
    expect((await nodeById(page, id)).text).toBe('Hello');
    expect(errors).toEqual([]);
  });

  test('empty text objects are removed when editing ends', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'text');
    await clickWorld(page, 300, 300);
    await expect.poll(() => editingId(page)).not.toBeNull();
    const id = (await editingId(page))!;
    await press(page, 'Escape');
    expect(await nodeById(page, id)).toBeUndefined();
    expect((await getState(page)).selection).toEqual([]);
    // typing then deleting everything also removes the object
    const id2 = await typeAt(page, 300, 400, 'abc');
    await press(page, 'Control+a');
    await press(page, 'Backspace');
    expect((await nodeById(page, id2)).text).toBe('');
    await press(page, 'Escape');
    expect(await nodeById(page, id2)).toBeUndefined();
  });

  test('drag creates area text that wraps into multiple lines', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'text');
    await dragWorld(page, { x: 200, y: 200 }, { x: 330, y: 400 });
    await expect.poll(() => editingId(page)).not.toBeNull();
    const id = (await editingId(page))!;
    let n = await nodeById(page, id);
    expect(n.kind).toBe('area');
    expect(Math.round(n.box.width)).toBe(130);
    expect(Math.round(n.box.height)).toBe(200);
    await page.keyboard.type('The quick brown fox jumps over the lazy dog');
    await press(page, 'Escape');
    n = await nodeById(page, id);
    expect(n.text).toBe('The quick brown fox jumps over the lazy dog');
    // rendered as several line tspans
    const lines = await page.locator(`[data-id="${id}"] text > tspan`).count();
    expect(lines).toBeGreaterThan(2);
  });

  test('click into existing text places the caret; keyboard editing and selection', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Hello world');
    await press(page, 'Escape');
    await selectTool(page, 'text');
    // click just right of the origin -> caret at index 0
    await clickWorld(page, 301, 292);
    await expect.poll(() => editingId(page)).toBe(id);
    await page.keyboard.type('X');
    expect((await nodeById(page, id)).text).toBe('XHello world');
    await press(page, 'End');
    await page.keyboard.type('!');
    expect((await nodeById(page, id)).text).toBe('XHello world!');
    await press(page, 'Home');
    await press(page, 'Delete');
    expect((await nodeById(page, id)).text).toBe('Hello world!');
    // Ctrl+Right jumps a word, Shift+End selects to the end, typing replaces
    await press(page, 'Control+ArrowRight');
    await press(page, 'Shift+End');
    await page.keyboard.type('there');
    expect((await nodeById(page, id)).text).toBe('Hello there');
    // Enter makes a new paragraph
    await press(page, 'Enter');
    await page.keyboard.type('Second');
    expect((await nodeById(page, id)).text).toBe('Hello there\nSecond');
    // ArrowUp moves to the first line
    await press(page, 'ArrowUp');
    await press(page, 'Home');
    await press(page, 'Shift+ArrowRight');
    await press(page, 'Shift+ArrowRight');
    await page.keyboard.type('J');
    expect((await nodeById(page, id)).text).toBe('Jllo there\nSecond');
    await press(page, 'Escape');
    expect((await getState(page)).activeTool).toBe('select');
  });

  test('undo while editing steps back through committed pauses and stays in editing', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Hello');
    await page.waitForTimeout(1300); // pause > 1s commits
    await page.keyboard.type(' world');
    expect((await nodeById(page, id)).text).toBe('Hello world');
    await press(page, 'Control+z');
    expect((await nodeById(page, id)).text).toBe('Hello');
    expect(await editingId(page)).toBe(id);
    await page.keyboard.type('!');
    expect((await nodeById(page, id)).text).toBe('Hello!');
    await press(page, 'Escape');
  });

  test('paste and copy use the system clipboard events', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'ab');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'CD');
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    expect((await nodeById(page, id)).text).toBe('abCD');
    await press(page, 'Shift+Home');
    const copied = await page.evaluate(() => {
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(ev);
      return dt.getData('text/plain');
    });
    expect(copied).toBe('abCD');
    await press(page, 'Escape');
  });

  test('Character panel changes the font size and style of the selected text', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Size');
    await press(page, 'Escape');
    await page.getByTestId('panel-tab-character').click();
    const size = page.getByTestId('character-size');
    await size.fill('48');
    await size.press('Enter');
    expect((await nodeById(page, id)).style.fontSize).toBe(48);
    // one undo step (focus back on the canvas first: shortcuts are ignored while typing in a field)
    await page.getByTestId('viewport').focus();
    await press(page, 'Control+z');
    expect((await nodeById(page, id)).style.fontSize).toBe(24);
    await press(page, 'Control+Shift+z');
    expect((await nodeById(page, id)).style.fontSize).toBe(48);
    // face select: bold
    await page.locator('#character-face').selectOption('700|normal');
    expect((await nodeById(page, id)).style.fontWeight).toBe(700);
    // underline toggle
    await page.getByTestId('character-underline').click();
    expect((await nodeById(page, id)).style.textDecoration).toBe('underline');
    // font family picker renders options in their font
    await page.getByTestId('font-family-picker').click();
    await expect(page.getByTestId('font-family-list')).toBeVisible();
    const item = page.locator('[data-family="Playfair Display"]');
    await expect(item.locator('.font-picker-item-name')).toHaveCSS('font-family', /Playfair Display/);
    await item.click();
    expect((await nodeById(page, id)).style.fontFamily).toBe('Playfair Display');
    // nothing selected: changes go to the defaults for new text
    await withStore(page, (s) => s.clearSelection());
    await size.fill('30');
    await size.press('Enter');
    expect((await getState(page)).appearance.textStyle.fontSize).toBe(30);
  });

  test('Character panel applies run styles to the selected range while editing', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Hello world');
    await press(page, 'Home');
    await press(page, 'Shift+Control+ArrowRight');
    await page.getByTestId('panel-tab-character').click();
    await page.locator('#character-face').selectOption('700|normal');
    let n = await nodeById(page, id);
    expect(n.text).toBe('Hello world');
    expect(n.runs.length).toBe(2);
    expect(n.runs[0].text).toBe('Hello ');
    expect(n.runs[0].style.fontWeight).toBe(700);
    expect(n.runs[1].style ?? {}).not.toHaveProperty('fontWeight');
    // typing inside the bold run inherits bold
    await press(page, 'ArrowLeft');
    await page.keyboard.type('X');
    n = await nodeById(page, id);
    expect(n.text).toBe('XHello world');
    expect(n.runs[0].text).toBe('XHello ');
    expect(n.runs[0].style.fontWeight).toBe(700);
    // rendered tspans carry the override
    const bold = await page.locator(`[data-id="${id}"] tspan[font-weight="700"]`).count();
    expect(bold).toBeGreaterThanOrEqual(1);
    await press(page, 'Escape');
  });

  test('Paragraph panel alignment and Type menu size shortcuts', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Align me');
    await press(page, 'Escape');
    await page.getByTestId('panel-tab-paragraph').click();
    await page.getByTestId('paragraph-panel').getByTitle('Align center (Ctrl+Shift+C)').click();
    expect((await nodeById(page, id)).style.textAlign).toBe('center');
    await press(page, 'Control+Shift+Period');
    expect((await nodeById(page, id)).style.fontSize).toBe(26);
    await press(page, 'Control+Shift+Comma');
    expect((await nodeById(page, id)).style.fontSize).toBe(24);
    await runCommand(page, 'type.caseUpper');
    expect((await nodeById(page, id)).text).toBe('ALIGN ME');
  });

  test('Create Outlines produces a group of paths and undo restores the text', async ({ page }) => {
    const errors = await collectErrors(page);
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'AB');
    await press(page, 'Escape');
    await runCommand(page, 'type.createOutlines');
    await expect.poll(async () => (await nodeById(page, id)) === undefined, { timeout: 15000 }).toBe(true);
    const s = await getState(page);
    expect(s.selection.length).toBe(1);
    const g = s.doc.nodes[s.selection[0]];
    expect(g.type).toBe('group');
    expect(g.children.length).toBe(2);
    for (const c of g.children) {
      const p = s.doc.nodes[c];
      expect(p.type).toBe('path');
      expect(p.fillRule).toBe('evenodd');
      expect(p.subpaths.length).toBeGreaterThan(0);
    }
    // the B glyph has holes -> compound subpaths
    const b = s.doc.nodes[g.children[1]];
    expect(b.subpaths.length).toBeGreaterThanOrEqual(2);
    // outlines sit where the text was (baseline at y=300, x from 300)
    const bounds = await page.evaluate((gid) => {
      const api = (window as any).__opuller;
      return api.worldBounds(api.store.getState().doc, gid);
    }, s.selection[0]);
    expect(bounds.x).toBeGreaterThan(295);
    expect(bounds.x).toBeLessThan(310);
    expect(bounds.y + bounds.height).toBeGreaterThan(295);
    expect(bounds.y + bounds.height).toBeLessThan(305);
    await press(page, 'Control+z');
    expect((await nodeById(page, id)).text).toBe('AB');
    expect(errors).toEqual([]);
  });

  test('clicking an open path creates type on a path', async ({ page }) => {
    await openApp(page);
    await selectTool(page, 'line');
    await dragWorld(page, { x: 200, y: 500 }, { x: 600, y: 500 });
    const lineId = (await getState(page)).selection[0];
    await withStore(page, (s) => s.clearSelection());
    await selectTool(page, 'text');
    await clickWorld(page, 400, 500);
    await expect.poll(() => editingId(page)).not.toBeNull();
    const id = (await editingId(page))!;
    let n = await nodeById(page, id);
    expect(n.kind).toBe('path');
    expect(n.pathId).toBe(lineId);
    expect(n.pathOffset).toBeGreaterThan(0.4);
    expect(n.pathOffset).toBeLessThan(0.6);
    await page.keyboard.type('On a path');
    n = await nodeById(page, id);
    expect(n.text).toBe('On a path');
    const line = await nodeById(page, lineId);
    expect(line.fill.type).toBe('none');
    expect(line.stroke.paint.type).toBe('none');
    expect(line.data.typeOnPath).toBeTruthy();
    await press(page, 'Escape');
    // rendered as textPath
    expect(await page.locator(`[data-testid="viewport"] [data-id="${id}"] textPath`).count()).toBe(1);
    // flip reverses the path direction
    const before = (await nodeById(page, lineId)).subpaths[0].anchors[0].point.x;
    await runCommand(page, 'type.flipPath');
    const after = (await nodeById(page, lineId)).subpaths[0].anchors[0].point.x;
    expect(after).not.toBe(before);
    // release restores the path appearance
    await runCommand(page, 'type.releasePath');
    n = await nodeById(page, id);
    expect(n.kind).toBe('point');
    expect(n.pathId).toBeNull();
    expect((await nodeById(page, lineId)).stroke.paint.type).toBe('solid');
  });

  test('editing works at 4x zoom and inside a rotated group', async ({ page }) => {
    await openApp(page);
    // text inside a rotated group
    const id = await page.evaluate(() => {
      const api = (window as any).__opuller;
      const s = api.store.getState();
      const text = api.api.nodes.makeText('Rotated', { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
      const r = Math.PI / 6;
      const group = api.api.nodes.makeGroup([], { transform: { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 400, f: 300 } });
      s.updateDoc((d: any) => {
        api.api.document.addNode(d, group, d.layers[0]);
        api.api.document.addNode(d, text, group.id);
      }, 'Add');
      return text.id;
    });
    await setView(page, 4, { x: -1200, y: -800 });
    await selectTool(page, 'text');
    // click near the start of the text (local (2, -8) -> world through the group's rotation)
    const r = Math.PI / 6;
    const lx = 2;
    const ly = -8;
    const wx = 400 + lx * Math.cos(r) - ly * Math.sin(r);
    const wy = 300 + lx * Math.sin(r) + ly * Math.cos(r);
    await clickWorld(page, wx, wy);
    await expect.poll(() => editingId(page)).toBe(id);
    await page.keyboard.type('X');
    const n = await nodeById(page, id);
    expect(n.text.startsWith('X')).toBe(true);
    await expect(page.getByTestId('text-edit-overlay')).toBeVisible();
    await press(page, 'Escape');
    expect((await getState(page)).selection).toEqual([id]);
  });

  test('double-click with the selection tool starts editing; switching tools commits', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Dbl');
    await press(page, 'Escape');
    await withStore(page, (s) => s.clearSelection());
    await clickWorld(page, 320, 292, { clickCount: 2 });
    await expect.poll(() => editingId(page)).toBe(id);
    expect((await getState(page)).activeTool).toBe('text');
    // whole text selected: typing replaces it
    await page.keyboard.type('New');
    expect((await nodeById(page, id)).text).toBe('New');
    await selectTool(page, 'rect');
    expect(await editingId(page)).toBeNull();
    expect((await nodeById(page, id)).text).toBe('New');
    expect((await getState(page)).selection).toEqual([id]);
  });

  test('convert point text to area and back keeps the text in place', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Convert me');
    await press(page, 'Escape');
    const b0 = await page.evaluate((id) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, id), id);
    await runCommand(page, 'type.convertToArea');
    let n = await nodeById(page, id);
    expect(n.kind).toBe('area');
    const b1 = await page.evaluate((id) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, id), id);
    expect(Math.abs(b1.x - b0.x)).toBeLessThan(3);
    expect(Math.abs(b1.y - b0.y)).toBeLessThan(3);
    await runCommand(page, 'type.convertToPoint');
    n = await nodeById(page, id);
    expect(n.kind).toBe('point');
    const b2 = await page.evaluate((id) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, id), id);
    expect(Math.abs(b2.x - b0.x)).toBeLessThan(3);
    expect(Math.abs(b2.y - b0.y)).toBeLessThan(3);
  });

  test('mouse drag selects a range, double-click selects a word, area frame handles resize the box', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Hello world');
    // drag from the start of the text over the first word and replace it
    await dragWorld(page, { x: 301, y: 292 }, { x: 355, y: 292 });
    await page.keyboard.type('Bye');
    let n = await nodeById(page, id);
    expect(n.text.endsWith(' world')).toBe(true);
    expect(n.text.startsWith('Bye')).toBe(true);
    // double-click on the last word selects it
    await clickWorld(page, 400, 292, { clickCount: 2 });
    await page.keyboard.type('X');
    n = await nodeById(page, id);
    expect(n.text).toBe('Bye X');
    await press(page, 'Escape');
    // area text: drag the south-east handle while editing
    await selectTool(page, 'text');
    await dragWorld(page, { x: 500, y: 200 }, { x: 700, y: 300 });
    await expect.poll(() => editingId(page)).not.toBeNull();
    const area = (await editingId(page))!;
    await page.keyboard.type('Resize me');
    const past = (await getState(page)).past.length;
    await dragWorld(page, { x: 700, y: 300 }, { x: 760, y: 340 });
    n = await nodeById(page, area);
    expect(Math.round(n.box.width)).toBe(260);
    expect(Math.round(n.box.height)).toBe(140);
    expect((await getState(page)).past.length).toBe(past + 1);
    expect(await editingId(page)).toBe(area);
    await press(page, 'Escape');
  });

  test('Create Outlines handles Cyrillic subsets and type on a path', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Привет');
    await press(page, 'Escape');
    await runCommand(page, 'type.createOutlines');
    await expect.poll(async () => (await nodeById(page, id)) === undefined, { timeout: 20000 }).toBe(true);
    let s = await getState(page);
    let g = s.doc.nodes[s.selection[0]];
    expect(g.type).toBe('group');
    expect(g.children.length).toBe(6);
    // type on a path
    await selectTool(page, 'line');
    await dragWorld(page, { x: 200, y: 600 }, { x: 700, y: 650 });
    await withStore(page, (st) => st.clearSelection());
    await selectTool(page, 'text');
    await clickWorld(page, 250, 605);
    await expect.poll(() => editingId(page)).not.toBeNull();
    const pid = (await editingId(page))!;
    await page.keyboard.type('On path');
    await press(page, 'Escape');
    await runCommand(page, 'type.createOutlines');
    await expect.poll(async () => (await nodeById(page, pid)) === undefined, { timeout: 20000 }).toBe(true);
    s = await getState(page);
    g = s.doc.nodes[s.selection[0]];
    expect(g.type).toBe('group');
    expect(g.children.length).toBe(6); // "On path" without the space
    const b = await page.evaluate((gid) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, gid), g.id);
    expect(b.x).toBeGreaterThan(200);
    expect(b.y).toBeGreaterThan(560);
    expect(b.y + b.height).toBeLessThan(660);
  });

  test('uploaded fonts are registered, applied and survive a reload', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Upload');
    await press(page, 'Escape');
    await runCommand(page, 'type.uploadFont');
    await expect(page.getByTestId('dialog')).toBeVisible();
    await page.getByTestId('font-file-input').setInputFiles('node_modules/@fontsource/lora/files/lora-latin-700-normal.woff');
    await expect(page.locator('[data-testid="uploaded-font-row"]')).toHaveCount(1);
    const family = await page.locator('[data-testid="uploaded-font-row"]').getAttribute('data-family');
    expect(family).toBe('Lora');
    await expect(page.locator('[data-testid="uploaded-font-row"]')).toContainText('Bold');
    // applied to the selection (dialog opened from the menu: apply is off by default)
    await page.getByTestId('dialog').getByText('Apply to the selected text').click();
    await page.getByTestId('font-file-input').setInputFiles('node_modules/@fontsource/lora/files/lora-latin-400-italic.woff');
    await expect.poll(async () => (await nodeById(page, id))?.style.fontStyle).toBe('italic');
    expect((await nodeById(page, id)).style.fontFamily).toBe('Lora');
    // persisted: after a reload the fonts are still listed
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__opuller?.store);
    await withStore(page, (s) => s.closeDialog?.());
    await runCommand(page, 'type.uploadFont');
    await expect(page.locator('[data-testid="uploaded-font-row"]')).toHaveCount(2, { timeout: 10000 });
  });

  test('locked text cannot be edited and Escape cancels an area drag', async ({ page }) => {
    await openApp(page);
    const id = await typeAt(page, 300, 300, 'Locked');
    await press(page, 'Escape');
    await withStore(page, (s) => s.updateDoc((d: any) => { d.nodes[s.selection[0]].locked = true; }, 'Lock'));
    await withStore(page, (s) => s.clearSelection());
    await selectTool(page, 'text');
    await withStore(page, (s) => s.setEditingText((Object.values(s.doc.nodes) as any[]).find((n) => n.type === 'text')?.id ?? null));
    expect(await editingId(page)).toBeNull();
    // clicking on the locked text creates a new text instead of editing it
    await clickWorld(page, 320, 292);
    await expect.poll(() => editingId(page)).not.toBeNull();
    expect(await editingId(page)).not.toBe(id);
    await press(page, 'Escape');
    // Escape during an area drag cancels without creating anything
    await selectTool(page, 'text');
    const count = await page.evaluate(() => Object.keys((window as any).__opuller.store.getState().doc.nodes).length);
    const box = (await page.locator('[data-testid="viewport"]').boundingBox())!;
    await page.mouse.move(box.x + 600, box.y + 600);
    await page.mouse.down();
    await page.mouse.move(box.x + 700, box.y + 700, { steps: 5 });
    await press(page, 'Escape');
    await page.mouse.up();
    expect(await page.evaluate(() => Object.keys((window as any).__opuller.store.getState().doc.nodes).length)).toBe(count);
    expect(await editingId(page)).toBeNull();
  });
});

void viewport;
void worldToScreen;
void textNodeIds;
