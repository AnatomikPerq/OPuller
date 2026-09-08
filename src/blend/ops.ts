/**
 * Blends (Object > Blend): a blend group contains its source objects and the
 * generated intermediate steps between consecutive sources. The group carries
 * `data.blend` so the steps can be regenerated when a source changes.
 */
import type { Document, ID, PathNode, Paint, StrokeStyle, GroupNode, SubPath, Node } from '@/model/types';
import { makePath, makeGroup, clonePaint, cloneStroke } from '@/model/nodes';
import { addNode, removeNode, worldSubPaths, setWorldSubPaths, moveNode, getChildren, indexInParent, sortByPaintOrder, topmostOf, worldBounds } from '@/model/document';
import { interpolatePaths, pathArea } from '@/geometry/paperBridge';
import { pathLength } from '@/geometry/path';
import { hexToRgb, rgbToHex } from '@/util/color';

export type BlendSpacing = 'steps' | 'distance' | 'smooth';

export interface BlendSpec {
  spacing: BlendSpacing;
  /** number of intermediate steps (spacing === 'steps') */
  steps: number;
  /** distance between steps in px (spacing === 'distance') */
  distance: number;
  /** ids of the source objects in order */
  sources: ID[];
  /** whether steps keep the fill/stroke interpolation (always true for now) */
  colors?: boolean;
}

export const DEFAULT_BLEND: Omit<BlendSpec, 'sources'> = { spacing: 'steps', steps: 8, distance: 40, colors: true };

export function isBlendGroup(n: Node | undefined | null): n is GroupNode & { data: { blend: BlendSpec } } {
  return !!n && n.type === 'group' && !!n.data && !!(n.data as any).blend;
}

export function blendSpec(n: Node | undefined | null): BlendSpec | null {
  return isBlendGroup(n) ? ((n.data as any).blend as BlendSpec) : null;
}

/** Blend groups among the selection (the groups themselves or their sources). */
export function blendGroupsOf(doc: Document, ids: ID[]): ID[] {
  const out = new Set<ID>();
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    if (isBlendGroup(n)) out.add(id);
    else if (n.parent && isBlendGroup(doc.nodes[n.parent])) out.add(n.parent);
  }
  return Array.from(out);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({ r: Math.round(lerp(ca.r, cb.r, t)), g: Math.round(lerp(ca.g, cb.g, t)), b: Math.round(lerp(ca.b, cb.b, t)) });
}

export function lerpPaint(a: Paint, b: Paint, t: number): Paint {
  if (a.type === 'solid' && b.type === 'solid') return { type: 'solid', color: lerpColor(a.color, b.color, t), opacity: lerp(a.opacity, b.opacity, t) };
  if (a.type === 'none' && b.type === 'solid') return { type: 'solid', color: b.color, opacity: lerp(0, b.opacity, t) };
  if (a.type === 'solid' && b.type === 'none') return { type: 'solid', color: a.color, opacity: lerp(a.opacity, 0, t) };
  if ((a.type === 'linear' && b.type === 'linear') || (a.type === 'radial' && b.type === 'radial')) {
    const n = Math.max(a.stops.length, b.stops.length);
    const stops = Array.from({ length: n }, (_, i) => {
      const sa = a.stops[Math.min(i, a.stops.length - 1)];
      const sb = b.stops[Math.min(i, b.stops.length - 1)];
      return { offset: lerp(sa.offset, sb.offset, t), color: lerpColor(sa.color, sb.color, t), opacity: lerp(sa.opacity, sb.opacity, t) };
    });
    if (a.type === 'linear' && b.type === 'linear') return { ...a, x1: lerp(a.x1, b.x1, t), y1: lerp(a.y1, b.y1, t), x2: lerp(a.x2, b.x2, t), y2: lerp(a.y2, b.y2, t), stops };
    if (a.type === 'radial' && b.type === 'radial') return { ...a, cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t), r: lerp(a.r, b.r, t), stops };
  }
  return t < 0.5 ? clonePaint(a) : clonePaint(b);
}

export function lerpStroke(a: StrokeStyle, b: StrokeStyle, t: number): StrokeStyle {
  const base = t < 0.5 ? cloneStroke(a) : cloneStroke(b);
  return { ...base, paint: lerpPaint(a.paint, b.paint, t), width: lerp(a.width, b.width, t), dash: base.dash };
}

/** Sources of a blend that can be interpolated (paths with geometry). */
function usableSources(doc: Document, ids: ID[]): ID[] {
  return ids.filter((id) => {
    const n = doc.nodes[id];
    return n && n.type === 'path' && n.subpaths.some((sp) => sp.anchors.length >= 2);
  });
}

function stepCount(doc: Document, spec: BlendSpec, a: ID, b: ID): number {
  if (spec.spacing === 'steps') return Math.max(0, Math.min(1000, Math.round(spec.steps)));
  const ba = worldBounds(doc, a);
  const bb = worldBounds(doc, b);
  if (!ba || !bb) return 0;
  const dist = Math.hypot(bb.x + bb.width / 2 - (ba.x + ba.width / 2), bb.y + bb.height / 2 - (ba.y + ba.height / 2));
  if (spec.spacing === 'distance') return Math.max(0, Math.min(1000, Math.round(dist / Math.max(1, spec.distance)) - 1));
  // smooth colour: enough steps for a smooth transition (about one per 2px of travel, capped)
  const na = doc.nodes[a] as PathNode;
  const nb = doc.nodes[b] as PathNode;
  const size = Math.max(ba.width, ba.height, bb.width, bb.height, 1);
  let colorDiff = 0;
  if (na.fill.type === 'solid' && nb.fill.type === 'solid') {
    const ca = hexToRgb(na.fill.color);
    const cb = hexToRgb(nb.fill.color);
    colorDiff = (Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b)) / 3;
  }
  const byTravel = Math.ceil(Math.max(dist, size) / 3);
  const byColor = Math.ceil(colorDiff);
  return Math.max(3, Math.min(254, Math.max(byTravel, byColor)));
}

/** Interpolated node between two path sources at t (world geometry). */
function interpolateNode(doc: Document, a: PathNode, b: PathNode, t: number): { node: PathNode; world: SubPath[] } {
  let from = worldSubPaths(doc, a.id);
  let to = worldSubPaths(doc, b.id);
  // orient both the same way so shapes do not twist through zero area
  if (from.length === 1 && to.length === 1 && Math.sign(pathArea(from) || 1) !== Math.sign(pathArea(to) || 1)) {
    to = [{ ...to[0], anchors: [...to[0].anchors].reverse().map((an) => ({ ...an, handleIn: an.handleOut, handleOut: an.handleIn })) }];
  }
  void pathLength;
  const world = interpolatePaths(from, to, t);
  const node = makePath([], {
    fill: lerpPaint(a.fill, b.fill, t),
    stroke: lerpStroke(a.stroke, b.stroke, t),
    fillRule: t < 0.5 ? a.fillRule : b.fillRule,
    opacity: lerp(a.opacity, b.opacity, t),
    blendMode: t < 0.5 ? a.blendMode : b.blendMode,
    name: 'Blend step',
  });
  node.data = { blendStep: true };
  return { node, world };
}

/**
 * (Re)generate the intermediate steps of a blend group. Existing steps are
 * removed; sources stay in place and steps are inserted between them.
 */
export function regenerateBlend(doc: Document, groupId: ID): void {
  const g = doc.nodes[groupId];
  const spec = blendSpec(g);
  if (!g || !isBlendGroup(g) || !spec) return;
  // drop old steps
  for (const c of [...g.children]) {
    const n = doc.nodes[c];
    if (n && n.data && (n.data as any).blendStep) removeNode(doc, c);
  }
  const sources = usableSources(doc, spec.sources.filter((id) => g.children.includes(id)));
  spec.sources = sources;
  if (sources.length < 2) return;
  for (let i = 0; i < sources.length - 1; i++) {
    const a = doc.nodes[sources[i]] as PathNode;
    const b = doc.nodes[sources[i + 1]] as PathNode;
    const n = stepCount(doc, spec, a.id, b.id);
    const insertAt = indexInParent(doc, a.id) + 1;
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const { node, world } = interpolateNode(doc, a, b, t);
      addNode(doc, node, groupId, insertAt + k - 1);
      setWorldSubPaths(doc, node.id, world);
    }
  }
  // keep the group's blend data object fresh
  g.data = { ...(g.data ?? {}), blend: { ...spec } };
}

/** Make a blend from the given objects (paint order). Returns the group id or null. */
export function makeBlend(doc: Document, ids: ID[], opts: Partial<Omit<BlendSpec, 'sources'>> = {}): ID | null {
  const roots = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id]?.type === 'path');
  if (roots.length < 2) return null;
  const top = roots[roots.length - 1];
  const parent = doc.nodes[top].parent;
  const index = indexInParent(doc, top);
  const g = makeGroup([], { name: 'Blend' });
  g.data = { blend: { ...DEFAULT_BLEND, ...opts, sources: roots } };
  addNode(doc, g, parent, index + 1);
  for (const id of roots) moveNode(doc, id, g.id);
  regenerateBlend(doc, g.id);
  return g.id;
}

/** Release: remove the steps and ungroup the sources. */
export function releaseBlend(doc: Document, groupId: ID): ID[] {
  const g = doc.nodes[groupId];
  if (!isBlendGroup(g)) return [];
  const parent = g.parent;
  const index = indexInParent(doc, groupId);
  const keep: ID[] = [];
  for (const c of [...g.children]) {
    const n = doc.nodes[c];
    if (!n) continue;
    if (n.data && (n.data as any).blendStep) removeNode(doc, c);
    else keep.push(c);
  }
  keep.forEach((id, i) => moveNode(doc, id, parent, index + i));
  removeNode(doc, groupId);
  return keep;
}

/** Expand: keep everything as a plain group of paths. */
export function expandBlend(doc: Document, groupId: ID): void {
  const g = doc.nodes[groupId];
  if (!isBlendGroup(g)) return;
  for (const c of g.children) {
    const n = doc.nodes[c];
    if (n && n.data && (n.data as any).blendStep) {
      const d = { ...n.data };
      delete (d as any).blendStep;
      n.data = Object.keys(d).length ? d : undefined;
      n.name = 'Path';
    }
  }
  const d = { ...(g.data ?? {}) };
  delete (d as any).blend;
  (g as GroupNode).data = Object.keys(d).length ? d : undefined;
  g.name = 'Group';
}

/** Reverse the order of the sources (the spine direction). */
export function reverseBlend(doc: Document, groupId: ID): void {
  const g = doc.nodes[groupId];
  const spec = blendSpec(g);
  if (!isBlendGroup(g) || !spec) return;
  const sources = [...spec.sources].reverse();
  // reorder children: sources in the new order, steps regenerated
  for (const c of [...g.children]) {
    const n = doc.nodes[c];
    if (n && n.data && (n.data as any).blendStep) removeNode(doc, c);
  }
  const others = g.children.filter((c) => !sources.includes(c));
  g.children = others.concat(sources);
  spec.sources = sources;
  g.data = { ...(g.data ?? {}), blend: { ...spec } };
  regenerateBlend(doc, groupId);
}

/** Reverse front-to-back stacking of the steps. */
export function reverseBlendStacking(doc: Document, groupId: ID): void {
  const g = doc.nodes[groupId];
  if (!isBlendGroup(g)) return;
  g.children = [...g.children].reverse();
}

export function setBlendOptions(doc: Document, groupId: ID, opts: Partial<Omit<BlendSpec, 'sources'>>): void {
  const g = doc.nodes[groupId];
  const spec = blendSpec(g);
  if (!isBlendGroup(g) || !spec) return;
  g.data = { ...(g.data ?? {}), blend: { ...spec, ...opts } };
  regenerateBlend(doc, groupId);
}

/** Add an object to an existing blend (becomes the last source). */
export function addToBlend(doc: Document, groupId: ID, id: ID): boolean {
  const g = doc.nodes[groupId];
  const spec = blendSpec(g);
  const n = doc.nodes[id];
  if (!isBlendGroup(g) || !spec || !n || n.type !== 'path' || spec.sources.includes(id)) return false;
  moveNode(doc, id, groupId);
  g.data = { ...(g.data ?? {}), blend: { ...spec, sources: spec.sources.concat([id]) } };
  regenerateBlend(doc, groupId);
  return true;
}

export function sourceSnapshot(doc: Document, groupId: ID): Node[] {
  const spec = blendSpec(doc.nodes[groupId]);
  if (!spec) return [];
  return spec.sources.map((id) => doc.nodes[id]).filter(Boolean) as Node[];
}

export function childrenIds(doc: Document, id: ID): ID[] {
  return getChildren(doc, id);
}
