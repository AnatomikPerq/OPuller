/**
 * Applying world-space transforms to selections.
 *
 * `previewDocument` only touches node matrices (cheap, used on every pointer
 * move). `transformDocument` additionally bakes the result into path geometry
 * (`bakeTransform`), pushes group matrices down to their children and keeps
 * stroke widths / effects visually stable unless "Scale strokes & effects" is on.
 */
import { produce } from 'immer';
import type { Document, ID, Matrix, Node, Effect } from '@/model/types';
import { isContainer } from '@/model/types';
import {
  applyWorldMatrix,
  bakeTransform,
  cloneSubtree,
  addSubtree,
  indexInParent,
  descendants,
  worldMatrix,
  topmostOf,
  sortByPaintOrder,
  isEffectivelyLocked,
  isEffectivelyVisible,
} from '@/model/document';
import { identity, isIdentity, multiply, scaleFactor } from '@/geometry/matrix';
import { transformSubPaths } from '@/geometry/path';
import { getState, type EditorState } from '@/store/store';
import { uniformFactor } from './matrices';

/** A single matrix for all targets, or a per-target matrix (null = skip). */
export type MatrixSource = Matrix | ((id: ID, doc: Document) => Matrix | null);

/**
 * Objects a transform acts on: the top-most selected nodes (layers are replaced
 * by their children), skipping locked or hidden ones, in paint order.
 */
export function transformTargets(s: EditorState = getState(), ids: ID[] = s.selection): ID[] {
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

function matrixOf(m: MatrixSource, id: ID, doc: Document): Matrix | null {
  return typeof m === 'function' ? m(id, doc) : m;
}

/** Transform node matrices only (no baking). */
export function previewDocument(base: Document, ids: ID[], m: MatrixSource): Document {
  return produce(base, (d) => {
    for (const id of ids) {
      const mm = matrixOf(m, id, d);
      if (mm) applyWorldMatrix(d, id, mm, false);
    }
  });
}

/** Duplicate subtrees right above their originals; returns the new root ids (same order). */
export function duplicateNodes(d: Document, ids: ID[]): ID[] {
  const out: ID[] = [];
  for (const id of ids) {
    const src = d.nodes[id];
    if (!src) continue;
    const { root, nodes } = cloneSubtree(d, id);
    addSubtree(d, root, nodes, src.parent, indexInParent(d, id) + 1);
    out.push(root.id);
  }
  return out;
}

interface LeafRecord {
  id: ID;
  /** visual stroke width before (local width × world scale) */
  strokeVisual: number;
  /** world scale factor before */
  sfBefore: number;
  /** uniform factor of the transform applied to this leaf's target */
  factor: number;
}

function collectLeaves(d: Document, targets: ID[]): LeafRecord[] {
  const out: LeafRecord[] = [];
  const seen = new Set<ID>();
  for (const t of targets) {
    for (const id of descendants(d, t, true)) {
      if (seen.has(id)) continue;
      const n = d.nodes[id];
      if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
      seen.add(id);
      const sf = scaleFactor(worldMatrix(d, id));
      out.push({ id, strokeVisual: n.stroke.width * sf, sfBefore: sf, factor: 1 });
    }
  }
  return out;
}

function scaleEffect(e: Effect, k: number): Effect {
  switch (e.type) {
    case 'dropShadow':
    case 'innerShadow':
      return { ...e, dx: e.dx * k, dy: e.dy * k, blur: e.blur * k };
    case 'blur':
      return { ...e, radius: e.radius * k };
    case 'outerGlow':
    case 'innerGlow':
      return { ...e, blur: e.blur * k };
    case 'roundCorners':
      return { ...e, radius: e.radius * k };
    default:
      return e;
  }
}

/** Restore the visual stroke width / effect sizes of leaves after baking (× factor when scaling strokes). */
function fixLeafAppearance(d: Document, leaves: LeafRecord[]): void {
  for (const l of leaves) {
    const n = d.nodes[l.id];
    if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
    const sfAfter = scaleFactor(worldMatrix(d, l.id));
    if (!(sfAfter > 1e-9) || !(l.sfBefore > 1e-9)) continue;
    const k = (l.sfBefore * l.factor) / sfAfter;
    if (Math.abs(k - 1) < 1e-9) continue;
    if (n.stroke.width > 0) n.stroke = { ...n.stroke, width: (l.strokeVisual * l.factor) / sfAfter };
    if (n.effects.length) n.effects = n.effects.map((e) => scaleEffect(e, k));
  }
}

/**
 * Bake a subtree: paths get their matrix baked (live shapes keep parameters
 * when possible), group matrices are pushed down to the children, text and
 * images keep their matrices.
 */
export function bakeSubtree(d: Document, id: ID): void {
  const n = d.nodes[id];
  if (!n) return;
  if (n.type === 'path') {
    bakeTransform(d, id);
    return;
  }
  if (isContainer(n)) {
    if (!isIdentity(n.transform)) {
      for (const c of n.children) {
        const cn = d.nodes[c];
        if (cn) cn.transform = multiply(n.transform, cn.transform);
      }
      n.transform = identity();
    }
    for (const c of n.children) bakeSubtree(d, c);
  }
}

/** Bake a subtree completely: every path becomes plain geometry with an identity matrix. */
function bakeSubtreeFully(d: Document, id: ID): void {
  const n = d.nodes[id];
  if (!n) return;
  if (n.type === 'path') {
    if (isIdentity(n.transform)) return;
    const m = n.transform;
    const pureScale = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
    if (pureScale && n.shape) {
      bakeTransform(d, id);
      return;
    }
    n.subpaths = transformSubPaths(n.subpaths, m);
    n.transform = identity();
    n.shape = undefined;
    return;
  }
  if (isContainer(n)) {
    if (!isIdentity(n.transform)) {
      for (const c of n.children) {
        const cn = d.nodes[c];
        if (cn) cn.transform = multiply(n.transform, cn.transform);
      }
      n.transform = identity();
    }
    for (const c of n.children) bakeSubtreeFully(d, c);
  }
}

export interface TransformDocOptions {
  /** scale stroke widths & effects with the object (default: prefs.scaleStrokes) */
  scaleStrokes?: boolean;
  /** transform copies instead of the originals */
  copy?: boolean;
}

/**
 * Apply `m` to the targets of `base` and bake the result. Returns the new
 * document and the ids that were transformed (the copies when `copy` is set).
 */
export function transformDocument(base: Document, ids: ID[], m: MatrixSource, opts: TransformDocOptions = {}): { doc: Document; ids: ID[] } {
  const scaleStrokes = opts.scaleStrokes ?? getState().prefs.scaleStrokes;
  let outIds = ids;
  const doc = produce(base, (d) => {
    const targets = opts.copy ? duplicateNodes(d, ids) : ids.filter((id) => !!d.nodes[id]);
    outIds = targets;
    const leaves = collectLeaves(d, targets);
    const leafIndex = new Map(leaves.map((l) => [l.id, l]));
    for (const id of targets) {
      const mm = matrixOf(m, id, d);
      if (!mm) continue;
      const f = scaleStrokes ? uniformFactor(mm) : 1;
      if (Math.abs(f - 1) > 1e-9) for (const leaf of descendants(d, id, true)) { const l = leafIndex.get(leaf); if (l) l.factor = f; }
      applyWorldMatrix(d, id, mm, false);
    }
    for (const id of targets) bakeSubtree(d, id);
    fixLeafAppearance(d, leaves);
  });
  return { doc, ids: outIds };
}

/** "Reset Bounding Box": bake every transform of the targets into plain geometry. */
export function resetBoundingBoxDocument(base: Document, ids: ID[]): Document {
  return produce(base, (d) => {
    const targets = ids.filter((id) => !!d.nodes[id]);
    const leaves = collectLeaves(d, targets);
    for (const id of targets) bakeSubtreeFully(d, id);
    fixLeafAppearance(d, leaves);
  });
}

export interface ApplyOptions {
  label: string;
  copy?: boolean;
  /** record a history step (default true) */
  commit?: boolean;
  ids?: ID[];
  scaleStrokes?: boolean;
}

/**
 * Apply a transform to the current selection (store-level): replaces the
 * document, commits one history step and selects the copies when copying.
 * Returns the transformed ids.
 */
export function applyTransform(m: MatrixSource, opts: ApplyOptions): ID[] {
  const s = getState();
  const ids = opts.ids ?? transformTargets(s);
  if (!ids.length) return [];
  const { doc, ids: outIds } = transformDocument(s.doc, ids, m, { copy: opts.copy, scaleStrokes: opts.scaleStrokes });
  if (doc !== s.doc) s.replaceDoc(doc);
  if (opts.commit !== false) s.commit(opts.label);
  if (opts.copy) s.setSelection(outIds);
  return outIds;
}

export function resetBoundingBox(ids?: ID[]): void {
  const s = getState();
  const targets = ids ?? transformTargets(s);
  if (!targets.length) return;
  const doc = resetBoundingBoxDocument(s.doc, targets);
  if (doc === s.doc) return;
  s.replaceDoc(doc);
  s.commit('Reset Bounding Box');
}

/** Rotation (degrees, ccw) stored in a node's world matrix, if it keeps one (text, images, live shapes). */
export function nodeRotation(doc: Document, id: ID): number {
  const n: Node | undefined = doc.nodes[id];
  if (!n) return 0;
  const m = worldMatrix(doc, id);
  const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  return Math.abs(rot) < 1e-9 ? 0 : -rot;
}

/** Skew (degrees, ccw) stored in a node's world matrix. */
export function nodeShear(doc: Document, id: ID): number {
  const n: Node | undefined = doc.nodes[id];
  if (!n) return 0;
  const m = worldMatrix(doc, id);
  const skew = Math.atan2(m.a * m.c + m.b * m.d, m.a * m.a + m.b * m.b);
  const deg = (skew * 180) / Math.PI;
  return Math.abs(deg) < 1e-9 ? 0 : -deg;
}
