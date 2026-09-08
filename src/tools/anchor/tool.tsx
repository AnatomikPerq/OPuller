/**
 * Anchor Point tool (Shift+C): click a smooth anchor to make it a corner
 * (handles removed), drag from an anchor to pull out symmetric handles, drag a
 * handle to break the pair, drag a segment to reshape it (straight segments
 * become curves). Ctrl temporarily acts as the Direct Selection tool.
 */
import React from 'react';
import { Triangle } from 'lucide-react';
import { produce } from 'immer';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import type { Document, Vec, AnchorRef, HandleRef } from '@/model/types';
import { getState } from '@/store/store';
import { hasHandle } from '@/geometry/path';
import { useOverlayStore } from '@/canvas/overlayStore';
import { formatLength } from '@/util/units';
import { dist } from '@/geometry/vec';
import { editablePathIds, setHandleWorld, convertAnchor, getAnchor, anchorWorldPoint, sameAnchor } from '../pathEditing/anchors';
import { reshapeSegmentWorld, constrainTo45, type SegmentRef } from '../pathEditing/curves';
import { findEditHit, editHitKey, type EditHit } from '../pathEditing/hover';
import { anchorPointCursor } from '../pathEditing/cursors';
import { AnchorHighlight, HandleHighlight, SegmentHighlight } from '../pathEditing/overlay';
import { directDelegate } from '../direct/tool';

type Gesture =
  | { kind: 'none' }
  | { kind: 'anchor'; ref: AnchorRef; base: Document; anchorWorld: Vec; startScreen: Vec; dragged: boolean }
  | { kind: 'handle'; ref: HandleRef; base: Document; anchorWorld: Vec; moved: boolean }
  | { kind: 'segment'; seg: SegmentRef; t: number; base: Document; grab: Vec; start: Vec; moved: boolean }
  | { kind: 'delegate' };

let gesture: Gesture = { kind: 'none' };
let hover: EditHit | null = null;
let hoverKey = '';

function hitAt(ctx: ToolContext, world: Vec): EditHit | null {
  const s = ctx.state;
  const ids = editablePathIds(s.doc, s.selection);
  const hit = findEditHit(ctx, world, { ids, handles: true, anyObject: true, anchorsOfHit: true, fills: false });
  if (!hit || hit.kind === 'object') return null;
  return hit;
}

function setHover(ctx: ToolContext, h: EditHit | null) {
  const key = editHitKey(h);
  if (key === hoverKey) return;
  hoverKey = key;
  hover = h;
  ctx.requestOverlay();
}

function cursorFor(h: EditHit | null): string {
  if (!h) return anchorPointCursor('none');
  if (h.kind === 'anchor') return anchorPointCursor('anchor');
  if (h.kind === 'handle') return anchorPointCursor('handle');
  if (h.kind === 'segment') return anchorPointCursor('segment');
  return anchorPointCursor('none');
}

function isBusy(): boolean {
  return gesture.kind !== 'none' && (gesture.kind !== 'delegate' || directDelegate.isBusy());
}

function cancel(ctx: ToolContext) {
  if (gesture.kind === 'delegate') directDelegate.cancel(ctx);
  else if (gesture.kind !== 'none') ctx.state.revert();
  gesture = { kind: 'none' };
  useOverlayStore.getState().setHud(null);
  ctx.requestOverlay();
}

export const anchorPointTool: Tool = {
  id: 'anchorPoint',
  name: 'Anchor Point Tool',
  shortcut: 'shift+c',
  icon: Triangle,
  group: 'pen',
  order: 103,
  cursor: anchorPointCursor('none'),
  hint: 'Click a smooth anchor to make it a corner. Drag from an anchor to pull out handles. Drag a handle to break the pair. Drag a segment to reshape it.',
  showSelectionOverlay: 'anchors',
  activate(ctx) {
    gesture = { kind: 'none' };
    hover = null;
    hoverKey = '';
    ctx.setCursor(anchorPointCursor('none'));
  },
  deactivate(ctx) {
    if (isBusy()) cancel(ctx);
    gesture = { kind: 'none' };
    hover = null;
    hoverKey = '';
    useOverlayStore.getState().setHud(null);
  },
  isBusy,
  cancel,

  onPointerDown(e, ctx) {
    if (e.button !== 0 || gesture.kind !== 'none') return;
    const s = ctx.state;
    if (e.primary) {
      gesture = { kind: 'delegate' };
      directDelegate.pointerDown(e, ctx);
      return;
    }
    const hit = hitAt(ctx, e.world);
    setHover(ctx, null);
    if (!hit) {
      if (!e.shift) s.clearSelection();
      return;
    }
    if (hit.kind === 'anchor') {
      if (!s.selectedAnchors.some((r) => sameAnchor(r, hit.ref)) || !s.selection.includes(hit.ref.nodeId)) s.setSelection([hit.ref.nodeId], [hit.ref]);
      gesture = { kind: 'anchor', ref: hit.ref, base: s.doc, anchorWorld: hit.point, startScreen: e.screen, dragged: false };
      return;
    }
    if (hit.kind === 'handle') {
      const anchorWorld = anchorWorldPoint(s.doc, hit.ref) ?? e.world;
      gesture = { kind: 'handle', ref: hit.ref, base: s.doc, anchorWorld, moved: false };
      return;
    }
    if (hit.kind === 'segment') {
      if (!s.selection.includes(hit.nodeId)) s.setSelection([hit.nodeId], []);
      gesture = { kind: 'segment', seg: { nodeId: hit.nodeId, subpath: hit.subpath, segment: hit.segment }, t: hit.t, base: s.doc, grab: hit.point, start: e.world, moved: false };
      ctx.requestOverlay();
    }
  },

  onPointerMove(e, ctx) {
    const s = ctx.state;
    const g = gesture;
    if (g.kind === 'delegate') {
      directDelegate.pointerMove(e, ctx);
      return;
    }
    if (g.kind === 'none') {
      if (e.primary) {
        directDelegate.pointerMove(e, ctx);
        setHover(ctx, null);
        return;
      }
      const hit = hitAt(ctx, e.world);
      setHover(ctx, hit);
      ctx.setCursor(cursorFor(hit));
      s.setHover(hit && hit.kind === 'segment' && !s.selection.includes(hit.nodeId) ? hit.nodeId : null);
      return;
    }
    if (g.kind === 'anchor') {
      if (!g.dragged && Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y) < 3) return;
      g.dragged = true;
      let target = e.world;
      if (e.shift) target = constrainTo45(g.anchorWorld, target, s.prefs.constrainAngle || 45);
      s.replaceDoc(
        produce(g.base, (d) => {
          setHandleWorld(d, { ...g.ref, side: 'out' }, target, { symmetric: true });
        }),
      );
      useOverlayStore.getState().setHud({ screen: e.screen, text: `L: ${formatLength(dist(target, g.anchorWorld), s.prefs.units)}` });
      ctx.requestOverlay();
      return;
    }
    if (g.kind === 'handle') {
      let target = e.world;
      if (e.shift) target = constrainTo45(g.anchorWorld, target, s.prefs.constrainAngle || 45);
      g.moved = true;
      s.replaceDoc(
        produce(g.base, (d) => {
          setHandleWorld(d, g.ref, target, { breakPair: true });
        }),
      );
      useOverlayStore.getState().setHud({ screen: e.screen, text: `L: ${formatLength(dist(target, g.anchorWorld), s.prefs.units)}\nbroken pair` });
      return;
    }
    if (g.kind === 'segment') {
      g.moved = true;
      const target = { x: g.grab.x + (e.world.x - g.start.x), y: g.grab.y + (e.world.y - g.start.y) };
      s.replaceDoc(
        produce(g.base, (d) => {
          reshapeSegmentWorld(d, g.seg, g.t, target, { smoothNeighbours: !e.alt });
        }),
      );
    }
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = { kind: 'none' };
    useOverlayStore.getState().setHud(null);
    if (g.kind === 'delegate') {
      directDelegate.pointerUp(e, ctx);
      return;
    }
    const s = ctx.state;
    if (g.kind === 'anchor') {
      if (!g.dragged) {
        const a = getAnchor(s.doc, g.ref);
        if (a && (hasHandle(a.handleIn) || hasHandle(a.handleOut))) {
          s.updateDoc((d) => convertAnchor(d, g.ref, 'corner'), 'Convert Anchor');
          ctx.setStatus('Anchor converted to corner');
        }
      } else {
        ctx.commit('Convert Anchor');
        ctx.setStatus('Anchor converted to smooth');
      }
    } else if (g.kind === 'handle') {
      if (g.moved) ctx.commit('Move Handle');
    } else if (g.kind === 'segment') {
      if (g.moved) ctx.commit('Reshape Segment');
    }
    getState().requestOverlay();
    this.onPointerMove!(e, ctx);
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (isBusy()) {
        cancel(ctx);
        return true;
      }
      if (ctx.state.selectedAnchors.length) {
        ctx.state.setSelectedAnchors([]);
        return true;
      }
      if (ctx.state.selection.length) {
        ctx.state.clearSelection();
        return true;
      }
      return false;
    }
    if (gesture.kind === 'delegate') return directDelegate.keyDown(e, ctx);
    if (gesture.kind === 'none' && ctx.state.selectedAnchors.length) return directDelegate.keyDown(e, ctx);
    return false;
  },

  onModifiers(e, ctx) {
    if (gesture.kind === 'none') ctx.setCursor(e.primary ? 'default' : cursorFor(hover));
  },

  renderOverlay(ctx) {
    const g = gesture;
    if (g.kind === 'delegate') return directDelegate.overlay(ctx);
    if (g.kind === 'anchor') return <AnchorHighlight ctx={ctx} ref={g.ref} />;
    if (g.kind === 'handle') return <HandleHighlight ctx={ctx} ref={g.ref} />;
    if (g.kind === 'segment') return <SegmentHighlight ctx={ctx} ref={g.seg} width={3} />;
    if (!hover) return null;
    if (hover.kind === 'anchor') return <AnchorHighlight ctx={ctx} ref={hover.ref} />;
    if (hover.kind === 'handle') return <HandleHighlight ctx={ctx} ref={hover.ref} />;
    if (hover.kind === 'segment') return <SegmentHighlight ctx={ctx} ref={{ nodeId: hover.nodeId, subpath: hover.subpath, segment: hover.segment }} width={2.5} />;
    return null;
  },
};

export const tool = anchorPointTool;
void React;
export type { ToolPointerEvent };
