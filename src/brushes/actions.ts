/**
 * Store-aware brush actions (one history step each).
 */
import type { ID, BrushDef, StrokeBrush, BrushColorization } from '@/model/types';
import { getState } from '@/store/store';
import { appearanceTargets } from '@/commands/appearance';
import { addBrushDef, applyBrushToNode, artworkFromNodes, deleteBrush, updateBrush, nodesUsingBrush, expandBrushStroke, getBrush } from './ops';
import { useBrushStore } from './store';
import { BRUSH_LIBRARY } from './library';

/** Apply a brush to the selected paths, or make it the default for new strokes. */
export function applyBrushCommand(brushId: ID | null, overrides: Partial<StrokeBrush> = {}): number {
  const s = getState();
  const targets = appearanceTargets().filter((id) => s.doc.nodes[id]?.type === 'path');
  const ref: StrokeBrush | null = brushId ? { id: brushId, ...overrides } : null;
  if (!targets.length) {
    const stroke = { ...s.appearance.stroke };
    if (ref) {
      stroke.brush = ref;
      if (stroke.paint.type === 'none') stroke.paint = { type: 'solid', color: '#000000', opacity: 1 };
      if (stroke.width <= 0) stroke.width = 1;
    } else delete stroke.brush;
    s.setAppearance({ stroke });
    useBrushStore.getState().setActive(brushId);
    return 0;
  }
  let n = 0;
  s.updateDoc((d) => {
    for (const id of targets) if (applyBrushToNode(d, id, ref)) n++;
  });
  if (n) getState().commit(ref ? 'Apply Brush' : 'Remove Brush Stroke');
  const st = getState();
  st.setAppearance({ stroke: ref ? { ...st.appearance.stroke, brush: ref } : (({ brush: _b, ...rest }) => rest)(st.appearance.stroke) });
  useBrushStore.getState().setActive(brushId);
  return n;
}

export function removeBrushStrokeCommand(): number {
  return applyBrushCommand(null);
}

/** Create a calligraphic brush. */
export function newCalligraphicBrush(opts: { name?: string; size?: number; angle?: number; roundness?: number; sizeVariation?: number; angleVariation?: number; roundnessVariation?: number } = {}): BrushDef | null {
  const s = getState();
  let def: BrushDef | null = null;
  s.updateDoc((d) => {
    def = addBrushDef(d, { id: '', name: opts.name ?? 'Calligraphic Brush', kind: 'calligraphic', size: opts.size ?? 8, angle: opts.angle ?? 0, roundness: opts.roundness ?? 100, sizeVariation: opts.sizeVariation, angleVariation: opts.angleVariation, roundnessVariation: opts.roundnessVariation });
  }, 'New Brush');
  if (def) useBrushStore.getState().setActive((def as BrushDef).id);
  return def;
}

/** Create a scatter / art / pattern brush from the selection's artwork. */
export function newArtworkBrush(kind: 'scatter' | 'art' | 'pattern', opts: { name?: string; colorization?: BrushColorization; ids?: ID[] } = {}): BrushDef | null {
  const s = getState();
  const ids = opts.ids ?? s.selection;
  if (!ids.length) {
    s.toast('Select artwork to make the brush from', 'info');
    return null;
  }
  let def: BrushDef | null = null;
  s.updateDoc((d) => {
    const art = artworkFromNodes(d, ids, opts.name ?? 'Brush');
    if (!art) return;
    const name = opts.name ?? (kind === 'scatter' ? 'Scatter Brush' : kind === 'art' ? 'Art Brush' : 'Pattern Brush');
    const colorization = opts.colorization ?? 'none';
    if (kind === 'scatter') def = addBrushDef(d, { id: '', name, kind, art, size: [100, 100], spacing: [100, 100], scatter: [0, 0], rotation: [0, 0], rotationRelativeTo: 'page', colorization });
    else if (kind === 'art') def = addBrushDef(d, { id: '', name, kind, art, width: 100, stretch: 'stretch', colorization });
    else def = addBrushDef(d, { id: '', name, kind, side: art, scale: 100, spacing: 0, fit: 'stretch', colorization });
  }, 'New Brush');
  if (def) useBrushStore.getState().setActive((def as BrushDef).id);
  return def;
}

export function updateBrushCommand(id: ID, patch: Partial<BrushDef>, commit = true): void {
  getState().updateDoc((d) => {
    updateBrush(d, id, patch);
  }, commit ? 'Brush Options' : undefined);
}

export function deleteBrushCommand(id: ID, mode: 'expand' | 'remove' = 'remove'): void {
  const s = getState();
  const users = nodesUsingBrush(s.doc, id).length;
  s.updateDoc((d) => {
    deleteBrush(d, id, mode);
  }, 'Delete Brush');
  if (useBrushStore.getState().activeId === id) useBrushStore.getState().setActive(null);
  if (users) getState().toast(mode === 'expand' ? `${users} stroke${users === 1 ? '' : 's'} expanded` : `Brush removed from ${users} stroke${users === 1 ? '' : 's'}`, 'info');
}

export function duplicateBrushCommand(id: ID): ID | null {
  const s = getState();
  const src = getBrush(s.doc, id);
  if (!src) return null;
  let nid: ID | null = null;
  s.updateDoc((d) => {
    nid = addBrushDef(d, { ...JSON.parse(JSON.stringify(src)), id: '', name: `${src.name} copy` }).id;
  }, 'Duplicate Brush');
  if (nid) useBrushStore.getState().setActive(nid);
  return nid;
}

export function addLibraryBrush(entryId: string): ID | null {
  const entry = BRUSH_LIBRARY.find((e) => e.id === entryId);
  if (!entry) return null;
  let id: ID | null = null;
  getState().updateDoc((d) => {
    id = addBrushDef(d, entry.build()).id;
  }, 'Add Brush');
  if (id) useBrushStore.getState().setActive(id);
  return id;
}

export function addWholeBrushLibrary(): number {
  const s = getState();
  const names = new Set(s.doc.brushes.map((b) => b.name));
  const missing = BRUSH_LIBRARY.filter((e) => !names.has(e.name));
  if (!missing.length) return 0;
  s.updateDoc((d) => {
    for (const e of missing) addBrushDef(d, e.build());
  }, 'Add Brush Library');
  return missing.length;
}

export function expandBrushStrokesCommand(ids?: ID[]): number {
  const s = getState();
  const targets = (ids ?? s.selection).filter((id) => {
    const n = s.doc.nodes[id];
    return n && n.type === 'path' && !!n.stroke.brush;
  });
  if (!targets.length) return 0;
  const out: ID[] = [];
  s.updateDoc((d) => {
    for (const id of targets) {
      const g = expandBrushStroke(d, id);
      if (g) out.push(g);
    }
  }, 'Expand Appearance');
  if (out.length) getState().setSelection(out);
  return out.length;
}

export function selectBrushUsers(id: ID): number {
  const s = getState();
  const ids = nodesUsingBrush(s.doc, id);
  s.setSelection(ids);
  if (!ids.length) s.toast('No strokes use this brush', 'info');
  return ids.length;
}

/** The brush selected in the panel (if it still exists). */
export function activeBrushId(): ID | null {
  const s = getState();
  const id = useBrushStore.getState().activeId;
  return id && getBrush(s.doc, id) ? id : null;
}
