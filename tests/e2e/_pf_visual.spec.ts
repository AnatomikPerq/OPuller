import { test } from '@playwright/test';
import { openApp, drawEllipse, drawRect, selectTool, moveWorld, viewport, worldToScreen, runCommand, withStore, setView, press } from './helpers';

const OUT = 'C:/Users/BADAB/AppData/Local/Temp/claude/C--Users-BADAB--------------OPuller/9538e8e9-28f5-4b8d-9cb3-a9e066e10c8b/scratchpad';

test('visual: menus, simplify, twitter bird performance', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type().toUpperCase() + ' ' + m.text());
  });
  await openApp(page);
  // Object menu with submenus
  const r = await drawRect(page, 500, 100, 200, 150);
  await page.evaluate((id) => (window as any).__opuller.store.getState().setSelection([id]), r);
  await page.locator('.menubar .menu-trigger', { hasText: 'Object' }).dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Pathfinder' }).first().hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/10-object-menu.png` });
  await page.locator('.menu-item', { hasText: 'Path' }).first().hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/11-object-path-menu.png` });
  await press(page, 'Escape');
  // simplify preview on a rectangle with added anchors
  await runCommand(page, 'path.addAnchors');
  await runCommand(page, 'path.simplify');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/12-simplify.png` });
  await page.getByTestId('simplify-cancel').click();

  // twitter bird style: 9 overlapping circles
  await page.evaluate(() => (window as any).__opuller.store.getState().setSelection([]));
  const circles: Array<[number, number, number]> = [
    [200, 350, 120], [300, 300, 140], [420, 320, 120], [520, 380, 100], [260, 450, 110], [380, 460, 130], [470, 520, 90], [180, 500, 80], [330, 560, 100],
  ];
  const ids: string[] = [];
  for (const [x, y, d] of circles) ids.push(await drawEllipse(page, x, y, d, d));
  await withStore(page, (s) => s.updateDoc((d: any) => {
    const colors = ['#1da1f2', '#0d8ddb', '#5ec2ff', '#1da1f2', '#3aa7f0', '#1a8fd8', '#7fd0ff', '#1da1f2', '#2b9de8'];
    Object.values(d.nodes).filter((n: any) => n.type === 'path').forEach((n: any, i: number) => { n.fill = { type: 'solid', color: colors[i % colors.length], opacity: 1 }; n.stroke.width = 1; });
  }, 'Fill'));
  await page.evaluate((ids) => (window as any).__opuller.store.getState().setSelection(ids), ids);
  const t0 = Date.now();
  await selectTool(page, 'shapebuilder');
  await page.getByTestId('shapebuilder-count').waitFor();
  const text = await page.getByTestId('shapebuilder-count').textContent();
  const t1 = Date.now();
  console.log('FACES', text, 'ms', t1 - t0);
  // hover timing
  const t2 = Date.now();
  for (let i = 0; i < 20; i++) await moveWorld(page, 250 + i * 12, 400 + (i % 3) * 10);
  console.log('20 hovers ms', Date.now() - t2);
  await page.screenshot({ path: `${OUT}/13-bird-hover.png` });
  // drag across several regions
  const box = (await viewport(page).boundingBox())!;
  const a = await worldToScreen(page, 240, 400);
  const b = await worldToScreen(page, 480, 420);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + a.x + ((b.x - a.x) * i) / 12, box.y + a.y + ((b.y - a.y) * i) / 12);
  await page.screenshot({ path: `${OUT}/14-bird-drag.png` });
  const t3 = Date.now();
  await page.mouse.up();
  await page.waitForTimeout(50);
  console.log('merge ms', Date.now() - t3, await page.getByTestId('shapebuilder-count').textContent());
  await page.screenshot({ path: `${OUT}/15-bird-merged.png` });
  await setView(page, 4, { x: -600, y: -1200 });
  await moveWorld(page, 300, 420);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/16-bird-zoom4.png` });
  console.log('ERRORS', JSON.stringify(errors.slice(0, 10)));
});
