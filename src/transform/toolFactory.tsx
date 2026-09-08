/**
 * Factory for the pivot-based transform tools (Rotate, Scale, Reflect, Shear).
 *
 * Interaction model (Illustrator):
 *  - click sets the reference point (snapped), Alt-click opens the tool dialog
 *  - drag transforms the selection around the reference point (live preview),
 *    Alt-drag transforms a copy, Shift constrains, Escape cancels
 *  - pointer-up commits exactly one history step and records the transform
 *    for "Transform Again"
 */
import React, { type ComponentType, type ReactNode } from 'react';
import type { Matrix, Vec, ID, Rect } from '@/model/types';
import type { Tool, ToolContext, ToolPointerEvent, ToolKeyEvent } from '@/tools/types';
import { selectionBounds } from '@/model/document';
import { dist } from '@/geometry/vec';
import { getState } from '@/store/store';
import {
  type Gesture,
  beginGesture,
  updateGesture,
  finishGesture,
  cancelGesture,
  setGestureCopy,
  currentPivot,
  setToolPivot,
  resetToolPivot,
  ensureTargets,
  setHud,
  clearHud,
  PivotMarker,
} from './gesture';
import { applyTransform, transformTargets } from './apply';
import { recordMatrixTransform } from './again';

export interface DragInfo {
  gesture: Gesture;
  /** world bounds of the original selection at drag start */
  bounds: Rect;
  /** last pointer position (world) */
  pointer: Vec;
  event: ToolPointerEvent;
}

export interface TransformToolSpec {
  id: string;
  name: string;
  shortcut?: string;
  icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  order: number;
  hint: string;
  /** dialog type opened by Alt-click */
  dialog: string;
  /** history label */
  label: string;
  Options?: ComponentType;
  /** matrix for the current drag */
  matrix(info: DragInfo, ctx: ToolContext): { m: Matrix; hud: string };
  /** extra screen-space overlay while dragging */
  overlay?(info: DragInfo, ctx: ToolContext): ReactNode;
  /** two-click mode (Reflect): a second click after setting the pivot performs the transform */
  clickTransform?(pivot: Vec, p: Vec, e: ToolPointerEvent, ctx: ToolContext): Matrix | null;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; start: Vec; startScreen: Vec; alt: boolean; ids: ID[]; pivot: Vec }
  | { kind: 'drag'; info: DragInfo; ids: ID[] };

export function makeTransformTool(spec: TransformToolSpec): Tool {
  let mode: Mode = { kind: 'idle' };
  /** a reference point was set by a click (two-click flows) */
  let armed = false;
  let altDown = false;

  const update = (e: ToolPointerEvent, ctx: ToolContext) => {
    if (mode.kind !== 'drag') return;
    const info = mode.info;
    setGestureCopy(info.gesture, ctx, e.alt);
    info.pointer = e.world;
    info.event = e;
    const { m, hud } = spec.matrix(info, ctx);
    updateGesture(info.gesture, ctx, m);
    setHud(e.screen, hud);
    ctx.requestOverlay();
  };

  const reset = (ctx: ToolContext) => {
    mode = { kind: 'idle' };
    clearHud();
    ctx.setSnapGuides(null);
    ctx.setCursor(altDown ? 'copy' : 'crosshair');
  };

  const tool: Tool = {
    id: spec.id,
    name: spec.name,
    shortcut: spec.shortcut,
    icon: spec.icon,
    group: 'transform',
    order: spec.order,
    cursor: 'crosshair',
    hint: spec.hint,
    Options: spec.Options,
    showSelectionOverlay: 'anchors',

    activate(ctx) {
      mode = { kind: 'idle' };
      armed = false;
      resetToolPivot();
      ctx.setCursor('crosshair');
      const s = ctx.state;
      if (!s.selection.length) ctx.setStatus(`${spec.name}: select an object first`);
    },
    deactivate(ctx) {
      if (mode.kind === 'drag') cancelGesture(mode.info.gesture, ctx);
      mode = { kind: 'idle' };
      armed = false;
      clearHud();
      ctx.setSnapGuides(null);
    },
    isBusy: () => mode.kind === 'drag',
    cancel(ctx) {
      if (mode.kind === 'drag') cancelGesture(mode.info.gesture, ctx);
      reset(ctx);
    },

    onPointerDown(e, ctx) {
      if (e.button !== 0) return;
      const ids = ensureTargets(ctx, e.world);
      if (!ids.length) {
        ctx.setStatus(`${spec.name}: select an object first`);
        return;
      }
      const s = ctx.state;
      const pivot = currentPivot(s, ids);
      if (!pivot) return;
      mode = { kind: 'pending', start: e.world, startScreen: e.screen, alt: e.alt, ids, pivot };
    },

    onPointerMove(e, ctx) {
      if (mode.kind === 'idle') {
        ctx.setCursor(e.alt ? 'copy' : 'crosshair');
        return;
      }
      if (mode.kind === 'pending') {
        if (Math.hypot(e.screen.x - mode.startScreen.x, e.screen.y - mode.startScreen.y) < 3) return;
        const g = beginGesture(ctx, mode.start, mode.pivot, mode.ids);
        const bounds = selectionBounds(g.original, g.originalIds) ?? { x: mode.start.x, y: mode.start.y, width: 0, height: 0 };
        mode = { kind: 'drag', ids: mode.ids, info: { gesture: g, bounds, pointer: e.world, event: e } };
      }
      update(e, ctx);
    },

    onPointerUp(e, ctx) {
      if (mode.kind === 'pending') {
        const { ids, pivot, alt } = mode;
        mode = { kind: 'idle' };
        const snapped = ctx.snap(e.world).point;
        const tol = ctx.tolerance() * 1.5;
        const onPivot = dist(snapped, pivot) <= tol;
        if (spec.clickTransform && armed && !onPivot) {
          // second click: transform across pivot → click
          const m = spec.clickTransform(pivot, snapped, e, ctx);
          armed = false;
          if (m) {
            const s = getState();
            const bounds = selectionBounds(s.doc, ids);
            applyTransform(m, { label: alt ? `${spec.label} Copy` : spec.label, copy: alt, ids });
            recordMatrixTransform(spec.label, m, { kind: 'absolute', point: pivot }, alt, bounds);
          }
          ctx.setSnapGuides(null);
          return;
        }
        setToolPivot(snapped, ids);
        armed = true;
        if (alt) getState().openDialog(spec.dialog, { pivot: snapped });
        ctx.setSnapGuides(null);
        ctx.requestOverlay();
        return;
      }
      if (mode.kind === 'drag') {
        const info = mode.info;
        finishGesture(info.gesture, ctx, spec.label);
        armed = false;
        reset(ctx);
        ctx.requestOverlay();
      }
    },

    onKeyDown(e: ToolKeyEvent, ctx) {
      if (e.key === 'Escape') {
        if (mode.kind !== 'idle') {
          tool.cancel!(ctx);
          return true;
        }
        if (armed) {
          armed = false;
          return true;
        }
      }
      if (e.key === 'Enter' && mode.kind === 'idle' && ctx.state.selection.length) {
        const ids = transformTargets(ctx.state);
        const pivot = currentPivot(ctx.state, ids);
        getState().openDialog(spec.dialog, pivot ? { pivot } : {});
        return true;
      }
      return false;
    },

    onModifiers(e, ctx) {
      altDown = e.alt;
      if (mode.kind === 'drag') {
        const last = mode.info.event;
        update({ ...last, shift: e.shift, alt: e.alt, ctrl: e.ctrl, meta: e.meta, primary: e.primary }, ctx);
        return;
      }
      ctx.setCursor(e.alt ? 'copy' : 'crosshair');
    },

    renderOverlay(ctx) {
      const s = ctx.state;
      if (mode.kind === 'drag') {
        const info = mode.info;
        const p = ctx.worldToScreen(info.gesture.pivot);
        return (
          <g className={`transform-tool-overlay ${spec.id}`}>
            {spec.overlay?.(info, ctx)}
            <PivotMarker x={p.x} y={p.y} active />
          </g>
        );
      }
      const ids = transformTargets(s);
      if (!ids.length) return null;
      const pivot = currentPivot(s, ids);
      if (!pivot) return null;
      const p = ctx.worldToScreen(pivot);
      return (
        <g className={`transform-tool-overlay ${spec.id}`}>
          <PivotMarker x={p.x} y={p.y} />
        </g>
      );
    },
  };
  return tool;
}
