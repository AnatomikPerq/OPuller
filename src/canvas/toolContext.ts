import type { Vec, ID } from '@/model/types';
import { useStore, getState, screenToWorld, worldToScreen } from '@/store/store';
import type { ToolContext } from '@/tools/types';
import { hitTest, hitTestAnchors, type HitOptions } from './hitTest';
import { SnapSession, type SnapOptions, type SnapResult } from './snap';
import { useOverlayStore } from './overlayStore';
import { getTool } from '@/tools/registry';

let captureFn: ((pointerId: number) => void) | null = null;

/** The viewport registers its pointer-capture implementation here. */
export function setCaptureImpl(fn: ((pointerId: number) => void) | null): void {
  captureFn = fn;
}

export const toolContext: ToolContext = {
  get state() {
    return getState();
  },
  get doc() {
    return getState().doc;
  },
  get zoom() {
    return getState().zoom;
  },
  snap(p: Vec, opts?: SnapOptions, session?: SnapSession): SnapResult {
    const s = getState();
    return (session ?? new SnapSession(s.doc, s, opts)).snap(p);
  },
  beginSnap(opts?: SnapOptions): SnapSession {
    const s = getState();
    return new SnapSession(s.doc, s, opts);
  },
  hitTest(world: Vec, opts: Partial<HitOptions> = {}) {
    const s = getState();
    return hitTest(s.doc, world, { tolerance: s.prefs.snapTolerance / s.zoom, isolation: s.isolationId, ...opts });
  },
  hitTestAnchors(world: Vec, ids: ID[], includeHandles = true) {
    const s = getState();
    return hitTestAnchors(s.doc, ids, world, (s.prefs.handleSize / 2 + 3) / s.zoom, includeHandles, s.selectedAnchors);
  },
  worldToScreen(p: Vec) {
    return worldToScreen(p);
  },
  screenToWorld(p: Vec) {
    return screenToWorld(p);
  },
  tolerance() {
    const s = getState();
    return s.prefs.snapTolerance / s.zoom;
  },
  requestOverlay() {
    getState().requestOverlay();
  },
  setCursor(cursor: string) {
    getState().setCursor(cursor);
  },
  setStatus(text: string) {
    getState().setStatus(text);
  },
  commit(label: string) {
    getState().commit(label);
  },
  capture(pointerId: number) {
    captureFn?.(pointerId);
  },
  setSnapGuides(result: SnapResult | null) {
    useOverlayStore.getState().setSnap(result && (result.lines.length || result.points.length) ? result : null);
  },
  setTool(id: string) {
    getState().setTool(id);
  },
  options<T extends Record<string, unknown>>(): T {
    const s = getState();
    const id = s.temporaryTool ?? s.activeTool;
    const tool = getTool(id);
    return { ...(tool?.defaults ?? {}), ...(s.toolOptions[id] ?? {}) } as T;
  },
  setOptions(patch: Record<string, unknown>) {
    const s = getState();
    s.setToolOptions(s.temporaryTool ?? s.activeTool, patch);
  },
};

/** React hook returning merged options for a tool id. */
export function useToolOptions<T extends Record<string, unknown>>(toolId: string): [T, (patch: Partial<T>) => void] {
  const opts = useStore((s) => s.toolOptions[toolId]);
  const tool = getTool(toolId);
  const merged = { ...(tool?.defaults ?? {}), ...(opts ?? {}) } as T;
  const set = (patch: Partial<T>) => getState().setToolOptions(toolId, patch as Record<string, unknown>);
  return [merged, set];
}
