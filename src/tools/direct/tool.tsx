/**
 * Direct Selection tool (A): select and move anchors, drag Bezier handles,
 * reshape segments, marquee-select anchors, nudge/delete anchors, convert
 * anchors with Alt-click, add anchors with a double-click on a segment.
 *
 * Objects inside groups are edited in place; all geometry edits go through
 * the world-space helpers in ../pathEditing so transformed nodes behave.
 */
import React from 'react';
import { MousePointer } from 'lucide-react';
import { produce } from 'immer';
import { Spline, CornerUpRight, Trash2 } from 'lucide-react';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import type { Document, ID, Vec, Rect, AnchorRef, HandleRef } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { applyWorldMatrix, bakeTransform, collectPaths, selectionBounds, worldBounds } from '@/model/document';
import { nodesInRect } from '@/canvas/hitTest';
import { useOverlayStore } from '@/canvas/overlayStore';
import { SnapSession, constrainDelta } from '@/canvas/snap';
import { translate } from '@/geometry/matrix';
import { rectFromPoints, sub, add, dist } from '@/geometry/vec';
import { formatLength } from '@/util/units';
import { Checkbox, Row, Button, IconButton, Segmented } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';
import { runCommand } from '@/commands/registry';
import { scheduleCommit } from '@/commands/core';
import {
  anchorKey,
  anchorSet,
  sameAnchor,
  dedupeRefs,
  validAnchors,
  allAnchorRefs,
  anchorWorldPoint,
  anchorsInRect,
  anchorsBounds,
  fullySelectedNodes,
  translateAnchorsWorld,
  setHandleWorld,
  toggleAnchorKind,
  insertAnchorAtLocation,
  editablePathIds,
  allEditablePathIds,
  getSubPath,
} from '../pathEditing/anchors';
import { reshapeSegmentWorld, translateSegmentWorld, segmentIsStraight, segmentWorldCubic, constrainTo45, type SegmentRef } from '../pathEditing/curves';
import { findEditHit, editHitKey, type EditHit } from '../pathEditing/hover';
import { directCursor } from '../pathEditing/cursors';
import { AnchorHighlight, HandleHighlight, SegmentHighlight, HL } from '../pathEditing/overlay';
import { convertSelectedAnchors } from '../pathEditing/register';
import { cubicPoint } from '@/geometry/bezier';

// ---------------------------------------------------------------------------
// Gesture state
// ---------------------------------------------------------------------------

type PendingTarget =
  | { kind: 'anchor'; ref: AnchorRef; wasSelected: boolean }
  | { kind: 'segment'; seg: SegmentRef; t: number; grab: Vec }
  | { kind: 'object'; id: ID; isPath: boolean; wasSelected: boolean };

type Gesture =
  | { kind: 'none' }
  | { kind: 'pending'; start: Vec; startScreen: Vec; target: PendingTarget; shift: boolean; alt: boolean }
  | { kind: 'marquee'; start: Vec; add: boolean }
  | { kind: 'anchors'; start: Vec; base: Document; refs: AnchorRef[]; primary: AnchorRef | null; primaryStart: Vec | null; wholeNodes: ID[]; bounds: Rect; snap: SnapSession }
  | { kind: 'handle'; base: Document; ref: HandleRef; anchorWorld: Vec; moved: boolean }
  | { kind: 'segment'; start: Vec; base: Document; seg: SegmentRef; t: number; mode: 'translate' | 'reshape'; bounds: Rect; snap: SnapSession; grab: Vec }
  | { kind: 'objects'; start: Vec; base: Document; ids: ID[]; bounds: Rect; snap: SnapSession };

let gesture: Gesture = { kind: 'none' };
let hover: EditHit | null = null;
let hoverKey = '';
/** segment selected by clicking on it (drawn highlighted, used by segment drags) */
let selectedSegment: SegmentRef | null = null;

function setGesture(g: Gesture) {
  gesture = g;
}

function isBusy(): boolean {
  return gesture.kind !== 'none' && gesture.kind !== 'pending';
}

function clearTransient(ctx: ToolContext) {
  ctx.setSnapGuides(null);
  useOverlayStore.getState().setHud(null);
  useOverlayStore.getState().setMarquee(null);
}

function setHover(ctx: ToolContext, h: EditHit | null) {
  const key = editHitKey(h);
  if (key === hoverKey) return;
  hoverKey = key;
  hover = h;
  ctx.requestOverlay();
}

/** Candidate paths for anchor hit testing: leaf paths of the selection. */
function selectedPaths(ctx: ToolContext): ID[] {
  const s = ctx.state;
  return editablePathIds(s.doc, s.selection);
}

function anchorsOfNode(doc: Document, id: ID): AnchorRef[] {
  return allAnchorRefs(doc, [id]);
}

function snapSessionFor(ctx: ToolContext, refs: AnchorRef[]): SnapSession {
  // the moving anchors must not snap to themselves; the other anchors of the
  // same paths remain useful targets
  const s = ctx.state;
  const moving = anchorSet(refs);
  const nodeIds = Array.from(new Set(refs.map((r) => r.nodeId)));
  const extra: Vec[] = [];
  for (const id of nodeIds) {
    for (const r of anchorsOfNode(s.doc, id)) {
      if (moving.has(anchorKey(r))) continue;
      const p = anchorWorldPoint(s.doc, r);
      if (p) extra.push(p);
    }
  }
  return ctx.beginSnap({ exclude: nodeIds, extraPoints: extra });
}

// ---------------------------------------------------------------------------
// Gesture start helpers
// ---------------------------------------------------------------------------

function beginAnchorMove(ctx: ToolContext, start: Vec, primary: AnchorRef | null) {
  const s = ctx.state;
  let refs = validAnchors(s.doc, dedupeRefs(s.selectedAnchors));
  if (primary && !refs.some((r) => sameAnchor(r, primary))) refs = refs.concat([primary]);
  if (!refs.length) return;
  const wholeNodes = fullySelectedNodes(s.doc, refs);
  const bounds = anchorsBounds(s.doc, refs) ?? { x: start.x, y: start.y, width: 0, height: 0 };
  setGesture({
    kind: 'anchors',
    start,
    base: s.doc,
    refs,
    primary,
    primaryStart: primary ? anchorWorldPoint(s.doc, primary) : null,
    wholeNodes,
    bounds,
    snap: snapSessionFor(ctx, refs),
  });
  ctx.setCursor(directCursor('move'));
}

function beginObjectMove(ctx: ToolContext, start: Vec, ids: ID[]) {
  const s = ctx.state;
  const bounds = selectionBounds(s.doc, ids) ?? { x: start.x, y: start.y, width: 0, height: 0 };
  setGesture({ kind: 'objects', start, base: s.doc, ids, bounds, snap: ctx.beginSnap({ exclude: ids }) });
  ctx.setCursor(directCursor('move'));
}

function beginSegmentDrag(ctx: ToolContext, start: Vec, seg: SegmentRef, t: number, grab: Vec) {
  const s = ctx.state;
  const sp = getSubPath(s.doc, seg);
  if (!sp) return;
  const c = segmentWorldCubic(s.doc, seg);
  const bounds = c ? rectFromPoints(c.p0, c.p3) : { x: start.x, y: start.y, width: 0, height: 0 };
  const opts = ctx.options<{ straightSegments?: 'move' | 'reshape' }>();
  const mode: 'translate' | 'reshape' = segmentIsStraight(sp, seg.segment) && opts.straightSegments !== 'reshape' ? 'translate' : 'reshape';
  const refs: AnchorRef[] = [
    { nodeId: seg.nodeId, subpath: seg.subpath, index: seg.segment },
    { nodeId: seg.nodeId, subpath: seg.subpath, index: (seg.segment + 1) % sp.anchors.length },
  ];
  setGesture({ kind: 'segment', start, base: s.doc, seg, t, mode, bounds, snap: snapSessionFor(ctx, refs), grab });
  ctx.setCursor(directCursor('segment'));
}

/** Translate anchors (world delta) on top of the gesture base document. */
function applyAnchorDelta(base: Document, refs: AnchorRef[], wholeNodes: ID[], delta: Vec): Document {
  const whole = new Set(wholeNodes);
  const partial = refs.filter((r) => !whole.has(r.nodeId));
  return produce(base, (d) => {
    if (partial.length) translateAnchorsWorld(d, partial, delta);
    for (const id of wholeNodes) applyWorldMatrix(d, id, translate(delta.x, delta.y), true);
  });
}

function finalizeObjects(ctx: ToolContext, ids: ID[]) {
  ctx.state.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n) continue;
      if (n.type === 'path') bakeTransform(d, id);
    }
  });
  ctx.commit('Move');
}

// ---------------------------------------------------------------------------
// Pointer handlers (exported so the Pen tool can delegate while Ctrl is held)
// ---------------------------------------------------------------------------

function pointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
  if (e.button !== 0) return;
  const s = ctx.state;
  if (s.editingTextId) s.setEditingText(null);
  const ids = selectedPaths(ctx);
  const hit = findEditHit(ctx, e.world, { ids, handles: true, anyObject: true, anchorsOfHit: true, fills: true });
  setHover(ctx, null);

  if (!hit) {
    if (!e.shift) {
      s.clearSelection();
      selectedSegment = null;
    }
    setGesture({ kind: 'marquee', start: e.world, add: e.shift });
    ctx.requestOverlay();
    return;
  }

  if (hit.kind === 'handle') {
    const anchorWorld = anchorWorldPoint(s.doc, hit.ref) ?? e.world;
    // make sure the anchor stays selected so its handles remain visible
    if (!s.selectedAnchors.some((r) => sameAnchor(r, hit.ref))) s.setSelectedAnchors(s.selectedAnchors.concat([{ nodeId: hit.ref.nodeId, subpath: hit.ref.subpath, index: hit.ref.index }]));
    setGesture({ kind: 'handle', base: s.doc, ref: hit.ref, anchorWorld, moved: false });
    ctx.setCursor(directCursor('handle'));
    return;
  }

  if (hit.kind === 'anchor') {
    const ref = hit.ref;
    const wasSelected = s.selectedAnchors.some((r) => sameAnchor(r, ref));
    selectedSegment = null;
    if (e.alt && !e.shift) {
      // Alt-click: toggle smooth / corner
      let result: 'smooth' | 'corner' | null = null;
      s.updateDoc((d) => {
        result = toggleAnchorKind(d, ref);
      }, 'Convert Anchor');
      if (!wasSelected) getState().setSelection([ref.nodeId], [ref]);
      ctx.setStatus(result === 'smooth' ? 'Anchor converted to smooth' : 'Anchor converted to corner');
      setGesture({ kind: 'none' });
      ctx.requestOverlay();
      return;
    }
    if (e.shift) {
      if (!wasSelected) {
        const sel = s.selection.includes(ref.nodeId) || s.selection.some((id) => collectPaths(s.doc, [id]).includes(ref.nodeId)) ? s.selection : s.selection.concat([ref.nodeId]);
        s.setSelection(sel, s.selectedAnchors.concat([ref]));
      }
    } else if (!wasSelected) {
      s.setSelection([ref.nodeId], [ref]);
    }
    setGesture({ kind: 'pending', start: e.world, startScreen: e.screen, target: { kind: 'anchor', ref, wasSelected }, shift: e.shift, alt: e.alt });
    return;
  }

  if (hit.kind === 'segment') {
    const seg: SegmentRef = { nodeId: hit.nodeId, subpath: hit.subpath, segment: hit.segment };
    const selected = s.selection.includes(hit.nodeId) || ids.includes(hit.nodeId);
    if (e.shift) {
      if (!selected) s.setSelection(s.selection.concat([hit.nodeId]), s.selectedAnchors);
    } else {
      // click on a segment: select the path, drop the anchor selection (Illustrator)
      s.setSelection([hit.nodeId], []);
    }
    selectedSegment = seg;
    setGesture({ kind: 'pending', start: e.world, startScreen: e.screen, target: { kind: 'segment', seg, t: hit.t, grab: hit.point }, shift: e.shift, alt: e.alt });
    ctx.requestOverlay();
    return;
  }

  // object (fill / text / image)
  const id = hit.id;
  const node = s.doc.nodes[id];
  const isPath = !!node && node.type === 'path';
  const wasSelected = s.selection.includes(id);
  selectedSegment = null;
  if (e.shift) {
    if (!wasSelected) s.setSelection(s.selection.concat([id]), isPath ? s.selectedAnchors.concat(anchorsOfNode(s.doc, id)) : s.selectedAnchors);
  } else if (!wasSelected) {
    s.setSelection([id], isPath ? anchorsOfNode(s.doc, id) : []);
  } else if (isPath) {
    // already selected: clicking inside selects all of its anchors
    const own = anchorsOfNode(s.doc, id);
    const set = anchorSet(s.selectedAnchors);
    s.setSelectedAnchors(s.selectedAnchors.concat(own.filter((r) => !set.has(anchorKey(r)))));
  }
  setGesture({ kind: 'pending', start: e.world, startScreen: e.screen, target: { kind: 'object', id, isPath, wasSelected }, shift: e.shift, alt: e.alt });
}

function pointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
  const s = ctx.state;
  const g = gesture;

  if (g.kind === 'none') {
    const ids = selectedPaths(ctx);
    const hit = findEditHit(ctx, e.world, { ids, handles: true, anyObject: true, anchorsOfHit: true, fills: true });
    setHover(ctx, hit);
    if (!hit) {
      s.setHover(null);
      ctx.setCursor(directCursor('none'));
      return;
    }
    if (hit.kind === 'object') {
      s.setHover(hit.id);
      ctx.setCursor(directCursor('object'));
    } else {
      s.setHover(hit.kind === 'segment' && !ids.includes(hit.nodeId) ? hit.nodeId : null);
      ctx.setCursor(directCursor(hit.kind));
    }
    return;
  }

  if (g.kind === 'pending') {
    const moved = Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y);
    if (moved < 3) return;
    const t = g.target;
    if (t.kind === 'anchor') beginAnchorMove(ctx, g.start, t.ref);
    else if (t.kind === 'segment') beginSegmentDrag(ctx, g.start, t.seg, t.t, t.grab);
    else if (t.kind === 'object') {
      if (t.isPath) beginAnchorMove(ctx, g.start, null);
      else beginObjectMove(ctx, g.start, s.selection.filter((id) => s.doc.nodes[id] && s.doc.nodes[id].type !== 'path'));
    }
    if (gesture.kind !== 'pending') pointerMove(e, ctx);
    return;
  }

  if (g.kind === 'marquee') {
    useOverlayStore.getState().setMarquee(rectFromPoints(g.start, e.world));
    return;
  }

  if (g.kind === 'anchors') {
    let delta = sub(e.world, g.start);
    if (e.shift) delta = constrainDelta(delta, s.prefs.constrainAngle || 45);
    let guides: ReturnType<SnapSession['snap']> | null = null;
    if (!e.primary) {
      if (g.primary && g.primaryStart) {
        const sr = g.snap.snap(add(g.primaryStart, delta));
        if (sr.snappedPoint || (!e.shift && (sr.snappedX || sr.snappedY))) {
          delta = sub(sr.point, g.primaryStart);
          guides = sr;
        }
      } else {
        const moved: Rect = { x: g.bounds.x + delta.x, y: g.bounds.y + delta.y, width: g.bounds.width, height: g.bounds.height };
        const rs = g.snap.snapRect(moved);
        if (!e.shift || Math.abs(delta.x) > Math.abs(delta.y)) delta.x += rs.dx;
        if (!e.shift || Math.abs(delta.y) >= Math.abs(delta.x)) delta.y += rs.dy;
        guides = { point: e.world, snappedX: rs.dx !== 0, snappedY: rs.dy !== 0, snappedPoint: false, lines: rs.lines, points: [] };
      }
    }
    s.replaceDoc(applyAnchorDelta(g.base, g.refs, g.wholeNodes, delta));
    ctx.setSnapGuides(guides);
    useOverlayStore.getState().setHud({ screen: e.screen, text: `ΔX: ${formatLength(delta.x, s.prefs.units)}\nΔY: ${formatLength(delta.y, s.prefs.units)}` });
    return;
  }

  if (g.kind === 'handle') {
    let target = e.world;
    if (e.shift) target = constrainTo45(g.anchorWorld, target, s.prefs.constrainAngle || 45);
    g.moved = true;
    s.replaceDoc(
      produce(g.base, (d) => {
        setHandleWorld(d, g.ref, target, { breakPair: e.alt });
      }),
    );
    const l = dist(target, g.anchorWorld);
    const ang = (Math.atan2(target.y - g.anchorWorld.y, target.x - g.anchorWorld.x) * 180) / Math.PI;
    useOverlayStore.getState().setHud({ screen: e.screen, text: `L: ${formatLength(l, s.prefs.units)}\n∠ ${ang.toFixed(1)}°${e.alt ? '\nAlt: break pair' : ''}` });
    return;
  }

  if (g.kind === 'segment') {
    if (g.mode === 'translate') {
      let delta = sub(e.world, g.start);
      if (e.shift) delta = constrainDelta(delta, s.prefs.constrainAngle || 45);
      let guides: ReturnType<SnapSession['snap']> | null = null;
      if (!e.primary) {
        const moved: Rect = { x: g.bounds.x + delta.x, y: g.bounds.y + delta.y, width: g.bounds.width, height: g.bounds.height };
        const rs = g.snap.snapRect(moved);
        if (!e.shift || Math.abs(delta.x) > Math.abs(delta.y)) delta.x += rs.dx;
        if (!e.shift || Math.abs(delta.y) >= Math.abs(delta.x)) delta.y += rs.dy;
        guides = { point: e.world, snappedX: rs.dx !== 0, snappedY: rs.dy !== 0, snappedPoint: false, lines: rs.lines, points: [] };
      }
      s.replaceDoc(
        produce(g.base, (d) => {
          translateSegmentWorld(d, g.seg, delta);
        }),
      );
      ctx.setSnapGuides(guides);
      useOverlayStore.getState().setHud({ screen: e.screen, text: `ΔX: ${formatLength(delta.x, s.prefs.units)}\nΔY: ${formatLength(delta.y, s.prefs.units)}` });
    } else {
      const delta = sub(e.world, g.start);
      const target = add(g.grab, delta);
      s.replaceDoc(
        produce(g.base, (d) => {
          reshapeSegmentWorld(d, g.seg, g.t, target, { smoothNeighbours: !e.alt });
        }),
      );
    }
    return;
  }

  if (g.kind === 'objects') {
    let delta = sub(e.world, g.start);
    if (e.shift) delta = constrainDelta(delta, s.prefs.constrainAngle || 45);
    let guides: ReturnType<SnapSession['snap']> | null = null;
    if (!e.primary) {
      const moved: Rect = { x: g.bounds.x + delta.x, y: g.bounds.y + delta.y, width: g.bounds.width, height: g.bounds.height };
      const rs = g.snap.snapRect(moved);
      delta.x += rs.dx;
      delta.y += rs.dy;
      guides = { point: e.world, snappedX: rs.dx !== 0, snappedY: rs.dy !== 0, snappedPoint: false, lines: rs.lines, points: [] };
    }
    s.replaceDoc(
      produce(g.base, (d) => {
        for (const id of g.ids) applyWorldMatrix(d, id, translate(delta.x, delta.y), false);
      }),
    );
    ctx.setSnapGuides(guides);
    useOverlayStore.getState().setHud({ screen: e.screen, text: `ΔX: ${formatLength(delta.x, s.prefs.units)}\nΔY: ${formatLength(delta.y, s.prefs.units)}` });
  }
}

function pointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
  const s = ctx.state;
  const g = gesture;
  setGesture({ kind: 'none' });
  clearTransient(ctx);

  if (g.kind === 'pending') {
    const t = g.target;
    if (t.kind === 'anchor') {
      if (e.shift && t.wasSelected) {
        const anchors = s.selectedAnchors.filter((r) => !sameAnchor(r, t.ref));
        s.setSelectedAnchors(anchors);
      } else if (!e.shift && t.wasSelected) {
        s.setSelection([t.ref.nodeId], [t.ref]);
      }
    } else if (t.kind === 'object') {
      if (e.shift && t.wasSelected) {
        s.setSelection(
          s.selection.filter((id) => id !== t.id),
          s.selectedAnchors.filter((r) => r.nodeId !== t.id),
        );
      } else if (!e.shift && t.wasSelected && s.selection.length > 1) {
        s.setSelection([t.id], t.isPath ? anchorsOfNode(s.doc, t.id) : []);
      }
    }
    pointerMove(e, ctx);
    return;
  }

  if (g.kind === 'marquee') {
    const r = rectFromPoints(g.start, e.world);
    ctx.requestOverlay();
    if (r.width < 1 && r.height < 1) return;
    const ids = allEditablePathIds(s.doc, s.isolationId);
    const inside = anchorsInRect(s.doc, ids, r);
    if (inside.length) {
      const nodeIds = Array.from(new Set(inside.map((a) => a.nodeId)));
      if (g.add) {
        const set = anchorSet(s.selectedAnchors);
        s.setSelection(Array.from(new Set(s.selection.concat(nodeIds))), s.selectedAnchors.concat(inside.filter((a) => !set.has(anchorKey(a)))));
      } else s.setSelection(nodeIds, inside);
    } else {
      const objs = nodesInRect(s.doc, r, { enterGroups: true, isolation: s.isolationId });
      if (g.add) s.setSelection(Array.from(new Set(s.selection.concat(objs))), s.selectedAnchors);
      else s.setSelection(objs, []);
    }
    return;
  }

  if (g.kind === 'anchors') {
    ctx.commit(g.wholeNodes.length && g.refs.every((r) => g.wholeNodes.includes(r.nodeId)) ? 'Move' : 'Move Anchors');
  } else if (g.kind === 'handle') {
    if (g.moved) ctx.commit('Move Handle');
  } else if (g.kind === 'segment') {
    ctx.commit(g.mode === 'translate' ? 'Move Segment' : 'Reshape Segment');
  } else if (g.kind === 'objects') {
    finalizeObjects(ctx, g.ids);
  }
  pointerMove(e, ctx);
}

function cancel(ctx: ToolContext): void {
  if (isBusy()) ctx.state.revert();
  setGesture({ kind: 'none' });
  clearTransient(ctx);
  ctx.setCursor(directCursor('none'));
  ctx.requestOverlay();
}

function doubleClick(e: ToolPointerEvent, ctx: ToolContext): void {
  const s = ctx.state;
  const ids = selectedPaths(ctx);
  const hit = findEditHit(ctx, e.world, { ids, handles: false, anyObject: true, anchorsOfHit: true, fills: false });
  if (hit && hit.kind === 'segment') {
    let ref: AnchorRef | null = null;
    s.updateDoc((d) => {
      ref = insertAnchorAtLocation(d, hit.nodeId, hit.subpath, hit.segment, hit.t);
    }, 'Add Anchor');
    if (ref) getState().setSelection([hit.nodeId], [ref]);
    selectedSegment = null;
    ctx.requestOverlay();
    return;
  }
  if (!hit && s.isolationId) {
    const parent = s.doc.nodes[s.isolationId]?.parent;
    const pn = parent ? s.doc.nodes[parent] : undefined;
    s.setIsolation(pn && pn.type === 'group' ? parent! : null);
    return;
  }
  if (hit && hit.kind === 'object') {
    const n = s.doc.nodes[hit.id];
    if (n?.type === 'text') {
      s.setSelection([hit.id]);
      s.setTool('text');
      s.setEditingText(hit.id);
    }
  }
}

function nudgeAnchors(ctx: ToolContext, dx: number, dy: number): boolean {
  const s = ctx.state;
  const refs = validAnchors(s.doc, dedupeRefs(s.selectedAnchors));
  if (!refs.length) return false;
  const whole = fullySelectedNodes(s.doc, refs);
  s.updateDoc((d) => {
    const set = new Set(whole);
    translateAnchorsWorld(d, refs.filter((r) => !set.has(r.nodeId)), { x: dx, y: dy });
    for (const id of whole) applyWorldMatrix(d, id, translate(dx, dy), true);
  });
  scheduleCommit('Move Anchors');
  return true;
}

function keyDown(e: { key: string; shift: boolean }, ctx: ToolContext): boolean {
  const s = ctx.state;
  if (e.key === 'Escape') {
    if (isBusy() || gesture.kind === 'pending') {
      cancel(ctx);
      return true;
    }
    if (s.selectedAnchors.length || selectedSegment) {
      s.setSelectedAnchors([]);
      selectedSegment = null;
      ctx.requestOverlay();
      return true;
    }
    if (s.selection.length) {
      s.clearSelection();
      return true;
    }
    if (s.isolationId) {
      const parent = s.doc.nodes[s.isolationId]?.parent;
      const pn = parent ? s.doc.nodes[parent] : undefined;
      s.setIsolation(pn && pn.type === 'group' ? parent! : null);
      return true;
    }
    return false;
  }
  if (isBusy()) return false;
  if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedAnchors.length) {
    runCommand('path.deleteAnchors');
    selectedSegment = null;
    ctx.requestOverlay();
    return true;
  }
  if (s.selectedAnchors.length) {
    const step = e.shift ? s.prefs.bigNudge : s.prefs.nudge;
    if (e.key === 'ArrowLeft') return nudgeAnchors(ctx, -step, 0);
    if (e.key === 'ArrowRight') return nudgeAnchors(ctx, step, 0);
    if (e.key === 'ArrowUp') return nudgeAnchors(ctx, 0, -step);
    if (e.key === 'ArrowDown') return nudgeAnchors(ctx, 0, step);
  }
  return false;
}

/** Hover / selection highlights (also used by the Pen tool while Ctrl is held). */
function overlay(ctx: ToolContext): React.ReactNode {
  const s = ctx.state;
  const items: React.ReactNode[] = [];
  const g = gesture;
  if (selectedSegment && getSubPath(s.doc, selectedSegment)) {
    items.push(<SegmentHighlight key="selseg" ctx={ctx} ref={selectedSegment} width={3} />);
  }
  if (g.kind === 'handle') {
    items.push(<HandleHighlight key="hdrag" ctx={ctx} ref={g.ref} />);
  } else if (g.kind === 'segment') {
    items.push(<SegmentHighlight key="sdrag" ctx={ctx} ref={g.seg} width={3} />);
  } else if (g.kind === 'anchors' && g.primary) {
    items.push(<AnchorHighlight key="adrag" ctx={ctx} ref={g.primary} />);
  } else if (g.kind === 'none' && hover) {
    if (hover.kind === 'anchor') items.push(<AnchorHighlight key="ha" ctx={ctx} ref={hover.ref} />);
    else if (hover.kind === 'handle') items.push(<HandleHighlight key="hh" ctx={ctx} ref={hover.ref} />);
    else if (hover.kind === 'segment') {
      const seg: SegmentRef = { nodeId: hover.nodeId, subpath: hover.subpath, segment: hover.segment };
      items.push(<SegmentHighlight key="hs" ctx={ctx} ref={seg} width={2.5} />);
      const c = segmentWorldCubic(s.doc, seg);
      if (c) {
        const p = ctx.worldToScreen(cubicPoint(c, hover.t));
        items.push(<circle key="hsp" cx={p.x} cy={p.y} r={2} fill={HL} pointerEvents="none" />);
      }
    }
  }
  return items.length ? <g className="direct-overlay">{items}</g> : null;
}

/** Entry points for other tools that temporarily behave like direct selection (Ctrl in the Pen tool). */
export const directDelegate = { pointerDown, pointerMove, pointerUp, cancel, overlay, isBusy, keyDown };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const directTool: Tool = {
  id: 'direct',
  name: 'Direct Selection Tool',
  shortcut: 'a',
  icon: MousePointer,
  group: 'select',
  order: 11,
  cursor: 'default',
  hint: 'Click anchors, handles or segments to edit them. Shift adds, Alt-click converts an anchor, double-click a segment to add an anchor.',
  showSelectionOverlay: 'anchors',
  defaults: { straightSegments: 'move' },
  Options: DirectOptions,

  activate() {
    setGesture({ kind: 'none' });
    hover = null;
    hoverKey = '';
    selectedSegment = null;
  },
  deactivate(ctx) {
    if (isBusy()) ctx.state.revert();
    setGesture({ kind: 'none' });
    hover = null;
    hoverKey = '';
    selectedSegment = null;
    clearTransient(ctx);
  },
  isBusy,
  cancel,
  onPointerDown: pointerDown,
  onPointerMove: pointerMove,
  onPointerUp: pointerUp,
  onDoubleClick: doubleClick,
  onKeyDown(e, ctx) {
    return keyDown(e, ctx);
  },
  onModifiers() {
    /* cursor badges do not depend on modifiers */
  },
  renderOverlay: overlay,
};

function DirectOptions() {
  const anchors = useStore((s) => s.selectedAnchors);
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const doc = useStore((s) => s.doc);
  const [opts, setOpts] = useToolOptions<{ straightSegments: 'move' | 'reshape' }>('direct');
  const count = anchors.length;
  const pathCount = collectPaths(doc, selection).length;
  const desc = count > 0 ? `${count} anchor${count > 1 ? 's' : ''} selected` : selection.length ? `${selection.length} object${selection.length > 1 ? 's' : ''}${pathCount ? ` · ${pathCount} path${pathCount > 1 ? 's' : ''}` : ''}` : 'No selection';
  return (
    <Row gap={8} className="pe-options">
      <span className="pe-status small">{desc}</span>
      <span className="pe-group">
        <span className="pe-group-label">Convert:</span>
        <IconButton icon={<Spline size={15} />} title="Convert selected anchors to smooth" disabled={!count} onClick={() => convertSelectedAnchors('smooth')} data-testid="direct-smooth" />
        <IconButton icon={<CornerUpRight size={15} />} title="Convert selected anchors to corner" disabled={!count} onClick={() => convertSelectedAnchors('corner')} data-testid="direct-corner" />
      </span>
      <IconButton icon={<Trash2 size={15} />} title="Remove selected anchors (Delete)" disabled={!count} onClick={() => runCommand('path.deleteAnchors')} data-testid="direct-remove" />
      <span className="pe-sep" />
      <Checkbox checked={view.showAnchors} onChange={(v) => setView({ showAnchors: v })} label="Show anchors" />
      <Checkbox checked={view.snapToPoint} onChange={(v) => setView({ snapToPoint: v })} label="Snap to point" />
      <span className="pe-group" title="What dragging a straight segment does: move it, or bend it into a curve">
        <span className="pe-group-label">Straight segment:</span>
        <Segmented value={opts.straightSegments ?? 'move'} options={[{ value: 'move', label: 'Move' }, { value: 'reshape', label: 'Reshape' }]} onChange={(v) => setOpts({ straightSegments: v })} />
      </span>
      {pathCount > 0 && (
        <Button small onClick={() => runCommand('path.selectAllAnchors')} title="Select every anchor of the selected paths">
          All anchors
        </Button>
      )}
      <span className="pe-kbd-hint">Alt-click: smooth/corner · Alt-drag handle: break pair · Shift: 45°</span>
    </Row>
  );
}

export const tool = directTool;
void React;
void worldBounds;
