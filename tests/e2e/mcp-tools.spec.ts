/**
 * Scripting layer (plan items 11–14): the methods behind opuller_blend, opuller_offset_path,
 * opuller_simplify, opuller_effect, opuller_align, opuller_pencil, opuller_pen, the transform
 * scale flags and pathfinder cleanup — driven through window.__opuller.mcp, which is exactly
 * what the MCP server forwards to.
 */
import { test, expect, type Page } from '@playwright/test';
import { openApp, getState, nodeById, worldBounds, press } from './helpers';

async function api(page: Page, method: string, args: Record<string, unknown> = {}): Promise<any> {
  return page.evaluate(({ method, args }) => (window as any).__opuller.mcp[method](args), { method, args });
}

async function label(page: Page): Promise<string> {
  const s = await getState(page);
  return s.past[s.past.length - 1]?.label;
}

test.describe('scripting tools', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('blend: make with steps, options, expand (plan item 11)', async ({ page }) => {
    const a = await api(page, 'createShape', { kind: 'circle', cx: 100, cy: 100, r: 20, fill: '#ff0000', stroke: 'none', name: 'A' });
    const b = await api(page, 'createShape', { kind: 'circle', cx: 400, cy: 100, r: 20, fill: '#0000ff', stroke: 'none', name: 'B' });
    const r = await api(page, 'blend', { op: 'make', ids: [a.id, b.id], steps: 6 });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].children).toBe(8); // two sources + six steps
    expect(r.groups[0].blend.steps).toBe(6);
    expect(await label(page)).toBe('Make Blend');
    const r2 = await api(page, 'blend', { op: 'options', ids: [r.groups[0].id], steps: 3 });
    expect(r2.groups[0].children).toBe(5);
    expect(await label(page)).toBe('Blend Options');
    // the same through runCommand with an argument (no dialog opens)
    await api(page, 'runCommand', { id: 'blend.options', arg: { spacing: 'distance', distance: 60 } });
    expect((await getState(page)).dialog).toBeNull();
    expect((await nodeById(page, r.groups[0].id)).data.blend.spacing).toBe('distance');
    const r3 = await api(page, 'blend', { op: 'expand', ids: [r.groups[0].id] });
    expect(r3.selection.length).toBeGreaterThanOrEqual(1);
    expect((await getState(page)).doc.nodes[r.groups[0].id]?.data?.blend).toBeUndefined();
  });

  test('offset path and simplify without dialogs, also via runCommand(id, arg)', async ({ page }) => {
    const rect = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 200, height: 100, fill: '#cccccc', stroke: 'none', name: 'R' });
    const off = await api(page, 'offsetPath', { ids: [rect.id], distance: 10, join: 'round' });
    expect(off.created).toHaveLength(1);
    const b = (await worldBounds(page, off.created[0]))!;
    expect(b.width).toBeCloseTo(220, 1);
    expect(b.height).toBeCloseTo(120, 1);
    expect((await nodeById(page, rect.id)).name).toBe('R'); // original kept (mode new)
    expect(await label(page)).toBe('Offset Path');
    await api(page, 'runCommand', { id: 'path.offset', arg: { distance: -5, mode: 'replace', ids: [rect.id] } });
    expect((await getState(page)).dialog).toBeNull();
    const b2 = (await worldBounds(page, rect.id))!;
    expect(b2.width).toBeCloseTo(190, 1);
    // simplify a dense polyline
    const pts: string[] = [];
    for (let i = 0; i <= 200; i++) pts.push(`${100 + i * 2} ${400 + Math.sin(i / 10) * 40}`);
    const dense = await api(page, 'createPath', { d: 'M' + pts.join(' L'), fill: 'none', stroke: '#000000', name: 'Dense' });
    const before = (await nodeById(page, dense.id)).subpaths[0].anchors.length;
    expect(before).toBe(201);
    const s = await api(page, 'simplify', { ids: [dense.id], tolerance: 1 });
    expect(s.before).toBe(201);
    expect(s.after).toBeLessThan(40);
    expect(await label(page)).toBe('Simplify');
    const after = (await nodeById(page, dense.id)).subpaths[0].anchors.length;
    expect(after).toBe(s.after);
    // the simplified curve stays close to the original wave
    const bb = (await worldBounds(page, dense.id))!;
    expect(bb.height).toBeGreaterThan(70);
    expect(bb.height).toBeLessThan(90);
  });

  test('effects: add / update / remove / list / expand', async ({ page }) => {
    const rect = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 200, height: 100, fill: '#cccccc', stroke: 'none', name: 'R' });
    const r = await api(page, 'effect', { op: 'add', ids: [rect.id], type: 'zigZag', params: { size: 5, ridges: 2 } });
    expect(r.nodes[0].effects).toHaveLength(1);
    expect(r.nodes[0].effects[0]).toMatchObject({ index: 0, type: 'zigZag', size: 5, ridges: 2, smooth: false, enabled: true });
    expect(await label(page)).toBe('Zig Zag');
    const r2 = await api(page, 'effect', { op: 'add', ids: [rect.id], type: 'roundCorners', params: { radius: 12 } });
    expect(r2.nodes[0].effects.map((e: any) => e.type)).toEqual(['zigZag', 'roundCorners']);
    const r3 = await api(page, 'effect', { op: 'update', ids: [rect.id], type: 'zigZag', params: { ridges: 5, smooth: true } });
    expect(r3.nodes[0].effects[0]).toMatchObject({ ridges: 5, smooth: true, size: 5 });
    const list = await api(page, 'effect', { op: 'list', ids: [rect.id] });
    expect(list.nodes[0].effects).toHaveLength(2);
    const r4 = await api(page, 'effect', { op: 'remove', ids: [rect.id], index: 1 });
    expect(r4.nodes[0].effects.map((e: any) => e.type)).toEqual(['zigZag']);
    await expect(api(page, 'effect', { op: 'add', ids: [rect.id], type: 'nope' })).rejects.toThrow(/Unknown effect type/);
    const r5 = await api(page, 'effect', { op: 'expand', ids: [rect.id] });
    expect(r5.nodes[0].effects ?? []).toHaveLength(0);
    const n = await nodeById(page, rect.id);
    expect(n.effects).toHaveLength(0);
    expect(n.subpaths[0].anchors.length).toBeGreaterThan(4);
  });

  test('align and distribute (plan item 12)', async ({ page }) => {
    const a = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 50, height: 50, fill: '#ff0000', stroke: 'none', name: 'A' });
    const b = await api(page, 'createShape', { kind: 'rect', x: 300, y: 200, width: 80, height: 30, fill: '#00ff00', stroke: 'none', name: 'B' });
    const c = await api(page, 'createShape', { kind: 'rect', x: 700, y: 150, width: 40, height: 40, fill: '#0000ff', stroke: 'none', name: 'C' });
    const r = await api(page, 'align', { ids: [a.id, b.id, c.id], v: 'middle' });
    expect(r.done).toEqual(['Align vertical centers']);
    const ya = (await worldBounds(page, a.id))!;
    const yb = (await worldBounds(page, b.id))!;
    expect(ya.y + ya.height / 2).toBeCloseTo(yb.y + yb.height / 2, 3);
    // align to the artboard: left edges at 0
    await api(page, 'align', { ids: [a.id, b.id], h: 'left', to: 'artboard' });
    expect((await worldBounds(page, a.id))!.x).toBeCloseTo(0, 3);
    expect((await worldBounds(page, b.id))!.x).toBeCloseTo(0, 3);
    // key object: B stays, A moves to its right edge
    await api(page, 'align', { ids: [a.id, b.id], h: 'right', to: 'key', key: b.id });
    const bb = (await worldBounds(page, b.id))!;
    expect(bb.x).toBeCloseTo(0, 3);
    expect((await worldBounds(page, a.id))!.x + 50).toBeCloseTo(bb.x + bb.width, 3);
    // distribute with a fixed spacing along x
    await api(page, 'setBounds', { id: a.id, x: 0 });
    await api(page, 'setBounds', { id: b.id, x: 100 });
    await api(page, 'setBounds', { id: c.id, x: 500 });
    const d = await api(page, 'align', { ids: [a.id, b.id, c.id], distribute: 'h', spacing: 20 });
    expect(d.done).toEqual(['Distribute horizontal spacing']);
    const xa = (await worldBounds(page, a.id))!;
    const xb = (await worldBounds(page, b.id))!;
    const xc = (await worldBounds(page, c.id))!;
    expect(xb.x - (xa.x + xa.width)).toBeCloseTo(20, 3);
    expect(xc.x - (xb.x + xb.width)).toBeCloseTo(20, 3);
    await press(page, 'Control+z');
    expect((await worldBounds(page, c.id))!.x).toBeCloseTo(500, 3);
  });

  test('pencil fits points, pen builds anchors (plan item 13)', async ({ page }) => {
    await api(page, 'setAppearance', { fill: '#ff8800', stroke: { color: '#000000', width: 2 } });
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 60; i++) pts.push([100 + i * 5, 300 + Math.sin(i / 6) * 50]);
    // select: false keeps the current appearance (selecting the new path would make its style current)
    const p = await api(page, 'pencil', { points: pts, fidelity: 3, smoothness: 50, select: false });
    expect(p.anchors).toBeGreaterThan(2);
    expect(p.anchors).toBeLessThan(20);
    expect(p.closed).toBe(false);
    const pn = await nodeById(page, p.id);
    expect(pn.fill.type).toBe('none');
    expect(pn.stroke.width).toBe(2);
    expect(await label(page)).toBe('Pencil');
    // a loop closes itself; fillStrokes takes the current fill
    const loop: Array<[number, number]> = [];
    for (let i = 0; i <= 40; i++) loop.push([500 + Math.cos((i / 40) * Math.PI * 2) * 60, 300 + Math.sin((i / 40) * Math.PI * 2) * 60]);
    const q = await api(page, 'pencil', { points: loop, fillStrokes: true });
    expect(q.closed).toBe(true);
    expect((await nodeById(page, q.id)).fill.color).toBe('#ff8800');
    // pen: relative handles, closed, per-anchor corner radius
    const pen = await api(page, 'pen', { anchors: [{ x: 100, y: 500 }, { x: 200, y: 400, handleIn: { x: -30, y: 0 }, handleOut: { x: 30, y: 0 }, kind: 'smooth' }, { x: 300, y: 500, cornerRadius: 10 }], closed: true, fill: '#00aaff', stroke: 'none' });
    const n = await nodeById(page, pen.id);
    expect(n.subpaths[0].closed).toBe(true);
    expect(n.subpaths[0].anchors).toHaveLength(3);
    expect(n.subpaths[0].anchors[1].kind).toBe('smooth');
    expect(n.subpaths[0].anchors[1].handleOut).toEqual({ x: 30, y: 0 });
    expect(n.subpaths[0].anchors[2].cornerRadius).toBe(10);
    expect(await label(page)).toBe('Pen');
    // absolute handles are converted
    const pen2 = await api(page, 'pen', { anchors: [{ x: 0, y: 0, handleOut: { x: 50, y: 0 } }, { x: 100, y: 100, handleIn: { x: 100, y: 50 } }], absoluteHandles: true, stroke: '#000000', fill: 'none' });
    const n2 = await nodeById(page, pen2.id);
    expect(n2.subpaths[0].anchors[1].handleIn).toEqual({ x: 0, y: -50 });
  });

  test('swatches: add, apply (linked global), update recolours, remove, libraries (plan item 15)', async ({ page }) => {
    const list0 = await api(page, 'swatches', { op: 'list' });
    const n0 = list0.swatches.length;
    const added = await api(page, 'swatches', { op: 'add', name: 'Fox', color: '#e8762b', kind: 'global' });
    expect(added.swatch).toMatchObject({ name: 'Fox', kind: 'global', paint: { type: 'solid', color: '#e8762b' } });
    expect(await label(page)).toBe('New Swatch');
    const r = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 100, height: 100, fill: '#cccccc', stroke: 'none', name: 'R' });
    const ap = await api(page, 'swatches', { op: 'apply', name: 'Fox', ids: [r.id], target: 'fill', tint: 50 });
    expect(ap.paint.swatchId).toBe(added.swatch.id);
    let n = await nodeById(page, r.id);
    expect(n.fill.swatchId).toBe(added.swatch.id);
    expect(n.fill.tint).toBe(50);
    // editing the global swatch recolours the linked object
    await api(page, 'swatches', { op: 'update', id: added.swatch.id, color: '#0044aa' });
    n = await nodeById(page, r.id);
    expect(n.fill.color).not.toBe('#e8762b');
    const sel = await api(page, 'swatches', { op: 'select', name: 'Fox' });
    expect(sel.selection).toEqual([r.id]);
    await api(page, 'swatches', { op: 'rename', name: 'Fox', newName: 'Fox orange' });
    expect((await api(page, 'swatches', { op: 'list' })).swatches.some((x: any) => x.name === 'Fox orange')).toBe(true);
    const libs = await api(page, 'swatches', { op: 'libraries' });
    expect(libs.libraries.length).toBeGreaterThan(0);
    const before = (await api(page, 'swatches', { op: 'list' })).swatches.length;
    await api(page, 'swatches', { op: 'addLibrary', library: libs.libraries[0].id });
    expect((await api(page, 'swatches', { op: 'list' })).swatches.length).toBeGreaterThan(before);
    await api(page, 'swatches', { op: 'remove', name: 'Fox orange' });
    expect((await api(page, 'swatches', { op: 'list' })).swatches.some((x: any) => x.name === 'Fox orange')).toBe(false);
    expect((await api(page, 'swatches', { op: 'list' })).swatches.length).toBeGreaterThanOrEqual(n0);
    // the project keeps the palette
    const json = await page.evaluate(async () => (await (window as any).__opuller.mcp.getProject({})).json as string);
    expect(json).toContain('"swatches"');
  });

  test('fonts: list families, load a font file, use it, remove it (plan item 16)', async ({ page }) => {
    const list = await api(page, 'fonts', { op: 'list' });
    expect(list.families.some((f: any) => f.family === 'Inter' && f.outlines)).toBe(true);
    expect(list.families.some((f: any) => f.source === 'system')).toBe(true);
    // load a bundled TTF through the same path the MCP server uses (base64 bytes)
    const b64 = await page.evaluate(async () => {
      const res = await fetch('/node_modules/@fontsource/oswald/files/oswald-latin-400-normal.woff');
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    });
    const loaded = await api(page, 'fonts', { op: 'load', name: 'Champion-Test.woff', base64: b64 });
    expect(loaded.loaded.family).toBeTruthy();
    const fam = loaded.loaded.family as string;
    const after = await api(page, 'fonts', { op: 'list' });
    expect(after.uploaded.some((u: any) => u.family === fam)).toBe(true);
    const t = await api(page, 'createText', { x: 100, y: 200, text: 'Champion', fontFamily: fam, fontSize: 40, fill: '#000000' });
    expect((await nodeById(page, t.id)).style.fontFamily).toBe(fam);
    await api(page, 'fonts', { op: 'remove', family: fam });
    expect((await api(page, 'fonts', { op: 'list' })).uploaded.some((u: any) => u.family === fam)).toBe(false);
  });

  test('ids that exist no more are an error, not a fallback to the selection', async ({ page }) => {
    const a = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 50, height: 50, fill: '#ff0000', stroke: 'none', name: 'A' });
    const b = await api(page, 'createShape', { kind: 'rect', x: 300, y: 100, width: 50, height: 50, fill: '#00ff00', stroke: 'none', name: 'B' });
    await api(page, 'select', { ids: [a.id, b.id] });
    const before = (await getState(page)).docVersion;
    await expect(api(page, 'corners', { ids: ['nope'], radius: 5 })).rejects.toThrow(/Unknown node ids: nope/);
    await expect(api(page, 'setAppearance', { ids: ['nope'], target: 'selection', fill: '#000000' })).rejects.toThrow(/Unknown node ids/);
    await expect(api(page, 'align', { ids: ['gone'], h: 'left' })).rejects.toThrow(/Unknown node ids/);
    await expect(api(page, 'effect', { id: 'gone', op: 'list' })).rejects.toThrow(/Unknown node id "gone"/);
    await expect(api(page, 'transform', { ids: ['gone'], scale: 2 })).rejects.toThrow(/Unknown node ids/);
    await expect(api(page, 'pathfinder', { ids: ['x', 'y'], op: 'unite' })).rejects.toThrow(/Unknown node ids/);
    // nothing happened to the selected objects
    expect((await getState(page)).docVersion).toBe(before);
    expect((await nodeById(page, a.id)).fill.color).toBe('#ff0000');
    // a mix of known and unknown ids acts on the known ones
    const r = await api(page, 'corners', { ids: [a.id, 'nope'], radius: 5 });
    expect(r.corners).toBe(4);
    expect((await nodeById(page, a.id)).shape.radii).toEqual([5, 5, 5, 5]);
    expect((await nodeById(page, b.id)).shape.radii).toEqual([0, 0, 0, 0]);
  });

  test('setAppearance on objects patches each object; unknown params and command errors are reported', async ({ page }) => {
    const a = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 50, height: 50, fill: '#ff0000', stroke: { color: '#0000ff', width: 2, dash: [4, 2] }, name: 'A' });
    const b = await api(page, 'createShape', { kind: 'rect', x: 300, y: 100, width: 50, height: 50, fill: '#00ff00', stroke: { color: '#ff00ff', width: 3 }, name: 'B' });
    // a stroke width for the selection keeps every object's own colour and dash
    const r = await api(page, 'setAppearance', { ids: [a.id, b.id], target: 'selection', stroke: { width: 7 } });
    expect(r.applied).toHaveLength(2);
    const na = await nodeById(page, a.id);
    const nb = await nodeById(page, b.id);
    expect(na.stroke.width).toBe(7);
    expect(na.stroke.paint.color).toBe('#0000ff');
    expect(na.stroke.dash).toEqual([4, 2]);
    expect(nb.stroke.width).toBe(7);
    expect(nb.stroke.paint.color).toBe('#ff00ff');
    expect(na.fill.color).toBe('#ff0000');
    // the defaults were not touched by target "selection"
    expect((await getState(page)).appearance.stroke.width).not.toBe(7);
    await expect(api(page, 'setAppearance', { ids: [a.id], target: 'selection', stroke: { width: 'thick' } })).resolves.toBeTruthy();
    // nothing selected and no ids: an error rather than a silent no-op
    await api(page, 'select', { ids: [] });
    await expect(api(page, 'setAppearance', { target: 'selection', fill: '#000000' })).rejects.toThrow(/No paths or text/);
    // effect params are checked against the effect's fields
    await expect(api(page, 'effect', { op: 'add', ids: [a.id], type: 'zigZag', params: { ridgez: 3 } })).rejects.toThrow(/no parameter "ridgez"/);
    await expect(api(page, 'effect', { op: 'add', ids: [a.id], type: 'zigZag', params: { size: 'big' } })).rejects.toThrow(/"size" must be a number/);
    await expect(api(page, 'effect', { op: 'add', ids: [a.id], type: 'zigZag', params: { smooth: 'yes' } })).rejects.toThrow(/"smooth" must be true or false/);
    const ok = await api(page, 'effect', { op: 'add', ids: [a.id], type: 'zigZag', params: { size: '6', ridges: 2, smooth: true } });
    expect(ok.nodes[0].effects[0]).toMatchObject({ type: 'zigZag', size: 6, ridges: 2, smooth: true });
    await expect(api(page, 'effect', { op: 'update', ids: [a.id], type: 'zigZag', params: { bogus: 1 } })).rejects.toThrow(/no parameter "bogus"/);
    // a command that fails on its argument reports the failure (the menu path would toast it)
    await api(page, 'select', { ids: [a.id] });
    await expect(api(page, 'runCommand', { id: 'path.simplify', arg: { tolerance: -1 } })).rejects.toThrow(/positive "tolerance"/);
    expect((await nodeById(page, a.id)).effects).toHaveLength(1);
  });

  test('blend: make with options in one step, options only on a blend, an already aligned selection reports no steps', async ({ page }) => {
    const a = await api(page, 'createShape', { kind: 'circle', cx: 100, cy: 300, r: 20, fill: '#ff0000', stroke: 'none', name: 'A' });
    const b = await api(page, 'createShape', { kind: 'circle', cx: 400, cy: 300, r: 20, fill: '#0000ff', stroke: 'none', name: 'B' });
    await expect(api(page, 'blend', { op: 'options', ids: [a.id, b.id], steps: 4 })).rejects.toThrow(/No blend in the selection/);
    expect((await getState(page)).past.map((h: any) => h.label)).not.toContain('Make Blend');
    const made = await api(page, 'blend', { op: 'make', ids: [a.id, b.id], spacing: 'distance', distance: 50, colors: false });
    expect(made.groups[0].blend.spacing).toBe('distance');
    expect(made.groups[0].blend.distance).toBe(50);
    expect(made.groups[0].blend.colors).toBe(false);
    expect(await label(page)).toBe('Make Blend');
    await expect(api(page, 'blend', { op: 'make', ids: [made.groups[0].id] })).rejects.toThrow(/already is a blend/);
    await expect(api(page, 'blend', { op: 'options', ids: [made.groups[0].id] })).rejects.toThrow(/options needs/);
    await expect(api(page, 'blend', { op: 'options', ids: [made.groups[0].id], spacing: 'bogus' })).rejects.toThrow(/spacing must be/);
    // align: only effective steps are listed, and the parameters are validated
    const c = await api(page, 'createShape', { kind: 'rect', x: 100, y: 500, width: 50, height: 50, fill: '#ff0000', stroke: 'none', name: 'C' });
    const d = await api(page, 'createShape', { kind: 'rect', x: 100, y: 600, width: 50, height: 50, fill: '#00ff00', stroke: 'none', name: 'D' });
    const r = await api(page, 'align', { ids: [c.id, d.id], h: 'left' });
    expect(r.done).toEqual([]);
    const r2 = await api(page, 'align', { ids: [c.id, d.id], h: 'left', v: 'top' });
    expect(r2.done).toEqual(['Align top edges']);
    await expect(api(page, 'align', { ids: [c.id, d.id] })).rejects.toThrow(/Nothing to do/);
    await expect(api(page, 'align', { ids: [c.id, d.id], h: 'left', to: 'key', key: 'nope' })).rejects.toThrow(/Unknown key object/);
  });

  test('transform scale flags and pathfinder cleanup (plan items 12, 14)', async ({ page }) => {
    const rect = await api(page, 'createShape', { kind: 'rect', x: 100, y: 100, width: 100, height: 100, radii: [10, 10, 10, 10], fill: '#cccccc', stroke: { color: '#000000', width: 4 }, name: 'R' });
    await api(page, 'effect', { op: 'add', ids: [rect.id], type: 'dropShadow', params: { dx: 5, dy: 5, blur: 4 } });
    // default: strokes and effects keep their size (Scale Strokes preference off), corners scale
    await api(page, 'transform', { ids: [rect.id], scale: 2 });
    let n = await nodeById(page, rect.id);
    expect((await worldBounds(page, rect.id))!.width).toBeCloseTo(200, 3);
    expect(n.stroke.width).toBeCloseTo(4, 6);
    expect(n.effects[0].dx).toBeCloseTo(5, 6);
    expect(n.shape.radii[0]).toBeCloseTo(20, 6);
    // scaleStrokes + scaleEffects
    await api(page, 'transform', { ids: [rect.id], scale: 0.5, scaleStrokes: true, scaleEffects: true });
    n = await nodeById(page, rect.id);
    expect(n.stroke.width).toBeCloseTo(2, 6);
    expect(n.effects[0].dx).toBeCloseTo(2.5, 6);
    expect(n.shape.radii[0]).toBeCloseTo(10, 6);
    // scaleCorners false keeps the radii, also under a non-uniform scale (the bake would take the smaller factor)
    await api(page, 'transform', { ids: [rect.id], scale: 2, scaleCorners: false });
    n = await nodeById(page, rect.id);
    expect(n.shape.radii[0]).toBeCloseTo(10, 6);
    expect((await worldBounds(page, rect.id))!.width).toBeCloseTo(200, 3);
    await api(page, 'transform', { ids: [rect.id], scale: { x: 1.5, y: 3 }, scaleCorners: false });
    n = await nodeById(page, rect.id);
    expect(n.shape.radii).toEqual([10, 10, 10, 10]);
    expect((await worldBounds(page, rect.id))!.height).toBeCloseTo(600, 3);
    // live corners of a polygon inside a scaled group keep their world radius too
    const poly = await api(page, 'createShape', { kind: 'polygon', cx: 800, cy: 300, radius: 40, sides: 6, fill: '#00ffff', stroke: 'none', name: 'P' });
    await api(page, 'corners', { ids: [poly.id], radius: 7 });
    const w0 = (await worldBounds(page, poly.id))!.width;
    const g = await api(page, 'group', { ids: [poly.id] });
    await api(page, 'transform', { ids: [g.selection[0]], scale: 3, scaleCorners: false });
    const pn = await nodeById(page, poly.id);
    const worldScale = Math.hypot(pn.transform.a, pn.transform.b);
    expect(pn.subpaths[0].anchors[0].cornerRadius * worldScale).toBeCloseTo(7, 4);
    expect((await worldBounds(page, poly.id))!.width).toBeCloseTo(3 * w0, 1);
    // pathfinder: a subtraction that leaves a sliver keeps only the real piece
    const base = await api(page, 'createShape', { kind: 'rect', x: 400, y: 100, width: 200, height: 100, fill: '#ff0000', stroke: 'none', name: 'Base' });
    const cutter = await api(page, 'createShape', { kind: 'rect', x: 500, y: 90, width: 200, height: 120, fill: '#00ff00', stroke: 'none', name: 'Cut' });
    const pf = await api(page, 'pathfinder', { op: 'minusFront', ids: [base.id, cutter.id] });
    const res = await nodeById(page, pf.selection[0]);
    expect(res.subpaths).toHaveLength(1);
    expect((await worldBounds(page, pf.selection[0]))!.width).toBeCloseTo(100, 3);
  });
});
