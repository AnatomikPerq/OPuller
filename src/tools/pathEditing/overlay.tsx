/**
 * Screen-space overlay primitives shared by the anchor editing tools.
 */
import React from 'react';
import type { Vec, SubPath, AnchorRef, HandleRef } from '@/model/types';
import type { ToolContext } from '@/tools/types';
import type { Cubic } from '@/geometry/bezier';
import { absHandleIn, absHandleOut, hasHandle, segmentCount, segmentCubic } from '@/geometry/path';
import { anchorWorldPoint, handleWorldPoint } from './anchors';
import { segmentWorldCubic, type SegmentRef } from './curves';

export const HL = '#4a90e2';
export const HL_SOFT = 'rgba(74,144,226,0.35)';

function f(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0';
}

/** SVG path data for a world-space cubic in screen space. */
export function cubicScreenD(ctx: ToolContext, c: Cubic): string {
  const p0 = ctx.worldToScreen(c.p0);
  const p1 = ctx.worldToScreen(c.p1);
  const p2 = ctx.worldToScreen(c.p2);
  const p3 = ctx.worldToScreen(c.p3);
  return `M${f(p0.x)} ${f(p0.y)}C${f(p1.x)} ${f(p1.y)} ${f(p2.x)} ${f(p2.y)} ${f(p3.x)} ${f(p3.y)}`;
}

/** SVG path data for a world-space subpath in screen space. */
export function subpathScreenD(ctx: ToolContext, sp: SubPath): string {
  const n = sp.anchors.length;
  if (!n) return '';
  const first = ctx.worldToScreen(sp.anchors[0].point);
  const parts = [`M${f(first.x)} ${f(first.y)}`];
  const segs = segmentCount(sp);
  for (let i = 0; i < segs; i++) {
    const c = segmentCubic(sp, i);
    const a = sp.anchors[i];
    const b = sp.anchors[(i + 1) % n];
    const p3 = ctx.worldToScreen(c.p3);
    if (!hasHandle(a.handleOut) && !hasHandle(b.handleIn)) parts.push(`L${f(p3.x)} ${f(p3.y)}`);
    else {
      const p1 = ctx.worldToScreen(c.p1);
      const p2 = ctx.worldToScreen(c.p2);
      parts.push(`C${f(p1.x)} ${f(p1.y)} ${f(p2.x)} ${f(p2.y)} ${f(p3.x)} ${f(p3.y)}`);
    }
  }
  if (sp.closed) parts.push('Z');
  return parts.join('');
}

/** Highlight ring around an anchor. */
export function AnchorHighlight({ ctx, ref, color = HL }: { ctx: ToolContext; ref: AnchorRef; color?: string }) {
  const p = anchorWorldPoint(ctx.doc, ref);
  if (!p) return null;
  const s = ctx.worldToScreen(p);
  const hs = ctx.state.prefs.handleSize + 2;
  return <rect x={s.x - hs / 2} y={s.y - hs / 2} width={hs} height={hs} fill="none" stroke={color} strokeWidth={1.5} pointerEvents="none" />;
}

/** Highlight ring around a handle end. */
export function HandleHighlight({ ctx, ref, color = HL }: { ctx: ToolContext; ref: HandleRef; color?: string }) {
  const p = handleWorldPoint(ctx.doc, ref);
  if (!p) return null;
  const s = ctx.worldToScreen(p);
  return <circle cx={s.x} cy={s.y} r={ctx.state.prefs.handleSize / 2 + 1.5} fill="none" stroke={color} strokeWidth={1.5} pointerEvents="none" />;
}

/** Thick highlight of one segment. */
export function SegmentHighlight({ ctx, ref, color = HL, width = 3 }: { ctx: ToolContext; ref: SegmentRef; color?: string; width?: number }) {
  const c = segmentWorldCubic(ctx.doc, ref);
  if (!c) return null;
  return <path d={cubicScreenD(ctx, c)} fill="none" stroke={color} strokeWidth={width} strokeOpacity={0.6} strokeLinecap="round" pointerEvents="none" />;
}

/** Small marker at a world point (e.g. the spot where an anchor would be added). */
export function PointMarker({ ctx, point, color = HL }: { ctx: ToolContext; point: Vec; color?: string }) {
  const s = ctx.worldToScreen(point);
  return <circle cx={s.x} cy={s.y} r={3.5} fill="#fff" stroke={color} strokeWidth={1.5} pointerEvents="none" />;
}

/** Handles (lines + knobs) of a world-space subpath's anchor at index i. */
export function AnchorHandles({ ctx, sp, index, color = HL }: { ctx: ToolContext; sp: SubPath; index: number; color?: string }) {
  const a = sp.anchors[index];
  if (!a) return null;
  const p = ctx.worldToScreen(a.point);
  const out: React.ReactNode[] = [];
  if (hasHandle(a.handleIn)) {
    const h = ctx.worldToScreen(absHandleIn(a));
    out.push(<line key="i" x1={p.x} y1={p.y} x2={h.x} y2={h.y} stroke={color} strokeWidth={1} />, <circle key="ic" cx={h.x} cy={h.y} r={2.5} fill="#fff" stroke={color} strokeWidth={1} />);
  }
  if (hasHandle(a.handleOut)) {
    const h = ctx.worldToScreen(absHandleOut(a));
    out.push(<line key="o" x1={p.x} y1={p.y} x2={h.x} y2={h.y} stroke={color} strokeWidth={1} />, <circle key="oc" cx={h.x} cy={h.y} r={2.5} fill="#fff" stroke={color} strokeWidth={1} />);
  }
  return <g pointerEvents="none">{out}</g>;
}
