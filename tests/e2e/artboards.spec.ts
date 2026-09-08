import { test } from '@playwright/test';
import { openApp, expect, getState, withStore, setView, dragWorld, clickWorld, selectTool, drawRect, runCommand, worldBounds, nodeById } from './helpers';

async function artboards(page: any) {
  return page.evaluate(() => (window as any).__opuller.store.getState().doc.artboards);
}

test.describe('artboards module', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await setView(page, 0.25, { x: 100, y: 100 });
  });

  test('artboard tool creates, moves (with artwork), resizes and duplicates artboards', async ({ page }) => {
    const rectId = await drawRect(page, 200, 200, 400, 300);
    await selectTool(page, 'artboard');
    await expect(page.locator('[data-testid="artboard-overlay"]')).toBeVisible();

    // create by dragging on empty canvas (right of artboard 1)
    await dragWorld(page, { x: 2200, y: 100 }, { x: 2800, y: 500 });
    let abs = await artboards(page);
    expect(abs.length).toBe(2);
    expect(Math.round(abs[1].x)).toBe(2200);
    expect(Math.round(abs[1].width)).toBe(600);
    expect(Math.round(abs[1].height)).toBe(400);
    let s = await getState(page);
    expect(s.activeArtboardId).toBe(abs[1].id);
    expect(s.past.length).toBe(2); // rect + artboard

    // move artboard 1 with its artwork
    await dragWorld(page, { x: 1000, y: 800 }, { x: 1200, y: 900 });
    abs = await artboards(page);
    expect(Math.round(abs[0].x)).toBe(200);
    expect(Math.round(abs[0].y)).toBe(100);
    const rb = await worldBounds(page, rectId);
    expect(Math.round(rb!.x)).toBe(400);
    expect(Math.round(rb!.y)).toBe(300);
    s = await getState(page);
    expect(s.activeArtboardId).toBe(abs[0].id);

    // resize via the bottom-right handle
    await dragWorld(page, { x: 200 + 1920, y: 100 + 1080 }, { x: 200 + 1500, y: 100 + 1000 });
    abs = await artboards(page);
    expect(Math.round(abs[0].width)).toBe(1500);
    expect(Math.round(abs[0].height)).toBe(1000);
    // artwork stays put on resize
    const rb2 = await worldBounds(page, rectId);
    expect(Math.round(rb2!.x)).toBe(400);

    // alt-drag duplicates (with artwork)
    await dragWorld(page, { x: 1000, y: 700 }, { x: 1000, y: 2200 }, { modifiers: ['Alt'] });
    abs = await artboards(page);
    expect(abs.length).toBe(3);
    const copy = abs.find((a: any) => a.name.includes('copy'));
    expect(copy).toBeTruthy();
    expect(Math.round(copy.y)).toBe(100 + 1500);
    s = await getState(page);
    const paths = Object.values(s.doc.nodes).filter((n: any) => n.type === 'path');
    expect(paths.length).toBe(2);

    // undo everything back to the single artboard
    for (let i = 0; i < 4; i++) await withStore(page, (st) => st.undo());
    abs = await artboards(page);
    expect(abs.length).toBe(1);
    expect(Math.round(abs[0].x)).toBe(0);
  });

  test('Escape returns to the previous tool; Delete removes the active artboard', async ({ page }) => {
    await selectTool(page, 'select');
    await selectTool(page, 'artboard');
    await runCommand(page, 'artboard.new');
    let abs = await artboards(page);
    expect(abs.length).toBe(2);
    await page.locator('[data-testid="viewport"]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Delete');
    abs = await artboards(page);
    expect(abs.length).toBe(1);
    await page.keyboard.press('Escape');
    const s = await getState(page);
    expect(s.activeTool).toBe('select');
  });

  test('commands: new, duplicate, delete, fit to artwork, convert, select all on artboard, rearrange', async ({ page }) => {
    const r1 = await drawRect(page, 100, 100, 300, 200);
    await runCommand(page, 'artboard.new');
    let abs = await artboards(page);
    expect(abs.length).toBe(2);
    expect(abs[1].x).toBeGreaterThan(1920);
    let s = await getState(page);
    expect(s.activeArtboardId).toBe(abs[1].id);

    await withStore(page, (st) => st.setActiveArtboard(st.doc.artboards[0].id));
    await runCommand(page, 'artboard.duplicate');
    abs = await artboards(page);
    expect(abs.length).toBe(3);
    s = await getState(page);
    expect(Object.values(s.doc.nodes).filter((n: any) => n.type === 'path').length).toBe(2);

    await runCommand(page, 'artboard.delete');
    abs = await artboards(page);
    expect(abs.length).toBe(2);

    // fit artboard 1 to its artwork
    await withStore(page, (st) => st.setActiveArtboard(st.doc.artboards[0].id));
    await runCommand(page, 'artboard.fitToArtwork');
    abs = await artboards(page);
    expect(Math.round(abs[0].x)).toBe(100);
    expect(Math.round(abs[0].y)).toBe(100);
    expect(Math.round(abs[0].width)).toBe(300);
    expect(Math.round(abs[0].height)).toBe(200);

    // select all on active artboard
    await withStore(page, (st) => st.clearSelection());
    await runCommand(page, 'select.allOnArtboard');
    s = await getState(page);
    expect(s.selection).toEqual([r1]);

    // convert a rectangle to an artboard
    const r2 = await drawRect(page, 3000, 3000, 500, 400);
    await withStore(page, (st) => st.setSelection([JSON.parse(JSON.stringify(st.selection))[0]]));
    await runCommand(page, 'artboard.convert');
    abs = await artboards(page);
    expect(abs.length).toBe(3);
    expect(await nodeById(page, r2)).toBeUndefined();
    const conv = abs[2];
    expect(Math.round(conv.x)).toBe(3000);
    expect(Math.round(conv.width)).toBe(500);

    // rearrange in one column with artwork
    await runCommand(page, 'artboard.rearrange');
    await expect(page.locator('[data-testid="rearrange-columns"] input')).toBeVisible();
    await page.locator('[data-testid="rearrange-columns"] input').fill('1');
    await page.locator('[data-testid="rearrange-columns"] input').press('Enter');
    await page.locator('[data-testid="rearrange-ok"]').click();
    abs = await artboards(page);
    expect(abs.every((a: any) => Math.round(a.x) === 100)).toBeTruthy();
    expect(abs[1].y).toBeGreaterThan(abs[0].y + abs[0].height);
    const rb = await worldBounds(page, r1);
    expect(Math.round(rb!.x)).toBe(100);
  });

  test('panel lists artboards, activates, renames and reorders; options dialog edits size', async ({ page }) => {
    await runCommand(page, 'artboard.new');
    await runCommand(page, 'artboard.new');
    const panel = page.locator('[data-testid="artboards-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.ab-row')).toHaveCount(3);
    await panel.locator('[data-testid="artboard-row-0"]').click();
    let s = await getState(page);
    expect(s.activeArtboardId).toBe(s.doc.artboards[0].id);

    // rename via double-click
    await panel.locator('[data-testid="artboard-row-0"] .ab-name').dblclick();
    await panel.locator('.ab-name-input').fill('Cover');
    await panel.locator('.ab-name-input').press('Enter');
    let abs = await artboards(page);
    expect(abs[0].name).toBe('Cover');

    // move down
    await panel.locator('[data-testid="artboards-down"]').click();
    abs = await artboards(page);
    expect(abs[1].name).toBe('Cover');

    // options dialog
    await runCommand(page, 'artboard.options');
    await page.locator('[data-testid="ab-opt-w"] input').fill('800');
    await page.locator('[data-testid="ab-opt-w"] input').press('Enter');
    await page.locator('[data-testid="ab-opt-h"] input').fill('600');
    await page.locator('[data-testid="ab-opt-h"] input').press('Enter');
    await page.locator('[data-testid="artboard-options-ok"]').click();
    abs = await artboards(page);
    const cover = abs.find((a: any) => a.name === 'Cover');
    expect(cover.width).toBe(800);
    expect(cover.height).toBe(600);

    // delete via panel
    await panel.locator('[data-testid="artboards-delete"]').click();
    abs = await artboards(page);
    expect(abs.length).toBe(2);
    s = await getState(page);
    expect(s.doc.artboards.some((a: any) => a.id === s.activeArtboardId)).toBeTruthy();
    void clickWorld;
  });
});
