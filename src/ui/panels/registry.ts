/**
 * Panel registry. Panels register themselves (id, title, component) and the
 * dock lays them out according to the persisted layout.
 */
import type { ComponentType } from 'react';

export interface PanelDef {
  id: string;
  title: string;
  component: ComponentType;
  /** default visibility */
  defaultVisible?: boolean;
  /** preferred min height in px */
  minHeight?: number;
  /** ordering in the Window menu */
  order?: number;
  /** keyboard shortcut to toggle (e.g. "f7") */
  shortcut?: string;
}

const panels = new Map<string, PanelDef>();
const listeners = new Set<() => void>();

export function registerPanel(def: PanelDef): void {
  panels.set(def.id, def);
  listeners.forEach((l) => l());
}

export function getPanel(id: string): PanelDef | undefined {
  return panels.get(id);
}

export function allPanels(): PanelDef[] {
  return Array.from(panels.values()).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function onPanelsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let snapshot: PanelDef[] = [];
export function panelsSnapshot(): PanelDef[] {
  const list = allPanels();
  if (list.length !== snapshot.length || list.some((p, i) => p !== snapshot[i])) snapshot = list;
  return snapshot;
}
