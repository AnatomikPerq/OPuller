/**
 * Screen-space model of the gradient annotator + hit testing. Pure functions
 * so the tool stays small and the maths is unit-testable.
 */
import type { ID, Vec, GradientPaint, Paint } from '@/model/types';
import type { EditorState } from '@/store/store';
import { appearanceTargets } from '@/commands/appearance';
import { gradientFrame, linearWorldPoints, radialWorldPoints, radialEllipsePath, type GradientFrame } from '@/color/annotator';
import { isGradient } from '@/color/paint';

export interface StopMarker {
  index: number;
  screen: Vec;
  color: string;
  opacity: number;
  offset: number;
}

export interface AnnotatorModel {
  id: ID;
  target: 'fill' | 'stroke';
  frame: GradientFrame;
  /** the gradient being annotated, null when the target paint is not a gradient */
  paint: GradientPaint | null;
  /** current paint of the target (solid/none/...) when not a gradient */
  rawPaint: Paint;
  /** all ids the edit applies to */
  targets: ID[];
  /** linear: start/end; radial: centre / radius handle (both screen space) */
  start: Vec | null;
  end: Vec | null;
  center: Vec | null;
  radiusY: Vec | null;
  focal: Vec | null;
  ellipsePath: string | null;
  stops: StopMarker[];
}

export type AnnotatorHit =
  | { kind: 'start' | 'end' | 'center' | 'radius' | 'focal' }
  | { kind: 'stop'; index: number }
  | { kind: 'line'; t: number }
  | null;

export function paintOf(state: EditorState, id: ID, target: 'fill' | 'stroke'): Paint | null {
  const n = state.doc.nodes[id];
  if (!n || (n.type !== 'path' && n.type !== 'text')) return null;
  return target === 'fill' ? n.fill : n.stroke.paint;
}

/** Build the annotator for the current selection (null when nothing is selected). */
export function buildAnnotator(state: EditorState, toScreen: (p: Vec) => Vec): AnnotatorModel | null {
  const targets = appearanceTargets(state.selection);
  if (!targets.length) return null;
  const target = state.activePaintTarget;
  // prefer the first target whose paint is a gradient, else the first target
  let id = targets.find((t) => isGradient(paintOf(state, t, target))) ?? targets[0];
  let frame = gradientFrame(state.doc, id);
  if (!frame) {
    for (const t of targets) {
      const f = gradientFrame(state.doc, t);
      if (f) {
        id = t;
        frame = f;
        break;
      }
    }
  }
  if (!frame) return null;
  const rawPaint = paintOf(state, id, target) ?? { type: 'none' };
  const model: AnnotatorModel = { id, target, frame, paint: null, rawPaint, targets, start: null, end: null, center: null, radiusY: null, focal: null, ellipsePath: null, stops: [] };
  if (!isGradient(rawPaint)) return model;
  model.paint = rawPaint;
  if (rawPaint.type === 'linear') {
    const w = linearWorldPoints(frame, rawPaint);
    model.start = toScreen(w.start);
    model.end = toScreen(w.end);
  } else {
    const w = radialWorldPoints(frame, rawPaint);
    model.start = toScreen(w.center);
    model.center = model.start;
    model.end = toScreen(w.radius);
    model.radiusY = toScreen(w.radiusY);
    model.focal = toScreen(w.focal);
    model.ellipsePath = radialEllipsePath(frame, rawPaint, toScreen);
  }
  const a = model.start!;
  const b = model.end!;
  model.stops = rawPaint.stops.map((s, index) => ({ index, offset: s.offset, color: s.color, opacity: s.opacity, screen: { x: a.x + (b.x - a.x) * s.offset, y: a.y + (b.y - a.y) * s.offset } }));
  return model;
}

/** Parameter t of the projection of p onto segment a→b (unclamped) and the distance to the segment. */
export function projectOnSegment(a: Vec, b: Vec, p: Vec): { t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return { t: 0, distance: Math.hypot(p.x - a.x, p.y - a.y) };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  const tc = Math.max(0, Math.min(1, t));
  const q = { x: a.x + dx * tc, y: a.y + dy * tc };
  return { t, distance: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** Hit test the annotator in screen space (stops and handles first, then the line). */
export function hitAnnotator(m: AnnotatorModel | null, p: Vec, tol = 7): AnnotatorHit {
  if (!m || !m.paint || !m.start || !m.end) return null;
  const near = (q: Vec | null, r = tol) => !!q && Math.hypot(q.x - p.x, q.y - p.y) <= r;
  // endpoint handles take priority over stops sitting on them
  if (m.paint.type === 'linear') {
    if (near(m.start)) return { kind: 'start' };
    if (near(m.end)) return { kind: 'end' };
  } else {
    if (near(m.focal, tol - 1) && m.focal && m.center && Math.hypot(m.focal.x - m.center.x, m.focal.y - m.center.y) > 3) return { kind: 'focal' };
    if (near(m.center)) return { kind: 'center' };
    if (near(m.end)) return { kind: 'radius' };
  }
  let best: { index: number; d: number } | null = null;
  for (const s of m.stops) {
    const d = Math.hypot(s.screen.x - p.x, s.screen.y - p.y);
    if (d <= tol && (!best || d < best.d)) best = { index: s.index, d };
  }
  if (best) return { kind: 'stop', index: best.index };
  const pr = projectOnSegment(m.start, m.end, p);
  if (pr.distance <= tol && pr.t >= 0 && pr.t <= 1) return { kind: 'line', t: pr.t };
  return null;
}

/** Constrain b relative to a to 45 degree steps (screen space). */
export function constrainTo45(a: Vec, b: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return b;
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}
