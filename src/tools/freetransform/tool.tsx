/**
 * Free Transform tool (E): bounding-box handles.
 *  - corners scale (Shift: uniform), edges scale one axis
 *  - dragging just outside a corner rotates (Shift: constrained angles)
 *  - Ctrl-drag an edge shears
 *  - Alt: scale / shear from the center; Alt-drag inside: move a copy
 *  - drag inside the box moves the selection (Shift: constrain, snapping)
 */
import React from 'react';
import type { Rect, Vec } from '@/model/types';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import { getSelectionFrame, hitHandle, handlePoint, oppositeHandle, rotateCursor, type HandleKind, type SelectionFrame } from '@/canvas/selectionHandles';
import { constrainDelta, type SnapSession } from '@/canvas/snap';
import { rotate, scale, translate } from '@/geometry/matrix';
import { formatLength } from '@/util/units';
import { useStore } from '@/store/store';
import { Checkbox, Row } from '@/ui/widgets';
import { type Gesture, beginGesture, updateGesture, finishGesture, cancelGesture, setGestureCopy, setHud, clearHud, PivotMarker, GuideLine } from '@/transform/gesture';
import { transformTargets } from '@/transform/apply';
import { aboutPoint, normalizeAngle, snapAngle } from '@/transform/matrices';
import { Hint } from '@/transform/ToolOptions';
import '@/transform/transform.css';

export function FreeTransformIcon({ size = 18, className, strokeWidth = 1.75 }: { size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="5" y="5" width="14" height="14" strokeDasharray="3 2" />
      <rect x="3" y="3" width="4" height="4" fill="currentColor" stroke="none" />
      <rect x="17" y="3" width="4" height="4" fill="currentColor" stroke="none" />
      <rect x="3" y="17" width="4" height="4" fill="currentColor" stroke="none" />
      <rect x="17" y="17" width="4" height="4" fill="currentColor" stroke="none" />
    </svg>
  );
}

type Mode =
  | { kind: 'none' }
  | { kind: 'pending'; start: Vec; startScreen: Vec }
  | { kind: 'move'; g: Gesture; bounds: Rect; snap: SnapSession; last: ToolPointerEvent }
  | { kind: 'scale'; g: Gesture; frame: SelectionFrame; handle: HandleKind; snap: SnapSession; last: ToolPointerEvent }
  | { kind: 'rotate'; g: Gesture; frame: SelectionFrame; startAngle: number; last: ToolPointerEvent }
  | { kind: 'shear'; g: Gesture; frame: SelectionFrame; handle: HandleKind; last: ToolPointerEvent };

let mode: Mode = { kind: 'none' };

function FreeTransformOptions() {
  const showBounds = useStore((s) => s.view.showBounds);
  const setView = useStore((s) => s.setView);
  const selection = useStore((s) => s.selection);
  return (
    <Row gap={8} className="transform-tool-options">
      <span className="muted" style={{ minWidth: 80 }}>
        {selection.length ? `${selection.length} object${selection.length > 1 ? 's' : ''}` : 'No selection'}
      </span>
      <Checkbox checked={showBounds} onChange={(v) => setView({ showBounds: v })} label="Bounding box" />
      <Hint>Corners: scale (Shift: uniform) · Edges: scale one axis · Outside corners: rotate · Ctrl-drag edge: shear · Alt: from center</Hint>
    </Row>
  );
}

function update(e: ToolPointerEvent, ctx: ToolContext) {
  const s = ctx.state;
  const units = s.prefs.units;
  const m = mode;
  if (m.kind === 'move') {
    m.last = e;
    setGestureCopy(m.g, ctx, e.alt);
    let delta = { x: e.world.x - m.g.start.x, y: e.world.y - m.g.start.y };
    if (e.shift) delta = constrainDelta(delta, 45);
    let snapLines: ReturnType<SnapSession['snap']> | null = null;
    if (!e.primary) {
      const moved: Rect = { x: m.bounds.x + delta.x, y: m.bounds.y + delta.y, width: m.bounds.width, height: m.bounds.height };
      const rs = m.snap.snapRect(moved);
      if (!e.shift || Math.abs(delta.x) > Math.abs(delta.y)) delta.x += rs.dx;
      if (!e.shift || Math.abs(delta.y) >= Math.abs(delta.x)) delta.y += rs.dy;
      snapLines = { point: e.world, snappedX: rs.dx !== 0, snappedY: rs.dy !== 0, snappedPoint: false, lines: rs.lines, points: [] };
    }
    updateGesture(m.g, ctx, translate(delta.x, delta.y));
    ctx.setSnapGuides(snapLines);
    setHud(e.screen, `ΔX: ${formatLength(delta.x, units)}\nΔY: ${formatLength(delta.y, units)}`);
    return;
  }
  if (m.kind === 'scale') {
    m.last = e;
    const b = m.frame.bounds;
    const fixed = e.alt ? m.frame.center : handlePoint(b, oppositeHandle(m.handle));
    m.g.pivot = fixed;
    const hp = handlePoint(b, m.handle);
    let p = e.world;
    if (!e.primary) {
      const sr = m.snap.snap(p);
      p = sr.point;
      ctx.setSnapGuides(sr);
    }
    const hasX = m.handle.includes('e') || m.handle.includes('w');
    const hasY = m.handle.includes('n') || m.handle.includes('s');
    const denomX = hp.x - fixed.x;
    const denomY = hp.y - fixed.y;
    let sx = hasX && Math.abs(denomX) > 1e-9 ? (p.x - fixed.x) / denomX : 1;
    let sy = hasY && Math.abs(denomY) > 1e-9 ? (p.y - fixed.y) / denomY : 1;
    if (e.shift && hasX && hasY) {
      const u = Math.max(Math.abs(sx), Math.abs(sy));
      sx = Math.sign(sx || 1) * u;
      sy = Math.sign(sy || 1) * u;
    } else if (e.shift && hasX !== hasY) {
      const u = hasX ? sx : sy;
      sx = u;
      sy = u;
    }
    if (!Number.isFinite(sx) || Math.abs(sx) < 1e-4) sx = 1e-4;
    if (!Number.isFinite(sy) || Math.abs(sy) < 1e-4) sy = 1e-4;
    updateGesture(m.g, ctx, scale(sx, sy, fixed.x, fixed.y));
    setHud(e.screen, `W: ${formatLength(Math.abs(b.width * sx), units)}\nH: ${formatLength(Math.abs(b.height * sy), units)}\n${Math.round(Math.abs(sx) * 100)}% × ${Math.round(Math.abs(sy) * 100)}%`);
    return;
  }
  if (m.kind === 'rotate') {
    m.last = e;
    const c = m.frame.center;
    let deg = ((Math.atan2(e.world.y - c.y, e.world.x - c.x) - m.startAngle) * 180) / Math.PI;
    if (e.shift) deg = snapAngle(deg, s.prefs.constrainAngle || 45);
    updateGesture(m.g, ctx, rotate(deg, c.x, c.y));
    setHud(e.screen, `∠ ${normalizeAngle(-deg).toFixed(1)}°`);
    return;
  }
  if (m.kind === 'shear') {
    m.last = e;
    const b = m.frame.bounds;
    const fixed = e.alt ? m.frame.center : handlePoint(b, oppositeHandle(m.handle));
    m.g.pivot = fixed;
    const hp = handlePoint(b, m.handle);
    const horizontal = m.handle === 'n' || m.handle === 's';
    let kx = 0;
    let ky = 0;
    if (horizontal) {
      const denom = hp.y - fixed.y;
      kx = Math.abs(denom) > 1e-9 ? (e.world.x - m.g.start.x) / denom : 0;
    } else {
      const denom = hp.x - fixed.x;
      ky = Math.abs(denom) > 1e-9 ? (e.world.y - m.g.start.y) / denom : 0;
    }
    kx = Math.max(-57, Math.min(57, kx));
    ky = Math.max(-57, Math.min(57, ky));
    updateGesture(m.g, ctx, aboutPoint({ a: 1, b: ky, c: kx, d: 1, e: 0, f: 0 }, fixed));
    const deg = horizontal ? (-Math.atan(kx) * 180) / Math.PI : (-Math.atan(ky) * 180) / Math.PI;
    setHud(e.screen, `Shear ${deg.toFixed(1)}° (${horizontal ? 'horizontal' : 'vertical'})`);
  }
}

function hoverCursor(ctx: ToolContext, e: ToolPointerEvent) {
  const s = ctx.state;
  const frame = getSelectionFrame(s);
  const hh = s.view.showBounds ? hitHandle(frame, e.screen, s.prefs.handleSize) : null;
  if (hh && frame) {
    if (hh.rotate) ctx.setCursor(rotateCursor(hh.kind));
    else if (e.primary && hh.kind.length === 1) ctx.setCursor(hh.kind === 'n' || hh.kind === 's' ? 'ew-resize' : 'ns-resize');
    else ctx.setCursor(frame.handles.find((h) => h.kind === hh.kind)!.cursor);
    s.setHover(null);
    return;
  }
  const hit = ctx.hitTest(e.world);
  s.setHover(hit ? hit.target : null);
  ctx.setCursor(hit ? 'move' : 'default');
}

export const tool: Tool = {
  id: 'freetransform',
  name: 'Free Transform Tool',
  shortcut: 'e',
  icon: FreeTransformIcon,
  group: 'transform',
  order: 504,
  cursor: 'default',
  hint: 'Drag corners to scale (Shift: uniform), just outside corners to rotate, Ctrl-drag edges to shear. Alt: from center.',
  showSelectionOverlay: true,
  Options: FreeTransformOptions,

  activate() {
    mode = { kind: 'none' };
  },
  deactivate(ctx) {
    if (mode.kind !== 'none' && mode.kind !== 'pending') cancelGesture(mode.g, ctx);
    mode = { kind: 'none' };
    clearHud();
    ctx.setSnapGuides(null);
  },
  isBusy: () => mode.kind !== 'none' && mode.kind !== 'pending',
  cancel(ctx) {
    if (mode.kind !== 'none' && mode.kind !== 'pending') cancelGesture(mode.g, ctx);
    mode = { kind: 'none' };
    clearHud();
    ctx.setSnapGuides(null);
    ctx.setCursor('default');
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const frame = getSelectionFrame(s);
    const hh = frame && s.view.showBounds ? hitHandle(frame, e.screen, s.prefs.handleSize) : null;
    if (hh && frame) {
      const ids = transformTargets(s);
      if (!ids.length) return;
      if (hh.rotate) {
        const g = beginGesture(ctx, e.world, frame.center, ids);
        mode = { kind: 'rotate', g, frame, startAngle: Math.atan2(e.world.y - frame.center.y, e.world.x - frame.center.x), last: e };
        ctx.setCursor(rotateCursor(hh.kind));
      } else if (e.primary && hh.kind.length === 1) {
        const g = beginGesture(ctx, e.world, handlePoint(frame.bounds, oppositeHandle(hh.kind)), ids);
        mode = { kind: 'shear', g, frame, handle: hh.kind, last: e };
      } else {
        const g = beginGesture(ctx, e.world, handlePoint(frame.bounds, oppositeHandle(hh.kind)), ids);
        mode = { kind: 'scale', g, frame, handle: hh.kind, snap: ctx.beginSnap({ exclude: ids }), last: e };
      }
      return;
    }
    const hit = ctx.hitTest(e.world);
    if (hit) {
      const selected = s.selection.includes(hit.target);
      if (!selected) {
        if (e.shift) s.addToSelection([hit.target]);
        else s.setSelection([hit.target]);
      }
      mode = { kind: 'pending', start: e.world, startScreen: e.screen };
      return;
    }
    if (!e.shift) s.clearSelection();
    mode = { kind: 'none' };
  },

  onPointerMove(e, ctx) {
    if (mode.kind === 'none') {
      hoverCursor(ctx, e);
      return;
    }
    if (mode.kind === 'pending') {
      if (Math.hypot(e.screen.x - mode.startScreen.x, e.screen.y - mode.startScreen.y) < 3) return;
      const s = ctx.state;
      const ids = transformTargets(s);
      if (!ids.length) {
        mode = { kind: 'none' };
        return;
      }
      const frame = getSelectionFrame(s, ids);
      const center = frame?.center ?? mode.start;
      const g = beginGesture(ctx, mode.start, center, ids);
      const bounds = frame?.bounds ?? { x: mode.start.x, y: mode.start.y, width: 0, height: 0 };
      mode = { kind: 'move', g, bounds, snap: ctx.beginSnap({ exclude: ids }), last: e };
      ctx.setCursor('move');
    }
    update(e, ctx);
    ctx.requestOverlay();
  },

  onPointerUp(_e, ctx) {
    const m = mode;
    mode = { kind: 'none' };
    ctx.setSnapGuides(null);
    clearHud();
    if (m.kind === 'none' || m.kind === 'pending') return;
    const label = m.kind === 'move' ? 'Move' : m.kind === 'scale' ? 'Scale' : m.kind === 'rotate' ? 'Rotate' : 'Shear';
    finishGesture(m.g, ctx, label);
    ctx.setCursor('default');
    ctx.requestOverlay();
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (mode.kind !== 'none') {
        tool.cancel!(ctx);
        return true;
      }
      if (ctx.state.selection.length) {
        ctx.state.clearSelection();
        return true;
      }
    }
    if (e.key === 'Enter' && ctx.state.selection.length && mode.kind === 'none') {
      ctx.state.openDialog('transform', { tab: 'scale' });
      return true;
    }
    return false;
  },

  onModifiers(e, ctx) {
    if (mode.kind === 'none' || mode.kind === 'pending') return;
    const last = mode.last;
    update({ ...last, shift: e.shift, alt: e.alt, ctrl: e.ctrl, meta: e.meta, primary: e.primary }, ctx);
    ctx.requestOverlay();
  },

  renderOverlay(ctx) {
    const m = mode;
    if (m.kind === 'rotate' || m.kind === 'shear' || m.kind === 'scale') {
      const p = ctx.worldToScreen(m.g.pivot);
      const cur = ctx.worldToScreen(m.last.world);
      return (
        <g className="freetransform-overlay">
          {m.kind === 'rotate' && <GuideLine from={p} to={cur} />}
          <PivotMarker x={p.x} y={p.y} active />
        </g>
      );
    }
    return null;
  },
};

void React;
