/**
 * Dialog registry: modules register dialog components by type; the host renders
 * the one referenced by `store.dialog`.
 */
import type { ComponentType } from 'react';

export interface DialogProps<P = Record<string, unknown>> {
  props: P;
  close: () => void;
}

const dialogs = new Map<string, ComponentType<DialogProps<any>>>();
const listeners = new Set<() => void>();

export function registerDialog<P = Record<string, unknown>>(type: string, component: ComponentType<DialogProps<P>>): void {
  dialogs.set(type, component as ComponentType<DialogProps<any>>);
  listeners.forEach((l) => l());
}

export function getDialog(type: string): ComponentType<DialogProps<any>> | undefined {
  return dialogs.get(type);
}

export function onDialogsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function dialogCount(): number {
  return dialogs.size;
}
