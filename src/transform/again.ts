/**
 * "Transform Again" memory: every transform applied by the transform tools,
 * dialogs and panels records how to repeat itself on any selection.
 */
import type { Matrix, Rect, Vec } from '@/model/types';
import { applyToPoint, multiply, translate } from '@/geometry/matrix';
import { selectionBounds } from '@/model/document';
import { getState } from '@/store/store';
import { refPointOf } from './refPoint';
import { aboutPoint, linearPart } from './matrices';
import { getTransformState, type TransformRecord } from './store';
import { applyTransform, transformTargets } from './apply';
import { applyTransformEach } from './each';

/** World matrix that repeats a record on a selection with the given bounds. */
export function matrixForRecord(rec: TransformRecord, bounds: Rect | null): Matrix {
  const pivot: Vec = rec.pivot.kind === 'absolute' ? rec.pivot.point : bounds ? refPointOf(bounds, rec.pivot.ref) : { x: 0, y: 0 };
  return multiply(translate(rec.translate.x, rec.translate.y), aboutPoint(rec.linear, pivot));
}

/**
 * Build a record from an applied world matrix: `m` is split into its linear
 * part about `pivot` plus a translation so that it can be re-applied around
 * the pivot of a different selection.
 */
export function recordFromMatrix(label: string, m: Matrix, pivot: TransformRecord['pivot'], copy: boolean, bounds: Rect | null): TransformRecord {
  const p: Vec = pivot.kind === 'absolute' ? pivot.point : bounds ? refPointOf(bounds, pivot.ref) : { x: 0, y: 0 };
  const mp = applyToPoint(m, p);
  return { label, copy, pivot, linear: linearPart(m), translate: { x: mp.x - p.x, y: mp.y - p.y } };
}

export function recordTransform(rec: TransformRecord): void {
  getTransformState().setLastTransform(rec);
}

export function recordMatrixTransform(label: string, m: Matrix, pivot: TransformRecord['pivot'], copy: boolean, bounds: Rect | null): void {
  recordTransform(recordFromMatrix(label, m, pivot, copy, bounds));
}

export function canTransformAgain(): boolean {
  return !!getTransformState().lastTransform && getState().selection.length > 0;
}

/** Repeat the last transform on the current selection. */
export function transformAgain(): void {
  const rec = getTransformState().lastTransform;
  if (!rec) return;
  const s = getState();
  const ids = transformTargets(s);
  if (!ids.length) return;
  if (rec.each) {
    applyTransformEach(rec.each, { label: 'Transform Again', copy: rec.copy, ids });
    return;
  }
  const m = matrixForRecord(rec, selectionBounds(s.doc, ids));
  applyTransform(m, { label: 'Transform Again', copy: rec.copy, ids });
}
