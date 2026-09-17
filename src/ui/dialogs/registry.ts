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
/** Programmatic counterparts of dialogs: apply the same edit from parameters, without UI. */
const appliers = new Map<string, (params: Record<string, unknown>) => unknown>();

export function registerDialog<P = Record<string, unknown>>(type: string, component: ComponentType<DialogProps<P>>, opts?: { apply?: (params: Record<string, unknown>) => unknown }): void {
  dialogs.set(type, component as ComponentType<DialogProps<any>>);
  if (opts?.apply) appliers.set(type, opts.apply);
  listeners.forEach((l) => l());
}

/** Whether a dialog can be applied from parameters (runCommand(id, arg) uses it instead of opening the UI). */
export function hasDialogApply(type: string): boolean {
  return appliers.has(type);
}

/** Apply a dialog's edit from parameters (one history step, no UI). Throws when the dialog has no applier. */
export function applyDialog(type: string, params: Record<string, unknown>): unknown {
  const fn = appliers.get(type);
  if (!fn) throw new Error(`Dialog "${type}" cannot be applied from parameters`);
  return fn(params);
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
