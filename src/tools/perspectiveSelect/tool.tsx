/**
 * Perspective Selection tool (Shift+V): selects objects and moves them along
 * their perspective plane (the flat rectangle slides on the plane and the
 * projection is recomputed). Objects that are not in perspective yet are
 * attached to the active plane when dropped while the grid is shown.
 * Alt-drag duplicates, Shift constrains to one plane axis, 1 / 2 / 3 select
 * the active plane.
 */
import React from 'react';
import { SquareDashedMousePointer } from 'lucide-react';
import { produce } from 'immer';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { Document, ID, PerspectiveGrid, PerspectivePlane, Vec } from '@/model/types';
import { getState } from '@/store/store';
import { applyWorldMatrix, topmostOf, sortByPaintOrder, worldMatrix, localBounds } from '@/model/document';
import { translate, applyToPoint } from '@/geometry/matrix';
import { duplicateSelection } from '@/commands/core';
import { useOverlayStore } from '@/canvas/overlayStore';
import { usePerspectiveStore } from '@/perspective/store';
import { planeCoords, planeToFlat, PLANE_COLORS, PLANE_LABELS } from '@/perspective/grid';
import { attachmentOf, attachToPlane, moveAttached, canAttach } from '@/perspective/ops';
import { Row, Segmented, Checkbox } from '@/ui/widgets';
import { applyGeometryEffects } from '@/canvas/effectiveGeometry';
import { pathBounds } from '@/geometry/path';

interface Gesture {
  ids: ID[];
  start: Vec;
  base: Document;
  moved: boolean;
  duplicated: boolean;
}

let gesture: Gesture | null = null;

function flatDelta(g: PerspectiveGrid, plane: PerspectivePlane, from: Vec, to: Vec, shift: boolean): Vec {
  const a = planeCoords(g, plane, from);
  const b = planeCoords(g, plane, to);
  const f0 = planeToFlat(g, plane, a.u, a.v);
  const f1 = planeToFlat(g, plane, b.u, b.v);
  let dx = f1.x - f0.x;
  let dy = f1.y - f0.y;
  if (shift) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  return { x: dx, y: dy };
}

function finish(ctx: ToolContext) {
  gesture = null;
  useOverlayStore.getState().setHud(null);
  ctx.requestOverlay();
}

export const tool: Tool = {
  id: 'perspectiveSelect',
  name: 'Perspective Selection Tool',
  shortcut: 'shift+v',
  icon: SquareDashedMousePointer,
  group: 'perspective',
  order: 781,
  cursor: 'default',
  hint: 'Drag objects along their perspective plane. Dropping a flat object attaches it to the active plane. Alt duplicates, Shift constrains, 1 / 2 / 3 switch the plane.',
  showSelectionOverlay: true,
  Options: PerspectiveSelectOptions,

  activate(ctx) {
    if (ctx.state.doc.perspective) usePerspectiveStore.getState().setVisible(true);
    ctx.requestOverlay();
  },
  deactivate(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    useOverlayStore.getState().setHud(null);
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const hit = ctx.hitTest(e.world);
    if (!hit) {
      if (!e.shift) s.clearSelection();
      return;
    }
    const target = hit.target;
    if (e.shift) {
      s.toggleSelection(target);
      return;
    }
    if (!s.selection.includes(target)) s.setSelection([target]);
    let base = getState().doc;
    let duplicated = false;
    if (e.alt) {
      duplicateSelection();
      base = getState().doc;
      duplicated = true;
    }
    const ids = sortByPaintOrder(base, topmostOf(base, getState().selection));
    gesture = { ids, start: e.world, base, moved: false, duplicated };
    ctx.setCursor('move');
  },

  onPointerMove(e, ctx) {
    const g = gesture;
    if (!g) {
      const hit = ctx.hitTest(e.world);
      ctx.setCursor(hit ? 'move' : 'default');
      return;
    }
    const s = ctx.state;
    if (!g.moved && Math.hypot(e.world.x - g.start.x, e.world.y - g.start.y) < 3 / s.zoom) return;
    g.moved = true;
    const grid = g.base.perspective;
    let dx = e.world.x - g.start.x;
    let dy = e.world.y - g.start.y;
    if (e.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const hud: string[] = [];
    s.replaceDoc(
      produce(g.base, (d) => {
        for (const id of g.ids) {
          const a = attachmentOf(d, id);
          if (a && grid) {
            const fd = flatDelta(grid, a.plane, g.start, e.world, e.shift);
            moveAttached(d, id, grid, fd.x, fd.y);
            if (!hud.length) hud.push(`${PLANE_LABELS[a.plane]}: ${Math.round(fd.x)}, ${Math.round(-fd.y)}`);
          } else applyWorldMatrix(d, id, translate(dx, dy));
        }
      }),
    );
    useOverlayStore.getState().setHud({ screen: { x: e.screen.x + 16, y: e.screen.y + 16 }, text: hud[0] ?? `dX: ${Math.round(dx)}  dY: ${Math.round(dy)}` });
    ctx.requestOverlay();
  },

  onPointerUp(_e: ToolPointerEvent, ctx) {
    const g = gesture;
    if (!g) return;
    const s = ctx.state;
    if (!g.moved) {
      if (g.duplicated) ctx.commit('Duplicate');
      finish(ctx);
      ctx.setCursor('default');
      return;
    }
    const ui = usePerspectiveStore.getState();
    const grid = s.doc.perspective;
    if (ui.visible && grid) {
      // flat objects dropped on the grid join the active plane
      const flat = g.ids.filter((id) => !attachmentOf(s.doc, id) && canAttach(s.doc.nodes[id]));
      if (flat.length) s.updateDoc((d) => flat.forEach((id) => attachToPlane(d, id, grid, ui.activePlane)));
    }
    ctx.commit(g.duplicated ? 'Duplicate in Perspective' : 'Move in Perspective');
    finish(ctx);
    ctx.setCursor('move');
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (gesture) {
        this.cancel!(ctx);
        return true;
      }
      return false;
    }
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      usePerspectiveStore.getState().setActivePlane(e.key === '1' ? 'left' : e.key === '2' ? 'floor' : 'right');
      ctx.requestOverlay();
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const s = ctx.state;
    const quads: React.ReactNode[] = [];
    for (const id of s.selection) {
      const a = attachmentOf(s.doc, id);
      const n = s.doc.nodes[id];
      if (!a || !n) continue;
      const eff = n.effects.find((x) => x.type === 'freeDistort');
      if (!eff || eff.type !== 'freeDistort') continue;
      const frame = n.type === 'path' ? localBoundsOfBase(s.doc, id) : localBounds(s.doc, id);
      if (!frame) continue;
      const wm = worldMatrix(s.doc, id);
      const pts = eff.corners.map((c) => ctx.worldToScreen(applyToPoint(wm, { x: frame.x + c.x * frame.width, y: frame.y + c.y * frame.height })));
      quads.push(<path key={id} className="pg-attached" d={pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + 'Z'} stroke={PLANE_COLORS[a.plane]} />);
    }
    return <g className="perspective-tool-overlay perspective-select-overlay">{quads}</g>;
  },

  isBusy: () => !!gesture,
  cancel(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    useOverlayStore.getState().setHud(null);
    ctx.requestOverlay();
  },
};

/** Bounds of a path's geometry before its free-distort effect (the effect frame). */
function localBoundsOfBase(doc: Document, id: ID) {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path') return null;
  const others = n.effects.filter((e) => e.type !== 'freeDistort');
  return pathBounds(applyGeometryEffects(n.subpaths, others, null));
}

function PerspectiveSelectOptions() {
  const active = usePerspectiveStore((s) => s.activePlane);
  const drawOn = usePerspectiveStore((s) => s.drawOnPlane);
  return (
    <Row gap={8}>
      <Segmented value={active} onChange={(v) => usePerspectiveStore.getState().setActivePlane(v as PerspectivePlane)} options={[{ value: 'left', label: 'Left' }, { value: 'floor', label: 'Floor' }, { value: 'right', label: 'Right' }]} title="Active plane (1 / 2 / 3)" />
      <Checkbox checked={drawOn} onChange={(v) => usePerspectiveStore.getState().setDrawOnPlane(v)} label="Draw on active plane" />
      <span className="muted small">Drag objects along the plane · Alt duplicates · drop a flat object to attach it</span>
    </Row>
  );
}

void React;
