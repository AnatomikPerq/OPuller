/**
 * Curvature tool (Shift+`): click to add points that form a smooth curve
 * passing through them, double-click a point to toggle a corner, drag points
 * to reshape, click the first point to close. Enter/Escape finishes.
 */
import React from 'react';
import { Waves } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, Vec, AnchorRef, SubPath } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { makePath } from '@/model/nodes';
import { addNode, worldMatrix, isEditable, removeNode } from '@/model/document';
import { invert, applyToPoint } from '@/geometry/matrix';
import { anchor as makeAnchor, transformSubPath, segmentCount, segmentCubic } from '@/geometry/path';
import { SnapSession } from '@/canvas/snap';
import { Row, Button } from '@/ui/widgets';
import { insertionParent } from '@/tools/shapes/tool';
import { runCommand } from '@/commands/registry';
import { getPathNode, getSubPath, editablePathIds, closeSubPath, appendAnchorWorld, setAnchorWorld, touchPath, sameAnchor, getAnchor, anchorWorldPoint } from '../pathEditing/anchors';
import { scheduleCommit } from '@/commands/core';
import { recomputeCurvatureWorld, curvatureNeighbourhood, curvaturePreview } from '../pathEditing/curves';
import { findEditHit, type EditHit } from '../pathEditing/hover';
import { penCursor } from '../pathEditing/cursors';
import { AnchorHighlight, cubicScreenD, HL } from '../pathEditing/overlay';

interface Current {
  nodeId: ID;
  subpath: number;
}

type Gesture = { kind: 'none' } | { kind: 'drag'; ref: AnchorRef; startScreen: Vec; dragged: boolean; placed: boolean };

let current: Current | null = null;
let gesture: Gesture = { kind: 'none' };
let hover: AnchorRef | null = null;
let hoverKey = '';
let mouse: Vec | null = null;
let hoverSnap: { session: SnapSession; docVersion: number; zoom: number; panX: number; panY: number; view: unknown } | null = null;

const listeners = new Set<() => void>();
let tick = 0;
function notify() {
  tick++;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function setCurrent(c: Current | null) {
  current = c;
  notify();
}

function validateCurrent(ctx: ToolContext): Current | null {
  if (!current) return null;
  const doc = ctx.doc;
  const n = getPathNode(doc, current.nodeId);
  const sp = n?.subpaths[current.subpath];
  if (!n || !sp || sp.closed || !sp.anchors.length || !isEditable(doc, current.nodeId)) {
    setCurrent(null);
    return null;
  }
  return current;
}

function snapSession(ctx: ToolContext): SnapSession {
  const s = ctx.state;
  if (!hoverSnap || hoverSnap.docVersion !== s.docVersion || hoverSnap.zoom !== s.zoom || hoverSnap.panX !== s.pan.x || hoverSnap.panY !== s.pan.y || hoverSnap.view !== s.view) {
    hoverSnap = { session: ctx.beginSnap(), docVersion: s.docVersion, zoom: s.zoom, panX: s.pan.x, panY: s.pan.y, view: s.view };
  }
  return hoverSnap.session;
}

function candidateIds(ctx: ToolContext, cur: Current | null): ID[] {
  const s = ctx.state;
  const ids = editablePathIds(s.doc, s.selection);
  if (cur && !ids.includes(cur.nodeId)) ids.push(cur.nodeId);
  return ids;
}

function anchorHit(ctx: ToolContext, world: Vec, cur: Current | null): EditHit | null {
  const hit = findEditHit(ctx, world, { ids: candidateIds(ctx, cur), handles: false, anyObject: true, anchorsOfHit: true, anchorsOnly: true, fills: false });
  return hit && hit.kind === 'anchor' ? hit : null;
}

function setHover(ctx: ToolContext, ref: AnchorRef | null) {
  const key = ref ? `${ref.nodeId}/${ref.subpath}/${ref.index}` : '';
  if (key === hoverKey) return;
  hoverKey = key;
  hover = ref;
  ctx.requestOverlay();
}

function finish(ctx: ToolContext) {
  const had = !!current;
  setCurrent(null);
  hover = null;
  hoverKey = '';
  if (ctx.state.selectedAnchors.length) ctx.state.setSelectedAnchors([]);
  if (had) ctx.setStatus('Path finished');
  ctx.requestOverlay();
}

function startPath(ctx: ToolContext, p: Vec): AnchorRef | null {
  const s = ctx.state;
  const parent = insertionParent();
  if (!parent) return null;
  const local = applyToPoint(invert(worldMatrix(s.doc, parent)), p);
  const node = makePath([{ anchors: [makeAnchor(local, null, null, 'smooth')], closed: false }], { fill: s.appearance.fill, stroke: s.appearance.stroke });
  s.updateDoc((d) => addNode(d, node, parent));
  const ref: AnchorRef = { nodeId: node.id, subpath: 0, index: 0 };
  getState().setSelection([node.id], [ref]);
  setCurrent({ nodeId: node.id, subpath: 0 });
  return ref;
}

function closeCurrent(ctx: ToolContext): boolean {
  const cur = validateCurrent(ctx);
  if (!cur) return false;
  const sp = getSubPath(ctx.doc, cur);
  if (!sp || sp.anchors.length < 2) return false;
  ctx.state.updateDoc((d) => {
    closeSubPath(d, cur.nodeId, cur.subpath);
    recomputeCurvatureWorld(d, cur.nodeId, cur.subpath);
  }, 'Close Path');
  setCurrent(null);
  getState().setSelectedAnchors([]);
  ctx.setStatus('Path closed');
  ctx.requestOverlay();
  return true;
}

function worldSubPathOf(ctx: ToolContext, cur: Current): SubPath | null {
  const sp = getSubPath(ctx.doc, cur);
  if (!sp) return null;
  return transformSubPath(sp, worldMatrix(ctx.doc, cur.nodeId));
}

function preview(ctx: ToolContext, cur: Current): React.ReactNode {
  if (!mouse) return null;
  const wsp = worldSubPathOf(ctx, cur);
  if (!wsp || !wsp.anchors.length) return null;
  const closing = !!hover && hover.nodeId === cur.nodeId && hover.subpath === cur.subpath && hover.index === 0 && wsp.anchors.length >= 2;
  const p = curvaturePreview(wsp, mouse, closing);
  const segs = segmentCount(p);
  const parts: string[] = [];
  const from = closing ? Math.max(0, segs - 2) : Math.max(0, segs - 3);
  for (let i = from; i < segs; i++) parts.push(cubicScreenD(ctx, segmentCubic(p, i)));
  if (closing && segs > 1) parts.push(cubicScreenD(ctx, segmentCubic(p, 0)));
  const m = ctx.worldToScreen(closing ? wsp.anchors[0].point : mouse);
  return (
    <g pointerEvents="none">
      {parts.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={HL} strokeWidth={1} strokeDasharray="4 3" opacity={0.9} />
      ))}
      {!closing && <circle cx={m.x} cy={m.y} r={3.5} fill="none" stroke={HL} strokeWidth={1.2} />}
    </g>
  );
}

function CurvatureOptions() {
  const t = React.useSyncExternalStore(subscribe, () => tick, () => 0);
  const doc = useStore((s) => s.doc);
  void t;
  const cur = current;
  const sp = cur ? getSubPath(doc, cur) : undefined;
  const drawing = !!sp && !sp.closed && sp.anchors.length > 0;
  const canClose = drawing && sp!.anchors.length >= 2;
  return (
    <Row gap={8} className="pe-options">
      <span className="pe-status small">{drawing ? `Drawing · ${sp!.anchors.length} point${sp!.anchors.length > 1 ? 's' : ''}` : 'Click to add curve points, double-click for corners'}</span>
      <Button
        small
        disabled={!canClose}
        onClick={() => {
          const s = getState();
          if (!cur) return;
          s.updateDoc((d) => {
            closeSubPath(d, cur.nodeId, cur.subpath);
            recomputeCurvatureWorld(d, cur.nodeId, cur.subpath);
          }, 'Close Path');
          setCurrent(null);
          s.setSelectedAnchors([]);
          s.requestOverlay();
        }}
        data-testid="curvature-close"
      >
        Close path
      </Button>
      <Button
        small
        disabled={!drawing}
        onClick={() => {
          const s = getState();
          setCurrent(null);
          s.setSelectedAnchors([]);
          s.requestOverlay();
        }}
        data-testid="curvature-finish"
      >
        Finish
      </Button>
      <span className="pe-kbd-hint">Drag: move point · Double-click: corner/smooth · Enter/Esc: finish</span>
    </Row>
  );
}

export const curvatureTool: Tool = {
  id: 'curvature',
  name: 'Curvature Tool',
  shortcut: 'shift+`',
  icon: Waves,
  group: 'pen',
  order: 104,
  cursor: penCursor('curvature'),
  hint: 'Click to add points of a smooth curve. Double-click a point for a corner. Click the first point to close.',
  showSelectionOverlay: 'anchors',
  Options: CurvatureOptions,
  activate(ctx) {
    gesture = { kind: 'none' };
    hover = null;
    hoverKey = '';
    hoverSnap = null;
    setCurrent(null);
    ctx.setCursor(penCursor('curvature'));
  },
  deactivate(ctx) {
    if (gesture.kind === 'drag') ctx.state.revert();
    gesture = { kind: 'none' };
    finish(ctx);
  },
  isBusy: () => gesture.kind === 'drag',
  cancel(ctx) {
    if (gesture.kind === 'drag') ctx.state.revert();
    gesture = { kind: 'none' };
    ctx.setSnapGuides(null);
    validateCurrent(ctx);
    ctx.requestOverlay();
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0 || gesture.kind !== 'none') return;
    const s = ctx.state;
    mouse = e.world;
    const cur = validateCurrent(ctx);
    const hit = anchorHit(ctx, e.world, cur);
    setHover(ctx, null);
    if (hit && hit.kind === 'anchor') {
      const ref = hit.ref;
      if (cur && ref.nodeId === cur.nodeId && ref.subpath === cur.subpath && ref.index === 0 && hit.count >= 2) {
        closeCurrent(ctx);
        return;
      }
      s.setSelection([ref.nodeId], [ref]);
      if (!cur || cur.nodeId !== ref.nodeId || cur.subpath !== ref.subpath) {
        // editing another path: continue it when it is open and the anchor is its last point
        const sp = getSubPath(s.doc, ref);
        if (sp && !sp.closed && ref.index === sp.anchors.length - 1) setCurrent({ nodeId: ref.nodeId, subpath: ref.subpath });
        else setCurrent(null);
      }
      gesture = { kind: 'drag', ref, startScreen: e.screen, dragged: false, placed: false };
      return;
    }
    // add a point
    const sr = snapSession(ctx).snap(e.world);
    const p = sr.point;
    ctx.setSnapGuides(sr);
    let ref: AnchorRef | null;
    if (!cur) ref = startPath(ctx, p);
    else {
      ref = null;
      s.updateDoc((d) => {
        ref = appendAnchorWorld(d, cur.nodeId, cur.subpath, p, 'smooth');
        const sp = getSubPath(d, cur);
        if (ref && sp) recomputeCurvatureWorld(d, cur.nodeId, cur.subpath, curvatureNeighbourhood(sp, ref.index));
      });
      if (ref) getState().setSelectedAnchors([ref]);
    }
    if (!ref) return;
    gesture = { kind: 'drag', ref, startScreen: e.screen, dragged: false, placed: true };
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    mouse = e.world;
    const s = ctx.state;
    const g = gesture;
    if (g.kind === 'drag') {
      if (!g.dragged && Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y) < 3) return;
      g.dragged = true;
      const sr = e.primary ? null : snapSession(ctx).snap(e.world);
      const target = sr ? sr.point : e.world;
      ctx.setSnapGuides(sr);
      s.updateDoc((d) => {
        setAnchorWorld(d, g.ref, target);
        const sp = getSubPath(d, g.ref);
        if (sp) recomputeCurvatureWorld(d, g.ref.nodeId, g.ref.subpath, curvatureNeighbourhood(sp, g.ref.index));
      });
      ctx.requestOverlay();
      return;
    }
    const cur = validateCurrent(ctx);
    const hit = anchorHit(ctx, e.world, cur);
    setHover(ctx, hit && hit.kind === 'anchor' ? hit.ref : null);
    const closing = !!hit && hit.kind === 'anchor' && !!cur && hit.ref.nodeId === cur.nodeId && hit.ref.subpath === cur.subpath && hit.ref.index === 0 && hit.count >= 2;
    ctx.setCursor(closing ? penCursor('close') : hit ? penCursor('corner') : penCursor('curvature'));
    if (!hit) {
      const sr = snapSession(ctx).snap(e.world);
      ctx.setSnapGuides(sr.snappedPoint ? sr : null);
    } else ctx.setSnapGuides(null);
    if (cur) ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = { kind: 'none' };
    ctx.setSnapGuides(null);
    if (g.kind !== 'drag') return;
    ctx.commit(g.placed ? 'Curvature' : 'Move Anchor');
    this.onPointerMove!(e, ctx);
  },

  onDoubleClick(e, ctx) {
    const cur = validateCurrent(ctx);
    const hit = anchorHit(ctx, e.world, cur);
    if (!hit || hit.kind !== 'anchor') return;
    const ref = hit.ref;
    ctx.state.updateDoc((d) => {
      const n = getPathNode(d, ref.nodeId);
      const sp = n?.subpaths[ref.subpath];
      const a = sp?.anchors[ref.index];
      if (!n || !sp || !a) return;
      a.kind = a.kind === 'corner' ? 'smooth' : 'corner';
      touchPath(n);
      recomputeCurvatureWorld(d, ref.nodeId, ref.subpath, curvatureNeighbourhood(sp, ref.index));
    }, 'Convert Anchor');
    const a = getSubPath(getState().doc, ref)?.anchors[ref.index];
    ctx.setStatus(a?.kind === 'corner' ? 'Corner point' : 'Smooth point');
    ctx.requestOverlay();
  },

  onKeyDown(e, ctx) {
    const s = ctx.state;
    if (e.key === 'Escape') {
      if (gesture.kind === 'drag') {
        this.cancel!(ctx);
        return true;
      }
      if (current) {
        finish(ctx);
        return true;
      }
      if (s.selection.length) {
        s.clearSelection();
        return true;
      }
      return false;
    }
    if (e.key === 'Enter') {
      if (current) {
        finish(ctx);
        return true;
      }
      return false;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const cur = validateCurrent(ctx);
      if (cur) {
        let alive = true;
        s.updateDoc((d) => {
          const n = getPathNode(d, cur.nodeId);
          const sp = n?.subpaths[cur.subpath];
          if (!n || !sp) return;
          sp.anchors.pop();
          touchPath(n);
          if (!sp.anchors.length) {
            n.subpaths.splice(cur.subpath, 1);
            alive = false;
            if (!n.subpaths.length) removeNode(d, cur.nodeId);
          } else recomputeCurvatureWorld(d, cur.nodeId, cur.subpath, curvatureNeighbourhood(sp, sp.anchors.length - 1));
        }, 'Delete Anchor');
        const st = getState();
        if (!alive) {
          setCurrent(null);
          st.setSelectedAnchors([]);
        } else {
          const sp = getSubPath(st.doc, cur);
          if (sp) st.setSelectedAnchors([{ nodeId: cur.nodeId, subpath: cur.subpath, index: sp.anchors.length - 1 }]);
        }
        ctx.requestOverlay();
        return true;
      }
      if (s.selectedAnchors.length) {
        runCommand('path.deleteAnchors');
        return true;
      }
    }
    if (gesture.kind === 'none' && s.selectedAnchors.length && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = e.shift ? s.prefs.bigNudge : s.prefs.nudge;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const refs = s.selectedAnchors;
      s.updateDoc((d) => {
        for (const r of refs) {
          const a = getAnchor(d, r);
          const p = anchorWorldPoint(d, r);
          if (!a || !p) continue;
          setAnchorWorld(d, r, { x: p.x + dx, y: p.y + dy });
          const sp = getSubPath(d, r);
          if (sp) recomputeCurvatureWorld(d, r.nodeId, r.subpath, curvatureNeighbourhood(sp, r.index));
        }
      });
      scheduleCommit('Move Anchors');
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const s = ctx.state;
    const items: React.ReactNode[] = [];
    const cur = current && getSubPath(s.doc, current) && !getSubPath(s.doc, current)!.closed ? current : null;
    if (cur && gesture.kind === 'none') items.push(<React.Fragment key="pv">{preview(ctx, cur)}</React.Fragment>);
    if (hover && gesture.kind === 'none') items.push(<AnchorHighlight key="h" ctx={ctx} ref={hover} />);
    if (gesture.kind === 'drag') items.push(<AnchorHighlight key="d" ctx={ctx} ref={gesture.ref} />);
    return items.length ? <g className="curvature-overlay">{items}</g> : null;
  },
};

export const tool = curvatureTool;
void React;
void sameAnchor;
