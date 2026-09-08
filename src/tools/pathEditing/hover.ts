/**
 * Shared hit testing for anchor editing tools: anchors and handles of the
 * editable paths first, then path segments, then any object under the cursor.
 */
import type { ID, Vec, AnchorRef, HandleRef } from '@/model/types';
import type { ToolContext } from '@/tools/types';
import { hitTestSegment } from '@/canvas/hitTest';
import { editablePathIds, isEndAnchor, getSubPath } from './anchors';

export type EditHit =
  | { kind: 'anchor'; ref: AnchorRef; point: Vec; first: boolean; last: boolean; open: boolean; count: number }
  | { kind: 'handle'; ref: HandleRef; point: Vec }
  | { kind: 'segment'; nodeId: ID; subpath: number; segment: number; t: number; point: Vec }
  | { kind: 'object'; id: ID; target: ID; hitKind: 'fill' | 'stroke' | 'bounds'; point: Vec };

export interface EditHitOptions {
  /** paths whose anchors / segments are tested first (usually the selected paths) */
  ids: ID[];
  /** test handles of selected anchors */
  handles?: boolean;
  /** also look for any other object under the cursor (enters groups) */
  anyObject?: boolean;
  /** when an unselected path is hit, test its anchors too */
  anchorsOfHit?: boolean;
  /** only anchors of `ids` are reported (no segments) */
  anchorsOnly?: boolean;
  /** report fills of `ids` paths as object hits (clicking inside a selected shape) */
  fills?: boolean;
}

function anchorHit(ctx: ToolContext, ref: AnchorRef, point: Vec): EditHit {
  const doc = ctx.doc;
  const sp = getSubPath(doc, ref);
  const ends = isEndAnchor(doc, ref);
  return { kind: 'anchor', ref, point, first: ends.first, last: ends.last, open: !!sp && !sp.closed, count: sp?.anchors.length ?? 0 };
}

export function findEditHit(ctx: ToolContext, world: Vec, opts: EditHitOptions): EditHit | null {
  const doc = ctx.doc;
  const ids = opts.ids;
  if (ids.length) {
    const ah = ctx.hitTestAnchors(world, ids, opts.handles ?? true);
    if (ah) {
      if (ah.kind === 'handle' && ah.handle) return { kind: 'handle', ref: ah.handle, point: ah.point };
      if (ah.kind === 'anchor' && ah.anchor) return anchorHit(ctx, ah.anchor, ah.point);
    }
    if (!opts.anchorsOnly) {
      const tol = ctx.tolerance();
      let best: ReturnType<typeof hitTestSegment> = null;
      for (const id of ids) {
        const r = hitTestSegment(doc, id, world, tol);
        if (r && (!best || r.distance < best.distance)) best = r;
      }
      if (best && best.segment) return { kind: 'segment', nodeId: best.id, subpath: best.segment.subpath, segment: best.segment.segment, t: best.segment.t, point: best.point };
    }
  }
  if (!opts.anyObject) return null;
  const hit = ctx.hitTest(world, { enterGroups: true, fills: opts.fills ?? true });
  if (!hit) return null;
  const n = doc.nodes[hit.id];
  if (n && n.type === 'path') {
    if (!ids.includes(hit.id) && (opts.anchorsOfHit ?? true)) {
      const ah = ctx.hitTestAnchors(world, [hit.id], false);
      if (ah && ah.kind === 'anchor' && ah.anchor) return anchorHit(ctx, ah.anchor, ah.point);
    }
    // stroke hits (also thick strokes of selected paths) are segment hits
    if (hit.kind === 'stroke' && hit.segment && !opts.anchorsOnly) {
      return { kind: 'segment', nodeId: hit.id, subpath: hit.segment.subpath, segment: hit.segment.segment, t: hit.segment.t, point: hit.point };
    }
  }
  if (hit.kind === 'anchor' || hit.kind === 'handle' || hit.kind === 'segment') return null;
  return { kind: 'object', id: hit.id, target: hit.target, hitKind: hit.kind, point: hit.point };
}

/** Editable paths of the selection (helper for tools). */
export function selectedPathIds(ctx: ToolContext): ID[] {
  const s = ctx.state;
  return editablePathIds(s.doc, s.selection);
}

/** A stable key for hover state comparisons. */
export function editHitKey(h: EditHit | null): string {
  if (!h) return '';
  switch (h.kind) {
    case 'anchor':
      return `a:${h.ref.nodeId}/${h.ref.subpath}/${h.ref.index}`;
    case 'handle':
      return `h:${h.ref.nodeId}/${h.ref.subpath}/${h.ref.index}/${h.ref.side}`;
    case 'segment':
      return `s:${h.nodeId}/${h.subpath}/${h.segment}`;
    case 'object':
      return `o:${h.id}`;
  }
}
