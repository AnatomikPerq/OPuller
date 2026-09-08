/**
 * Pen tool (P) plus the Add Anchor Point (=) and Delete Anchor Point (-) tools.
 *
 * Pen: click = corner anchor, click-drag = smooth anchor with symmetric
 * handles (Alt breaks the outgoing handle), Shift constrains to 45°, click the
 * first anchor to close, click an end anchor of an open path to continue it,
 * click a segment of the drawn/selected path to add an anchor, click an anchor
 * to delete it, Enter/Escape/tool switch finishes. Ctrl temporarily acts as
 * the Direct Selection tool. Every click is one undo step.
 */
import React from 'react';
import { PenTool, Plus, Minus } from 'lucide-react';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import type { ID, Vec, AnchorRef, SubPath } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { makePath } from '@/model/nodes';
import { addNode, worldMatrix, worldSubPaths, removeNode, isEditable } from '@/model/document';
import { invert, applyToPoint } from '@/geometry/matrix';
import { absHandleIn, absHandleOut, hasHandle, joinSubPaths, reverseSubPath, transformSubPath, anchor as makeAnchor } from '@/geometry/path';
import { dist } from '@/geometry/vec';
import { SnapSession } from '@/canvas/snap';
import { Checkbox, Row, Button } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';
import { insertionParent } from '@/tools/shapes/tool';
import {
  getPathNode,
  getSubPath,
  editablePathIds,
  closeSubPath,
  appendAnchorWorld,
  setHandleWorld,
  retractHandle,
  removeAnchorJoin,
  insertAnchorAtLocation,
  reverseSubPathInPlace,
  touchPath,
  cleanupPath,
} from '../pathEditing/anchors';
import { constrainTo45, type SegmentRef } from '../pathEditing/curves';
import { findEditHit, editHitKey, type EditHit } from '../pathEditing/hover';
import { penCursor } from '../pathEditing/cursors';
import { AnchorHighlight, SegmentHighlight, PointMarker, cubicScreenD, HL } from '../pathEditing/overlay';
import { directDelegate } from '../direct/tool';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Current {
  nodeId: ID;
  subpath: number;
}

type PenHit =
  | { kind: 'close'; ref: AnchorRef; point: Vec }
  | { kind: 'last'; ref: AnchorRef; point: Vec }
  | { kind: 'continue'; ref: AnchorRef; point: Vec }
  | { kind: 'join'; ref: AnchorRef; point: Vec }
  | { kind: 'delete'; ref: AnchorRef; point: Vec }
  | { kind: 'add'; seg: SegmentRef; t: number; point: Vec };

type Gesture =
  | { kind: 'none' }
  | { kind: 'place'; ref: AnchorRef; anchorWorld: Vec; startScreen: Vec; dragged: boolean; mode: 'new' | 'close' | 'pullOut'; label: string; symmetric: boolean }
  | { kind: 'delegate' };

let current: Current | null = null;
let gesture: Gesture = { kind: 'none' };
let mouse: Vec | null = null;
let mods = { shift: false, alt: false, primary: false };
let hover: PenHit | null = null;
let hoverKey = '';
let hoverSnap: { session: SnapSession; docVersion: number; zoom: number; panX: number; panY: number; view: unknown } | null = null;

/** Notifies the Options component when the drawing state changes. */
const penListeners = new Set<() => void>();
let penTick = 0;
function notifyPen() {
  penTick++;
  penListeners.forEach((l) => l());
}
function subscribePen(l: () => void) {
  penListeners.add(l);
  return () => {
    penListeners.delete(l);
  };
}

export function penCurrent(): Current | null {
  return current;
}

function validateCurrent(ctx: ToolContext): Current | null {
  if (!current) return null;
  const doc = ctx.doc;
  const n = getPathNode(doc, current.nodeId);
  const sp = n?.subpaths[current.subpath];
  if (!n || !sp || sp.closed || !sp.anchors.length || !isEditable(doc, current.nodeId)) {
    current = null;
    notifyPen();
    return null;
  }
  return current;
}

function setCurrent(c: Current | null) {
  current = c;
  notifyPen();
}

function setHover(ctx: ToolContext, h: PenHit | null) {
  const key = h ? (h.kind === 'add' ? `add:${h.seg.nodeId}/${h.seg.subpath}/${h.seg.segment}` : `${h.kind}:${h.ref.nodeId}/${h.ref.subpath}/${h.ref.index}`) : '';
  if (key === hoverKey) return;
  hoverKey = key;
  hover = h;
  ctx.requestOverlay();
}

function hoverSnapSession(ctx: ToolContext): SnapSession {
  const s = ctx.state;
  if (!hoverSnap || hoverSnap.docVersion !== s.docVersion || hoverSnap.zoom !== s.zoom || hoverSnap.panX !== s.pan.x || hoverSnap.panY !== s.pan.y || hoverSnap.view !== s.view) {
    hoverSnap = { session: ctx.beginSnap(), docVersion: s.docVersion, zoom: s.zoom, panX: s.pan.x, panY: s.pan.y, view: s.view };
  }
  return hoverSnap.session;
}

function lastAnchorWorld(ctx: ToolContext, cur: Current): Vec | null {
  const sp = getSubPath(ctx.doc, cur);
  if (!sp || !sp.anchors.length) return null;
  return applyToPoint(worldMatrix(ctx.doc, cur.nodeId), sp.anchors[sp.anchors.length - 1].point);
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

function penHit(ctx: ToolContext, world: Vec, cur: Current | null): PenHit | null {
  const s = ctx.state;
  const doc = s.doc;
  const ids = editablePathIds(doc, s.selection);
  if (cur && !ids.includes(cur.nodeId)) ids.push(cur.nodeId);
  const hit: EditHit | null = findEditHit(ctx, world, { ids, handles: false, anyObject: true, anchorsOfHit: true, fills: false });
  if (!hit) return null;
  if (hit.kind === 'anchor') {
    const ref = hit.ref;
    if (cur && ref.nodeId === cur.nodeId && ref.subpath === cur.subpath) {
      if (ref.index === 0 && hit.count >= 2) return { kind: 'close', ref, point: hit.point };
      if (ref.index === hit.count - 1) return { kind: 'last', ref, point: hit.point };
      return { kind: 'delete', ref, point: hit.point };
    }
    if (hit.open && (hit.first || hit.last)) return { kind: cur ? 'join' : 'continue', ref, point: hit.point };
    if (ids.includes(ref.nodeId)) return { kind: 'delete', ref, point: hit.point };
    return null;
  }
  if (hit.kind === 'segment') {
    if (!ids.includes(hit.nodeId)) return null;
    return { kind: 'add', seg: { nodeId: hit.nodeId, subpath: hit.subpath, segment: hit.segment }, t: hit.t, point: hit.point };
  }
  return null;
}

function cursorFor(h: PenHit | null, cur: Current | null): string {
  if (!h) return penCursor(cur ? 'none' : 'start');
  switch (h.kind) {
    case 'close':
      return penCursor('close');
    case 'last':
      return penCursor('corner');
    case 'continue':
      return penCursor('continue');
    case 'join':
      return penCursor('join');
    case 'delete':
      return penCursor('delete');
    case 'add':
      return penCursor('add');
  }
}

// ---------------------------------------------------------------------------
// Editing operations
// ---------------------------------------------------------------------------

function finish(ctx: ToolContext, silent = false) {
  const had = !!current;
  setCurrent(null);
  hover = null;
  hoverKey = '';
  const s = ctx.state;
  if (s.selectedAnchors.length) s.setSelectedAnchors([]);
  if (had && !silent) ctx.setStatus('Path finished');
  ctx.requestOverlay();
}

/** Join the current path's end with an end anchor of another open subpath. */
function joinWith(ctx: ToolContext, cur: Current, target: AnchorRef) {
  const s = ctx.state;
  s.updateDoc((d) => {
    const a = getPathNode(d, cur.nodeId);
    const b = getPathNode(d, target.nodeId);
    if (!a || !b) return;
    const wa = worldSubPaths(d, cur.nodeId)[cur.subpath];
    const wbRaw = worldSubPaths(d, target.nodeId)[target.subpath];
    if (!wa || !wbRaw) return;
    const wb = target.index === 0 ? wbRaw : reverseSubPath(wbRaw);
    const joined = joinSubPaths(wa, wb);
    const local = transformSubPath(joined, invert(worldMatrix(d, cur.nodeId)));
    if (cur.nodeId === target.nodeId) {
      a.subpaths[cur.subpath] = local;
      a.subpaths.splice(target.subpath, 1);
    } else {
      a.subpaths[cur.subpath] = local;
      b.subpaths.splice(target.subpath, 1);
      touchPath(b);
      if (!b.subpaths.length) removeNode(d, target.nodeId);
    }
    touchPath(a);
  }, 'Join');
  getState().setSelection([cur.nodeId], []);
  setCurrent(null);
  ctx.setStatus('Paths joined');
}

/** Start a new path node with a single anchor at a world point. */
function startPath(ctx: ToolContext, p: Vec): AnchorRef | null {
  const s = ctx.state;
  const parent = insertionParent();
  if (!parent) return null;
  const local = applyToPoint(invert(worldMatrix(s.doc, parent)), p);
  const node = makePath([{ anchors: [makeAnchor(local)], closed: false }], { fill: s.appearance.fill, stroke: s.appearance.stroke });
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
  }, 'Close Path');
  finish(ctx, true);
  ctx.setStatus('Path closed');
  return true;
}

function deleteLastAnchor(ctx: ToolContext): boolean {
  const cur = validateCurrent(ctx);
  if (!cur) return false;
  let alive = true;
  ctx.state.updateDoc((d) => {
    const n = getPathNode(d, cur.nodeId);
    const sp = n?.subpaths[cur.subpath];
    if (!n || !sp) return;
    sp.anchors.pop();
    touchPath(n);
    if (!sp.anchors.length) {
      n.subpaths.splice(cur.subpath, 1);
      if (!n.subpaths.length) {
        removeNode(d, cur.nodeId);
        alive = false;
      } else alive = false;
    }
  }, 'Delete Anchor');
  if (!alive) {
    setCurrent(null);
    getState().setSelectedAnchors([]);
  } else {
    const sp = getSubPath(getState().doc, cur);
    if (sp) getState().setSelectedAnchors([{ nodeId: cur.nodeId, subpath: cur.subpath, index: sp.anchors.length - 1 }]);
  }
  ctx.requestOverlay();
  return true;
}

// ---------------------------------------------------------------------------
// Pen tool
// ---------------------------------------------------------------------------

function penDown(e: ToolPointerEvent, ctx: ToolContext) {
  if (e.button !== 0) return;
  if (gesture.kind !== 'none') return;
  const s = ctx.state;
  if (s.editingTextId) s.setEditingText(null);
  mouse = e.world;
  if (e.primary) {
    // Ctrl: temporary direct selection
    gesture = { kind: 'delegate' };
    directDelegate.pointerDown(e, ctx);
    return;
  }
  const cur = validateCurrent(ctx);
  const hit = penHit(ctx, e.world, cur);
  setHover(ctx, null);
  if (hit) {
    switch (hit.kind) {
      case 'close': {
        s.updateDoc((d) => {
          closeSubPath(d, cur!.nodeId, cur!.subpath);
        });
        s.setSelectedAnchors([hit.ref]);
        gesture = { kind: 'place', ref: hit.ref, anchorWorld: hit.point, startScreen: e.screen, dragged: false, mode: 'close', label: 'Close Path', symmetric: true };
        return;
      }
      case 'last': {
        const a = getSubPath(s.doc, hit.ref)?.anchors[hit.ref.index];
        s.setSelectedAnchors([hit.ref]);
        gesture = { kind: 'place', ref: hit.ref, anchorWorld: hit.point, startScreen: e.screen, dragged: false, mode: 'pullOut', label: 'Pen', symmetric: !a || !hasHandle(a.handleIn) };
        return;
      }
      case 'continue': {
        let ref = hit.ref;
        const sp = getSubPath(s.doc, ref);
        if (!sp) return;
        if (ref.index === 0 && sp.anchors.length > 1) {
          s.updateDoc((d) => reverseSubPathInPlace(d, ref.nodeId, ref.subpath));
          ref = { nodeId: ref.nodeId, subpath: ref.subpath, index: sp.anchors.length - 1 };
        }
        getState().setSelection([ref.nodeId], [ref]);
        setCurrent({ nodeId: ref.nodeId, subpath: ref.subpath });
        const a = getSubPath(getState().doc, ref)?.anchors[ref.index];
        gesture = { kind: 'place', ref, anchorWorld: hit.point, startScreen: e.screen, dragged: false, mode: 'pullOut', label: 'Continue Path', symmetric: !a || !hasHandle(a.handleIn) };
        ctx.setStatus('Continuing path');
        return;
      }
      case 'join': {
        if (cur) joinWith(ctx, cur, hit.ref);
        return;
      }
      case 'delete': {
        let alive = true;
        s.updateDoc((d) => {
          alive = removeAnchorJoin(d, hit.ref);
        }, 'Delete Anchor');
        const st = getState();
        if (!alive) {
          st.setSelection(st.selection.filter((id) => id !== hit.ref.nodeId), []);
          if (current?.nodeId === hit.ref.nodeId) setCurrent(null);
        } else if (cur && cur.nodeId === hit.ref.nodeId) {
          const sp = getSubPath(st.doc, cur);
          if (sp && !sp.closed && sp.anchors.length) st.setSelectedAnchors([{ nodeId: cur.nodeId, subpath: cur.subpath, index: sp.anchors.length - 1 }]);
          else setCurrent(null);
        } else st.setSelectedAnchors([]);
        ctx.requestOverlay();
        return;
      }
      case 'add': {
        let ref: AnchorRef | null = null;
        s.updateDoc((d) => {
          ref = insertAnchorAtLocation(d, hit.seg.nodeId, hit.seg.subpath, hit.seg.segment, hit.t);
        }, 'Add Anchor');
        const st = getState();
        if (cur && cur.nodeId === hit.seg.nodeId) {
          const sp = getSubPath(st.doc, cur);
          if (sp) st.setSelectedAnchors([{ nodeId: cur.nodeId, subpath: cur.subpath, index: sp.anchors.length - 1 }]);
        } else if (ref) st.setSelection([hit.seg.nodeId], [ref]);
        ctx.requestOverlay();
        return;
      }
    }
  }

  // place a new anchor
  let p = e.world;
  const prev = cur ? lastAnchorWorld(ctx, cur) : null;
  if (e.shift && prev) p = constrainTo45(prev, p, s.prefs.constrainAngle || 45);
  else {
    const sr = hoverSnapSession(ctx).snap(p);
    p = sr.point;
    ctx.setSnapGuides(sr);
  }
  let ref: AnchorRef | null;
  if (!cur) ref = startPath(ctx, p);
  else {
    ref = null;
    s.updateDoc((d) => {
      ref = appendAnchorWorld(d, cur.nodeId, cur.subpath, p);
    });
    if (ref) getState().setSelectedAnchors([ref]);
  }
  if (!ref) return;
  gesture = { kind: 'place', ref, anchorWorld: p, startScreen: e.screen, dragged: false, mode: 'new', label: 'Pen', symmetric: true };
  ctx.requestOverlay();
}

function penMove(e: ToolPointerEvent, ctx: ToolContext) {
  mouse = e.world;
  mods = { shift: e.shift, alt: e.alt, primary: e.primary };
  const s = ctx.state;
  const g = gesture;
  if (g.kind === 'delegate') {
    directDelegate.pointerMove(e, ctx);
    return;
  }
  if (g.kind === 'place') {
    if (!g.dragged && Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y) < 3) return;
    g.dragged = true;
    let target = e.world;
    if (e.shift) target = constrainTo45(g.anchorWorld, target, s.prefs.constrainAngle || 45);
    const ref = g.ref;
    s.updateDoc((d) => {
      if (g.mode === 'close') {
        if (e.alt) {
          const v = { x: g.anchorWorld.x - (target.x - g.anchorWorld.x), y: g.anchorWorld.y - (target.y - g.anchorWorld.y) };
          setHandleWorld(d, { ...ref, side: 'in' }, v, { breakPair: true });
        } else setHandleWorld(d, { ...ref, side: 'out' }, target, { symmetric: true });
      } else if (g.mode === 'pullOut') {
        if (g.symmetric && !e.alt) setHandleWorld(d, { ...ref, side: 'out' }, target, { symmetric: true });
        else setHandleWorld(d, { ...ref, side: 'out' }, target, { breakPair: true });
      } else {
        if (e.alt) setHandleWorld(d, { ...ref, side: 'out' }, target, { breakPair: true });
        else setHandleWorld(d, { ...ref, side: 'out' }, target, { symmetric: true });
      }
    });
    ctx.setCursor(penCursor(e.alt ? 'corner' : 'none'));
    ctx.requestOverlay();
    return;
  }
  // hover
  if (e.primary) {
    directDelegate.pointerMove(e, ctx);
    setHover(ctx, null);
    ctx.requestOverlay();
    return;
  }
  const cur = validateCurrent(ctx);
  const hit = penHit(ctx, e.world, cur);
  setHover(ctx, hit);
  ctx.setCursor(cursorFor(hit, cur));
  if (!hit && !e.shift) {
    const sr = hoverSnapSession(ctx).snap(e.world);
    ctx.setSnapGuides(sr.snappedPoint ? sr : null);
  } else ctx.setSnapGuides(null);
  if (cur) ctx.requestOverlay();
}

function penUp(e: ToolPointerEvent, ctx: ToolContext) {
  const g = gesture;
  gesture = { kind: 'none' };
  ctx.setSnapGuides(null);
  if (g.kind === 'delegate') {
    directDelegate.pointerUp(e, ctx);
    return;
  }
  if (g.kind !== 'place') return;
  const s = ctx.state;
  if (g.mode === 'pullOut' && !g.dragged) {
    // click on the last anchor: retract the outgoing handle so the next segment starts straight
    const a = getSubPath(s.doc, g.ref)?.anchors[g.ref.index];
    if (a && hasHandle(a.handleOut)) {
      s.updateDoc((d) => retractHandle(d, { ...g.ref, side: 'out' }));
    }
  }
  ctx.commit(g.label);
  if (g.mode === 'close') {
    finish(ctx, true);
    ctx.setStatus('Path closed');
  }
  ctx.setCursor(cursorFor(hover, validateCurrent(ctx)));
  ctx.requestOverlay();
}

function penCancel(ctx: ToolContext) {
  if (gesture.kind === 'delegate') directDelegate.cancel(ctx);
  else if (gesture.kind === 'place') ctx.state.revert();
  gesture = { kind: 'none' };
  ctx.setSnapGuides(null);
  validateCurrent(ctx);
  ctx.requestOverlay();
}

function rubberBand(ctx: ToolContext, cur: Current): React.ReactNode {
  const s = ctx.state;
  const sp = getSubPath(s.doc, cur);
  if (!sp || !sp.anchors.length || !mouse) return null;
  const wm = worldMatrix(s.doc, cur.nodeId);
  const wsp: SubPath = transformSubPath(sp, wm);
  const last = wsp.anchors[wsp.anchors.length - 1];
  const L = last.point;
  const H = absHandleOut(last);
  let target: Vec;
  let h2: Vec;
  if (hover && hover.kind === 'close') {
    const first = wsp.anchors[0];
    target = first.point;
    h2 = absHandleIn(first);
  } else if (hover && hover.kind === 'join') {
    target = hover.point;
    h2 = target;
  } else {
    target = mods.shift ? constrainTo45(L, mouse, s.prefs.constrainAngle || 45) : mouse;
    h2 = target;
  }
  const d = cubicScreenD(ctx, { p0: L, p1: H, p2: h2, p3: target });
  return <path d={d} fill="none" stroke={HL} strokeWidth={1} strokeDasharray="4 3" opacity={0.9} pointerEvents="none" />;
}

function penOverlay(ctx: ToolContext): React.ReactNode {
  const s = ctx.state;
  const items: React.ReactNode[] = [];
  if (gesture.kind === 'delegate' || (mods.primary && gesture.kind === 'none')) {
    return directDelegate.overlay(ctx);
  }
  const cur = current && getSubPath(s.doc, current) && !getSubPath(s.doc, current)!.closed ? current : null;
  const opts = ctx.options<{ rubberBand: boolean }>();
  if (cur && gesture.kind === 'none' && opts.rubberBand !== false) items.push(<React.Fragment key="rb">{rubberBand(ctx, cur)}</React.Fragment>);
  if (gesture.kind === 'none' && hover) {
    if (hover.kind === 'add') {
      items.push(<SegmentHighlight key="hs" ctx={ctx} ref={hover.seg} width={2.5} />);
      items.push(<PointMarker key="hp" ctx={ctx} point={hover.point} />);
    } else items.push(<AnchorHighlight key="ha" ctx={ctx} ref={hover.ref} color={hover.kind === 'delete' ? '#e5484d' : HL} />);
  }
  return items.length ? <g className="pen-overlay">{items}</g> : null;
}

function PenOptions() {
  const [opts, set] = useToolOptions<{ rubberBand: boolean }>('pen');
  const tick = React.useSyncExternalStore(subscribePen, () => penTick, () => 0);
  const docVersion = useStore((s) => s.docVersion);
  const doc = useStore((s) => s.doc);
  void tick;
  void docVersion;
  const cur = current;
  const sp = cur ? getSubPath(doc, cur) : undefined;
  const drawing = !!sp && !sp.closed && sp.anchors.length > 0;
  const canClose = drawing && sp!.anchors.length >= 2;
  const onClose = () => {
    const s = getState();
    if (!cur) return;
    const spc = getSubPath(s.doc, cur);
    if (!spc || spc.anchors.length < 2) return;
    s.updateDoc((d) => {
      closeSubPath(d, cur.nodeId, cur.subpath);
    }, 'Close Path');
    setCurrent(null);
    s.setSelectedAnchors([]);
    s.requestOverlay();
    s.setStatus('Path closed');
  };
  const onFinish = () => {
    const s = getState();
    setCurrent(null);
    s.setSelectedAnchors([]);
    s.requestOverlay();
    s.setStatus('Path finished');
  };
  return (
    <Row gap={8} className="pe-options">
      <span className="pe-status small">{drawing ? `Drawing · ${sp!.anchors.length} anchor${sp!.anchors.length > 1 ? 's' : ''}` : 'Click to add anchors, drag for curves'}</span>
      <Checkbox checked={opts.rubberBand !== false} onChange={(v) => set({ rubberBand: v })} label="Rubber band" title="Preview the next segment while drawing" />
      <Button small onClick={onClose} disabled={!canClose} title="Close the path being drawn" data-testid="pen-close">
        Close path
      </Button>
      <Button small onClick={onFinish} disabled={!drawing} title="Finish the path (Enter)" data-testid="pen-finish">
        Finish
      </Button>
      <span className="pe-kbd-hint">Drag: curve · Alt: break handle · Shift: 45° · Ctrl: direct select · Enter/Esc: finish</span>
    </Row>
  );
}

export const penTool: Tool = {
  id: 'pen',
  name: 'Pen Tool',
  shortcut: 'p',
  icon: PenTool,
  group: 'pen',
  order: 100,
  cursor: penCursor('start'),
  hint: 'Click to add corner anchors, drag to add smooth anchors. Click the first anchor to close. Enter/Esc finishes.',
  showSelectionOverlay: 'anchors',
  defaults: { rubberBand: true },
  Options: PenOptions,
  activate(ctx) {
    gesture = { kind: 'none' };
    hover = null;
    hoverKey = '';
    hoverSnap = null;
    // continue drawing when the selection is a single open path? no: Illustrator starts fresh
    setCurrent(null);
    ctx.setCursor(penCursor('start'));
  },
  deactivate(ctx) {
    if (gesture.kind === 'place') ctx.state.revert();
    if (gesture.kind === 'delegate') directDelegate.cancel(ctx);
    gesture = { kind: 'none' };
    finish(ctx, true);
    ctx.setSnapGuides(null);
  },
  isBusy: () => gesture.kind === 'place' || (gesture.kind === 'delegate' && directDelegate.isBusy()),
  cancel: penCancel,
  onPointerDown: penDown,
  onPointerMove: penMove,
  onPointerUp: penUp,
  onDoubleClick(e, ctx) {
    void e;
    // double-click while drawing finishes the path (the second click already placed its anchor)
    if (current) finish(ctx);
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (gesture.kind !== 'none') {
        penCancel(ctx);
        finish(ctx);
        return true;
      }
      if (current) {
        finish(ctx);
        return true;
      }
      if (ctx.state.selection.length) {
        ctx.state.clearSelection();
        return true;
      }
      return false;
    }
    if (e.key === 'Enter') {
      if (gesture.kind !== 'none') penCancel(ctx);
      if (current) {
        finish(ctx);
        return true;
      }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && current && gesture.kind === 'none') return deleteLastAnchor(ctx);
    if (gesture.kind === 'delegate') return directDelegate.keyDown(e, ctx);
    // selected anchors (e.g. after Ctrl-selecting): Delete / arrows act on anchors, not objects
    if (gesture.kind === 'none' && ctx.state.selectedAnchors.length) return directDelegate.keyDown(e, ctx);
    return false;
  },
  onModifiers(e, ctx) {
    mods = { shift: e.shift, alt: e.alt, primary: e.primary };
    if (gesture.kind === 'none') {
      if (e.primary) ctx.setCursor('default');
      else ctx.setCursor(cursorFor(hover, current));
    }
    ctx.requestOverlay();
  },
  renderOverlay: penOverlay,
};

// ---------------------------------------------------------------------------
// Add Anchor Point tool
// ---------------------------------------------------------------------------

let addHover: EditHit | null = null;
let addHoverKey = '';

function addHit(ctx: ToolContext, world: Vec): EditHit | null {
  const s = ctx.state;
  const ids = editablePathIds(s.doc, s.selection);
  const hit = findEditHit(ctx, world, { ids, handles: false, anyObject: true, anchorsOfHit: true, fills: false });
  if (!hit || hit.kind === 'object') return null;
  return hit;
}

export const addAnchorTool: Tool = {
  id: 'addAnchor',
  name: 'Add Anchor Point Tool',
  shortcut: '=',
  icon: Plus,
  group: 'pen',
  order: 101,
  cursor: penCursor('none'),
  hint: 'Click a path segment to add an anchor point.',
  showSelectionOverlay: 'anchors',
  activate(ctx) {
    addHover = null;
    addHoverKey = '';
    ctx.setCursor(penCursor('none'));
  },
  deactivate() {
    addHover = null;
    addHoverKey = '';
  },
  onPointerMove(e, ctx) {
    const hit = addHit(ctx, e.world);
    const key = editHitKey(hit);
    if (key !== addHoverKey) {
      addHoverKey = key;
      addHover = hit;
      ctx.requestOverlay();
    }
    ctx.setCursor(penCursor(hit && hit.kind === 'segment' ? 'add' : 'none'));
    ctx.state.setHover(hit && hit.kind === 'segment' && !ctx.state.selection.includes(hit.nodeId) ? hit.nodeId : null);
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const hit = addHit(ctx, e.world);
    if (!hit || hit.kind !== 'segment') {
      ctx.setStatus('Click on a path segment to add an anchor point');
      return;
    }
    let ref: AnchorRef | null = null;
    ctx.state.updateDoc((d) => {
      ref = insertAnchorAtLocation(d, hit.nodeId, hit.subpath, hit.segment, hit.t);
    }, 'Add Anchor');
    if (ref) getState().setSelection([hit.nodeId], [ref]);
    addHover = null;
    addHoverKey = '';
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && ctx.state.selection.length) {
      ctx.state.clearSelection();
      return true;
    }
    if (ctx.state.selectedAnchors.length) return directDelegate.keyDown(e, ctx);
    return false;
  },
  renderOverlay(ctx) {
    if (!addHover || addHover.kind !== 'segment') return null;
    return (
      <g className="add-anchor-overlay">
        <SegmentHighlight ctx={ctx} ref={{ nodeId: addHover.nodeId, subpath: addHover.subpath, segment: addHover.segment }} width={2.5} />
        <PointMarker ctx={ctx} point={addHover.point} />
      </g>
    );
  },
};

// ---------------------------------------------------------------------------
// Delete Anchor Point tool
// ---------------------------------------------------------------------------

let delHover: EditHit | null = null;
let delHoverKey = '';

function delHit(ctx: ToolContext, world: Vec): EditHit | null {
  const s = ctx.state;
  const ids = editablePathIds(s.doc, s.selection);
  const hit = findEditHit(ctx, world, { ids, handles: false, anyObject: true, anchorsOfHit: true, fills: false });
  if (!hit || hit.kind === 'object') return null;
  return hit;
}

export const deleteAnchorTool: Tool = {
  id: 'deleteAnchor',
  name: 'Delete Anchor Point Tool',
  shortcut: '-',
  icon: Minus,
  group: 'pen',
  order: 102,
  cursor: penCursor('none'),
  hint: 'Click an anchor point to remove it (the path stays connected).',
  showSelectionOverlay: 'anchors',
  activate(ctx) {
    delHover = null;
    delHoverKey = '';
    ctx.setCursor(penCursor('none'));
  },
  deactivate() {
    delHover = null;
    delHoverKey = '';
  },
  onPointerMove(e, ctx) {
    const hit = delHit(ctx, e.world);
    const key = editHitKey(hit);
    if (key !== delHoverKey) {
      delHoverKey = key;
      delHover = hit;
      ctx.requestOverlay();
    }
    ctx.setCursor(penCursor(hit && hit.kind === 'anchor' ? 'delete' : 'none'));
    ctx.state.setHover(hit && hit.kind === 'segment' && !ctx.state.selection.includes(hit.nodeId) ? hit.nodeId : null);
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const hit = delHit(ctx, e.world);
    if (!hit || hit.kind !== 'anchor') {
      if (hit && hit.kind === 'segment') getState().setSelection([hit.nodeId], []);
      else ctx.setStatus('Click on an anchor point to delete it');
      return;
    }
    let alive = true;
    ctx.state.updateDoc((d) => {
      alive = removeAnchorJoin(d, hit.ref);
      if (alive) alive = cleanupPath(d, hit.ref.nodeId);
    }, 'Delete Anchor');
    const st = getState();
    st.setSelection(alive ? [hit.ref.nodeId] : st.selection.filter((id) => id !== hit.ref.nodeId), []);
    delHover = null;
    delHoverKey = '';
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && ctx.state.selection.length) {
      ctx.state.clearSelection();
      return true;
    }
    if (ctx.state.selectedAnchors.length) return directDelegate.keyDown(e, ctx);
    return false;
  },
  renderOverlay(ctx) {
    if (!delHover || delHover.kind !== 'anchor') return null;
    return <AnchorHighlight ctx={ctx} ref={delHover.ref} color="#e5484d" />;
  },
};

export const tools: Tool[] = [penTool, addAnchorTool, deleteAnchorTool];
void React;
void dist;
