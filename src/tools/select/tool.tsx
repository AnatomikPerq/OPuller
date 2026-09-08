/**
 * Selection tool (V): click/shift-click selection, marquee, move with snapping,
 * scale/rotate via bounding-box handles, alt-drag duplicate, double-click to
 * isolate groups or edit text.
 */
import React from 'react';
import { MousePointer2 } from 'lucide-react';
import { produce } from 'immer';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import type { Document, ID, Matrix, Vec, Rect } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { getSelectionFrame, hitHandle, handlePoint, oppositeHandle, type HandleKind, type SelectionFrame } from '@/canvas/selectionHandles';
import { nodesInRect } from '@/canvas/hitTest';
import { useOverlayStore } from '@/canvas/overlayStore';
import { applyWorldMatrix, bakeTransform, cloneSubtree, addSubtree, indexInParent, selectionBounds, worldMatrix, layerOf, isAncestor } from '@/model/document';
import { translate, scale, rotate, multiply, invert, scaleFactor, identity } from '@/geometry/matrix';
import { rectFromPoints, sub, add, constrainAngle } from '@/geometry/vec';
import { SnapSession, constrainDelta } from '@/canvas/snap';
import { formatLength } from '@/util/units';
import { Checkbox, Row, Button } from '@/ui/widgets';
import { runCommand } from '@/commands/registry';

type Gesture =
  | { kind: 'none' }
  | { kind: 'pending'; start: Vec; startScreen: Vec; hitId: ID | null; wasSelected: boolean; toggled: boolean; alt: boolean }
  | { kind: 'marquee'; start: Vec; add: boolean }
  | { kind: 'move'; start: Vec; base: Document; ids: ID[]; bounds: Rect; snap: SnapSession; duplicated: boolean }
  | { kind: 'scale'; start: Vec; base: Document; ids: ID[]; frame: SelectionFrame; handle: HandleKind; snap: SnapSession }
  | { kind: 'rotate'; start: Vec; base: Document; ids: ID[]; frame: SelectionFrame; startAngle: number };

let gesture: Gesture = { kind: 'none' };
let lastAppliedMatrix: Matrix | null = null;

function setGesture(g: Gesture) {
  gesture = g;
}

function selectableTarget(ctx: ToolContext, e: ToolPointerEvent): ID | null {
  const hit = ctx.hitTest(e.world, { enterGroups: e.alt && !e.shift ? true : false });
  return hit ? hit.target : null;
}

function beginMove(ctx: ToolContext, e: ToolPointerEvent, ids: ID[], duplicate: boolean) {
  const s = ctx.state;
  let base = s.doc;
  let moveIds = ids;
  if (duplicate) {
    // duplicate selection and move the copies
    const newIds: ID[] = [];
    base = produce(base, (d) => {
      for (const id of ids) {
        const { root, nodes } = cloneSubtree(d, id);
        const parent = d.nodes[id].parent;
        addSubtree(d, root, nodes, parent, indexInParent(d, id) + 1);
        newIds.push(root.id);
      }
    });
    s.replaceDoc(base);
    s.setSelection(newIds);
    moveIds = newIds;
  }
  const bounds = selectionBounds(base, moveIds) ?? { x: e.world.x, y: e.world.y, width: 0, height: 0 };
  setGesture({ kind: 'move', start: e.world, base, ids: moveIds, bounds, snap: ctx.beginSnap({ exclude: moveIds }), duplicated: duplicate });
  ctx.setCursor('move');
}

function applyMatrixToSelection(base: Document, ids: ID[], m: Matrix): Document {
  return produce(base, (d) => {
    for (const id of ids) applyWorldMatrix(d, id, m, false);
  });
}

function finalize(ctx: ToolContext, label: string, ids: ID[], m: Matrix | null) {
  const s = ctx.state;
  s.updateDoc((d) => {
    for (const id of ids) {
      // bake into path geometry & optionally scale strokes
      const node = d.nodes[id];
      if (!node) continue;
      const walk = (nid: ID) => {
        const n = d.nodes[nid];
        if (!n) return;
        if (n.type === 'path') {
          if (m && s.prefs.scaleStrokes) {
            const f = scaleFactor(m);
            if (Math.abs(f - 1) > 1e-6) n.stroke = { ...n.stroke, width: n.stroke.width * f };
          }
          bakeTransform(d, nid);
        } else if (n.type === 'group' || n.type === 'layer') {
          for (const c of n.children) walk(c);
        }
      };
      if (node.type === 'path') walk(id);
      else if (node.type === 'group') {
        // keep the group's matrix (children stay in group space) unless it is a pure translation
        const t = node.transform;
        if (Math.abs(t.a - 1) < 1e-9 && Math.abs(t.d - 1) < 1e-9 && Math.abs(t.b) < 1e-9 && Math.abs(t.c) < 1e-9) {
          // push translation down into children so groups stay at identity
          for (const c of node.children) {
            const cn = d.nodes[c];
            cn.transform = multiply(t, cn.transform);
            if (cn.type === 'path') bakeTransform(d, c);
          }
          node.transform = identity();
        }
      }
    }
  });
  ctx.commit(label);
}

export const selectTool: Tool = {
  id: 'select',
  name: 'Selection Tool',
  shortcut: 'v',
  icon: MousePointer2,
  group: 'select',
  order: 10,
  cursor: 'default',
  hint: 'Click to select. Shift+click to add. Drag handles to scale, outside corners to rotate. Alt+drag to duplicate.',
  showSelectionOverlay: true,
  Options: SelectOptions,

  activate() {
    setGesture({ kind: 'none' });
  },
  deactivate(ctx) {
    if (gesture.kind !== 'none' && gesture.kind !== 'pending') ctx.state.revert();
    setGesture({ kind: 'none' });
    ctx.setSnapGuides(null);
    useOverlayStore.getState().setHud(null);
  },
  isBusy: () => gesture.kind !== 'none' && gesture.kind !== 'pending',
  cancel(ctx) {
    if (gesture.kind === 'move' || gesture.kind === 'scale' || gesture.kind === 'rotate') {
      ctx.state.revert();
      if (gesture.kind === 'move' && gesture.duplicated) ctx.state.setSelection([]);
    }
    setGesture({ kind: 'none' });
    ctx.setSnapGuides(null);
    useOverlayStore.getState().setMarquee(null);
    useOverlayStore.getState().setHud(null);
    ctx.setCursor('default');
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    if (s.editingTextId) s.setEditingText(null);
    const frame = getSelectionFrame(s);
    const hh = s.view.showBounds ? hitHandle(frame, e.screen, s.prefs.handleSize) : null;
    if (hh && frame) {
      if (hh.rotate) {
        const c = frame.center;
        setGesture({ kind: 'rotate', start: e.world, base: s.doc, ids: [...s.selection], frame, startAngle: Math.atan2(e.world.y - c.y, e.world.x - c.x) });
      } else {
        setGesture({ kind: 'scale', start: e.world, base: s.doc, ids: [...s.selection], frame, handle: hh.kind, snap: ctx.beginSnap({ exclude: s.selection }) });
      }
      return;
    }
    const target = selectableTarget(ctx, e);
    const wasSelected = !!target && (s.selection.includes(target) || s.selection.some((id) => isAncestor(s.doc, id, target)));
    if (target) {
      if (e.shift) {
        // toggle now (Illustrator toggles on mouse down for add, on mouse up for remove)
        if (!wasSelected) s.addToSelection([target]);
        setGesture({ kind: 'pending', start: e.world, startScreen: e.screen, hitId: target, wasSelected, toggled: !wasSelected, alt: e.alt });
      } else {
        if (!wasSelected) s.setSelection([target]);
        setGesture({ kind: 'pending', start: e.world, startScreen: e.screen, hitId: target, wasSelected, toggled: false, alt: e.alt });
      }
    } else {
      if (!e.shift) s.clearSelection();
      setGesture({ kind: 'marquee', start: e.world, add: e.shift });
    }
  },

  onPointerMove(e, ctx) {
    const s = ctx.state;
    const g = gesture;
    if (g.kind === 'none') {
      // hover feedback
      const frame = getSelectionFrame(s);
      const hh = s.view.showBounds ? hitHandle(frame, e.screen, s.prefs.handleSize) : null;
      if (hh) {
        ctx.setCursor(hh.rotate ? 'alias' : frame!.handles.find((h) => h.kind === hh.kind)!.cursor);
        s.setHover(null);
        return;
      }
      const hit = ctx.hitTest(e.world, { enterGroups: e.alt });
      s.setHover(hit ? hit.target : null);
      ctx.setCursor(hit ? 'move' : 'default');
      return;
    }
    if (g.kind === 'pending') {
      const dist = Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y);
      if (dist < 3) return;
      const ids = s.selection.length ? [...s.selection] : g.hitId ? [g.hitId] : [];
      if (!ids.length) {
        setGesture({ kind: 'marquee', start: g.start, add: false });
        return;
      }
      beginMove(ctx, { ...e, world: g.start }, ids, g.alt);
      this.onPointerMove!(e, ctx);
      return;
    }
    if (g.kind === 'marquee') {
      const r = rectFromPoints(g.start, e.world);
      useOverlayStore.getState().setMarquee(r);
      return;
    }
    if (g.kind === 'move') {
      let delta = sub(e.world, g.start);
      if (e.shift) delta = constrainDelta(delta, 45);
      // snap: try moving the bounds, plus the pointer itself for anchor snapping
      let snapLines: ReturnType<SnapSession['snap']> | null = null;
      if (!e.primary) {
        const moved: Rect = { x: g.bounds.x + delta.x, y: g.bounds.y + delta.y, width: g.bounds.width, height: g.bounds.height };
        const rs = g.snap.snapRect(moved);
        if (!e.shift || Math.abs(delta.x) > Math.abs(delta.y)) delta.x += rs.dx;
        if (!e.shift || Math.abs(delta.y) >= Math.abs(delta.x)) delta.y += rs.dy;
        snapLines = { point: e.world, snappedX: rs.dx !== 0, snappedY: rs.dy !== 0, snappedPoint: false, lines: rs.lines, points: [] };
      }
      const m = translate(delta.x, delta.y);
      lastAppliedMatrix = m;
      s.replaceDoc(applyMatrixToSelection(g.base, g.ids, m));
      ctx.setSnapGuides(snapLines);
      useOverlayStore.getState().setHud({ screen: e.screen, text: `ΔX: ${formatLength(delta.x, s.prefs.units)}\nΔY: ${formatLength(delta.y, s.prefs.units)}` });
      return;
    }
    if (g.kind === 'scale') {
      const b = g.frame.bounds;
      const useCenter = e.alt;
      const fixed = useCenter ? g.frame.center : handlePoint(b, oppositeHandle(g.handle));
      const hp = handlePoint(b, g.handle);
      let p = e.world;
      if (!e.primary) {
        const sr = g.snap.snap(p);
        p = sr.point;
        ctx.setSnapGuides(sr);
      }
      const hasX = g.handle.includes('e') || g.handle.includes('w');
      const hasY = g.handle.includes('n') || g.handle.includes('s');
      const denomX = hp.x - fixed.x;
      const denomY = hp.y - fixed.y;
      let sx = hasX && Math.abs(denomX) > 1e-9 ? (p.x - fixed.x) / denomX : 1;
      let sy = hasY && Math.abs(denomY) > 1e-9 ? (p.y - fixed.y) / denomY : 1;
      if (e.shift && hasX && hasY) {
        const u = Math.max(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx || 1) * u;
        sy = Math.sign(sy || 1) * u;
      } else if (e.shift && (hasX !== hasY)) {
        const u = hasX ? sx : sy;
        sx = u;
        sy = u;
      }
      if (!Number.isFinite(sx) || Math.abs(sx) < 1e-4) sx = 1e-4;
      if (!Number.isFinite(sy) || Math.abs(sy) < 1e-4) sy = 1e-4;
      const m = scale(sx, sy, fixed.x, fixed.y);
      lastAppliedMatrix = m;
      s.replaceDoc(applyMatrixToSelection(g.base, g.ids, m));
      useOverlayStore.getState().setHud({
        screen: e.screen,
        text: `W: ${formatLength(Math.abs(b.width * sx), s.prefs.units)}\nH: ${formatLength(Math.abs(b.height * sy), s.prefs.units)}\n${Math.round(Math.abs(sx) * 100)}% × ${Math.round(Math.abs(sy) * 100)}%`,
      });
      return;
    }
    if (g.kind === 'rotate') {
      const c = g.frame.center;
      let ang = Math.atan2(e.world.y - c.y, e.world.x - c.x) - g.startAngle;
      let deg = (ang * 180) / Math.PI;
      if (e.shift) deg = Math.round(deg / 15) * 15;
      const m = rotate(deg, c.x, c.y);
      lastAppliedMatrix = m;
      s.replaceDoc(applyMatrixToSelection(g.base, g.ids, m));
      useOverlayStore.getState().setHud({ screen: e.screen, text: `∠ ${deg.toFixed(1)}°` });
      ctx.setCursor('alias');
      return;
    }
  },

  onPointerUp(e, ctx) {
    const s = ctx.state;
    const g = gesture;
    setGesture({ kind: 'none' });
    ctx.setSnapGuides(null);
    useOverlayStore.getState().setHud(null);
    useOverlayStore.getState().setMarquee(null);
    if (g.kind === 'pending') {
      // click without drag
      if (e.shift && g.wasSelected && !g.toggled && g.hitId) {
        s.removeFromSelection([g.hitId]);
      } else if (!e.shift && g.hitId && g.wasSelected && s.selection.length > 1) {
        s.setSelection([g.hitId]);
      }
      return;
    }
    if (g.kind === 'marquee') {
      const r = rectFromPoints(g.start, e.world);
      if (r.width < 1 && r.height < 1) return;
      const ids = nodesInRect(s.doc, r, { isolation: s.isolationId });
      if (g.add) s.addToSelection(ids);
      else s.setSelection(ids);
      return;
    }
    if (g.kind === 'move') {
      finalize(ctx, g.duplicated ? 'Duplicate' : 'Move', g.ids, null);
      ctx.setCursor('default');
      return;
    }
    if (g.kind === 'scale') {
      finalize(ctx, 'Scale', g.ids, lastAppliedMatrix);
      ctx.setCursor('default');
      return;
    }
    if (g.kind === 'rotate') {
      finalize(ctx, 'Rotate', g.ids, null);
      ctx.setCursor('default');
      return;
    }
  },

  onDoubleClick(e, ctx) {
    const s = ctx.state;
    const hit = ctx.hitTest(e.world);
    if (!hit) {
      if (s.isolationId) {
        // step out one level
        const parent = s.doc.nodes[s.isolationId]?.parent;
        const pn = parent ? s.doc.nodes[parent] : undefined;
        s.setIsolation(pn && pn.type === 'group' ? parent! : null);
      }
      return;
    }
    const target = s.doc.nodes[hit.target];
    if (!target) return;
    if (target.type === 'group') {
      s.setIsolation(target.id);
      s.setSelection([hit.id]);
      return;
    }
    if (target.type === 'text') {
      s.setSelection([target.id]);
      s.setTool('text');
      s.setEditingText(target.id);
      return;
    }
    if (target.type === 'path') {
      s.setSelection([target.id]);
      s.setTool('direct');
    }
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (gesture.kind !== 'none') {
        this.cancel!(ctx);
        return true;
      }
      const s = ctx.state;
      if (s.isolationId) {
        const parent = s.doc.nodes[s.isolationId]?.parent;
        const pn = parent ? s.doc.nodes[parent] : undefined;
        s.setIsolation(pn && pn.type === 'group' ? parent! : null);
        return true;
      }
      if (s.selection.length) {
        s.clearSelection();
        return true;
      }
    }
    if (e.key === 'Enter' && ctx.state.selection.length) {
      runCommand('object.transformDialog');
      return true;
    }
    return false;
  },

  onModifiers(e, ctx) {
    void e;
    void ctx;
  },
};

function SelectOptions() {
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const isolation = useStore((s) => s.isolationId);
  const doc = useStore((s) => s.doc);
  const count = selection.length;
  const desc = count === 0 ? 'No selection' : count === 1 ? `${doc.nodes[selection[0]]?.name ?? 'Object'}` : `${count} objects`;
  return (
    <Row gap={10}>
      <span className="muted" style={{ minWidth: 90 }}>
        {desc}
      </span>
      <Checkbox checked={view.showBounds} onChange={(v) => setView({ showBounds: v })} label="Bounding box" />
      <Checkbox checked={view.smartGuides} onChange={(v) => setView({ smartGuides: v })} label="Smart guides" />
      <Checkbox checked={view.snapToPoint} onChange={(v) => setView({ snapToPoint: v })} label="Snap to point" />
      {isolation && (
        <Button small onClick={() => getState().setIsolation(null)}>
          Exit isolation
        </Button>
      )}
      {count > 0 && (
        <>
          <Button small onClick={() => runCommand('object.group')} disabled={count < 1}>
            Group
          </Button>
          <Button small onClick={() => runCommand('object.transformDialog')}>
            Transform…
          </Button>
        </>
      )}
    </Row>
  );
}

export const tool = selectTool;
void React;
void add;
void invert;
void constrainAngle;
void worldMatrix;
void layerOf;
