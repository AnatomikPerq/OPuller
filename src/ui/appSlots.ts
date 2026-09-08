/**
 * App-level overlay slots: modules register full-screen React components that
 * are rendered on top of the editor shell (e.g. the Home / projects screen).
 */
import type { ComponentType } from 'react';

const overlays: Array<{ id: string; component: ComponentType }> = [];
const listeners = new Set<() => void>();
let snapshot = overlays.slice();

export function registerAppOverlay(id: string, component: ComponentType): void {
  const i = overlays.findIndex((o) => o.id === id);
  if (i >= 0) overlays[i] = { id, component };
  else overlays.push({ id, component });
  snapshot = overlays.slice();
  listeners.forEach((l) => l());
}

export function appOverlaysSnapshot(): Array<{ id: string; component: ComponentType }> {
  return snapshot;
}

export function onAppOverlaysChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
