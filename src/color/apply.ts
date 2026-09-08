/**
 * Change-guarded appearance updates: widgets commit on Enter and again on blur,
 * and immer treats a freshly cloned paint as a change, so re-applying an
 * identical value would create empty history steps. These helpers skip no-ops.
 */
import type { Paint, StrokeStyle } from '@/model/types';
import { getState } from '@/store/store';
import { setActivePaint, setStrokeProps, currentAppearance } from '@/commands/appearance';
import { paintNearlyEqual } from './paint';
import { strokeSummary, MIXED } from './stroke';

/** Apply a paint to the active target unless it already has exactly this paint. Returns whether something changed. */
export function applyActivePaint(paint: Paint, commit: boolean): boolean {
  const s = getState();
  const app = currentAppearance(s);
  const mixed = s.activePaintTarget === 'fill' ? app.mixedFill : app.mixedStroke;
  const cur = s.activePaintTarget === 'fill' ? app.fill : app.stroke.paint;
  if (!mixed && paintNearlyEqual(cur, paint)) return false;
  setActivePaint(paint, commit);
  return true;
}

export type StrokePatch = Partial<Omit<StrokeStyle, 'paint'>>;

/** Whether applying the patch would change any target (mixed properties always count as a change). */
export function strokePatchChanges(patch: StrokePatch): boolean {
  const sum = strokeSummary(getState());
  for (const key of Object.keys(patch) as Array<keyof StrokePatch>) {
    const cur = (sum as unknown as Record<string, unknown>)[key];
    if (cur === MIXED) return true;
    if (JSON.stringify(cur ?? null) !== JSON.stringify(patch[key] ?? null)) return true;
  }
  return false;
}

/** setStrokeProps guarded against no-op patches; commits with `label` when requested. */
export function applyStrokePatch(patch: StrokePatch, label: string, commit = true): boolean {
  if (!strokePatchChanges(patch)) return false;
  setStrokeProps(patch, false);
  if (commit) getState().commit(label);
  return true;
}
