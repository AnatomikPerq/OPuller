/**
 * Symbols: panel, make / place / edit / break, the Symbol Sprayer tool and the
 * scripting API.
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, drawRect, dragWorld, selectTool, nodeById } from './helpers';

test.describe('symbols', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('make a symbol from the selection, place instances, edit in isolation updates all, break link', async ({ page }) => {
    const id = await drawRect(page, 100, 100, 80, 60);
    await runCommand(page, 'symbol.make');
    let s = await getState(page);
    expect(s.doc.symbols).toHaveLength(1);
    const symbolId = s.doc.symbols[0].id;
    expect(s.doc.nodes[id]).toBeUndefined();
    const inst1 = s.selection[0];
    expect(s.doc.nodes[inst1].data.symbol.id).toBe(symbolId);
    // panel shows it and Place adds a second instance at the artboard centre
    await page.getByTestId('panel-tab-symbols').click();
    await expect(page.getByTestId(`symbol-${symbolId}`)).toBeVisible();
    await page.getByTestId('symbols-place').click();
    s = await getState(page);
    const inst2 = s.selection[0];
    expect(inst2).not.toBe(inst1);
    expect(Object.values(s.doc.nodes).filter((n: any) => n.data?.symbol?.id === symbolId)).toHaveLength(2);
    // edit the symbol through isolation: recolour the child of instance 1, then exit
    await page.evaluate((inst) => {
      const st = (window as any).__opuller.store.getState();
      st.setSelection([inst]);
      st.setIsolation(inst);
    }, inst1);
    await page.evaluate((inst) => {
      const st = (window as any).__opuller.store.getState();
      const child = st.doc.nodes[inst].children[0];
      st.updateDoc((d: any) => {
        d.nodes[child].fill = { type: 'solid', color: '#00ff00', opacity: 1 };
      }, 'Fill');
    }, inst1);
    await page.evaluate(() => (window as any).__opuller.store.getState().setIsolation(null));
    await expect.poll(async () => {
      const st = await getState(page);
      const child = st.doc.nodes[inst2].children[0];
      return st.doc.nodes[child].fill.color;
    }).toBe('#00ff00');
    s = await getState(page);
    expect(s.doc.symbols[0].version).toBe(2);
    expect(s.past[s.past.length - 1].label).toBe('Edit Symbol');
    // break the link on instance 2
    await page.evaluate((inst) => (window as any).__opuller.store.getState().setSelection([inst]), inst2);
    await runCommand(page, 'symbol.breakLink');
    s = await getState(page);
    expect(s.doc.nodes[inst2].data?.symbol).toBeUndefined();
    expect(s.doc.nodes[inst2].type).toBe('group');
    // select all instances finds only the linked one
    await runCommand(page, 'symbol.selectInstances');
    expect((await getState(page)).selection).toEqual([inst1]);
  });

  test('symbol sprayer creates a symbol set; library adds symbols', async ({ page }) => {
    await page.getByTestId('panel-tab-symbols').click();
    await page.getByTestId('symbols-libraries').click();
    await page.getByTestId('symbols-lib-star').click();
    let s = await getState(page);
    expect(s.doc.symbols).toHaveLength(1);
    expect(s.doc.symbols[0].name).toBe('Star');
    await selectTool(page, 'symbolSprayer');
    await dragWorld(page, { x: 200, y: 200 }, { x: 700, y: 300 }, { steps: 30 });
    s = await getState(page);
    const set = s.doc.nodes[s.selection[0]];
    expect(set.type).toBe('group');
    expect(set.data.symbolSet).toBe(true);
    expect(set.children.length).toBeGreaterThan(5);
    for (const c of set.children) expect(s.doc.nodes[c].data.symbol.id).toBe(s.doc.symbols[0].id);
    expect(s.past[s.past.length - 1].label).toBe('Spray Symbols');
    // size mode scales instances under the brush
    const before = await page.evaluate((c) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, c), set.children[0]);
    await page.evaluate(() => (window as any).__opuller.store.getState().setToolOptions('symbolSprayer', { mode: 'size', diameter: 400 }));
    const b0 = before!;
    await dragWorld(page, { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 }, { x: b0.x + b0.width / 2 + 60, y: b0.y + b0.height / 2 }, { steps: 20 });
    const after = await page.evaluate((c) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, c), set.children[0]);
    expect(after!.width).toBeGreaterThan(b0.width * 1.05);
    // expand the set turns it into a normal group
    await runCommand(page, 'symbol.expandSet');
    s = await getState(page);
    expect(s.doc.nodes[set.id].data?.symbolSet).toBeUndefined();
    // the redefined star instance keeps working after undo of the spray
    const n = await nodeById(page, set.children[0]);
    expect(n.type).toBe('group');
  });

  test('scripting API: make, place, list, redefine from selection', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const api = (window as any).__opuller.mcp;
      const a = api.createShape({ kind: 'circle', cx: 200, cy: 200, r: 40, fill: '#1da1f2', stroke: 'none' });
      const made = await api.symbols({ op: 'make', ids: [a.id], name: 'Dot' });
      const placed = await api.symbols({ op: 'place', id: made.id, x: 500, y: 500, scale: 2 });
      const list = await api.symbols({ op: 'list' });
      const lib = await api.symbols({ op: 'library', name: 'heart' });
      return { made, placed, list, lib };
    });
    expect(res.made.id).toBeTruthy();
    expect(res.placed.instance).toBeTruthy();
    expect(res.list).toHaveLength(1);
    expect(res.list[0].instances).toBe(2);
    expect(res.lib.id).toBeTruthy();
    const s = await getState(page);
    expect(s.doc.symbols).toHaveLength(2);
    const b = await page.evaluate((id) => (window as any).__opuller.worldBounds((window as any).__opuller.store.getState().doc, id), res.placed.instance);
    expect(Math.round(b!.width)).toBe(160);
  });
});
