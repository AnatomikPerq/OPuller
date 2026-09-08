/**
 * Live Paint (make / bucket / selection / release) and Graphs (tool, data and
 * type dialogs, regenerate).
 */
import { test } from '@playwright/test';
import { openApp, expect, getState, runCommand, dragWorld, selectTool, nodeById, clickWorld } from './helpers';

test.describe('live paint', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('make a Live Paint group from overlapping circles, paint faces and edges with the bucket, release', async ({ page }) => {
    const ids = await page.evaluate(() => {
      const api = (window as any).__opuller.mcp;
      const a = api.createShape({ kind: 'circle', cx: 200, cy: 200, r: 100, fill: '#ffffff', stroke: '#000000', name: 'A' });
      const b = api.createShape({ kind: 'circle', cx: 300, cy: 200, r: 100, fill: '#ffffff', stroke: '#000000', name: 'B' });
      (window as any).__opuller.store.getState().setSelection([a.id, b.id]);
      return [a.id, b.id];
    });
    await runCommand(page, 'livepaint.make');
    let s = await getState(page);
    const gid = s.selection[0];
    const g = s.doc.nodes[gid];
    expect(g.type).toBe('group');
    expect(g.data.livePaint).toBe(true);
    const faces = g.children.filter((c: string) => s.doc.nodes[c].data?.lpKind === 'face');
    const edges = g.children.filter((c: string) => s.doc.nodes[c].data?.lpKind === 'edge');
    expect(faces).toHaveLength(3);
    expect(edges.length).toBeGreaterThanOrEqual(4);
    expect(s.doc.nodes[ids[0]]).toBeUndefined();
    // bucket: set the fill colour, click the lens (centre 250,200) and the left lobe
    await page.evaluate(() => (window as any).__opuller.store.getState().setAppearance({ fill: { type: 'solid', color: '#ff0000', opacity: 1 } }));
    await selectTool(page, 'livepaint');
    await clickWorld(page, 250, 200);
    await page.evaluate(() => (window as any).__opuller.store.getState().setAppearance({ fill: { type: 'solid', color: '#0000ff', opacity: 1 } }));
    await clickWorld(page, 140, 200);
    s = await getState(page);
    const fills = faces.map((f: string) => s.doc.nodes[f].fill.color).sort();
    expect(fills).toEqual(['#0000ff', '#ff0000', '#ffffff']);
    expect(s.past[s.past.length - 1].label).toBe('Live Paint');
    // drag across two faces paints both in one step
    await page.evaluate(() => (window as any).__opuller.store.getState().setAppearance({ fill: { type: 'solid', color: '#00ff00', opacity: 1 } }));
    const steps0 = s.past.length;
    await dragWorld(page, { x: 140, y: 200 }, { x: 360, y: 200 }, { steps: 12 });
    s = await getState(page);
    expect(faces.every((f: string) => s.doc.nodes[f].fill.color === '#00ff00')).toBe(true);
    expect(s.past.length).toBe(steps0 + 1);
    // paint an edge: click on the left circle's outline (100,200) with a red stroke
    await page.evaluate(() => (window as any).__opuller.store.getState().setAppearance({ stroke: { ...(window as any).__opuller.store.getState().appearance.stroke, paint: { type: 'solid', color: '#ff00ff', opacity: 1 }, width: 3 } }));
    await clickWorld(page, 100, 200);
    s = await getState(page);
    expect(edges.some((e: string) => s.doc.nodes[e].stroke.paint.color === '#ff00ff')).toBe(true);
    // live paint selection tool selects a face; release restores plain paths
    await selectTool(page, 'livepaintSelect');
    await clickWorld(page, 250, 200);
    s = await getState(page);
    expect(faces).toContain(s.selection[0]);
    await runCommand(page, 'livepaint.release');
    s = await getState(page);
    expect(s.doc.nodes[gid]).toBeUndefined();
    expect(s.doc.nodes[faces[0]].data?.lpKind).toBeUndefined();
  });
});

test.describe('graphs', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('graph tool creates a graph, data dialog edits values, type dialog switches to pie', async ({ page }) => {
    await selectTool(page, 'graph');
    await dragWorld(page, { x: 100, y: 100 }, { x: 500, y: 400 }, { steps: 6 });
    await expect(page.getByTestId('graph-data-ok')).toBeVisible();
    let s = await getState(page);
    const gid = s.selection[0];
    expect(s.doc.nodes[gid].data.graph.type).toBe('column');
    expect(s.doc.nodes[gid].data.frame).toEqual({ width: 400, height: 300 });
    // edit a value and a series name, add a row
    await page.getByTestId('graph-cell-0-0').fill('40');
    await page.getByTestId('graph-series-0').fill('Sales');
    await page.getByTestId('graph-add-row').click();
    await page.getByTestId('graph-data-ok').click();
    s = await getState(page);
    const spec = s.doc.nodes[gid].data.graph;
    expect(spec.data[0][0]).toBe(40);
    expect(spec.series[0]).toBe('Sales');
    expect(spec.data).toHaveLength(5);
    expect(s.doc.nodes[gid].children.length).toBeGreaterThan(10);
    expect(s.past[s.past.length - 1].label).toBe('Graph Data');
    // legend text exists on the canvas
    const names = s.doc.nodes[gid].children.map((c: string) => s.doc.nodes[c].name);
    expect(names).toContain('Legend Sales');
    // type dialog: switch to pie and cancel restores column
    await runCommand(page, 'graph.type');
    await page.locator('#graph-type').selectOption('pie');
    await expect.poll(async () => (await nodeById(page, gid)).data.graph.type).toBe('pie');
    await page.keyboard.press('Escape');
    expect((await nodeById(page, gid)).data.graph.type).toBe('column');
    await runCommand(page, 'graph.type');
    await page.locator('#graph-type').selectOption('line');
    await page.getByTestId('graph-type-ok').click();
    s = await getState(page);
    expect(s.doc.nodes[gid].data.graph.type).toBe('line');
    expect(s.doc.nodes[gid].children.some((c: string) => s.doc.nodes[c].name === 'Marker')).toBe(true);
    // paste text data
    await runCommand(page, 'graph.data');
    await page.getByRole('button', { name: /Text \/ paste/ }).click();
    await page.getByTestId('graph-raw').fill('\tA\tB\nx\t1\t2\ny\t3\t4');
    await page.getByTestId('graph-raw-apply').click();
    await page.getByTestId('graph-data-ok').click();
    s = await getState(page);
    expect(s.doc.nodes[gid].data.graph.categories).toEqual(['x', 'y']);
    expect(s.doc.nodes[gid].data.graph.series).toEqual(['A', 'B']);
  });
});
