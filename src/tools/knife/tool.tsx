/**
 * Knife tool (K): drag a freehand line across paths to cut them into pieces.
 * Alt drags a straight line, Shift+Alt constrains it to 45°. Filled shapes are
 * divided into separate closed pieces, stroked open paths are split at the
 * crossings. Acts on the selection when there is one, otherwise on every
 * editable path.
 */
import React from 'react';
import { Slice } from 'lucide-react';
import type { Tool } from '../types';
import type { ID, Vec, PathNode, SubPath } from '@/model/types';
import { worldSubPaths, worldBounds } from '@/model/document';
import { polylineSubPath, pathBounds } from '@/geometry/path';
import { outlineStroke, booleanOp, fitPoints } from '@/geometry/paperBridge';
import { splitAtIntersections, splitIslands } from '@/pathops';
import { replaceNodeGeometry, erasableTargets, rectsIntersect } from '@/tools/freehand/apply';
import { constrainDelta } from '@/canvas/snap';
import { Checkbox, Row } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';

interface KnifeOptions extends Record<string, unknown> {
  straight: boolean;
}

let points: Vec[] | null = null;
let straightEnd: Vec | null = null;

const CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l7-7"/><path d="M10 14l9.5-9.5a2.1 2.1 0 0 1 3 3L13 17l-4 1z"/><path d="M14 8l3 3"/></svg>',
)}") 3 20, crosshair`;

/** Cut world-space geometry of one node with the knife path. Returns true when the node changed. */
export function cutNodeWithKnife(draft: import('@/model/types').Document, id: ID, knife: SubPath): ID[] | null {
  const n = draft.nodes[id] as PathNode | undefined;
  if (!n || n.type !== 'path') return null;
  const world = worldSubPaths(draft, id);
  const closed = world.filter((sp) => sp.closed && sp.anchors.length >= 3);
  const open = world.filter((sp) => !sp.closed || sp.anchors.length < 3);
  const filled = n.fill.type !== 'none' && closed.length > 0;
  let changed = false;
  let next: SubPath[] = [];
  if (filled) {
    const blade = outlineStroke([knife], 0.08, { cap: 'butt', join: 'round' });
    if (!blade.length) return null;
    const before = splitIslands(closed).length;
    let cut: SubPath[];
    try {
      cut = booleanOp('subtract', { subpaths: closed, fillRule: n.fillRule }, { subpaths: blade, fillRule: 'nonzero' });
    } catch {
      return null;
    }
    const after = splitIslands(cut).length;
    if (after > before) {
      changed = true;
      next = cut.concat(open.flatMap((sp) => splitAtIntersections(sp, [[knife]])));
    }
  }
  if (!changed) {
    // stroke-only or unfilled paths: split at the crossings
    const pieces: SubPath[] = [];
    for (const sp of world) {
      const parts = splitAtIntersections(sp, [[knife]]);
      if (parts.length > 1 || (parts.length === 1 && parts[0] !== sp && sp.closed)) changed = true;
      pieces.push(...parts);
    }
    if (!changed) return null;
    next = pieces;
  }
  return replaceNodeGeometry(draft, id, next, true);
}

function knifeSubPath(pts: Vec[]): SubPath | null {
  if (pts.length < 2) return null;
  if (pts.length === 2) return polylineSubPath(pts, false);
  const fitted = fitPoints(pts, 1.5, false);
  return fitted && fitted.anchors.length >= 2 ? fitted : polylineSubPath(pts, false);
}

export const tool: Tool = {
  id: 'knife',
  name: 'Knife Tool',
  shortcut: 'k',
  icon: Slice,
  group: 'edit',
  order: 631,
  cursor: CURSOR,
  hint: 'Drag across shapes to cut them. Alt: straight cut, Shift+Alt: constrain to 45°.',
  showSelectionOverlay: true,
  defaults: { straight: false } satisfies KnifeOptions,
  Options: KnifeOptions,

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    points = [e.world];
    straightEnd = null;
    ctx.capture(e.pointerId);
    ctx.requestOverlay();
  },
  onPointerMove(e, ctx) {
    if (!points) return;
    const opts = ctx.options<KnifeOptions>();
    const straight = e.alt || opts.straight;
    if (straight) {
      let end = e.world;
      if (e.shift) {
        const d = constrainDelta({ x: end.x - points[0].x, y: end.y - points[0].y });
        end = { x: points[0].x + d.x, y: points[0].y + d.y };
      }
      straightEnd = end;
    } else {
      straightEnd = null;
      const last = points[points.length - 1];
      if (Math.hypot(e.world.x - last.x, e.world.y - last.y) >= 1.5 / ctx.zoom) points.push(e.world);
    }
    ctx.requestOverlay();
  },
  onPointerUp(_e, ctx) {
    const pts = points;
    const end = straightEnd;
    points = null;
    straightEnd = null;
    ctx.requestOverlay();
    if (!pts) return;
    const line = end ? [pts[0], end] : pts;
    const knife = knifeSubPath(line);
    if (!knife) return;
    const s = ctx.state;
    const kb = pathBounds([knife]);
    const targets = erasableTargets(s).ids.filter((id) => rectsIntersect(worldBounds(s.doc, id), kb, 1));
    if (!targets.length) return;
    let cutCount = 0;
    const newIds: ID[] = [];
    s.updateDoc((d) => {
      for (const id of targets) {
        const ids = cutNodeWithKnife(d, id, knife);
        if (ids) {
          cutCount++;
          newIds.push(...ids);
        }
      }
    }, 'Knife');
    if (!cutCount) {
      ctx.setStatus('The knife did not cross any path');
      return;
    }
    ctx.state.setSelection(newIds);
    ctx.setStatus(`Cut ${cutCount} path${cutCount > 1 ? 's' : ''} into ${newIds.length} pieces`);
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && points) {
      this.cancel!(ctx);
      return true;
    }
    return false;
  },
  renderOverlay(ctx) {
    if (!points || points.length < 1) return null;
    const line = straightEnd ? [points[0], straightEnd] : points;
    if (line.length < 2) return null;
    const d = line.map((p, i) => {
      const sp = ctx.worldToScreen(p);
      return `${i === 0 ? 'M' : 'L'}${sp.x.toFixed(1)} ${sp.y.toFixed(1)}`;
    });
    return (
      <g className="knife-overlay" pointerEvents="none">
        <path d={d.join(' ')} fill="none" stroke="#fff" strokeWidth={3} strokeOpacity={0.6} strokeLinecap="round" strokeLinejoin="round" />
        <path d={d.join(' ')} fill="none" stroke="#e0245e" strokeWidth={1.5} strokeDasharray="6 4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
  },
  isBusy: () => !!points,
  cancel(ctx) {
    points = null;
    straightEnd = null;
    ctx.requestOverlay();
  },
};

function KnifeOptions() {
  const [opts, set] = useToolOptions<KnifeOptions>('knife');
  return (
    <Row gap={10}>
      <Checkbox checked={!!opts.straight} onChange={(v) => set({ straight: v })} label="Straight line" title="Cut along a straight line (same as holding Alt)" />
      <span className="muted small">Drag across shapes. Selected paths only when there is a selection.</span>
    </Row>
  );
}

void React;
