/**
 * Shared Playwright helpers for OPuller e2e tests.
 *
 * The app exposes its zustand store on `window.__opuller.store` so tests can
 * inspect/modify state directly (getState/setState) in addition to driving the UI.
 */
import { expect, type Page, type Locator } from '@playwright/test';

export async function openApp(page: Page): Promise<void> {
  // Block Vite's HMR websocket so edits by other people in the tree do not trigger
  // full reloads that destroy the page mid-test.
  try {
    await page.routeWebSocket(/.*/, () => {});
  } catch {
    /* older Playwright */
  }
  await page.goto('/');
  await page.waitForSelector('[data-testid="viewport"]');
  // make sure the store is exposed and tools are registered
  await page.waitForFunction(() => !!(window as any).__opuller?.store);
  // dismiss any recovery/welcome dialog that a module may show
  await page.evaluate(() => {
    const s = (window as any).__opuller.store.getState();
    s.closeDialog?.();
  });
  // deterministic view: 100% zoom, artboard origin at (100,100) of the viewport
  await setView(page, 1, { x: 100, y: 100 });
}

export async function getState<T = any>(page: Page): Promise<T> {
  return page.evaluate(() => {
    const s = (window as any).__opuller.store.getState();
    // strip functions for serialization
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(s)) if (typeof s[k] !== 'function') out[k] = s[k];
    return out;
  }) as Promise<T>;
}

/** Run a function against the live store (e.g. call actions). */
export async function withStore<R>(page: Page, fn: (s: any) => R): Promise<R> {
  return page.evaluate((src) => {
    const s = (window as any).__opuller.store.getState();
    // eslint-disable-next-line no-new-func
    return new Function('s', `return (${src})(s)`)(s);
  }, fn.toString()) as Promise<R>;
}

export async function setView(page: Page, zoom: number, pan: { x: number; y: number }): Promise<void> {
  await page.evaluate(
    ({ zoom, pan }) => {
      const s = (window as any).__opuller.store.getState();
      s.setPan(pan);
      (window as any).__opuller.store.setState({ zoom });
    },
    { zoom, pan },
  );
}

export function viewport(page: Page): Locator {
  return page.locator('[data-testid="viewport"]');
}

/** World → viewport-relative screen coordinates (uses the store's zoom/pan). */
export async function worldToScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ x, y }) => {
      const s = (window as any).__opuller.store.getState();
      return { x: x * s.zoom + s.pan.x, y: y * s.zoom + s.pan.y };
    },
    { x, y },
  );
}

/** Mouse drag on the viewport in world coordinates. */
export async function dragWorld(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { steps?: number; modifiers?: string[] } = {}): Promise<void> {
  const box = await viewport(page).boundingBox();
  if (!box) throw new Error('viewport not found');
  const a = await worldToScreen(page, from.x, from.y);
  const b = await worldToScreen(page, to.x, to.y);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  const steps = opts.steps ?? 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + a.x + ((b.x - a.x) * i) / steps, box.y + a.y + ((b.y - a.y) * i) / steps);
  }
  await page.mouse.up();
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
}

export async function clickWorld(page: Page, x: number, y: number, opts: { modifiers?: string[]; button?: 'left' | 'right'; clickCount?: number } = {}): Promise<void> {
  const box = await viewport(page).boundingBox();
  if (!box) throw new Error('viewport not found');
  const p = await worldToScreen(page, x, y);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.click(box.x + p.x, box.y + p.y, { button: opts.button ?? 'left', clickCount: opts.clickCount ?? 1 });
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
}

export async function moveWorld(page: Page, x: number, y: number): Promise<void> {
  const box = await viewport(page).boundingBox();
  if (!box) throw new Error('viewport not found');
  const p = await worldToScreen(page, x, y);
  await page.mouse.move(box.x + p.x, box.y + p.y);
}

export async function selectTool(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => (window as any).__opuller.store.getState().setTool(id), id);
  await expect.poll(() => page.evaluate(() => (window as any).__opuller.store.getState().activeTool)).toBe(id);
}

/** Draw a rectangle with the rectangle tool (world coords). Returns the new node id. */
export async function drawRect(page: Page, x: number, y: number, w: number, h: number): Promise<string> {
  await selectTool(page, 'rect');
  await dragWorld(page, { x, y }, { x: x + w, y: y + h });
  const s = await getState(page);
  return s.selection[0];
}

export async function drawEllipse(page: Page, x: number, y: number, w: number, h: number): Promise<string> {
  await selectTool(page, 'ellipse');
  await dragWorld(page, { x, y }, { x: x + w, y: y + h });
  const s = await getState(page);
  return s.selection[0];
}

export async function nodeById(page: Page, id: string): Promise<any> {
  return page.evaluate((id) => (window as any).__opuller.store.getState().doc.nodes[id], id);
}

export async function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__opuller.store.getState().selection);
}

export async function worldBounds(page: Page, id: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((id) => {
    const s = (window as any).__opuller.store.getState();
    const api = (window as any).__opuller;
    return api.worldBounds ? api.worldBounds(s.doc, id) : null;
  }, id);
}

export async function runCommand(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => (window as any).__opuller.runCommand(id), id);
}

export async function nodeCount(page: Page): Promise<number> {
  return page.evaluate(() => Object.keys((window as any).__opuller.store.getState().doc.nodes).length);
}

export async function press(page: Page, keys: string): Promise<void> {
  await page.keyboard.press(keys);
}

export { expect };
