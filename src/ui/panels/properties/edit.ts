/**
 * Editing helpers for the Properties panel: targets of an edit, transform
 * sessions for live (scrubbed) X/Y/W/H/angle edits, baking, align-to-artboard.
 */
import { produce } from 'immer';
import type { Document, ID, Matrix, Rect, Artboard, Node } from '@/model/types';
import { isContainer } from '@/model/types';
import { getState, type EditorState } from '@/store/store';
import { topmostOf, sortByPaintOrder, isEffectivelyLocked, isEffectivelyVisible, applyWorldMatrix, bakeTransform, selectionBounds, worldBounds, worldMatrix } from '@/model/document';
import { translate, multiply, identity, scaleFactor } from '@/geometry/matrix';

/** Objects an edit acts on: top-most selected nodes (layers → their children), editable only, paint order. */
export function editTargets(s: EditorState = getState(), ids: ID[] = s.selection): ID[] {
  const doc = s.doc;
  const out: ID[] = [];
  for (const id of topmostOf(doc, ids.filter((x) => !!doc.nodes[x]))) {
    const n = doc.nodes[id];
    if (n.type === 'layer') {
      for (const c of n.children) if (doc.nodes[c] && !isEffectivelyLocked(doc, c) && isEffectivelyVisible(doc, c)) out.push(c);
    } else if (!isEffectivelyLocked(doc, id) && isEffectivelyVisible(doc, id)) out.push(id);
  }
  return sortByPaintOrder(doc, Array.from(new Set(out)));
}

export function activeArtboard(s: EditorState = getState()): Artboard | null {
  return s.doc.artboards.find((a) => a.id === s.activeArtboardId) ?? s.doc.artboards[0] ?? null;
}

export function artboardRect(s: EditorState = getState()): Rect {
  const a = activeArtboard(s);
  return a ? { x: a.x, y: a.y, width: a.width, height: a.height } : { x: 0, y: 0, width: 0, height: 0 };
}

/** Bake node matrices into geometry after a transform (same policy as the selection tool). */
export function bakeNode(d: Document, id: ID, strokeScale: number | null = null): void {
  const node = d.nodes[id];
  if (!node) return;
  const walk = (nid: ID) => {
    const n = d.nodes[nid];
    if (!n) return;
    if (n.type === 'path') {
      if (strokeScale !== null && Math.abs(strokeScale - 1) > 1e-6) n.stroke = { ...n.stroke, width: n.stroke.width * strokeScale };
      bakeTransform(d, nid);
    } else if (isContainer(n)) for (const c of n.children) walk(c);
  };
  if (node.type === 'path') walk(id);
  else if (node.type === 'group') {
    const t = node.transform;
    const pureTranslation = Math.abs(t.a - 1) < 1e-9 && Math.abs(t.d - 1) < 1e-9 && Math.abs(t.b) < 1e-9 && Math.abs(t.c) < 1e-9;
    if (pureTranslation) {
      for (const c of node.children) {
        const cn = d.nodes[c];
        if (!cn) continue;
        cn.transform = multiply(t, cn.transform);
        if (cn.type === 'path') bakeTransform(d, c);
      }
      node.transform = identity();
    }
  }
}

/** Rotation (degrees, counter-clockwise positive) stored in a node's world matrix. */
export function nodeRotationDeg(doc: Document, id: ID): number {
  const m = worldMatrix(doc, id);
  const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  const v = Math.abs(rot) < 1e-9 ? 0 : -rot;
  let a = ((v + 180) % 360) - 180;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

export interface TransformSession {
  base: Document;
  ids: ID[];
  bounds: Rect;
  rotation: number;
  lastMatrix: Matrix | null;
}

/** Start (or continue) a live transform session from the current document. */
export function beginTransformSession(current: TransformSession | null): TransformSession | null {
  if (current) return current;
  const s = getState();
  const ids = editTargets(s);
  const bounds = selectionBounds(s.doc, ids);
  if (!ids.length || !bounds) return null;
  const rots = ids.map((id) => nodeRotationDeg(s.doc, id));
  const rotation = rots.every((r) => Math.abs(r - rots[0]) < 1e-6) ? rots[0] : 0;
  return { base: s.doc, ids, bounds, rotation, lastMatrix: null };
}

/** Preview a world matrix applied to the session's targets (no history). */
export function previewTransform(session: TransformSession, m: Matrix): void {
  session.lastMatrix = m;
  const next = produce(session.base, (d) => {
    for (const id of session.ids) applyWorldMatrix(d, id, m, false);
  });
  getState().replaceDoc(next);
}

/** Bake the previewed transform and record one history step. */
export function finishTransform(session: TransformSession | null, label: string): void {
  if (!session) return;
  const s = getState();
  const m = session.lastMatrix;
  const f = m && s.prefs.scaleStrokes ? scaleFactor(m) : null;
  s.updateDoc((d) => {
    for (const id of session.ids) bakeNode(d, id, f);
  });
  s.commit(label);
}

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export const ALIGN_TITLES: Record<AlignKind, string> = {
  left: 'Align to artboard left',
  hcenter: 'Align to artboard horizontal center',
  right: 'Align to artboard right',
  top: 'Align to artboard top',
  vcenter: 'Align to artboard vertical center',
  bottom: 'Align to artboard bottom',
};

/** Align every target to the active artboard (one history step). */
export function alignToArtboard(kind: AlignKind): void {
  const s = getState();
  const ids = editTargets(s);
  const ab = artboardRect(s);
  if (!ids.length || !ab.width) return;
  s.updateDoc((d) => {
    for (const id of ids) {
      const b = worldBounds(d, id);
      if (!b) continue;
      let dx = 0;
      let dy = 0;
      switch (kind) {
        case 'left':
          dx = ab.x - b.x;
          break;
        case 'hcenter':
          dx = ab.x + ab.width / 2 - (b.x + b.width / 2);
          break;
        case 'right':
          dx = ab.x + ab.width - (b.x + b.width);
          break;
        case 'top':
          dy = ab.y - b.y;
          break;
        case 'vcenter':
          dy = ab.y + ab.height / 2 - (b.y + b.height / 2);
          break;
        case 'bottom':
          dy = ab.y + ab.height - (b.y + b.height);
          break;
      }
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) applyWorldMatrix(d, id, translate(dx, dy), false);
      bakeNode(d, id);
    }
  }, 'Align to Artboard');
}

/** Whether all values are (nearly) equal; returns the common value or null (mixed). */
export function common<T extends number | string | boolean>(values: T[], eps = 1e-6): T | null {
  if (!values.length) return null;
  const first = values[0];
  for (const v of values) {
    if (typeof v === 'number' && typeof first === 'number') {
      if (Math.abs(v - first) > eps) return null;
    } else if (v !== first) return null;
  }
  return first;
}

export function nodeOf(id: ID): Node | undefined {
  return getState().doc.nodes[id];
}
