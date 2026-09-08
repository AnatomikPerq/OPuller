/**
 * Patterns: make from selection, swatch + options dialog, apply, edit the tile
 * in isolation, expand, library.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, drawRect, nodeById } from './helpers';

test.describe('patterns', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('make pattern, options dialog, apply swatch, edit tile in isolation, expand', async ({ page }) => {
    const a = await drawRect(page, 100, 100, 20, 20);
    await runCommand(page, 'pattern.make');
    await expect(page.getByTestId('pattern-options-ok')).toBeVisible();
    let s = await getState(page);
    expect(s.doc.patterns).toHaveLength(1);
    const pid = s.doc.patterns[0].id;
    // change the tile type and spacing live
    await page.locator('#pattern-layout').selectOption('brick-row');
    await page.getByTestId('pattern-spacing-x').fill('10');
    await page.getByTestId('pattern-spacing-x').press('Enter');
    await page.getByTestId('pattern-options-ok').click();
    s = await getState(page);
    expect(s.doc.patterns[0].layout).toBe('brick-row');
    expect(s.doc.patterns[0].spacing.x).toBe(10);
    expect(s.past[s.past.length - 1].label).toBe('Pattern Options');
    // apply the swatch to a new rectangle
    const big = await drawRect(page, 300, 100, 200, 150);
    await page.getByTestId('panel-tab-swatches').click();
    const sw = s.doc.swatches.find((x: any) => x.paint.type === 'pattern');
    await page.getByTestId(`swatch-${sw.id}`).click();
    let n = await nodeById(page, big);
    expect(n.fill.type).toBe('pattern');
    expect(n.fill.patternId).toBe(pid);
    // the canvas renders a <pattern> for it
    await expect(page.locator(`.canvas-svg .document-layer pattern`)).toHaveCount(1);
    // pattern fill options
    await runCommand(page, 'pattern.fillOptions');
    await page.getByTestId('pattern-fill-x').fill('7');
    await page.getByTestId('pattern-fill-x').press('Enter');
    await page.getByTestId('pattern-fill-ok').click();
    n = await nodeById(page, big);
    expect(n.fill.x).toBe(7);
    // edit the tile artwork in isolation: recolour, exit → pattern updated
    await runCommand(page, 'pattern.edit');
    s = await getState(page);
    const gid = s.isolationId;
    expect(gid).toBeTruthy();
    const g = s.doc.nodes[gid];
    expect(g.data.patternEdit.id).toBe(pid);
    const art = g.children[1];
    await page.evaluate((id) => (window as any).__opuller.store.getState().updateDoc((d: any) => { d.nodes[id].fill = { type: 'solid', color: '#00ff00', opacity: 1 }; }, 'Fill'), art);
    await page.evaluate(() => (window as any).__opuller.store.getState().setIsolation(null));
    await expect.poll(async () => (await getState(page)).doc.patterns[0].svg.includes('#00ff00')).toBe(true);
    s = await getState(page);
    expect(s.doc.nodes[gid]).toBeUndefined();
    // expand the pattern fill into tiles
    await page.evaluate((id) => (window as any).__opuller.store.getState().setSelection([id]), big);
    await runCommand(page, 'pattern.expand');
    s = await getState(page);
    const group = s.doc.nodes[s.selection[0]];
    expect(group.type).toBe('group');
    expect(group.clipId).toBeTruthy();
    expect(group.children.length).toBeGreaterThan(20);
    expect(s.doc.nodes[a]).toBeTruthy(); // the source artwork was kept
  });

  test('pattern library adds editable pattern swatches', async ({ page }) => {
    await page.getByTestId('panel-tab-swatches').click();
    await page.getByTestId('swatches-libraries').click();
    await page.getByTestId('swatches-pattern-dots').click();
    let s = await getState(page);
    expect(s.doc.patterns).toHaveLength(1);
    expect(s.doc.patterns[0].name).toBe('Polka Dots');
    expect(s.doc.swatches[s.doc.swatches.length - 1].paint.type).toBe('pattern');
    await runCommand(page, 'pattern.addLibrary');
    s = await getState(page);
    expect(s.doc.patterns.length).toBeGreaterThan(10);
    // scripting API
    const res = await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      const r = api.createShape({ kind: 'rect', x: 100, y: 100, width: 200, height: 100, fill: '#ffffff', stroke: 'none' });
      const list = await api.patterns({ op: 'list' });
      await api.patterns({ op: 'apply', id: list[1].id, ids: [r.id], scale: 2 });
      return { id: r.id, list: list.length };
    });
    const n = await nodeById(page, res.id);
    expect(n.fill.type).toBe('pattern');
    expect(n.fill.scale).toBe(2);
  });
});
