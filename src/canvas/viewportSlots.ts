/**
 * Modules can register React components to be rendered inside the viewport:
 * - 'overlay': inside the screen-space overlay <svg> (e.g. gradient annotator)
 * - 'html': as HTML positioned over the canvas (e.g. inline text editor)
 */
import type { ComponentType } from 'react';

type SlotName = 'overlay' | 'html';
const slots: Record<SlotName, Array<{ id: string; component: ComponentType }>> = { overlay: [], html: [] };
const listeners = new Set<() => void>();

export function registerViewportSlot(slot: SlotName, id: string, component: ComponentType): void {
  const list = slots[slot];
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list[i] = { id, component };
  else list.push({ id, component });
  listeners.forEach((l) => l());
}

export function getViewportSlots(slot: SlotName) {
  return slots[slot];
}

export function onSlotsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

import type { ContextMenuItem } from '@/store/store';
import type { HitResult } from './hitTest';
import type { Vec } from '@/model/types';

export type ContextMenuBuilder = (hit: HitResult | null, world: Vec) => ContextMenuItem[];
let contextMenuBuilder: ContextMenuBuilder | null = null;

export function registerContextMenuBuilder(fn: ContextMenuBuilder | null): void {
  contextMenuBuilder = fn;
}

export function buildContextMenu(hit: HitResult | null, world: Vec): ContextMenuItem[] {
  return contextMenuBuilder ? contextMenuBuilder(hit, world) : [];
}
