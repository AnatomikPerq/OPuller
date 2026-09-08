/**
 * Status bar extension points: modules register small components that are
 * rendered at the right end of the status bar (e.g. the AI bridge indicator).
 */
import type { ComponentType } from 'react';

const items: Array<{ id: string; component: ComponentType }> = [];
const listeners = new Set<() => void>();

export function registerStatusItem(id: string, component: ComponentType): void {
  const i = items.findIndex((s) => s.id === id);
  if (i >= 0) items[i] = { id, component };
  else items.push({ id, component });
  listeners.forEach((l) => l());
}

let snapshot = items.slice();
export function statusItemsSnapshot(): Array<{ id: string; component: ComponentType }> {
  if (snapshot.length !== items.length || snapshot.some((s, i) => s !== items[i])) snapshot = items.slice();
  return snapshot;
}

export function onStatusItemsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
