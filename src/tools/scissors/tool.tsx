/**
 * Scissors tool (C): click a segment or an anchor of a path to split the path
 * there. Closed paths become open; open paths become two paths.
 */
import React from 'react';
import { Scissors } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, Vec, PathNode, SubPath } from '@/model/types';
import { splitAtLocation, splitAtAnchor, nearestPointOnPath, cloneSubPath } from '@/geometry/path';
import { worldSubPaths } from '@/model/document';
import { replaceNodeGeometry, allEditablePaths, selectedEditablePaths } from '@/tools/freehand/apply';
import { hitTestSegment } from '@/canvas/hitTest';
import { SegmentHighlight, AnchorHighlight, PointMarker } from '@/tools/pathEditing/overlay';
import { Checkbox, Row } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';

interface CutHit {
  nodeId: ID;
  subpath: number;
  /** anchor index when cutting at an anchor */
  anchor?: number;
  /** segment location when cutting inside a segment */
  segment?: number;
  t?: number;
  point: Vec;
}

let hover: CutHit | null = null;

const CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
)}") 11 11, crosshair`;

function findCutHit(ctx: ToolContext, world: Vec): CutHit | null {
  const s = ctx.state;
  const opts = ctx.options<{ selectedOnly: boolean }>();
  const sel = selectedEditablePaths(s);
  const ids = opts.selectedOnly && sel.length ? sel : sel.length ? sel.concat(allEditablePaths(s).filter((id) => !sel.includes(id))) : allEditablePaths(s);
  const tol = ctx.tolerance() * 1.5;
  // anchors first (selected paths get priority)
  const ah = ctx.hitTestAnchors(world, ids, false);
  if (ah && ah.anchor) {
    const n = s.doc.nodes[ah.anchor.nodeId] as PathNode | undefined;
    const sp = n?.subpaths[ah.anchor.subpath];
    if (n && sp && sp.anchors.length > 2) return { nodeId: ah.anchor.nodeId, subpath: ah.anchor.subpath, anchor: ah.anchor.index, point: ah.point };
  }
  let best: CutHit | null = null;
  for (const id of ids) {
    const h = hitTestSegment(s.doc, id, world, tol);
    if (!h || !h.segment) continue;
    if (!best || h.distance < (best as any).distance) {
      best = { nodeId: id, subpath: h.segment.subpath, segment: h.segment.segment, t: h.segment.t, point: h.point };
      (best as any).distance = h.distance;
    }
  }
  return best;
}

/** Split the path at the hit; returns the ids of the resulting nodes. */
export function cutPathAt(ctx: ToolContext, hit: CutHit): ID[] {
  const s = ctx.state;
  let result: ID[] = [];
  s.updateDoc((d) => {
    const n = d.nodes[hit.nodeId] as PathNode | undefined;
    if (!n) return;
    const world = worldSubPaths(d, hit.nodeId);
    const sp = world[hit.subpath];
    if (!sp) return;
    let pieces: SubPath[];
    if (hit.anchor !== undefined) {
      pieces = splitAtAnchor(cloneSubPath(sp), hit.anchor);
    } else {
      // relocate the cut on the world subpath (t is from the same geometry)
      const loc = nearestPointOnPath([sp], hit.point);
      pieces = loc ? splitAtLocation(cloneSubPath(sp), loc.segment, loc.t) : splitAtLocation(cloneSubPath(sp), hit.segment ?? 0, hit.t ?? 0.5);
    }
    pieces = pieces.filter((p) => p.anchors.length >= 2);
    if (!pieces.length) return;
    if (pieces.length === 1 && pieces[0].closed) return;
    const others = world.filter((_, i) => i !== hit.subpath);
    if (pieces.length === 1) {
      // closed -> open, stays one node
      const next = [...world];
      next[hit.subpath] = pieces[0];
      replaceNodeGeometry(d, hit.nodeId, next, false);
      result = [hit.nodeId];
      return;
    }
    // open path split in two: first piece (+ other subpaths) stays, second becomes a new node
    const ids = replaceNodeGeometry(d, hit.nodeId, others.length ? [pieces[0], ...others, pieces[1]] : [pieces[0], pieces[1]], true);
    result = ids;
    void n;
  }, 'Cut Path');
  return result;
}

export const tool: Tool = {
  id: 'scissors',
  name: 'Scissors Tool',
  shortcut: 'c',
  icon: Scissors,
  group: 'edit',
  order: 630,
  cursor: CURSOR,
  hint: 'Click on a path segment or anchor point to cut the path there.',
  showSelectionOverlay: 'anchors',
  defaults: { selectedOnly: false },
  Options: ScissorsOptions,

  onPointerMove(e, ctx) {
    const h = findCutHit(ctx, e.world);
    const changed = (h?.nodeId ?? null) !== (hover?.nodeId ?? null) || h?.anchor !== hover?.anchor || h?.segment !== hover?.segment || h?.point.x !== hover?.point.x || h?.point.y !== hover?.point.y;
    hover = h;
    if (changed) ctx.requestOverlay();
    ctx.setStatus(h ? (h.anchor !== undefined ? 'Click to cut at this anchor point' : 'Click to cut the path here') : 'Move over a path to cut it');
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const h = findCutHit(ctx, e.world);
    if (!h) {
      ctx.state.toast('Click on a path to cut it.', 'info');
      return;
    }
    const ids = cutPathAt(ctx, h);
    if (ids.length) {
      const st = ctx.state;
      st.setSelection(ids);
      // select the new end anchors (Illustrator selects the cut points)
      const refs = ids.map((id) => {
        const n = st.doc.nodes[id] as PathNode;
        return { nodeId: id, subpath: 0, index: id === h.nodeId ? n.subpaths[0].anchors.length - 1 : 0 };
      });
      st.setSelectedAnchors(refs);
    }
    hover = null;
    ctx.requestOverlay();
  },
  renderOverlay(ctx) {
    if (!hover) return null;
    const h = hover;
    return (
      <g className="scissors-overlay">
        {h.anchor !== undefined ? (
          <AnchorHighlight ctx={ctx} ref={{ nodeId: h.nodeId, subpath: h.subpath, index: h.anchor }} />
        ) : (
          <>
            <SegmentHighlight ctx={ctx} ref={{ nodeId: h.nodeId, subpath: h.subpath, segment: h.segment ?? 0 }} />
            <PointMarker ctx={ctx} point={h.point} />
          </>
        )}
      </g>
    );
  },
  deactivate(ctx) {
    hover = null;
    ctx.requestOverlay();
  },
};

function ScissorsOptions() {
  const [opts, set] = useToolOptions<{ selectedOnly: boolean }>('scissors');
  return (
    <Row gap={10}>
      <Checkbox checked={!!opts.selectedOnly} onChange={(v) => set({ selectedOnly: v })} label="Selected paths only" title="When paths are selected, cut only those" />
      <span className="muted small">Click a segment or an anchor point to cut the path there.</span>
    </Row>
  );
}

void React;
