/**
 * Type tool (T): click for point text, drag for area text, click an open path for
 * type on a path, click existing text to edit it inline. Keyboard editing follows
 * the usual conventions (Shift extends, Ctrl/Alt jumps words, Home/End, Ctrl+A,
 * Escape commits and returns to the Selection tool).
 */
import React from 'react';
import { Type } from 'lucide-react';
import { produce } from 'immer';
import type { Tool, ToolPointerEvent, ToolContext, HitResult } from '../types';
import type { Document, ID, Vec, TextNode, PathNode, Paint, Rect } from '@/model/types';
import { getState } from '@/store/store';
import { makeText, clonePaint } from '@/model/nodes';
import { noStroke } from '@/model/defaults';
import { addNode, worldMatrix, indexInParent, isEditable } from '@/model/document';
import { invert, applyToPoint, translate, identity, multiply } from '@/geometry/matrix';
import { rectFromPoints, rectContainsPoint } from '@/geometry/vec';
import { nearestPointOnPath } from '@/geometry/path';
import { useOverlayStore } from '@/canvas/overlayStore';
import type { SnapSession } from '@/canvas/snap';
import { insertionParent } from '@/tools/shapes/tool';
import { IS_MAC } from '@/util/keys';
import { formatLength } from '@/util/units';
import { layoutText, indexAtPoint, indexAtLineX } from '@/text/layout';
import { wordRangeAt, paragraphRangeAt } from '@/text/editing';
import { pathTextSampler, pathTextStart, layoutFor } from '@/text/outline';
import {
  useTextEdit,
  startEditing,
  finishEditing,
  setCaret,
  insertText,
  deleteBackward,
  deleteForward,
  moveCaret,
  selectAll,
  undoWhileEditing,
  redoWhileEditing,
  focusInput,
  editingNode,
} from './session';
import { hitFrameHandle, frameCursor, type FrameHandle } from './frame';
import { TextOptions } from './TextOptions';
import './text.css';

type Gesture =
  | { kind: 'none' }
  | { kind: 'createPending'; start: Vec; startScreen: Vec; snap: SnapSession }
  | { kind: 'createArea'; start: Vec; snap: SnapSession }
  | { kind: 'selectDrag'; id: ID; anchor: number }
  | { kind: 'resizeBox'; id: ID; handle: FrameHandle; base: Document; startLocal: Vec; startBox: { width: number; height: number } };

let gesture: Gesture = { kind: 'none' };

function localPoint(doc: Document, id: ID, world: Vec): Vec {
  return applyToPoint(invert(worldMatrix(doc, id)), world);
}

/**
 * Character index for a world point on a text node. With `clamp` the nearest
 * index is returned even when the point is outside the text; otherwise null.
 */
export function indexAtWorld(doc: Document, node: TextNode, world: Vec, tolerance: number, clamp = false): number | null {
  const local = localPoint(doc, node.id, world);
  if (node.kind === 'path' && node.pathId) {
    const sampler = pathTextSampler(doc, node);
    if (!sampler) return null;
    const loc = nearestPointOnPath([sampler.subpath], local);
    if (!loc) return null;
    const layout = layoutFor(node);
    const line = layout.lines[0];
    if (!line) return null;
    const limit = Math.max(line.ascent + line.descent, node.style.fontSize) + tolerance;
    if (!clamp && loc.distance > limit) return null;
    const len = sampler.lengthAt(loc.segment, loc.t);
    const start = pathTextStart(node, layout, sampler.total);
    return indexAtLineX(line, len - start, node.text.length);
  }
  const layout = layoutText(node);
  if (!clamp && !rectContainsPoint(layout.bounds, local, tolerance)) return null;
  return indexAtPoint(layout, local, node.text.length);
}

/** Fill for new text: the current fill unless it is none/white (text defaults to black). */
function textFill(): Paint {
  const f = getState().appearance.fill;
  if (f.type === 'none') return { type: 'solid', color: '#000000', opacity: 1 };
  if (f.type === 'solid' && f.color === '#ffffff') return { type: 'solid', color: '#000000', opacity: 1 };
  return clonePaint(f);
}

function createPointText(p: Vec): void {
  const s = getState();
  const parent = insertionParent();
  if (!parent) return;
  const node = makeText('', { style: s.appearance.textStyle, transform: translate(p.x, p.y), fill: textFill(), stroke: noStroke() });
  s.updateDoc((d) => addNode(d, node, parent));
  startEditing(node.id, 0, 0);
}

function createAreaText(r: Rect): void {
  const s = getState();
  const parent = insertionParent();
  if (!parent) return;
  const node = makeText('', { kind: 'area', box: { width: r.width, height: r.height }, style: s.appearance.textStyle, transform: translate(r.x, r.y), fill: textFill(), stroke: noStroke() });
  s.updateDoc((d) => addNode(d, node, parent));
  startEditing(node.id, 0, 0);
}

function createPathText(path: PathNode, hit: HitResult): void {
  const s = getState();
  const parent = path.parent;
  const index = indexInParent(s.doc, path.id);
  const node = makeText('', { kind: 'path', pathId: path.id, style: s.appearance.textStyle, transform: identity(), fill: textFill(), stroke: noStroke() });
  node.name = 'Type on a Path';
  s.updateDoc((d) => {
    const p = d.nodes[path.id];
    if (!p || p.type !== 'path') return;
    p.data = { ...(p.data ?? {}), typeOnPath: { fill: clonePaint(p.fill), stroke: { ...p.stroke, paint: clonePaint(p.stroke.paint), dash: [...p.stroke.dash] } } };
    p.fill = { type: 'none' };
    p.stroke = { ...p.stroke, paint: { type: 'none' } };
    addNode(d, node, parent, index + 1);
    // start the text where the path was clicked
    const nn = d.nodes[node.id] as TextNode;
    const sampler = pathTextSampler(d, nn);
    if (sampler && hit.segment && sampler.total > 0) {
      const sps = p.subpaths;
      const chosen = sps.findIndex((sp) => sp.anchors.length >= 2);
      if (hit.segment.subpath === (chosen < 0 ? 0 : chosen)) {
        const len = sampler.lengthAt(hit.segment.segment, hit.segment.t);
        nn.pathOffset = Math.max(0, Math.min(1, len / sampler.total));
      }
    }
  });
  startEditing(node.id, 0, 0);
}

function hasOpenSubPath(p: PathNode): boolean {
  return p.subpaths.some((sp) => !sp.closed && sp.anchors.length >= 2);
}

function areaRect(g: { start: Vec; snap: SnapSession }, e: ToolPointerEvent, ctx: ToolContext): Rect {
  let p = e.world;
  if (!e.primary) {
    const sr = g.snap.snap(p);
    p = sr.point;
    ctx.setSnapGuides(sr);
  }
  let dx = p.x - g.start.x;
  let dy = p.y - g.start.y;
  if (e.shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  if (e.alt) return rectFromPoints({ x: g.start.x - dx, y: g.start.y - dy }, { x: g.start.x + dx, y: g.start.y + dy });
  return rectFromPoints(g.start, { x: g.start.x + dx, y: g.start.y + dy });
}

function resizeBox(g: Extract<Gesture, { kind: 'resizeBox' }>, e: ToolPointerEvent): void {
  const s = getState();
  const local = localPoint(g.base, g.id, e.world);
  const dx = local.x - g.startLocal.x;
  const dy = local.y - g.startLocal.y;
  const h = g.handle;
  let w = g.startBox.width;
  let hh = g.startBox.height;
  let ox = 0;
  let oy = 0;
  if (h.includes('e')) w += dx;
  if (h.includes('w')) {
    w -= dx;
    ox = dx;
  }
  if (h.includes('s')) hh += dy;
  if (h.includes('n')) {
    hh -= dy;
    oy = dy;
  }
  const MIN = 4;
  if (w < MIN) {
    if (h.includes('w')) ox -= MIN - w;
    w = MIN;
  }
  if (hh < MIN) {
    if (h.includes('n')) oy -= MIN - hh;
    hh = MIN;
  }
  const next = produce(g.base, (d) => {
    const n = d.nodes[g.id];
    if (!n || n.type !== 'text') return;
    n.box = { width: w, height: hh };
    if (ox || oy) n.transform = multiply(n.transform, translate(ox, oy));
  });
  s.replaceDoc(next);
  useOverlayStore.getState().setHud({ screen: e.screen, text: `W: ${formatLength(w, s.prefs.units)}\nH: ${formatLength(hh, s.prefs.units)}` });
}

function clearVisuals(ctx: ToolContext): void {
  ctx.setSnapGuides(null);
  useOverlayStore.getState().setMarquee(null);
  useOverlayStore.getState().setHud(null);
}

export const textTool: Tool = {
  id: 'text',
  name: 'Type Tool',
  shortcut: 't',
  icon: Type,
  group: 'text',
  order: 400,
  cursor: 'text',
  hint: 'Click to create point text, drag to create area text, click an open path for type on a path. Click existing text to edit it.',
  showSelectionOverlay: true,
  defaults: {},
  Options: TextOptions,

  activate(ctx) {
    gesture = { kind: 'none' };
    const s = ctx.state;
    if (s.editingTextId && !useTextEdit.getState().id) startEditing(s.editingTextId, undefined, 0);
    ctx.setCursor('text');
  },

  deactivate(ctx) {
    if (gesture.kind === 'resizeBox') ctx.state.revert();
    gesture = { kind: 'none' };
    clearVisuals(ctx);
    finishEditing({ select: true });
  },

  isBusy: () => gesture.kind === 'createArea' || gesture.kind === 'resizeBox' || gesture.kind === 'selectDrag',

  cancel(ctx) {
    if (gesture.kind === 'resizeBox') ctx.state.revert();
    gesture = { kind: 'none' };
    clearVisuals(ctx);
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const st = useTextEdit.getState();
    const tol = ctx.tolerance();
    if (st.id) {
      const node = s.doc.nodes[st.id];
      if (node && node.type === 'text') {
        const handle = hitFrameHandle(s, node, e.screen);
        if (handle) {
          gesture = { kind: 'resizeBox', id: node.id, handle, base: s.doc, startLocal: localPoint(s.doc, node.id, e.world), startBox: { ...node.box! } };
          return;
        }
        const idx = indexAtWorld(s.doc, node, e.world, tol);
        if (idx !== null) {
          const detail = e.native?.detail ?? 1;
          if (detail >= 3) {
            const r = paragraphRangeAt(node.text, idx);
            setCaret(r.end, r.start);
          } else if (e.shift) setCaret(idx, st.anchor);
          else setCaret(idx);
          gesture = { kind: 'selectDrag', id: node.id, anchor: useTextEdit.getState().anchor };
          focusInput();
          return;
        }
      }
      // clicked outside the edited text: commit
      finishEditing({ select: false });
    }
    const doc = getState().doc;
    const hit = ctx.hitTest(e.world, { enterGroups: true });
    if (hit) {
      const n = doc.nodes[hit.id];
      if (n && n.type === 'text' && isEditable(doc, n.id)) {
        const idx = indexAtWorld(doc, n, e.world, tol);
        if (idx !== null) {
          startEditing(n.id, idx, idx);
          gesture = { kind: 'selectDrag', id: n.id, anchor: idx };
          return;
        }
      }
      const sel = getState().selection;
      if (n && n.type === 'path' && hit.kind === 'stroke' && isEditable(doc, n.id) && !sel.includes(hit.id) && !sel.includes(hit.target)) {
        // a path that already carries type: edit that text instead of adding another
        const existing = Object.values(doc.nodes).find((x): x is TextNode => x.type === 'text' && x.pathId === n.id);
        if (existing && isEditable(doc, existing.id)) {
          const idx = indexAtWorld(doc, existing, e.world, tol, true) ?? existing.text.length;
          startEditing(existing.id, idx, idx);
          gesture = { kind: 'selectDrag', id: existing.id, anchor: idx };
          return;
        }
        if (hasOpenSubPath(n) || e.alt) {
          createPathText(n, hit);
          return;
        }
      }
    }
    const snap = ctx.beginSnap();
    const sr = e.primary ? null : snap.snap(e.world);
    gesture = { kind: 'createPending', start: sr ? sr.point : e.world, startScreen: e.screen, snap };
  },

  onPointerMove(e, ctx) {
    const s = ctx.state;
    const g = gesture;
    if (g.kind === 'none') {
      const st = useTextEdit.getState();
      if (st.id) {
        const node = s.doc.nodes[st.id];
        if (node && node.type === 'text') {
          const handle = hitFrameHandle(s, node, e.screen);
          if (handle) {
            ctx.setCursor(frameCursor(handle));
            return;
          }
          if (indexAtWorld(s.doc, node, e.world, ctx.tolerance()) !== null) {
            ctx.setCursor('text');
            s.setHover(null);
            return;
          }
        }
      }
      const hit = ctx.hitTest(e.world, { enterGroups: true });
      if (hit) {
        const n = s.doc.nodes[hit.id];
        if (n && n.type === 'text') {
          s.setHover(hit.target);
          ctx.setCursor('text');
          ctx.setStatus('Click to edit text');
          return;
        }
        if (n && n.type === 'path' && hit.kind === 'stroke' && (hasOpenSubPath(n) || e.alt) && !s.selection.includes(hit.target)) {
          s.setHover(hit.target);
          ctx.setCursor('text');
          ctx.setStatus('Click the path to place type on it');
          return;
        }
      }
      s.setHover(null);
      ctx.setCursor('text');
      ctx.setStatus('');
      return;
    }
    if (g.kind === 'createPending') {
      const dist = Math.hypot(e.screen.x - g.startScreen.x, e.screen.y - g.startScreen.y);
      if (dist < 3) return;
      gesture = { kind: 'createArea', start: g.start, snap: g.snap };
      this.onPointerMove!(e, ctx);
      return;
    }
    if (g.kind === 'createArea') {
      const r = areaRect(g, e, ctx);
      useOverlayStore.getState().setMarquee(r);
      useOverlayStore.getState().setHud({ screen: e.screen, text: `W: ${formatLength(r.width, s.prefs.units)}\nH: ${formatLength(r.height, s.prefs.units)}` });
      return;
    }
    if (g.kind === 'selectDrag') {
      const node = s.doc.nodes[g.id];
      if (!node || node.type !== 'text') return;
      const idx = indexAtWorld(s.doc, node, e.world, ctx.tolerance(), true);
      if (idx !== null) setCaret(idx, g.anchor);
      return;
    }
    if (g.kind === 'resizeBox') {
      resizeBox(g, e);
      ctx.setCursor(frameCursor(g.handle));
      return;
    }
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = { kind: 'none' };
    clearVisuals(ctx);
    if (g.kind === 'createPending') {
      createPointText(g.start);
      return;
    }
    if (g.kind === 'createArea') {
      const r = areaRect(g, e, ctx);
      ctx.setSnapGuides(null);
      if (r.width < 2 || r.height < 2) createPointText(g.start);
      else createAreaText(r);
      return;
    }
    if (g.kind === 'resizeBox') {
      ctx.commit('Resize Text Box');
      ctx.setCursor('text');
      return;
    }
    if (g.kind === 'selectDrag') {
      focusInput();
      return;
    }
  },

  onDoubleClick(e, ctx) {
    const node = editingNode();
    if (!node) return;
    const idx = indexAtWorld(ctx.doc, node, e.world, ctx.tolerance());
    if (idx === null) return;
    const r = wordRangeAt(node.text, idx);
    setCaret(r.end, r.start);
    gesture = { kind: 'none' };
    focusInput();
  },

  onKeyDown(e, ctx) {
    const st = useTextEdit.getState();
    if (!st.id) {
      if (e.key === 'Escape') {
        if (gesture.kind !== 'none') {
          this.cancel!(ctx);
          return true;
        }
        if (ctx.state.selection.length) {
          ctx.state.clearSelection();
          return true;
        }
      }
      return false;
    }
    const node = editingNode();
    if (!node) return false;
    const k = e.key;
    const wordMod = IS_MAC ? e.alt : e.ctrl;
    const lineMod = IS_MAC ? e.meta : false;
    if (k === 'Escape') {
      if (gesture.kind !== 'none') this.cancel!(ctx);
      finishEditing({ select: true, switchToSelect: true });
      return true;
    }
    if (e.primary && !e.alt) {
      const lk = k.toLowerCase();
      if (lk === 'a') {
        selectAll();
        return true;
      }
      if (lk === 'z') {
        if (e.shift) redoWhileEditing();
        else undoWhileEditing();
        return true;
      }
      if (lk === 'y') {
        redoWhileEditing();
        return true;
      }
      if (lk === 'c' || lk === 'x' || lk === 'v') return false; // native clipboard events (see TextInputProxy)
    }
    switch (k) {
      case 'Enter':
        if (node.kind !== 'path') insertText('\n');
        return true;
      case 'Tab':
        insertText('\t');
        return true;
      case 'Backspace':
        deleteBackward(wordMod);
        return true;
      case 'Delete':
        deleteForward(wordMod);
        return true;
      case 'ArrowLeft':
        moveCaret(lineMod ? 'home' : 'left', e.shift, wordMod);
        return true;
      case 'ArrowRight':
        moveCaret(lineMod ? 'end' : 'right', e.shift, wordMod);
        return true;
      case 'ArrowUp':
        moveCaret(lineMod ? 'docStart' : 'up', e.shift);
        return true;
      case 'ArrowDown':
        moveCaret(lineMod ? 'docEnd' : 'down', e.shift);
        return true;
      case 'Home':
        moveCaret(e.ctrl ? 'docStart' : 'home', e.shift);
        return true;
      case 'End':
        moveCaret(e.ctrl ? 'docEnd' : 'end', e.shift);
        return true;
      default:
        break;
    }
    if (k === 'Process' || k === 'Dead' || k === 'Unidentified' || k.length !== 1) return false;
    const altGr = e.ctrl && e.alt;
    if ((e.ctrl || e.meta) && !altGr) return false;
    if (e.alt && !altGr && !IS_MAC) return false;
    insertText(k);
    return true;
  },

  onModifiers() {
    /* nothing */
  },
};

export const tool = textTool;
void React;
