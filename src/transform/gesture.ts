/**
 * Shared gesture machinery for the Rotate / Scale / Reflect / Shear tools:
 * reference point handling, live preview, Alt-drag copies, commit & cancel.
 */
import React from 'react';
import type { Document, ID, Matrix, Vec } from '@/model/types';
import type { ToolContext } from '@/tools/types';
import type { EditorState } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { identity } from '@/geometry/matrix';
import { useOverlayStore } from '@/canvas/overlayStore';
import { getTransformState } from './store';
import { previewDocument, transformDocument, transformTargets, duplicateNodes } from './apply';
import { recordMatrixTransform } from './again';
import { produce } from 'immer';

export function selectionKey(ids: ID[]): string {
  return ids.join('|');
}

/** Center of the selection bounds. */
export function selectionCenter(s: EditorState, ids: ID[]): Vec | null {
  const b = selectionBounds(s.doc, ids);
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}

/** The tools' reference point for the given targets (the stored one, or the selection center). */
export function currentPivot(s: EditorState, ids: ID[]): Vec | null {
  const tp = getTransformState().toolPivot;
  if (tp && tp.selectionKey === selectionKey(ids)) return tp.point;
  return selectionCenter(s, ids);
}

export function isCustomPivot(ids: ID[]): boolean {
  const tp = getTransformState().toolPivot;
  return !!tp && tp.selectionKey === selectionKey(ids);
}

export function setToolPivot(point: Vec, ids: ID[]): void {
  getTransformState().setToolPivot({ point, selectionKey: selectionKey(ids) });
}

export function resetToolPivot(): void {
  getTransformState().setToolPivot(null);
}

/**
 * Ensure something is selected for a transform tool click: with an empty
 * selection, clicking an object selects it. Returns the targets.
 */
export function ensureTargets(ctx: ToolContext, world: Vec): ID[] {
  const s = ctx.state;
  let ids = transformTargets(s);
  if (!ids.length) {
    const hit = ctx.hitTest(world);
    if (hit) {
      s.setSelection([hit.target]);
      ids = transformTargets(ctx.state);
    }
  }
  return ids;
}

export interface Gesture {
  /** document before the gesture (history base) */
  original: Document;
  originalIds: ID[];
  originalSelection: ID[];
  /** document the preview is computed from (includes copies when duplicated) */
  base: Document;
  ids: ID[];
  duplicated: boolean;
  matrix: Matrix;
  start: Vec;
  pivot: Vec;
}

export function beginGesture(ctx: ToolContext, start: Vec, pivot: Vec, ids: ID[]): Gesture {
  const s = ctx.state;
  if (s.doc !== s.historyBase) s.commit('Edit');
  const doc = ctx.state.doc;
  return { original: doc, originalIds: ids, originalSelection: [...s.selection], base: doc, ids, duplicated: false, matrix: identity(), start, pivot };
}

/** Toggle "transform a copy" (Alt) during a gesture. */
export function setGestureCopy(g: Gesture, ctx: ToolContext, on: boolean): void {
  if (on === g.duplicated) return;
  const s = ctx.state;
  if (on) {
    let newIds: ID[] = [];
    const doc = produce(g.original, (d) => {
      newIds = duplicateNodes(d, g.originalIds);
    });
    g.base = doc;
    g.ids = newIds;
    g.duplicated = true;
    s.replaceDoc(doc);
    s.setSelection(newIds);
  } else {
    g.base = g.original;
    g.ids = g.originalIds;
    g.duplicated = false;
    s.replaceDoc(g.original);
    s.setSelection(g.originalSelection);
  }
}

/** Live preview of the matrix (no baking). */
export function updateGesture(g: Gesture, ctx: ToolContext, m: Matrix): void {
  g.matrix = m;
  ctx.state.replaceDoc(previewDocument(g.base, g.ids, m));
}

/** Bake, commit one history step and record the transform for Transform Again. */
export function finishGesture(g: Gesture, ctx: ToolContext, label: string): void {
  const s = ctx.state;
  const finalLabel = g.duplicated ? `${label} Copy` : label;
  const { doc } = transformDocument(g.base, g.ids, g.matrix, { scaleStrokes: s.prefs.scaleStrokes });
  s.replaceDoc(doc);
  if (g.duplicated) {
    s.setSelection(g.originalSelection);
    s.commit(finalLabel);
    ctx.state.setSelection(g.ids);
  } else s.commit(finalLabel);
  recordMatrixTransform(label, g.matrix, { kind: 'absolute', point: g.pivot }, g.duplicated, selectionBounds(g.original, g.originalIds));
  useOverlayStore.getState().setHud(null);
  ctx.setSnapGuides(null);
}

export function cancelGesture(g: Gesture, ctx: ToolContext): void {
  const s = ctx.state;
  s.revert();
  s.setSelection(g.originalSelection);
  useOverlayStore.getState().setHud(null);
  ctx.setSnapGuides(null);
}

export function setHud(screen: Vec, text: string): void {
  useOverlayStore.getState().setHud({ screen, text });
}

export function clearHud(): void {
  useOverlayStore.getState().setHud(null);
}

// ---------------------------------------------------------------------------
// Overlay pieces (screen space)
// ---------------------------------------------------------------------------

/** Illustrator-style reference point marker (crosshair in a circle). */
export function PivotMarker({ x, y, active }: { x: number; y: number; active?: boolean }) {
  const c = active ? '#4a90e2' : '#4a90e2';
  return React.createElement(
    'g',
    { className: 'transform-pivot', pointerEvents: 'none', transform: `translate(${x} ${y})` },
    React.createElement('circle', { r: 5.5, fill: 'none', stroke: '#fff', strokeWidth: 3, opacity: 0.85 }),
    React.createElement('circle', { r: 5.5, fill: 'none', stroke: c, strokeWidth: 1.25 }),
    React.createElement('path', { d: 'M-10 0H-3M3 0H10M0 -10V-3M0 3V10', stroke: '#fff', strokeWidth: 3, opacity: 0.85 }),
    React.createElement('path', { d: 'M-10 0H-3M3 0H10M0 -10V-3M0 3V10', stroke: c, strokeWidth: 1.25 }),
  );
}

/** Dashed guide line between two screen points. */
export function GuideLine({ from, to, dashed = true, color = '#4a90e2' }: { from: Vec; to: Vec; dashed?: boolean; color?: string }) {
  return React.createElement(
    'g',
    { pointerEvents: 'none' },
    React.createElement('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: '#fff', strokeWidth: 2.5, opacity: 0.6 }),
    React.createElement('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: color, strokeWidth: 1, strokeDasharray: dashed ? '4 3' : undefined }),
  );
}
