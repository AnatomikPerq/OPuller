/**
 * Screen-space overlay drawn while editing text: selection highlight, blinking
 * caret, the area text frame (with resize handles and an overflow marker) and
 * the guide path for type on a path.
 */
import React from 'react';
import { useStore, getState } from '@/store/store';
import type { TextNode, Vec } from '@/model/types';
import { toSvgTransform } from '@/geometry/matrix';
import { pathToSvgD } from '@/geometry/path';
import { nodeScreenMatrix } from '@/canvas/SelectionOverlay';
import { layoutText, caretAt, xAtIndex, visualLineEnd, layoutGeneration } from '@/text/layout';
import { pathGlyphPositions, upVector } from '@/text/outline';
import { useTextEdit } from './session';
import { FRAME_HANDLES, frameHandleLocal } from './frame';

const SELECTION_FILL = 'rgba(74, 144, 226, 0.35)';
const FRAME_STROKE = '#4a90e2';

function Caret({ x, y, height, scale, k }: { x: number; y: number; height: number; scale: number; k: number }) {
  const w = 1.5 / scale;
  return (
    <g className="text-caret" key={k}>
      <rect x={x - w} y={y} width={w * 2} height={height} fill="rgba(255,255,255,0.85)" />
      <rect x={x - w / 2} y={y} width={w} height={height} fill="#111" />
    </g>
  );
}

function PathCaret({ a, b, scale }: { a: Vec; b: Vec; scale: number }) {
  return (
    <g className="text-caret">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(255,255,255,0.85)" strokeWidth={3 / scale} />
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#111" strokeWidth={1.5 / scale} />
    </g>
  );
}

function pointTextOverlay(node: TextNode, start: number, end: number, caret: number, scale: number, handleSize: number): React.ReactNode {
  const layout = layoutText(node);
  const sel: React.ReactNode[] = [];
  if (end > start) {
    layout.lines.forEach((line, li) => {
      if (line.end < start || line.start > end) return;
      if (line.start === line.end && !(start <= line.start && end > line.end)) {
        // empty line fully inside the selection: small marker
        if (start < line.start && end > line.start) sel.push(<rect key={li} x={line.x} y={line.y - line.ascent} width={4 / scale} height={line.ascent + line.descent} fill={SELECTION_FILL} />);
        return;
      }
      const a = Math.max(start, line.start);
      const vEnd = visualLineEnd(line);
      const b = Math.min(end, line.paragraphEnd ? line.end : vEnd);
      if (b < a) return;
      const x1 = xAtIndex(line, a);
      let x2 = xAtIndex(line, b);
      // paragraph break inside the selection: show a small tail
      if (line.paragraphEnd && end > line.end) x2 += 4 / scale;
      if (x2 - x1 < 0.01) return;
      sel.push(<rect key={li} x={Math.min(x1, x2)} y={line.y - line.ascent} width={Math.abs(x2 - x1)} height={line.ascent + line.descent} fill={SELECTION_FILL} />);
    });
  }
  const c = caretAt(layout, caret, node.style);
  let frame: React.ReactNode = null;
  if (node.kind === 'area' && node.box) {
    const hs = handleSize / scale;
    frame = (
      <g className="text-frame">
        <rect x={0} y={0} width={node.box.width} height={node.box.height} fill="none" stroke={FRAME_STROKE} strokeWidth={1 / scale} />
        {FRAME_HANDLES.map((k) => {
          const p = frameHandleLocal(node.box!, k);
          return <rect key={k} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} fill="#fff" stroke={FRAME_STROKE} strokeWidth={1 / scale} />;
        })}
        {layout.overflow && (
          <g transform={`translate(${node.box.width + 2 / scale} ${node.box.height + 2 / scale})`}>
            <rect x={0} y={0} width={hs * 1.4} height={hs * 1.4} className="text-frame-overflow" strokeWidth={1 / scale} />
            <path d={`M${hs * 0.7} ${hs * 0.3}V${hs * 1.1}M${hs * 0.3} ${hs * 0.7}H${hs * 1.1}`} stroke="#e5484d" strokeWidth={1.2 / scale} />
          </g>
        )}
      </g>
    );
  }
  return (
    <>
      {sel}
      {frame}
      <Caret x={c.x} y={c.y} height={c.height} scale={scale} k={caret} />
    </>
  );
}

function pathTextOverlay(node: TextNode, start: number, end: number, caret: number, scale: number): React.ReactNode {
  const doc = getState().doc;
  const placed = pathGlyphPositions(doc, node);
  if (!placed) return null;
  const { sampler, layout } = placed;
  const line = layout.lines[0];
  if (!line) return null;
  const asc = line.ascent;
  const desc = line.descent;
  const at = (index: number) => sampler.at(placed.start + xAtIndex(line, index));
  const sel: React.ReactNode[] = [];
  if (end > start) {
    for (let k = start; k < end; k++) {
      const a = at(k);
      const b = at(k + 1);
      const ua = upVector(a.tangent);
      const ub = upVector(b.tangent);
      const pts = [
        { x: a.point.x + ua.x * asc, y: a.point.y + ua.y * asc },
        { x: b.point.x + ub.x * asc, y: b.point.y + ub.y * asc },
        { x: b.point.x - ub.x * desc, y: b.point.y - ub.y * desc },
        { x: a.point.x - ua.x * desc, y: a.point.y - ua.y * desc },
      ];
      sel.push(<polygon key={k} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={SELECTION_FILL} />);
    }
  }
  const c = at(caret);
  const up = upVector(c.tangent);
  const top = { x: c.point.x + up.x * asc, y: c.point.y + up.y * asc };
  const bottom = { x: c.point.x - up.x * desc, y: c.point.y - up.y * desc };
  const startLoc = sampler.at(0);
  const endLoc = sampler.at(sampler.total);
  const tick = (loc: { point: Vec; tangent: Vec }, key: string) => {
    const u = upVector(loc.tangent);
    return <line key={key} x1={loc.point.x - u.x * desc} y1={loc.point.y - u.y * desc} x2={loc.point.x + u.x * asc} y2={loc.point.y + u.y * asc} stroke={FRAME_STROKE} strokeWidth={1 / scale} />;
  };
  return (
    <>
      <path d={pathToSvgD([sampler.subpath])} fill="none" stroke={FRAME_STROKE} strokeWidth={1 / scale} strokeDasharray={`${4 / scale} ${3 / scale}`} opacity={0.8} />
      {tick(startLoc, 's')}
      {tick(endLoc, 'e')}
      {sel}
      <g key={caret}>
        <PathCaret a={top} b={bottom} scale={scale} />
      </g>
    </>
  );
}

export function TextEditOverlay() {
  const id = useTextEdit((s) => s.id);
  const caret = useTextEdit((s) => s.caret);
  const anchor = useTextEdit((s) => s.anchor);
  const editingTextId = useStore((s) => s.editingTextId);
  useStore((s) => s.docVersion);
  useStore((s) => s.zoom);
  useStore((s) => s.pan.x);
  useStore((s) => s.pan.y);
  const handleSize = useStore((s) => s.prefs.handleSize);
  void layoutGeneration();
  if (!id || editingTextId !== id) return null;
  const state = getState();
  const node = state.doc.nodes[id];
  if (!node || node.type !== 'text') return null;
  const m = nodeScreenMatrix(state, id);
  const scale = Math.hypot(m.a, m.b) || 1;
  const start = Math.min(caret, anchor);
  const end = Math.max(caret, anchor);
  return (
    <g className="text-edit-overlay" transform={toSvgTransform(m)} pointerEvents="none" data-testid="text-edit-overlay">
      {node.kind === 'path' && node.pathId ? pathTextOverlay(node, start, end, caret, scale) : pointTextOverlay(node, start, end, caret, scale, handleSize)}
    </g>
  );
}
