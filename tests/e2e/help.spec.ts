import { test } from '@playwright/test';
import { openApp, expect, getState, withStore, runCommand, drawRect } from './helpers';

test.describe('help, preferences, samples and the scripting API', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('preferences dialog edits prefs; shortcuts and about dialogs open', async ({ page }) => {
    await runCommand(page, 'edit.preferences');
    await expect(page.getByTestId('prefs-close')).toBeVisible();
    await page.getByTestId('pref-nudge').fill('5');
    await page.getByTestId('pref-nudge').press('Enter');
    expect((await getState(page)).prefs.nudge).toBe(5);
    await page.getByTestId('prefs-close').click();
    await runCommand(page, 'help.shortcuts');
    await expect(page.locator('.shortcuts-dialog')).toBeVisible();
    await expect(page.locator('.shortcut-table').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await runCommand(page, 'help.about');
    await expect(page.locator('.about-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('welcome screen opens the bird sample built with pathfinder', async ({ page }) => {
    await runCommand(page, 'help.welcome');
    await expect(page.getByTestId('welcome-sample-bird')).toBeVisible();
    await page.getByTestId('welcome-sample-bird').click();
    await expect.poll(async () => (await getState(page)).doc.name).toBe('Bird from circles');
    const s = await getState(page);
    expect(s.doc.layers.length).toBe(2);
    const bird: any = Object.values(s.doc.nodes).find((n: any) => n.type === 'path' && n.name === 'Bird');
    expect(bird).toBeTruthy();
    expect(bird.subpaths[0].closed).toBe(true);
    expect(bird.subpaths[0].anchors.length).toBeGreaterThan(20);
    const circles = Object.values(s.doc.nodes).filter((n: any) => n.type === 'path' && n.shape?.kind === 'ellipse');
    expect(circles.length).toBe(13);
    await runCommand(page, 'file.sample.showcase');
    await expect.poll(async () => (await getState(page)).doc.name).toBe('Showcase');
  });

  test('scripting API (MCP bridge): create, combine, gesture, render', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      const st = api.status({});
      const a = api.createShape({ kind: 'circle', cx: 300, cy: 300, r: 100, fill: '#1da1f2', stroke: 'none', name: 'A' });
      const b = api.createShape({ kind: 'circle', cx: 380, cy: 260, r: 90, fill: '#ff0000', stroke: 'none', name: 'B' });
      const pf = api.pathfinder({ op: 'minusFront', ids: [a.id, b.id] });
      const tree = api.getTree({ depth: 2 });
      const g = await api.gesture({ tool: 'rect', points: [{ x: 600, y: 100 }, { x: 800, y: 250 }] });
      const png = await api.renderPng({ scope: 'selection', scale: 0.5 });
      const upd = api.updateNodes({ ids: g.selection, patch: { fill: '#00ff00', opacity: 0.5, name: 'Scripted' } });
      const k = await api.key({ keys: ['mod+z'] });
      const cmds = api.listCommands({ menu: 'Object/Path' });
      return { st, a, pf, treeCount: tree.length, g, pngPrefix: png.dataUrl.slice(0, 22), pngW: png.width, upd, k, cmdCount: cmds.length };
    });
    expect(res.st.document.artboards.length).toBe(1);
    expect(res.a.type).toBe('path');
    expect(res.pf.changed).toBe(true);
    expect(res.pf.selection.length).toBe(1);
    expect(res.treeCount).toBe(1);
    expect(res.g.selection.length).toBe(1);
    expect(res.pngPrefix).toBe('data:image/png;base64,');
    expect(res.pngW).toBeGreaterThan(50);
    expect(res.upd[0].name).toBe('Scripted');
    expect(res.upd[0].opacity).toBe(0.5);
    expect(res.cmdCount).toBeGreaterThan(5);
    const s = await getState(page);
    const scripted: any = Object.values(s.doc.nodes).find((n: any) => n.name === 'Scripted');
    // the undo (mod+z) reverted the update
    expect(scripted).toBeUndefined();
    const rect: any = Object.values(s.doc.nodes).find((n: any) => n.type === 'path' && n.shape?.kind === 'rect');
    expect(rect).toBeTruthy();
    expect(Math.round(rect.shape.width)).toBe(200);
  });

  test('window.__opuller exposes both the test api and the mcp api', async ({ page }) => {
    await drawRect(page, 10, 10, 50, 50);
    const ok = await page.evaluate(() => {
      const o = (window as any).__opuller;
      return !!o.store && !!o.mcp && typeof o.mcp.status === 'function' && Object.keys(o.mcp).length > 40;
    });
    expect(ok).toBe(true);
    await withStore(page, (st) => st.clearSelection());
  });
});
