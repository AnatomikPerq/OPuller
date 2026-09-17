import { test, expect } from '@playwright/test';
import { openApp, drawRect, drawEllipse, getState, selectTool, clickWorld, dragWorld, nodeById, selection, press, worldBounds } from './helpers';

test.describe('core editor', () => {
  test('draws, selects, moves, scales and undoes a rectangle', async ({ page }) => {
    await openApp(page);
    const id = await drawRect(page, 100, 100, 200, 120);
    expect(id).toBeTruthy();
    let n = await nodeById(page, id);
    expect(n.type).toBe('path');
    expect(n.shape.kind).toBe('rect');
    expect(Math.round(n.shape.width)).toBe(200);
    expect(Math.round(n.shape.height)).toBe(120);

    // move with the selection tool
    await selectTool(page, 'select');
    await dragWorld(page, { x: 200, y: 160 }, { x: 260, y: 200 });
    let b = await worldBounds(page, id);
    expect(b).not.toBeNull();
    expect(Math.round(b!.x)).toBe(160);
    expect(Math.round(b!.y)).toBe(140);

    // scale via the south-east handle
    await dragWorld(page, { x: 360, y: 260 }, { x: 460, y: 320 });
    b = await worldBounds(page, id);
    expect(Math.round(b!.width)).toBe(300);
    expect(Math.round(b!.height)).toBe(180);

    // undo twice restores the original position
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(100);
    expect(Math.round(b!.width)).toBe(200);

    // redo
    await press(page, 'Control+Shift+z');
    b = await worldBounds(page, id);
    expect(Math.round(b!.x)).toBe(160);
  });

  test('rulers span the whole viewport edge and draw ticks along it', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => {
      const vp = document.querySelector('[data-testid="viewport"]') as HTMLElement;
      const h = document.querySelector('canvas.ruler-h') as HTMLCanvasElement;
      const v = document.querySelector('canvas.ruler-v') as HTMLCanvasElement;
      const box = vp.getBoundingClientRect();
      // count tick columns / rows: pixels darker or lighter than the ruler background along the inner edge
      const ticks = (c: HTMLCanvasElement, vertical: boolean) => {
        const ctx = c.getContext('2d')!;
        const dpr = window.devicePixelRatio || 1;
        const len = vertical ? c.height : c.width;
        const inner = Math.round(16 * dpr); // inside the tick zone, above the edge line
        const px = vertical ? ctx.getImageData(inner, 0, 1, len).data : ctx.getImageData(0, inner, len, 1).data;
        // the most common colour of the row is the ruler background; everything else is a tick
        const hist = new Map<string, number>();
        const keys: string[] = [];
        for (let i = 0; i < px.length; i += 4) {
          const k = `${px[i]},${px[i + 1]},${px[i + 2]}`;
          keys.push(k);
          hist.set(k, (hist.get(k) ?? 0) + 1);
        }
        const bg = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return keys.filter((k) => k !== bg).length;
      };
      return { vw: v.clientWidth, vh: v.clientHeight, hw: h.clientWidth, hh: h.clientHeight, vpW: box.width, vpH: box.height, vTicks: ticks(v, true), hTicks: ticks(h, false) };
    });
    expect(r.hh).toBe(20);
    expect(r.vw).toBe(20);
    expect(Math.abs(r.hw - r.vpW)).toBeLessThan(2);
    expect(Math.abs(r.vh - r.vpH)).toBeLessThan(2); // the vertical ruler used to be a 20 px stub
    expect(r.hTicks).toBeGreaterThan(20);
    expect(r.vTicks).toBeGreaterThan(20);
  });

  test('marquee selection, shift-click and delete', async ({ page }) => {
    await openApp(page);
    const a = await drawRect(page, 100, 100, 50, 50);
    const b = await drawEllipse(page, 300, 100, 60, 60);
    await selectTool(page, 'select');
    await clickWorld(page, 500, 500); // deselect
    expect(await selection(page)).toEqual([]);
    await dragWorld(page, { x: 80, y: 80 }, { x: 400, y: 200 });
    expect((await selection(page)).sort()).toEqual([a, b].sort());
    await clickWorld(page, 600, 600);
    await clickWorld(page, 125, 125);
    expect(await selection(page)).toEqual([a]);
    await clickWorld(page, 330, 130, { modifiers: ['Shift'] });
    expect((await selection(page)).sort()).toEqual([a, b].sort());
    await press(page, 'Delete');
    const s = await getState(page);
    expect(s.doc.nodes[a]).toBeUndefined();
    expect(s.doc.nodes[b]).toBeUndefined();
  });

  test('tool shortcuts and menus work', async ({ page }) => {
    await openApp(page);
    await page.mouse.click(400, 400);
    await press(page, 'l');
    expect((await getState(page)).activeTool).toBe('ellipse');
    await press(page, 'v');
    expect((await getState(page)).activeTool).toBe('select');
    await page.getByRole('button', { name: 'View', exact: true }).dispatchEvent('pointerdown');
    await expect(page.locator('.menu')).toBeVisible();
    await page.locator('.menu-item', { hasText: 'Show Grid' }).click();
    expect((await getState(page)).view.grid).toBe(true);
  });
});
