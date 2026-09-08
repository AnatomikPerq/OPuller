/**
 * Geometric hit testing against the document (world coordinates).
 */
import type { Document, ID, Vec, AnchorRef, HandleRef, PathNode } from '@/model/types';
import { isContainer } from '@/model/types';
import { worldMatrix, visualBounds, ancestors, isEffectivelyLocked, isEffectivelyVisible } from '@/model/document';
import { invert, applyToPoint, scaleFactor, multiply } from '@/geometry/matrix';
import { nearestPointOnPath, pointInPath, absHandleIn, absHandleOut, hasHandle } from '@/geometry/path';
import { layoutText } from '@/text/layout';
import { rectContainsPoint } from '@/geometry/vec';

export interface HitOptions {
  /** tolerance in world units */
  tolerance: number;
  /** hit leaves inside groups (direct selection) instead of the top-level group */
  enterGroups: boolean;
  /** also consider locked nodes */
  includeLocked: boolean;
  /** nodes to ignore */
  ignore?: Set<ID>;
  /** restrict to descendants of this container (isolation mode) */
  isolation?: ID | null;
  /** restrict to these ids (and their descendants) */
  only?: Set<ID>;
  /** test fills (interior) — when false only strokes/outlines count */
  fills: boolean;
  /** hit test text/image by bounds */
  bounds: boolean;
}

export type HitKind = 'fill' | 'stroke' | 'bounds' | 'anchor' | 'handle' | 'segment';

export interface HitResult {
  /** leaf node that was hit */
  id: ID;
  /** selectable target: the top-level group containing the leaf, or the leaf itself */
  target: ID;
  kind: HitKind;
  /** world point of the hit (on the stroke for stroke hits) */
  point: Vec;
  anchor?: AnchorRef;
  handle?: HandleRef;
  segment?: { subpath: number; segment: number; t: number };
  distance: number;
}

const DEFAULTS: HitOptions = { tolerance: 4, enterGroups: false, includeLocked: false, fills: true, bounds: true };

/** Candidates in reverse paint order (top-most first), honouring isolation. */
function candidateRoots(doc: Document, opts: HitOptions): ID[] {
  if (opts.isolation && doc.nodes[opts.isolation]) {
    const n = doc.nodes[opts.isolation];
    return isContainer(n) ? [...n.children].reverse() : [];
  }
  const out: ID[] = [];
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.nodes[doc.layers[i]];
    if (!layer || !isContainer(layer) || !layer.visible || (layer.locked && !opts.includeLocked)) continue;
    for (let k = layer.children.length - 1; k >= 0; k--) out.push(layer.children[k]);
  }
  return out;
}

/**
 * Hit test the document at a world point. Returns the top-most hit.
 */
export function hitTest(doc: Document, world: Vec, options: Partial<HitOptions> = {}): HitResult | null {
  const opts: HitOptions = { ...DEFAULTS, ...options };
  const roots = candidateRoots(doc, opts);
  for (const rootId of roots) {
    const r = hitNode(doc, rootId, world, opts, rootId);
    if (r) return r;
  }
  return null;
}

function hitNode(doc: Document, id: ID, world: Vec, opts: HitOptions, target: ID): HitResult | null {
  const n = doc.nodes[id];
  if (!n || !n.visible) return null;
  if (n.locked && !opts.includeLocked) return null;
  if (opts.ignore?.has(id)) return null;
  if (opts.only && !opts.only.has(id) && !ancestors(doc, id).some((a) => opts.only!.has(a))) {
    // maybe a descendant is allowed
    if (!isContainer(n)) return null;
  }
  const vb = visualBounds(doc, id);
  if (!vb) return null;
  if (!rectContainsPoint(vb, world, opts.tolerance)) return null;

  if (isContainer(n)) {
    // clipping group: only hits inside the clip area count
    if (n.type === 'group' && n.clipId) {
      const clip = doc.nodes[n.clipId];
      if (clip && clip.type === 'path') {
        const inv = invert(worldMatrix(doc, n.clipId));
        const local = applyToPoint(inv, world);
        if (!pointInPath(clip.subpaths, local, clip.fillRule)) {
          // allow hitting the clip path's outline itself
          const s = scaleFactor(worldMatrix(doc, n.clipId)) || 1;
          const loc = nearestPointOnPath(clip.subpaths, local);
          if (!loc || loc.distance * s > opts.tolerance) return null;
        }
      }
    }
    for (let i = n.children.length - 1; i >= 0; i--) {
      const cid = n.children[i];
      const childTarget = opts.enterGroups ? cid : target;
      const r = hitNode(doc, cid, world, opts, childTarget);
      if (r) return opts.enterGroups ? r : { ...r, target };
    }
    return null;
  }

  if (opts.only && !opts.only.has(id) && !ancestors(doc, id).some((a) => opts.only!.has(a))) return null;

  const wm = worldMatrix(doc, id);
  const inv = invert(wm);
  const local = applyToPoint(inv, world);
  const s = scaleFactor(wm) || 1;
  const tolLocal = opts.tolerance / s;

  if (n.type === 'path') {
    const strokeW = n.stroke.paint.type !== 'none' ? n.stroke.width : 0;
    const loc = nearestPointOnPath(n.subpaths, local);
    if (loc && loc.distance <= Math.max(tolLocal, strokeW / 2 + tolLocal * 0.5)) {
      return {
        id,
        target,
        kind: 'stroke',
        point: applyToPoint(wm, loc.point),
        segment: { subpath: loc.subpath, segment: loc.segment, t: loc.t },
        distance: loc.distance * s,
      };
    }
    if (opts.fills && n.fill.type !== 'none' && pointInPath(n.subpaths, local, n.fillRule)) {
      return { id, target, kind: 'fill', point: world, distance: 0 };
    }
    return null;
  }

  if (n.type === 'text') {
    if (!opts.bounds) return null;
    if (n.kind === 'path' && n.pathId && doc.nodes[n.pathId]?.type === 'path') {
      // type on a path: hit when close to the path (within the font size)
      const pathNode = doc.nodes[n.pathId] as PathNode;
      const rel = multiply(invert(n.transform), pathNode.transform);
      const localOnPath = applyToPoint(invert(rel), local);
      const loc = nearestPointOnPath(pathNode.subpaths, localOnPath);
      if (loc && loc.distance <= n.style.fontSize + tolLocal) return { id, target, kind: 'bounds', point: world, distance: loc.distance * s };
      return null;
    }
    const b = layoutText(n).bounds;
    if (rectContainsPoint(b, local, tolLocal)) return { id, target, kind: 'bounds', point: world, distance: 0 };
    return null;
  }

  if (n.type === 'image') {
    if (!opts.bounds) return null;
    if (rectContainsPoint({ x: 0, y: 0, width: n.width, height: n.height }, local, tolLocal))
      return { id, target, kind: 'bounds', point: world, distance: 0 };
    return null;
  }
  return null;
}

/**
 * Hit test anchors and handles of the given path nodes. Handles take precedence
 * over anchors (they are drawn on top). Returns null when nothing is close.
 */
export function hitTestAnchors(
  doc: Document,
  ids: ID[],
  world: Vec,
  tolerance: number,
  includeHandles = true,
  selectedAnchors: AnchorRef[] = [],
): HitResult | null {
  let best: HitResult | null = null;
  const consider = (r: HitResult) => {
    if (!best || r.distance < best.distance) best = r;
  };
  const selectedSet = new Set(selectedAnchors.map((a) => `${a.nodeId}/${a.subpath}/${a.index}`));
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || n.type !== 'path') continue;
    if (isEffectivelyLocked(doc, id) || !isEffectivelyVisible(doc, id)) continue;
    const wm = worldMatrix(doc, id);
    n.subpaths.forEach((sp, si) => {
      sp.anchors.forEach((a, ai) => {
        const p = applyToPoint(wm, a.point);
        const d = Math.hypot(p.x - world.x, p.y - world.y);
        if (d <= tolerance) consider({ id, target: id, kind: 'anchor', point: p, anchor: { nodeId: id, subpath: si, index: ai }, distance: d });
        if (includeHandles) {
          // handles are only hit-testable on selected anchors (or neighbours), like Illustrator
          const isSel = selectedSet.has(`${id}/${si}/${ai}`);
          const prevSel = selectedSet.has(`${id}/${si}/${(ai - 1 + sp.anchors.length) % sp.anchors.length}`);
          const nextSel = selectedSet.has(`${id}/${si}/${(ai + 1) % sp.anchors.length}`);
          // handles are only interactive on selected anchors and their neighbours
          if (!(isSel || prevSel || nextSel)) return;
          if (hasHandle(a.handleIn)) {
            const h = applyToPoint(wm, absHandleIn(a));
            const dh = Math.hypot(h.x - world.x, h.y - world.y);
            if (dh <= tolerance) consider({ id, target: id, kind: 'handle', point: h, handle: { nodeId: id, subpath: si, index: ai, side: 'in' }, distance: dh - 0.01 });
          }
          if (hasHandle(a.handleOut)) {
            const h = applyToPoint(wm, absHandleOut(a));
            const dh = Math.hypot(h.x - world.x, h.y - world.y);
            if (dh <= tolerance) consider({ id, target: id, kind: 'handle', point: h, handle: { nodeId: id, subpath: si, index: ai, side: 'out' }, distance: dh - 0.01 });
          }
        }
      });
    });
  }
  return best;
}

/** Hit test only the outline of a path (used by pen/scissors/knife to find a segment). */
export function hitTestSegment(doc: Document, id: ID, world: Vec, tolerance: number): HitResult | null {
  const n = doc.nodes[id] as PathNode | undefined;
  if (!n || n.type !== 'path') return null;
  const wm = worldMatrix(doc, id);
  const local = applyToPoint(invert(wm), world);
  const s = scaleFactor(wm) || 1;
  const loc = nearestPointOnPath(n.subpaths, local);
  if (!loc || loc.distance * s > tolerance) return null;
  return {
    id,
    target: id,
    kind: 'segment',
    point: applyToPoint(wm, loc.point),
    segment: { subpath: loc.subpath, segment: loc.segment, t: loc.t },
    distance: loc.distance * s,
  };
}

/** All selectable targets whose visual bounds intersect a world rect (marquee). */
export function nodesInRect(
  doc: Document,
  rect: { x: number; y: number; width: number; height: number },
  opts: { enterGroups?: boolean; isolation?: ID | null; containedOnly?: boolean; includeLocked?: boolean } = {},
): ID[] {
  const out: ID[] = [];
  const roots = candidateRoots(doc, { ...DEFAULTS, isolation: opts.isolation ?? null, includeLocked: !!opts.includeLocked });
  const test = (id: ID) => {
    const n = doc.nodes[id];
    if (!n || !n.visible || (n.locked && !opts.includeLocked)) return;
    if (isContainer(n) && opts.enterGroups) {
      for (const c of n.children) test(c);
      return;
    }
    const b = visualBounds(doc, id);
    if (!b) return;
    const intersects = b.x <= rect.x + rect.width && rect.x <= b.x + b.width && b.y <= rect.y + rect.height && rect.y <= b.y + b.height;
    const contained = b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height;
    if (opts.containedOnly ? contained : intersects) out.push(id);
  };
  for (const r of roots) test(r);
  return out.reverse();
}
