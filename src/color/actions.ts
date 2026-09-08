/**
 * Store-aware swatch actions (one history step each) used by the Swatches and
 * Color panels. Global and spot swatches keep the paints linked to them in
 * sync (see color/globals.ts).
 */
import type { ID, Paint, Swatch, SwatchKind, CMYK } from '@/model/types';
import { getState } from '@/store/store';
import { setFillPaint, setStrokePaint, activePaint, currentAppearance, setActivePaint } from '@/commands/appearance';
import { makeSwatch, uniqueSwatchName, defaultSwatchName, replacePaintInDoc, nodesUsingPaint, parseSwatchesJson, moveItem, findSwatchByPaint } from './swatches';
import { libraryById } from './libraries';
import { clonePaintDeep } from './paint';
import { isGlobalSwatch, linkedPaint, propagateSwatch, unlinkSwatch, nodesLinkedTo, plainPaint, hexToCmyk, cmykToHex, tintColor, swatchBaseColor } from './globals';

export interface AddSwatchOptions {
  kind?: SwatchKind;
  cmyk?: CMYK;
  /** apply the new (global) swatch to the active paint target */
  apply?: boolean;
}

export function addSwatch(paint: Paint, name?: string, opts: AddSwatchOptions | boolean = {}): Swatch {
  const o = typeof opts === 'boolean' ? {} : opts;
  const s = getState();
  const base = plainPaint(paint);
  const sw = makeSwatch(uniqueSwatchName(s.doc.swatches, name?.trim() || defaultSwatchName(base, s.doc.colorMode)), base);
  if (o.kind && o.kind !== 'process') sw.kind = o.kind;
  if (o.cmyk) sw.cmyk = { ...o.cmyk };
  else if (s.doc.colorMode === 'cmyk' && base.type === 'solid') sw.cmyk = hexToCmyk(base.color);
  s.updateDoc((d) => {
    d.swatches.push(sw);
  }, 'New Swatch');
  if (o.apply && isGlobalSwatch(sw)) applySwatch(sw);
  return sw;
}

/** Apply a plain paint to a target (fill/stroke). */
export function applySwatchPaint(paint: Paint, target: 'fill' | 'stroke' = getState().activePaintTarget): void {
  const p = clonePaintDeep(paint);
  if (target === 'fill') setFillPaint(p, true);
  else setStrokePaint(p, true);
}

/** Apply a swatch: global/spot swatches are applied as linked paints (tint 100 %). */
export function applySwatch(sw: Swatch, target: 'fill' | 'stroke' = getState().activePaintTarget, tint = 100): void {
  if (isGlobalSwatch(sw) && sw.paint.type === 'solid') applySwatchPaint(linkedPaint(sw, tint, sw.paint.opacity), target);
  else applySwatchPaint(sw.paint, target);
}

/** Set the tint of the active paint (must be linked to a global swatch). */
export function setActiveTint(tint: number, commit = true): boolean {
  const s = getState();
  const p = activePaint(s);
  if (p.type !== 'solid' || !p.swatchId) return false;
  const sw = s.doc.swatches.find((x) => x.id === p.swatchId);
  if (!sw) return false;
  const t = Math.max(0, Math.min(100, Math.round(tint)));
  setActivePaint({ ...p, tint: t, color: tintColor(swatchBaseColor(sw), t) }, commit);
  return true;
}

export function deleteSwatches(ids: ID[]): void {
  if (!ids.length) return;
  const set = new Set(ids);
  getState().updateDoc((d) => {
    for (const id of ids) if (d.swatches.some((sw) => sw.id === id && isGlobalSwatch(sw))) unlinkSwatch(d, id);
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
  if (src.kind) copy.kind = src.kind;
  if (src.cmyk) copy.cmyk = { ...src.cmyk };
  s.updateDoc((d) => {
    const i = d.swatches.findIndex((x) => x.id === id);
    d.swatches.splice(i + 1, 0, copy);
  }, 'Duplicate Swatch');
  return copy;
}

/**
 * Update a swatch's paint (and optionally every object using the previous
 * paint). Global/spot swatches always update their linked paints.
 * `commit=false` while dragging in a picker; call `commit('Edit Swatch')` after.
 */
export function updateSwatchPaint(id: ID, paint: Paint, updateObjects: boolean, commit = true, cmyk?: CMYK | null): void {
  const s = getState();
  const prev = s.doc.swatches.find((x) => x.id === id);
  if (!prev) return;
  const next = plainPaint(paint);
  s.updateDoc(
    (d) => {
      const sw = d.swatches.find((x) => x.id === id);
      if (!sw) return;
      const old = sw.paint;
      sw.paint = next;
      if (cmyk === null) delete sw.cmyk;
      else if (cmyk) sw.cmyk = { ...cmyk };
      else if (sw.cmyk && next.type === 'solid') sw.cmyk = hexToCmyk(next.color);
      if (isGlobalSwatch(sw)) propagateSwatch(d, sw);
      else if (updateObjects) replacePaintInDoc(d, old, next);
    },
    commit ? 'Edit Swatch' : undefined,
  );
}

/** Set the swatch's CMYK values (updates the colour and linked paints). */
export function setSwatchCmyk(id: ID, cmyk: CMYK, commit = true): void {
  const s = getState();
  const sw = s.doc.swatches.find((x) => x.id === id);
  if (!sw || sw.paint.type !== 'solid') return;
  updateSwatchPaint(id, { ...sw.paint, color: cmykToHex(cmyk) }, true, commit, cmyk);
}

/**
 * Change the kind of a swatch. Making a swatch global links every object that
 * uses exactly its colour; making it process keeps the colours but drops links.
 */
export function setSwatchKind(id: ID, kind: SwatchKind): void {
  const s = getState();
  const sw = s.doc.swatches.find((x) => x.id === id);
  if (!sw) return;
  s.updateDoc((d) => {
    const t = d.swatches.find((x) => x.id === id);
    if (!t) return;
    const wasGlobal = isGlobalSwatch(t);
    if (kind === 'process') delete t.kind;
    else t.kind = kind;
    if (kind === 'spot' && t.paint.type === 'solid' && !t.cmyk) t.cmyk = hexToCmyk(t.paint.color);
    const nowGlobal = isGlobalSwatch(t);
    if (nowGlobal && !wasGlobal && t.paint.type === 'solid') {
      // link objects painted with exactly this colour
      const base = t.paint.color;
      for (const n of Object.values(d.nodes)) {
        if (n.type !== 'path' && n.type !== 'text') continue;
        if (n.fill.type === 'solid' && !n.fill.swatchId && n.fill.color === base) n.fill = { ...n.fill, swatchId: t.id, tint: 100 };
        if (n.stroke.paint.type === 'solid' && !n.stroke.paint.swatchId && n.stroke.paint.color === base) n.stroke = { ...n.stroke, paint: { ...n.stroke.paint, swatchId: t.id, tint: 100 } };
      }
    } else if (!nowGlobal && wasGlobal) unlinkSwatch(d, id);
  }, kind === 'process' ? 'Convert to Process Color' : kind === 'spot' ? 'Convert to Spot Color' : 'Make Global Color');
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
    if (lib.kind && lib.kind !== 'process') sw.kind = lib.kind;
    if (lib.cmyk || lib.kind === 'spot' || s.doc.colorMode === 'cmyk') sw.cmyk = hexToCmyk(color);
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

/** Select the objects painted with a swatch (linked paints or exact colour). */
export function selectObjectsUsing(paint: Paint, swatchId?: ID): number {
  const s = getState();
  let ids = nodesUsingPaint(s.doc, paint);
  if (swatchId) ids = Array.from(new Set(ids.concat(nodesLinkedTo(s.doc, swatchId))));
  s.setSelection(ids);
  if (!ids.length) s.toast('No objects use this swatch', 'info');
  return ids.length;
}

/** The swatch the active paint is linked to, if any. */
export function activeLinkedSwatch(): { swatch: Swatch; tint: number } | null {
  const s = getState();
  const p = activePaint(s);
  if (p.type !== 'solid' || !p.swatchId) return null;
  const sw = s.doc.swatches.find((x) => x.id === p.swatchId);
  return sw ? { swatch: sw, tint: p.tint ?? 100 } : null;
}

void currentAppearance;
