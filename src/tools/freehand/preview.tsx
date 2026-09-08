/**
 * Screen-space overlay primitives shared by the freehand tools.
 */
import React from 'react';
import type { Vec, Paint } from '@/model/types';
import type { ToolContext } from '@/tools/types';
import { polylineSvg } from './sampling';

export function toScreen(ctx: ToolContext, pts: Vec[]): Vec[] {
  return pts.map((p) => ctx.worldToScreen(p));
}

/** CSS colour approximating a paint for previews. */
export function previewColor(paint: Paint, alpha = 0.6): string {
  let hex = '#888888';
  let op = 1;
  if (paint.type === 'solid') {
    hex = paint.color;
    op = paint.opacity;
  } else if (paint.type === 'linear' || paint.type === 'radial') {
    hex = paint.stops[0]?.color ?? hex;
    op = paint.stops[0]?.opacity ?? 1;
  }
  const r = parseInt(hex.slice(1, 3), 16) || 0;
  const g = parseInt(hex.slice(3, 5), 16) || 0;
  const b = parseInt(hex.slice(5, 7), 16) || 0;
  return `rgba(${r},${g},${b},${Math.max(0.15, Math.min(1, op * alpha)).toFixed(3)})`;
}

/** Thin polyline preview of the raw stroke. */
export function StrokePreview({ points, closed, color = '#7fb2ff', dashed }: { points: Vec[]; closed?: boolean; color?: string; dashed?: boolean }) {
  if (points.length < 2) return null;
  const d = polylineSvg(points, closed);
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dashed ? '4 3' : undefined} />
    </g>
  );
}

/** Wide stroke preview (eraser area / blob brush). Drawn with SVG round caps and joins. */
export function AreaPreview({ points, diameter, fill = 'rgba(255,255,255,0.35)', edge = 'rgba(0,0,0,0.45)' }: { points: Vec[]; diameter: number; fill?: string; edge?: string }) {
  if (!points.length) return null;
  const pts = points.length === 1 ? [points[0], { x: points[0].x + 0.01, y: points[0].y }] : points;
  const d = polylineSvg(pts);
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" stroke={edge} strokeWidth={diameter + 2} strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} fill="none" stroke={fill} strokeWidth={diameter} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** Closed polygon preview (variable-width brush). */
export function PolygonPreview({ ring, fill, edge = 'rgba(0,0,0,0.4)' }: { ring: Vec[]; fill: string; edge?: string }) {
  if (ring.length < 3) return null;
  return <path d={polylineSvg(ring, true)} fill={fill} fillRule="nonzero" stroke={edge} strokeWidth={1} pointerEvents="none" />;
}

/** Circle following the pointer when the CSS cursor cannot show the brush size. */
export function CirclePreview({ center, diameter }: { center: Vec; diameter: number }) {
  return (
    <g pointerEvents="none">
      <circle cx={center.x} cy={center.y} r={diameter / 2} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={2.5} />
      <circle cx={center.x} cy={center.y} r={diameter / 2} fill="none" stroke="#fff" strokeWidth={1} />
    </g>
  );
}

/** Marker drawn at the stroke start when releasing now would close the path. */
export function CloseMarker({ at }: { at: Vec }) {
  return (
    <g pointerEvents="none">
      <circle cx={at.x} cy={at.y} r={5} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
      <circle cx={at.x} cy={at.y} r={5} fill="none" stroke="#fff" strokeWidth={1.5} />
    </g>
  );
}

/** Rectangle preview (eraser marquee). */
export function RectPreview({ a, b }: { a: Vec; b: Vec }) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return <rect x={x} y={y} width={w} height={h} fill="rgba(255,255,255,0.3)" stroke="rgba(0,0,0,0.6)" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />;
}

void React;
