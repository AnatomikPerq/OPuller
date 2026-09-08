/**
 * Align & distribute (pure computations + store-level application).
 */
import type { Document, ID, Rect, Vec } from '@/model/types';
import { translate } from '@/geometry/matrix';
import { worldBounds, sortByPaintOrder } from '@/model/document';
import { getState, type EditorState } from '@/store/store';
import { applyTransform, transformTargets } from './apply';
import { getTransformState, type AlignTo } from './store';

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type Axis = 'h' | 'v';

export interface AlignItem {
  id: ID;
  bounds: Rect;
}

export const ALIGN_LABELS: Record<AlignKind, string> = {
  left: 'Align left edges',
  hcenter: 'Align horizontal centers',
  right: 'Align right edges',
  top: 'Align top edges',
  vcenter: 'Align vertical centers',
  bottom: 'Align bottom edges',
};

export const DISTRIBUTE_LABELS: Record<DistributeKind, string> = {
  top: 'Distribute top edges',
  vcenter: 'Distribute vertical centers',
  bottom: 'Distribute bottom edges',
  left: 'Distribute left edges',
  hcenter: 'Distribute horizontal centers',
  right: 'Distribute right edges',
};

function unionRect(items: AlignItem[]): Rect | null {
  if (!items.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const it of items) {
    x1 = Math.min(x1, it.bounds.x);
    y1 = Math.min(y1, it.bounds.y);
    x2 = Math.max(x2, it.bounds.x + it.bounds.width);
    y2 = Math.max(y2, it.bounds.y + it.bounds.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Translation per item aligning it to `target`. */
export function alignDeltas(items: AlignItem[], kind: AlignKind, target: Rect): Map<ID, Vec> {
  const out = new Map<ID, Vec>();
  for (const it of items) {
    const b = it.bounds;
    let dx = 0;
    let dy = 0;
    switch (kind) {
      case 'left':
        dx = target.x - b.x;
        break;
      case 'hcenter':
        dx = target.x + target.width / 2 - (b.x + b.width / 2);
        break;
      case 'right':
        dx = target.x + target.width - (b.x + b.width);
        break;
      case 'top':
        dy = target.y - b.y;
        break;
      case 'vcenter':
        dy = target.y + target.height / 2 - (b.y + b.height / 2);
        break;
      case 'bottom':
        dy = target.y + target.height - (b.y + b.height);
        break;
    }
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) out.set(it.id, { x: dx, y: dy });
  }
  return out;
}

function edgeOffset(kind: DistributeKind, b: Rect): number {
  switch (kind) {
    case 'left':
    case 'top':
      return 0;
    case 'hcenter':
      return b.width / 2;
    case 'vcenter':
      return b.height / 2;
    case 'right':
      return b.width;
    case 'bottom':
      return b.height;
  }
}

/**
 * Distribute the chosen edges evenly. Without a target the first and last
 * objects stay in place; with a target (artboard) the outer objects are placed
 * flush with the target's edges.
 */
export function distributeDeltas(items: AlignItem[], kind: DistributeKind, target?: Rect | null): Map<ID, Vec> {
  const out = new Map<ID, Vec>();
  const axis: Axis = kind === 'left' || kind === 'hcenter' || kind === 'right' ? 'h' : 'v';
  const pos = (b: Rect) => (axis === 'h' ? b.x : b.y);
  const size = (b: Rect) => (axis === 'h' ? b.width : b.height);
  const sorted = [...items].sort((a, b) => pos(a.bounds) + edgeOffset(kind, a.bounds) - (pos(b.bounds) + edgeOffset(kind, b.bounds)));
  const n = sorted.length;
  if (n < 2) return out;
  let first: number;
  let last: number;
  if (target) {
    const t0 = axis === 'h' ? target.x : target.y;
    const t1 = t0 + (axis === 'h' ? target.width : target.height);
    first = t0 + edgeOffset(kind, sorted[0].bounds);
    last = t1 - size(sorted[n - 1].bounds) + edgeOffset(kind, sorted[n - 1].bounds);
  } else {
    if (n < 3) return out;
    first = pos(sorted[0].bounds) + edgeOffset(kind, sorted[0].bounds);
    last = pos(sorted[n - 1].bounds) + edgeOffset(kind, sorted[n - 1].bounds);
  }
  const step = (last - first) / (n - 1);
  sorted.forEach((it, i) => {
    const cur = pos(it.bounds) + edgeOffset(kind, it.bounds);
    const d = first + step * i - cur;
    if (Math.abs(d) > 1e-9) out.set(it.id, axis === 'h' ? { x: d, y: 0 } : { x: 0, y: d });
  });
  return out;
}

/**
 * Distribute spacing: equal gaps between objects. `spacing` null = auto (the
 * outer objects stay / fill the target); a number = fixed gap, anchored at the
 * key object (or the first object).
 */
export function distributeSpacingDeltas(items: AlignItem[], axis: Axis, spacing: number | null, keyId?: ID | null, target?: Rect | null): Map<ID, Vec> {
  const out = new Map<ID, Vec>();
  const pos = (b: Rect) => (axis === 'h' ? b.x : b.y);
  const size = (b: Rect) => (axis === 'h' ? b.width : b.height);
  const sorted = [...items].sort((a, b) => pos(a.bounds) + size(a.bounds) / 2 - (pos(b.bounds) + size(b.bounds) / 2));
  const n = sorted.length;
  if (n < 2) return out;
  const total = sorted.reduce((acc, it) => acc + size(it.bounds), 0);
  const place = (positions: number[]) => {
    sorted.forEach((it, i) => {
      const d = positions[i] - pos(it.bounds);
      if (Math.abs(d) > 1e-9) out.set(it.id, axis === 'h' ? { x: d, y: 0 } : { x: 0, y: d });
    });
  };
  if (spacing === null || spacing === undefined) {
    let start: number;
    let end: number;
    if (target) {
      start = axis === 'h' ? target.x : target.y;
      end = start + (axis === 'h' ? target.width : target.height);
    } else {
      start = pos(sorted[0].bounds);
      end = pos(sorted[n - 1].bounds) + size(sorted[n - 1].bounds);
    }
    const gap = (end - start - total) / (n - 1);
    const positions: number[] = [];
    let cur = start;
    for (const it of sorted) {
      positions.push(cur);
      cur += size(it.bounds) + gap;
    }
    place(positions);
    return out;
  }
  // fixed spacing anchored at the key object (or the first one)
  let anchorIndex = keyId ? sorted.findIndex((it) => it.id === keyId) : 0;
  if (anchorIndex < 0) anchorIndex = 0;
  const positions: number[] = new Array(n);
  positions[anchorIndex] = pos(sorted[anchorIndex].bounds);
  for (let i = anchorIndex + 1; i < n; i++) positions[i] = positions[i - 1] + size(sorted[i - 1].bounds) + spacing;
  for (let i = anchorIndex - 1; i >= 0; i--) positions[i] = positions[i + 1] - spacing - size(sorted[i].bounds);
  place(positions);
  return out;
}

// ---------------------------------------------------------------------------
// Store-level
// ---------------------------------------------------------------------------

export function alignItems(s: EditorState = getState()): AlignItem[] {
  const ids = transformTargets(s);
  const out: AlignItem[] = [];
  for (const id of ids) {
    const b = worldBounds(s.doc, id);
    if (b) out.push({ id, bounds: b });
  }
  return out;
}

export function activeArtboardRect(s: EditorState = getState()): Rect | null {
  const ab = s.doc.artboards.find((a) => a.id === s.activeArtboardId) ?? s.doc.artboards[0];
  return ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : null;
}

/** The key object: the chosen one if it is part of the selection, else the top-most selected object. */
export function effectiveKeyObject(s: EditorState = getState(), items = alignItems(s)): ID | null {
  const key = getTransformState().keyObject;
  if (key && items.some((it) => it.id === key)) return key;
  if (!items.length) return null;
  const sorted = sortByPaintOrder(s.doc, items.map((it) => it.id));
  return sorted[sorted.length - 1];
}

/** Target rectangle for the current align-to mode (null when not applicable). */
export function alignTarget(mode: AlignTo, s: EditorState = getState(), items = alignItems(s)): Rect | null {
  if (mode === 'artboard') return activeArtboardRect(s);
  if (mode === 'key') {
    const key = effectiveKeyObject(s, items);
    return items.find((it) => it.id === key)?.bounds ?? null;
  }
  return unionRect(items);
}

export function canAlign(mode: AlignTo, count: number): boolean {
  return mode === 'artboard' ? count >= 1 : count >= 2;
}

export function canDistribute(mode: AlignTo, count: number): boolean {
  return mode === 'artboard' ? count >= 2 : count >= 3;
}

export function canDistributeSpacing(count: number): boolean {
  return count >= 2;
}

function applyDeltas(deltas: Map<ID, Vec>, label: string, ids: ID[]): void {
  if (!deltas.size) return;
  applyTransform(
    (id) => {
      const d = deltas.get(id);
      return d ? translate(d.x, d.y) : null;
    },
    { label, ids },
  );
}

export function alignSelection(kind: AlignKind, mode: AlignTo = getTransformState().alignTo): void {
  const s = getState();
  const items = alignItems(s);
  if (!canAlign(mode, items.length)) return;
  const target = alignTarget(mode, s, items);
  if (!target) return;
  const key = mode === 'key' ? effectiveKeyObject(s, items) : null;
  const deltas = alignDeltas(items.filter((it) => it.id !== key), kind, target);
  applyDeltas(deltas, ALIGN_LABELS[kind], items.map((it) => it.id));
}

export function distributeSelection(kind: DistributeKind, mode: AlignTo = getTransformState().alignTo): void {
  const s = getState();
  const items = alignItems(s);
  if (!canDistribute(mode, items.length)) return;
  const target = mode === 'artboard' ? activeArtboardRect(s) : null;
  const deltas = distributeDeltas(items, kind, target);
  applyDeltas(deltas, DISTRIBUTE_LABELS[kind], items.map((it) => it.id));
}

export function distributeSpacingSelection(axis: Axis, mode: AlignTo = getTransformState().alignTo, spacing: number | null = getTransformState().spacing): void {
  const s = getState();
  const items = alignItems(s);
  if (!canDistributeSpacing(items.length)) return;
  const target = mode === 'artboard' && spacing === null ? activeArtboardRect(s) : null;
  const key = mode === 'key' ? effectiveKeyObject(s, items) : null;
  const deltas = distributeSpacingDeltas(items, axis, spacing, key, target);
  applyDeltas(deltas, axis === 'h' ? 'Distribute horizontal spacing' : 'Distribute vertical spacing', items.map((it) => it.id));
}

export function docOf(s: EditorState): Document {
  return s.doc;
}

/** Center the selection on the active artboard (one history step). */
export function centerOnArtboard(): void {
  const s = getState();
  const items = alignItems(s);
  const target = activeArtboardRect(s);
  if (!items.length || !target) return;
  const dh = alignDeltas(items, 'hcenter', target);
  const dv = alignDeltas(items, 'vcenter', target);
  const deltas = new Map<ID, Vec>();
  for (const it of items) {
    const a = dh.get(it.id);
    const b = dv.get(it.id);
    if (a || b) deltas.set(it.id, { x: a?.x ?? 0, y: b?.y ?? 0 });
  }
  applyDeltas(deltas, 'Center on Artboard', items.map((it) => it.id));
}
