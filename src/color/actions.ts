/**
 * Store-aware swatch actions (one history step each) used by the Swatches and
 * Color panels.
 */
import type { ID, Paint, Swatch } from '@/model/types';
import { getState } from '@/store/store';
import { setFillPaint, setStrokePaint } from '@/commands/appearance';
import { makeSwatch, uniqueSwatchName, defaultSwatchName, replacePaintInDoc, nodesUsingPaint, parseSwatchesJson, moveItem, findSwatchByPaint } from './swatches';
import { libraryById } from './libraries';
import { clonePaintDeep } from './paint';

export function addSwatch(paint: Paint, name?: string, select = true): Swatch {
  const s = getState();
  const sw = makeSwatch(uniqueSwatchName(s.doc.swatches, name?.trim() || defaultSwatchName(paint)), paint);
  s.updateDoc((d) => {
    d.swatches.push(sw);
  }, 'New Swatch');
  void select;
  return sw;
}

export function applySwatchPaint(paint: Paint, target: 'fill' | 'stroke' = getState().activePaintTarget): void {
  const p = clonePaintDeep(paint);
  if (target === 'fill') setFillPaint(p, true);
  else setStrokePaint(p, true);
}

export function deleteSwatches(ids: ID[]): void {
  if (!ids.length) return;
  const set = new Set(ids);
  getState().updateDoc((d) => {
    d.swatches = d.swatches.filter((sw) => !set.has(sw.id));
  }, ids.length > 1 ? 'Delete Swatches' : 'Delete Swatch');
}

export function renameSwatch(id: ID, name: string): void {
  const n = name.trim();
  if (!n) return;
  getState().updateDoc((d) => {
    const sw = d.swatches.find((x) => x.id === id);
    if (sw) sw.name = n;
  }, 'Rename Swatch');
}

export function duplicateSwatch(id: ID): Swatch | null {
  const s = getState();
  const src = s.doc.swatches.find((x) => x.id === id);
  if (!src) return null;
  const copy = makeSwatch(uniqueSwatchName(s.doc.swatches, `${src.name} copy`), src.paint);
  s.updateDoc((d) => {
    const i = d.swatches.findIndex((x) => x.id === id);
    d.swatches.splice(i + 1, 0, copy);
  }, 'Duplicate Swatch');
  return copy;
}

/**
 * Update a swatch's paint (and optionally every object using the previous
 * paint). `commit=false` while dragging in a picker; call `commitSwatchEdit`.
 */
export function updateSwatchPaint(id: ID, paint: Paint, updateObjects: boolean, commit = true): void {
  const s = getState();
  const prev = s.doc.swatches.find((x) => x.id === id);
  if (!prev) return;
  const next = clonePaintDeep(paint);
  s.updateDoc(
    (d) => {
      const sw = d.swatches.find((x) => x.id === id);
      if (!sw) return;
      const old = sw.paint;
      sw.paint = next;
      if (updateObjects) replacePaintInDoc(d, old, next);
    },
    commit ? 'Edit Swatch' : undefined,
  );
}

export function reorderSwatch(from: number, to: number): void {
  if (from === to) return;
  getState().updateDoc((d) => {
    d.swatches = moveItem(d.swatches, from, to);
  }, 'Reorder Swatches');
}

/** Append a built-in library (skipping colours already present by paint). */
export function addLibrary(libraryId: string): number {
  const lib = libraryById(libraryId);
  if (!lib) return 0;
  const s = getState();
  const toAdd: Swatch[] = [];
  const existing = [...s.doc.swatches];
  for (const [name, color] of lib.colors) {
    const paint: Paint = { type: 'solid', color, opacity: 1 };
    if (findSwatchByPaint(existing, paint)) continue;
    const sw = makeSwatch(uniqueSwatchName(existing, name), paint);
    existing.push(sw);
    toAdd.push(sw);
  }
  if (!toAdd.length) {
    s.toast(`All "${lib.name}" colours are already in the document`, 'info');
    return 0;
  }
  s.updateDoc((d) => {
    d.swatches.push(...toAdd);
  }, `Add ${lib.name} swatches`);
  return toAdd.length;
}

export function importSwatchesFromJson(text: string): number {
  const s = getState();
  const list = parseSwatchesJson(text);
  const existing = [...s.doc.swatches];
  const toAdd: Swatch[] = [];
  for (const sw of list) {
    const named = { ...sw, name: uniqueSwatchName(existing, sw.name) };
    existing.push(named);
    toAdd.push(named);
  }
  s.updateDoc((d) => {
    d.swatches.push(...toAdd);
  }, 'Import Swatches');
  return toAdd.length;
}

export function selectObjectsUsing(paint: Paint): number {
  const s = getState();
  const ids = nodesUsingPaint(s.doc, paint);
  s.setSelection(ids);
  if (!ids.length) s.toast('No objects use this swatch', 'info');
  return ids.length;
}
