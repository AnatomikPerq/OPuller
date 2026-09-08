/**
 * Gradient annotator geometry: maps gradient coordinates (object bounding box
 * units, 0..1 across the node's local geometry bounds) to world space and back.
 * The renderer maps gradients onto `pathBounds` of the local geometry, so we
 * use `localBounds` + `worldMatrix` here for an exact match.
 */
import type { Document, ID, Matrix, Rect, Vec, LinearGradientPaint, RadialGradientPaint } from '@/model/types';
import { localBounds, worldMatrix } from '@/model/document';
import { applyToPoint, invert } from '@/geometry/matrix';

export interface GradientFrame {
  id: ID;
  /** local geometry bounds the gradient is mapped onto */
  bounds: Rect;
  wm: Matrix;
  inv: Matrix;
}

export function gradientFrame(doc: Document, id: ID): GradientFrame | null {
  const b = localBounds(doc, id);
  if (!b) return null;
  const wm = worldMatrix(doc, id);
  return { id, bounds: { x: b.x, y: b.y, width: Math.max(b.width, 1e-6), height: Math.max(b.height, 1e-6) }, wm, inv: invert(wm) };
}

export function bboxToLocal(f: GradientFrame, u: number, v: number): Vec {
  return { x: f.bounds.x + u * f.bounds.width, y: f.bounds.y + v * f.bounds.height };
}

export function bboxToWorld(f: GradientFrame, u: number, v: number): Vec {
  return applyToPoint(f.wm, bboxToLocal(f, u, v));
}

export function worldToBbox(f: GradientFrame, p: Vec): { u: number; v: number } {
  const l = applyToPoint(f.inv, p);
  return { u: (l.x - f.bounds.x) / f.bounds.width, v: (l.y - f.bounds.y) / f.bounds.height };
}

export function linearWorldPoints(f: GradientFrame, g: LinearGradientPaint): { start: Vec; end: Vec } {
  return { start: bboxToWorld(f, g.x1, g.y1), end: bboxToWorld(f, g.x2, g.y2) };
}

/**
 * Radial gradient handles in world space: centre, a point on the ellipse along
 * the local +x axis (radius handle) and the focal point.
 */
export function radialWorldPoints(f: GradientFrame, g: RadialGradientPaint): { center: Vec; radius: Vec; focal: Vec; radiusY: Vec } {
  return {
    center: bboxToWorld(f, g.cx, g.cy),
    radius: bboxToWorld(f, g.cx + g.r, g.cy),
    radiusY: bboxToWorld(f, g.cx, g.cy + g.r),
    focal: bboxToWorld(f, g.fx ?? g.cx, g.fy ?? g.cy),
  };
}

/** Radial radius (bbox units) from a centre and an edge point, both in world space. */
export function radialRadiusFromWorld(f: GradientFrame, center: Vec, edge: Vec): number {
  const c = worldToBbox(f, center);
  const e = worldToBbox(f, edge);
  return Math.hypot(e.u - c.u, e.v - c.v);
}

/**
 * Points of the radial ellipse outline in world space (for drawing).
 * The ellipse has semi-axes r*w and r*h in local space.
 */
export function radialEllipsePath(f: GradientFrame, g: RadialGradientPaint, toScreen: (p: Vec) => Vec, segments = 48): string {
  const pts: Vec[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(toScreen(bboxToWorld(f, g.cx + Math.cos(a) * g.r, g.cy + Math.sin(a) * g.r)));
  }
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('') + 'Z';
}

/** Keep the focal point inside the radial ellipse (SVG clamps it to the edge otherwise). */
export function clampFocal(g: RadialGradientPaint, fx: number, fy: number): { fx: number; fy: number } {
  const dx = fx - g.cx;
  const dy = fy - g.cy;
  const d = Math.hypot(dx, dy);
  const max = g.r * 0.98;
  if (d <= max || d < 1e-9) return { fx, fy };
  return { fx: g.cx + (dx / d) * max, fy: g.cy + (dy / d) * max };
}
