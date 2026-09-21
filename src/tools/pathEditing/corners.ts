/**
 * Live corners (Illustrator's corner widgets): the maths and document edits behind the
 * widgets the Direct Selection tool shows next to every corner of a selected path.
 *
 * A corner of a plain path is `anchor.cornerRadius`; a corner of a live rectangle is one of
 * `shape.radii`. Both are edited in local units through the node's world matrix so a path
 * inside a rotated / scaled group behaves. Positions are world space unless noted.
 */
import type { Document, ID, Vec, AnchorRef, PathNode } from '@/model/types';
import { worldMatrix, refreshLiveShape } from '@/model/document';
import { scaleFactor, applyToPoint, applyToVector } from '@/geometry/matrix';
import { transformSubPath } from '@/geometry/path';
import { cornerAngle, cornerBisector, isRoundableCorner, maxCornerRadius, maxSharedRadius, clampRectRadii } from '@/geometry/corners';
import { normalize, sub, dot } from '@/geometry/vec';

type RectPath = PathNode & { shape: { kind: 'rect'; width: number; height: number; radii: [number, number, number, number] } };
import { editablePathIds } from './anchors';

/** Screen distance from the vertex at which a sharp corner shows its widget. */
export const WIDGET_OFFSET_PX = 14;
/** Hit radius of a widget in screen pixels. */
export const WIDGET_HIT_PX = 7;
/** Above this many corners in the selection the widgets are hidden (they would only clutter). */
export const MAX_WIDGETS = 64;

export type CornerTarget = { kind: 'anchor'; subpath: number; index: number } | { kind: 'rect'; corner: 0 | 1 | 2 | 3 };

export interface CornerWidget {
  key: string;
  nodeId: ID;
  target: CornerTarget;
  /** the sharp vertex, world */
  vertex: Vec;
  /** unit bisector pointing into the corner (between the two edges), world */
  bisector: Vec;
  /** interior angle of the corner */
  theta: number;
  /** current radius, world units */
  radius: number;
  /** largest radius the corner can take, world units */
  maxRadius: number;
}

/** World-space distance from the vertex to the widget centre for a radius (arc midpoint + a fixed screen offset). */
export function widgetDistance(w: CornerWidget, zoom: number): number {
  const s = Math.sin(w.theta / 2);
  const arcMid = s > 1e-6 ? w.radius / s - w.radius : 0;
  return arcMid + WIDGET_OFFSET_PX / zoom;
}

export function widgetWorldPosition(w: CornerWidget, zoom: number): Vec {
  const d = widgetDistance(w, zoom);
  return { x: w.vertex.x + w.bisector.x * d, y: w.vertex.y + w.bisector.y * d };
}

/** Radius for a pointer position dragged along the bisector (inverse of widgetDistance). */
export function radiusForPointer(w: CornerWidget, world: Vec, zoom: number): number {
  const along = dot(sub(world, w.vertex), w.bisector) - WIDGET_OFFSET_PX / zoom;
  const s = Math.sin(w.theta / 2);
  if (s <= 1e-6 || s >= 1 - 1e-9) return 0;
  const r = (along * s) / (1 - s);
  return Math.max(0, Math.min(w.maxRadius, r));
}

function rectCornerLocal(n: RectPath, corner: number): { vertex: Vec; bisector: Vec } {
  const w = n.shape.width;
  const h = n.shape.height;
  const sx = Math.sign(w) || 1;
  const sy = Math.sign(h) || 1;
  switch (corner) {
    case 0:
      return { vertex: { x: 0, y: 0 }, bisector: { x: sx, y: sy } };
    case 1:
      return { vertex: { x: w, y: 0 }, bisector: { x: -sx, y: sy } };
    case 2:
      return { vertex: { x: w, y: h }, bisector: { x: -sx, y: -sy } };
    default:
      return { vertex: { x: 0, y: h }, bisector: { x: sx, y: -sy } };
  }
}

/** The largest value one rectangle corner may take given the other three (the edge minus the neighbour). */
export function rectCornerMax(width: number, height: number, radii: [number, number, number, number], corner: number): number {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const [tl, tr, br, bl] = radii;
  switch (corner) {
    case 0:
      return Math.max(0, Math.min(w - tr, h - bl));
    case 1:
      return Math.max(0, Math.min(w - tl, h - br));
    case 2:
      return Math.max(0, Math.min(w - bl, h - tr));
    default:
      return Math.max(0, Math.min(w - br, h - tl));
  }
}

/** The largest radius a set of rectangle corners can share, the other corners keeping theirs (two dragged corners split their edge). */
export function rectSharedMax(width: number, height: number, radii: [number, number, number, number], corners: Set<number>): number {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const sides: Array<[number, number, number]> = [
    [0, 1, w],
    [1, 2, h],
    [2, 3, w],
    [3, 0, h],
  ];
  let r = Infinity;
  for (const [a, b, len] of sides) {
    const da = corners.has(a);
    const db = corners.has(b);
    if (da && db) r = Math.min(r, len / 2);
    else if (da) r = Math.min(r, len - radii[b]);
    else if (db) r = Math.min(r, len - radii[a]);
  }
  return Number.isFinite(r) ? Math.max(0, r) : 0;
}

/** Widgets of one path: its live-rect corners, or its roundable anchors (optionally only `only` anchor indices per subpath). */
export function nodeCornerWidgets(doc: Document, id: ID, only?: Map<number, Set<number>>): CornerWidget[] {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path') return [];
  const wm = worldMatrix(doc, id);
  const k = scaleFactor(wm);
  const out: CornerWidget[] = [];
  if (n.shape?.kind === 'rect') {
    const shape = n.shape;
    const radii = clampRectRadii(shape.width, shape.height, shape.radii);
    for (let c = 0; c < 4; c++) {
      if (only && !rectCornerSelected(n as RectPath, c, only)) continue;
      const loc = rectCornerLocal(n as RectPath, c);
      const vertex = applyToPoint(wm, loc.vertex);
      const ex = normalize(applyToVector(wm, { x: loc.bisector.x, y: 0 }));
      const ey = normalize(applyToVector(wm, { x: 0, y: loc.bisector.y }));
      const bis = normalize({ x: ex.x + ey.x, y: ex.y + ey.y });
      const theta = Math.acos(Math.max(-1, Math.min(1, ex.x * ey.x + ex.y * ey.y)));
      out.push({ key: `${id}/rect/${c}`, nodeId: id, target: { kind: 'rect', corner: c as 0 | 1 | 2 | 3 }, vertex, bisector: bis, theta, radius: radii[c] * k, maxRadius: rectCornerMax(shape.width, shape.height, radii, c) * k });
    }
    return out;
  }
  n.subpaths.forEach((sp, si) => {
    const wsp = transformSubPath(sp, wm);
    for (let i = 0; i < wsp.anchors.length; i++) {
      if (only && !only.get(si)?.has(i)) continue;
      if (!isRoundableCorner(wsp, i)) continue;
      const theta = cornerAngle(wsp, i);
      const radius = (sp.anchors[i].cornerRadius ?? 0) * k;
      // the room for this corner is measured with the other corners at their current radii
      // (wsp is world space: transformSubPath already scaled the neighbours' radii)
      const maxR = maxCornerRadius(wsp, i, (j, a) => (j === i ? Number.MAX_SAFE_INTEGER : (a.cornerRadius ?? 0)));
      out.push({ key: `${id}/${si}/${i}`, nodeId: id, target: { kind: 'anchor', subpath: si, index: i }, vertex: { ...wsp.anchors[i].point }, bisector: cornerBisector(wsp, i), theta, radius, maxRadius: Number.isFinite(maxR) ? maxR : 0 });
    }
  });
  return out;
}

/** For a live rect the widget belongs to the selected anchor(s) nearest to that corner. */
function rectCornerSelected(n: RectPath, corner: number, only: Map<number, Set<number>>): boolean {
  const sel = only.get(0);
  if (!sel || !sel.size) return false;
  const loc = rectCornerLocal(n, corner).vertex;
  const sp = n.subpaths[0];
  if (!sp) return false;
  for (const i of sel) {
    const a = sp.anchors[i];
    if (!a) continue;
    // an anchor sits on this corner when it is within the corner's radius region (arc end points touch the edges)
    const dx = Math.abs(a.point.x - loc.x);
    const dy = Math.abs(a.point.y - loc.y);
    const r = Math.max(1e-6, n.shape.radii[corner] ?? 0);
    if ((dx <= r + 1e-6 && dy <= 1e-6) || (dy <= r + 1e-6 && dx <= 1e-6) || (dx <= 1e-6 && dy <= 1e-6)) return true;
  }
  return false;
}

/**
 * Widgets for the current selection: the selected anchors' corners when anchors are
 * selected, otherwise every corner of the selected paths. Empty above MAX_WIDGETS.
 */
export function selectionCornerWidgets(doc: Document, selection: ID[], selectedAnchors: AnchorRef[]): CornerWidget[] {
  // computed on every pointer move of the Direct Selection tool: memoise on the store objects
  if (memo && memo.doc === doc && memo.selection === selection && memo.anchors === selectedAnchors) return memo.widgets;
  const widgets = computeSelectionCornerWidgets(doc, selection, selectedAnchors);
  memo = { doc, selection, anchors: selectedAnchors, widgets };
  return widgets;
}

let memo: { doc: Document; selection: ID[]; anchors: AnchorRef[]; widgets: CornerWidget[] } | null = null;

/** Paths above this many anchors show no widgets (a traced photo would cost a full pass per pointer move). */
const MAX_WIDGET_ANCHORS = 4000;

function computeSelectionCornerWidgets(doc: Document, selection: ID[], selectedAnchors: AnchorRef[]): CornerWidget[] {
  const ids = editablePathIds(doc, selection);
  const out: CornerWidget[] = [];
  let anchors = 0;
  for (const id of ids) {
    const n = doc.nodes[id];
    if (n && n.type === 'path') for (const sp of n.subpaths) anchors += sp.anchors.length;
    if (anchors > MAX_WIDGET_ANCHORS) return [];
  }
  if (selectedAnchors.length) {
    const byNode = new Map<ID, Map<number, Set<number>>>();
    for (const r of selectedAnchors) {
      if (!byNode.has(r.nodeId)) byNode.set(r.nodeId, new Map());
      const m = byNode.get(r.nodeId)!;
      if (!m.has(r.subpath)) m.set(r.subpath, new Set());
      m.get(r.subpath)!.add(r.index);
    }
    for (const [id, only] of byNode) if (ids.includes(id)) out.push(...nodeCornerWidgets(doc, id, only));
  } else {
    for (const id of ids) {
      out.push(...nodeCornerWidgets(doc, id));
      if (out.length > MAX_WIDGETS) return [];
    }
  }
  return out.length > MAX_WIDGETS ? [] : out;
}

/** Nearest widget within `hitPx` screen pixels of a screen point. */
export function hitCornerWidget(widgets: CornerWidget[], screen: Vec, worldToScreen: (p: Vec) => Vec, zoom: number, hitPx = WIDGET_HIT_PX): CornerWidget | null {
  let best: CornerWidget | null = null;
  let bestD = hitPx;
  for (const w of widgets) {
    const p = worldToScreen(widgetWorldPosition(w, zoom));
    const d = Math.hypot(p.x - screen.x, p.y - screen.y);
    if (d <= bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/** Set the radius (world units) of one corner on an immer draft. Returns false when the target is gone. */
export function setCornerRadiusWorld(draft: Document, nodeId: ID, target: CornerTarget, radiusWorld: number): boolean {
  const n = draft.nodes[nodeId];
  if (!n || n.type !== 'path') return false;
  const k = scaleFactor(worldMatrix(draft, nodeId)) || 1;
  const r = Math.max(0, radiusWorld / k);
  if (target.kind === 'rect') {
    if (n.shape?.kind !== 'rect') return false;
    const radii = [...n.shape.radii] as [number, number, number, number];
    radii[target.corner] = Math.min(r, rectCornerMax(n.shape.width, n.shape.height, radii, target.corner));
    n.shape = { ...n.shape, radii };
    refreshLiveShape(n);
    return true;
  }
  const a = n.subpaths[target.subpath]?.anchors[target.index];
  if (!a) return false;
  if (r > 1e-9) a.cornerRadius = r;
  else delete a.cornerRadius;
  return true;
}

/**
 * Apply one dragged radius (world units) to a set of widgets at once: the corners of a live
 * rectangle are clamped together, and the anchors of one subpath share their edges (the
 * radius is capped so every dragged corner really gets it instead of a proportional cut).
 * Returns the radius actually stored (world units).
 */
export function applyCornerDrag(draft: Document, widgets: CornerWidget[], radiusWorld: number): number {
  let applied = radiusWorld;
  const byNode = new Map<ID, CornerWidget[]>();
  for (const w of widgets) (byNode.get(w.nodeId) ?? byNode.set(w.nodeId, []).get(w.nodeId)!).push(w);
  for (const [nodeId, list] of byNode) {
    const n = draft.nodes[nodeId];
    if (!n || n.type !== 'path') continue;
    const k = scaleFactor(worldMatrix(draft, nodeId)) || 1;
    const rects = new Set<number>();
    for (const w of list) if (w.target.kind === 'rect') rects.add(w.target.corner);
    if (rects.size && n.shape?.kind === 'rect') {
      const radii = [...n.shape.radii] as [number, number, number, number];
      const local = Math.min(radiusWorld / k, rectSharedMax(n.shape.width, n.shape.height, radii, rects));
      for (const c of rects) radii[c] = local;
      n.shape = { ...n.shape, radii };
      refreshLiveShape(n);
      applied = Math.min(applied, local * k);
    }
    const bySub = new Map<number, number[]>();
    for (const w of list) if (w.target.kind === 'anchor') (bySub.get(w.target.subpath) ?? bySub.set(w.target.subpath, []).get(w.target.subpath)!).push(w.target.index);
    for (const [si, indices] of bySub) {
      const sp = n.subpaths[si];
      if (!sp) continue;
      // the room is measured with the other corners at their current radii (a lone widget too)
      const local = Math.min(radiusWorld / k, maxSharedRadius(sp, indices));
      for (const i of indices) {
        const a = sp.anchors[i];
        if (!a) continue;
        const r = Math.max(0, local);
        if (r > 1e-9) a.cornerRadius = r;
        else delete a.cornerRadius;
      }
      applied = Math.min(applied, local * k);
    }
  }
  return Math.max(0, applied);
}

/** Set one radius (local units) on every corner of the given paths / anchors (Object > Path > Corners…). */
export function setCornerRadii(draft: Document, ids: ID[], radius: number, anchors?: AnchorRef[]): number {
  let count = 0;
  const r = Math.max(0, radius);
  if (anchors && anchors.length) {
    for (const ref of anchors) {
      const n = draft.nodes[ref.nodeId];
      if (!n || n.type !== 'path') continue;
      if (n.shape?.kind === 'rect') {
        const widgets = nodeCornerWidgets(draft, ref.nodeId, new Map([[ref.subpath, new Set([ref.index])]]));
        for (const w of widgets) if (setCornerRadiusWorld(draft, ref.nodeId, w.target, r * scaleFactor(worldMatrix(draft, ref.nodeId)))) count++;
        continue;
      }
      const a = n.subpaths[ref.subpath]?.anchors[ref.index];
      if (!a) continue;
      if (r > 1e-9) a.cornerRadius = r;
      else delete a.cornerRadius;
      count++;
    }
    return count;
  }
  for (const id of ids) {
    const n = draft.nodes[id];
    if (!n || n.type !== 'path') continue;
    if (n.shape?.kind === 'rect') {
      n.shape = { ...n.shape, radii: clampRectRadii(n.shape.width, n.shape.height, [r, r, r, r]) };
      refreshLiveShape(n);
      count += 4;
      continue;
    }
    for (const sp of n.subpaths) {
      for (let i = 0; i < sp.anchors.length; i++) {
        if (!isRoundableCorner(sp, i)) {
          delete sp.anchors[i].cornerRadius;
          continue;
        }
        if (r > 1e-9) sp.anchors[i].cornerRadius = r;
        else delete sp.anchors[i].cornerRadius;
        count++;
      }
    }
  }
  return count;
}

/** Current radius (local units) shared by the corners of the selection, or null when mixed / none. */
export function commonCornerRadius(doc: Document, ids: ID[], anchors?: AnchorRef[]): { radius: number | null; corners: number } {
  const values: number[] = [];
  const consider = (n: PathNode, si: number, i: number) => {
    if (n.shape?.kind === 'rect') return;
    const sp = n.subpaths[si];
    if (!sp || !isRoundableCorner(sp, i)) return;
    values.push(sp.anchors[i].cornerRadius ?? 0);
  };
  if (anchors && anchors.length) {
    for (const ref of anchors) {
      const n = doc.nodes[ref.nodeId];
      if (!n || n.type !== 'path') continue;
      if (n.shape?.kind === 'rect') {
        for (const w of nodeCornerWidgets(doc, ref.nodeId, new Map([[ref.subpath, new Set([ref.index])]]))) values.push(w.radius / (scaleFactor(worldMatrix(doc, ref.nodeId)) || 1));
        continue;
      }
      consider(n, ref.subpath, ref.index);
    }
  } else {
    for (const id of ids) {
      const n = doc.nodes[id];
      if (!n || n.type !== 'path') continue;
      if (n.shape?.kind === 'rect') {
        values.push(...n.shape.radii);
        continue;
      }
      n.subpaths.forEach((sp, si) => sp.anchors.forEach((_, i) => consider(n, si, i)));
    }
  }
  if (!values.length) return { radius: null, corners: 0 };
  const first = values[0];
  return { radius: values.every((v) => Math.abs(v - first) < 1e-6) ? first : null, corners: values.length };
}
