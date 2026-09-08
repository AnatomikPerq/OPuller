/**
 * Screen-space overlay: selection outlines, bounding box handles, anchors and
 * Bezier handles (direct selection), hover highlight.
 */
import React, { memo } from 'react';
import { useStore, getState } from '@/store/store';
import type { EditorState } from '@/store/store';
import type { ID, Node, Vec, AnchorRef } from '@/model/types';
import { worldMatrix, layerOf, descendants, localBounds } from '@/model/document';
import { multiply, applyToPoint, toSvgTransform } from '@/geometry/matrix';
import { pathToSvgD, absHandleIn, absHandleOut, hasHandle } from '@/geometry/path';
import { getSelectionFrame } from './selectionHandles';
import { getTool } from '@/tools/registry';
import { effectiveSubPaths } from './Renderer';

/** SVG path data for a node's outline in screen space. */
export function nodeScreenOutline(state: EditorState, id: ID): string {
  const doc = state.doc;
  const n = doc.nodes[id];
  if (!n) return '';
  const view = { a: state.zoom, b: 0, c: 0, d: state.zoom, e: state.pan.x, f: state.pan.y };
  const parts: string[] = [];
  const visit = (nid: ID) => {
    const node = doc.nodes[nid];
    if (!node || !node.visible) return;
    if (node.type === 'group' || node.type === 'layer') {
      for (const c of node.children) visit(c);
      return;
    }
    const m = multiply(view, worldMatrix(doc, nid));
    if (node.type === 'path') {
      const sps = effectiveSubPaths(node);
      const d = pathToSvgD(sps.map((sp) => ({ closed: sp.closed, anchors: sp.anchors.map((a) => ({ ...a, point: applyToPoint(m, a.point), handleIn: a.handleIn ? { x: a.handleIn.x * m.a + a.handleIn.y * m.c, y: a.handleIn.x * m.b + a.handleIn.y * m.d } : null, handleOut: a.handleOut ? { x: a.handleOut.x * m.a + a.handleOut.y * m.c, y: a.handleOut.x * m.b + a.handleOut.y * m.d } : null })) })));
      parts.push(d);
    } else {
      const b = localBounds(doc, nid);
      if (!b) return;
      const p = [
        applyToPoint(m, { x: b.x, y: b.y }),
        applyToPoint(m, { x: b.x + b.width, y: b.y }),
        applyToPoint(m, { x: b.x + b.width, y: b.y + b.height }),
        applyToPoint(m, { x: b.x, y: b.y + b.height }),
      ];
      parts.push(`M${p[0].x} ${p[0].y}L${p[1].x} ${p[1].y}L${p[2].x} ${p[2].y}L${p[3].x} ${p[3].y}Z`);
    }
  };
  visit(id);
  return parts.join('');
}

function layerColor(state: EditorState, id: ID): string {
  return layerOf(state.doc, id)?.color ?? '#3b82f6';
}

/** Subscribe narrowly to everything the overlay depends on, then read a snapshot. */
function useOverlayState(): EditorState {
  useStore((s) => s.docVersion);
  useStore((s) => s.selection);
  useStore((s) => s.selectedAnchors);
  useStore((s) => s.zoom);
  useStore((s) => s.pan.x);
  useStore((s) => s.pan.y);
  useStore((s) => s.hoverId);
  useStore((s) => s.activeTool);
  useStore((s) => s.temporaryTool);
  useStore((s) => s.view.showAnchors);
  useStore((s) => s.view.showBounds);
  useStore((s) => s.prefs.handleSize);
  useStore((s) => s.editingTextId);
  return getState();
}

const HoverOutline = memo(function HoverOutline() {
  const hoverId = useStore((s) => s.hoverId);
  const selection = useStore((s) => s.selection);
  const state = useOverlayState();
  if (!hoverId || selection.includes(hoverId)) return null;
  const n = state.doc.nodes[hoverId];
  if (!n) return null;
  const d = nodeScreenOutline(state, hoverId);
  if (!d) return null;
  return <path d={d} fill="none" stroke={layerColor(state, hoverId)} strokeWidth={1.5} opacity={0.9} pointerEvents="none" />;
});

interface AnchorDot {
  key: string;
  x: number;
  y: number;
  selected: boolean;
  kind: 'corner' | 'smooth';
  ref: AnchorRef;
}

function collectAnchors(state: EditorState, ids: ID[]): { dots: AnchorDot[]; handles: Array<{ key: string; from: Vec; to: Vec }> } {
  const doc = state.doc;
  const z = state.zoom;
  const p = state.pan;
  const dots: AnchorDot[] = [];
  const handles: Array<{ key: string; from: Vec; to: Vec }> = [];
  const selSet = new Set(state.selectedAnchors.map((a) => `${a.nodeId}/${a.subpath}/${a.index}`));
  const showHandlesFor = new Set<string>();
  for (const a of state.selectedAnchors) {
    const n = doc.nodes[a.nodeId];
    if (!n || n.type !== 'path') continue;
    const sp = n.subpaths[a.subpath];
    if (!sp) continue;
    const len = sp.anchors.length;
    showHandlesFor.add(`${a.nodeId}/${a.subpath}/${a.index}`);
    if (sp.closed || a.index > 0) showHandlesFor.add(`${a.nodeId}/${a.subpath}/${(a.index - 1 + len) % len}`);
    if (sp.closed || a.index < len - 1) showHandlesFor.add(`${a.nodeId}/${a.subpath}/${(a.index + 1) % len}`);
  }
  const single = ids.length === 1;
  for (const id of ids) {
    for (const d of descendants(doc, id, true)) {
      const n = doc.nodes[d];
      if (!n || n.type !== 'path' || !n.visible) continue;
      const wm = worldMatrix(doc, d);
      const m = { a: wm.a * z, b: wm.b * z, c: wm.c * z, d: wm.d * z, e: wm.e * z + p.x, f: wm.f * z + p.y };
      n.subpaths.forEach((sp, si) => {
        sp.anchors.forEach((a, ai) => {
          const key = `${d}/${si}/${ai}`;
          const sp0 = applyToPoint(m, a.point);
          const selected = selSet.has(key);
          dots.push({ key, x: sp0.x, y: sp0.y, selected, kind: a.kind, ref: { nodeId: d, subpath: si, index: ai } });
          if (showHandlesFor.has(key) || (single && state.selectedAnchors.length === 0 && false)) {
            if (hasHandle(a.handleIn)) handles.push({ key: key + 'i', from: sp0, to: applyToPoint(m, absHandleIn(a)) });
            if (hasHandle(a.handleOut)) handles.push({ key: key + 'o', from: sp0, to: applyToPoint(m, absHandleOut(a)) });
          }
        });
      });
    }
  }
  return { dots, handles };
}

export const SelectionOverlay = memo(function SelectionOverlay() {
  const state = useOverlayState();
  const { selection, editingTextId } = state;
  const toolId = state.temporaryTool ?? state.activeTool;
  const tool = getTool(toolId);
  const mode = tool?.showSelectionOverlay ?? true;
  if (mode === false || !selection.length) return <HoverOutline />;
  const handleSize = state.prefs.handleSize;
  const frame = getSelectionFrame(state);
  const anchorsMode = mode === 'anchors';
  const outlines = selection.map((id) => {
    const d = nodeScreenOutline(state, id);
    if (!d || id === editingTextId) return null;
    return <path key={id} d={d} fill="none" stroke={layerColor(state, id)} strokeWidth={1} opacity={0.85} />;
  });
  let anchors: React.ReactNode = null;
  if (state.view.showAnchors && !editingTextId) {
    const { dots, handles } = collectAnchors(state, selection);
    const hs = handleSize - 2;
    anchors = (
      <g className="anchors">
        {handles.map((h) => (
          <g key={h.key}>
            <line x1={h.from.x} y1={h.from.y} x2={h.to.x} y2={h.to.y} stroke="#4a90e2" strokeWidth={1} />
            <circle cx={h.to.x} cy={h.to.y} r={hs / 2} fill="#fff" stroke="#4a90e2" strokeWidth={1} />
          </g>
        ))}
        {dots.map((d) => {
          if (!anchorsMode && !d.selected) {
            // selection tool: small filled squares
            return <rect key={d.key} x={d.x - hs / 2 + 1} y={d.y - hs / 2 + 1} width={hs - 2} height={hs - 2} fill={layerColor(state, d.ref.nodeId)} stroke="none" />;
          }
          return d.kind === 'smooth' && false ? null : (
            <rect
              key={d.key}
              x={d.x - hs / 2}
              y={d.y - hs / 2}
              width={hs}
              height={hs}
              fill={d.selected ? '#4a90e2' : '#ffffff'}
              stroke="#4a90e2"
              strokeWidth={1}
            />
          );
        })}
      </g>
    );
  }
  let box: React.ReactNode = null;
  if (frame && state.view.showBounds && !anchorsMode && !editingTextId) {
    const r = frame.screen;
    box = (
      <g className="bbox">
        <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="none" stroke="#4a90e2" strokeWidth={1} strokeDasharray={selection.length > 1 ? '4 3' : undefined} />
        {frame.handles.map((h) => (
          <rect key={h.kind} x={h.x - handleSize / 2} y={h.y - handleSize / 2} width={handleSize} height={handleSize} fill="#fff" stroke="#4a90e2" strokeWidth={1} />
        ))}
      </g>
    );
  }
  return (
    <g className="selection-overlay" pointerEvents="none">
      <HoverOutline />
      {outlines}
      {box}
      {anchors}
    </g>
  );
});

/** Utility for tools: screen-space transform for a node. */
export function nodeScreenMatrix(state: EditorState, id: ID) {
  const wm = worldMatrix(state.doc, id);
  return { a: wm.a * state.zoom, b: wm.b * state.zoom, c: wm.c * state.zoom, d: wm.d * state.zoom, e: wm.e * state.zoom + state.pan.x, f: wm.f * state.zoom + state.pan.y };
}

export function nodeScreenTransform(state: EditorState, node: Node): string {
  return toSvgTransform(nodeScreenMatrix(state, node.id));
}
