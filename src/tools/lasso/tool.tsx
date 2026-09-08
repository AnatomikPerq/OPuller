/**
 * Lasso tool (Q): freehand-drag a lasso. With selected paths it selects the
 * anchors inside the lasso; with nothing selected it selects objects whose
 * bounds centre lies inside. Shift adds, Alt subtracts.
 */
import React from 'react';
import { Lasso } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, Vec } from '@/model/types';
import { useStore } from '@/store/store';
import { selectableNodes, getChildren, worldBounds } from '@/model/document';
import { Row, Checkbox } from '@/ui/widgets';
import { runCommand } from '@/commands/registry';
import { anchorsInPolygon, anchorSet, anchorKey, editablePathIds, pointInPolygon } from '../pathEditing/anchors';
import { lassoCursor } from '../pathEditing/cursors';
import { directDelegate } from '../direct/tool';
import { HL } from '../pathEditing/overlay';
import { useToolOptions } from '@/canvas/toolContext';

let points: Vec[] | null = null;
let lastScreen: Vec | null = null;

function cursorFor(shift: boolean, alt: boolean): string {
  return lassoCursor(alt ? 'subtract' : shift ? 'add' : 'none');
}

function objectCandidates(ctx: ToolContext): ID[] {
  const s = ctx.state;
  if (s.isolationId && s.doc.nodes[s.isolationId]) {
    return getChildren(s.doc, s.isolationId).filter((id) => {
      const n = s.doc.nodes[id];
      return !!n && n.visible && !n.locked;
    });
  }
  return selectableNodes(s.doc, false);
}

function objectsInside(ctx: ToolContext, poly: Vec[]): ID[] {
  const out: ID[] = [];
  for (const id of objectCandidates(ctx)) {
    const b = worldBounds(ctx.doc, id);
    if (!b) continue;
    if (pointInPolygon({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, poly)) out.push(id);
  }
  return out;
}

function apply(ctx: ToolContext, poly: Vec[], shift: boolean, alt: boolean) {
  const s = ctx.state;
  const opts = ctx.options<{ objectsFallback: boolean }>();
  const pathIds = editablePathIds(s.doc, s.selection);
  const fallback = opts.objectsFallback !== false;
  if (pathIds.length) {
    const refs = anchorsInPolygon(s.doc, pathIds, poly);
    if (alt) {
      if (refs.length || !fallback) {
        const del = anchorSet(refs);
        s.setSelectedAnchors(s.selectedAnchors.filter((r) => !del.has(anchorKey(r))));
        ctx.setStatus(`${refs.length} anchor${refs.length === 1 ? '' : 's'} deselected`);
      } else {
        const objs = objectsInside(ctx, poly).filter((id) => s.selection.includes(id));
        s.setSelection(
          s.selection.filter((id) => !objs.includes(id)),
          s.selectedAnchors.filter((r) => !objs.includes(r.nodeId)),
        );
        ctx.setStatus(`${objs.length} object${objs.length === 1 ? '' : 's'} deselected`);
      }
      return;
    }
    if (shift) {
      if (refs.length || !fallback) {
        const have = anchorSet(s.selectedAnchors);
        s.setSelectedAnchors(s.selectedAnchors.concat(refs.filter((r) => !have.has(anchorKey(r)))));
        ctx.setStatus(`${refs.length} anchor${refs.length === 1 ? '' : 's'} added`);
      } else {
        // no anchors of the selected paths inside: add the enclosed objects instead
        const objs = objectsInside(ctx, poly).filter((id) => !s.selection.includes(id));
        s.setSelection(s.selection.concat(objs), s.selectedAnchors);
        ctx.setStatus(`${objs.length} object${objs.length === 1 ? '' : 's'} added`);
      }
      return;
    }
    if (refs.length || !fallback) {
      s.setSelection(s.selection, refs);
      ctx.setStatus(`${refs.length} anchor${refs.length === 1 ? '' : 's'} selected`);
      return;
    }
    // nothing of the selected paths inside: fall back to object selection
    const objs = objectsInside(ctx, poly);
    s.setSelection(objs, []);
    ctx.setStatus(objs.length ? `${objs.length} object${objs.length === 1 ? '' : 's'} selected` : 'Nothing inside the lasso');
    return;
  }
  const ids = objectsInside(ctx, poly);
  if (alt) s.removeFromSelection(ids);
  else if (shift) s.addToSelection(ids);
  else s.setSelection(ids, []);
  ctx.setStatus(`${ids.length} object${ids.length === 1 ? '' : 's'} ${alt ? 'deselected' : 'selected'}`);
}

function LassoOptions() {
  const [opts, set] = useToolOptions<{ objectsFallback: boolean }>('lasso');
  const anchors = useStore((s) => s.selectedAnchors.length);
  const sel = useStore((s) => s.selection.length);
  return (
    <Row gap={8} className="pe-options">
      <span className="pe-status small">{anchors ? `${anchors} anchor${anchors > 1 ? 's' : ''} selected` : sel ? `${sel} object${sel > 1 ? 's' : ''} selected` : 'No selection'}</span>
      <Checkbox checked={opts.objectsFallback !== false} onChange={(v) => set({ objectsFallback: v })} label="Select objects when no anchors are inside" />
      <span className="pe-kbd-hint">Shift: add · Alt: subtract · selected paths → anchors, otherwise objects</span>
    </Row>
  );
}

export const lassoTool: Tool = {
  id: 'lasso',
  name: 'Lasso Tool',
  shortcut: 'q',
  icon: Lasso,
  group: 'select',
  order: 12,
  cursor: lassoCursor('none'),
  hint: 'Drag a freehand lasso around anchors (of selected paths) or objects. Shift adds, Alt subtracts.',
  showSelectionOverlay: 'anchors',
  defaults: { objectsFallback: true },
  Options: LassoOptions,
  activate(ctx) {
    points = null;
    ctx.setCursor(lassoCursor('none'));
  },
  deactivate(ctx) {
    points = null;
    ctx.requestOverlay();
  },
  isBusy: () => !!points,
  cancel(ctx) {
    points = null;
    ctx.requestOverlay();
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    points = [e.world];
    lastScreen = e.screen;
    ctx.setCursor(cursorFor(e.shift, e.alt));
    ctx.requestOverlay();
  },
  onPointerMove(e, ctx) {
    ctx.setCursor(cursorFor(e.shift, e.alt));
    if (!points) return;
    if (lastScreen && Math.hypot(e.screen.x - lastScreen.x, e.screen.y - lastScreen.y) < 2) return;
    lastScreen = e.screen;
    points.push(e.world);
    ctx.requestOverlay();
  },
  onPointerUp(e, ctx) {
    const poly = points;
    points = null;
    ctx.requestOverlay();
    if (!poly) return;
    if (poly.length < 3) {
      if (!e.shift && !e.alt) ctx.state.clearSelection();
      return;
    }
    apply(ctx, poly, e.shift, e.alt);
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && points) {
      points = null;
      ctx.requestOverlay();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && ctx.state.selectedAnchors.length) {
      runCommand('path.deleteAnchors');
      return true;
    }
    return directDelegate.keyDown(e, ctx);
  },
  onModifiers(e, ctx) {
    ctx.setCursor(cursorFor(e.shift, e.alt));
  },
  renderOverlay(ctx) {
    if (!points || points.length < 2) return null;
    const pts = points.map((p) => ctx.worldToScreen(p));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
    return (
      <g className="lasso-overlay" pointerEvents="none">
        <path d={d + 'Z'} fill="rgba(74,144,226,0.08)" stroke="none" />
        <path d={d} fill="none" stroke={HL} strokeWidth={1} strokeDasharray="4 3" />
        <line x1={pts[pts.length - 1].x} y1={pts[pts.length - 1].y} x2={pts[0].x} y2={pts[0].y} stroke={HL} strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />
      </g>
    );
  },
};

export const tool = lassoTool;
void React;
