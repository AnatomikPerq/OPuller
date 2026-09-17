/**
 * Effect > Distort & Transform: Zig Zag, Pucker & Bloat, Roughen, Transform, Tweak —
 * live geometry effects (Illustrator's set), as pure subpath → subpath functions.
 * No React, no paper.js, so vitest covers them.
 */
import type { SubPath, Anchor, Vec, Rect, Matrix, ZigZagEffect, PuckerBloatEffect, RoughenEffect, TransformEffect, TweakEffect } from '@/model/types';
import { subpathToCubics, segmentCount, absHandleIn, absHandleOut, anchor as makeAnchor, transformSubPath } from '@/geometry/path';
import { cubicPoint, cubicDerivative, cubicLength, cubicTAtLength, type Cubic } from '@/geometry/bezier';
import { compose, translate, scale as scaleM, rotate as rotateM } from '@/geometry/matrix';

function norm(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** Tangent of a cubic at t, falling back to the chord where the derivative vanishes (degenerate ends of straight cubics). */
function tangentAt(c: Cubic, t: number): Vec {
  let d = cubicDerivative(c, t);
  if (Math.hypot(d.x, d.y) < 1e-9) d = { x: c.p3.x - c.p0.x, y: c.p3.y - c.p0.y };
  return norm(d);
}

/** Deterministic pseudo-random numbers (mulberry32) so a seeded effect renders the same every time. */
export function seededRandom(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catmull-Rom style smooth handles through a list of points (open or closed). */
function smoothThrough(points: Vec[], closed: boolean, tension = 1 / 3): Anchor[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : closed ? points[n - 1] : null;
    const next = i < n - 1 ? points[i + 1] : closed ? points[0] : null;
    if (!prev || !next) {
      // open ends: aim the single handle at the neighbour
      const other = next ?? prev;
      if (!other) return makeAnchor(p);
      const h = { x: (other.x - p.x) * tension, y: (other.y - p.y) * tension };
      return next ? makeAnchor(p, null, h, 'corner') : makeAnchor(p, h, null, 'corner');
    }
    const d = { x: ((next.x - prev.x) / 2) * tension, y: ((next.y - prev.y) / 2) * tension };
    return makeAnchor(p, { x: -d.x, y: -d.y }, d, 'smooth');
  });
}

// ---------------------------------------------------------------------------
// Zig Zag
// ---------------------------------------------------------------------------

/**
 * Zig Zag: every segment gets `ridges` peaks — 2·ridges − 1 points spaced evenly along it
 * (by arc length), offset alternately to the left and right of the path by `size`
 * (absolute, or a percentage of the segment length when `relative`). Corner points give
 * a saw tooth, smooth points a wave. The original anchors stay in place.
 */
export function zigZagSubPath(sp: SubPath, e: ZigZagEffect): SubPath {
  const segs = segmentCount(sp);
  const ridges = Math.max(0, Math.round(e.ridges));
  if (segs < 1 || ridges === 0 || !(Math.abs(e.size) > 1e-9)) return sp;
  const cubics = subpathToCubics(sp);
  const points: Vec[] = [];
  /** path tangent at a peak (null for the original anchors) */
  const peakTangent: Array<Vec | null> = [];
  const spacing: number[] = [];
  for (let s = 0; s < segs; s++) {
    const c = cubics[s];
    const len = cubicLength(c, 0.05);
    const amp = e.relative ? (len * e.size) / 100 : e.size;
    points.push(c.p0);
    peakTangent.push(null);
    const count = 2 * ridges - 1;
    spacing.push(len / (count + 1));
    if (len < 1e-9) continue;
    for (let k = 1; k <= count; k++) {
      const t = cubicTAtLength(c, (len * k) / (count + 1));
      const p = cubicPoint(c, t);
      const tg = tangentAt(c, t);
      const sign = k % 2 === 1 ? 1 : -1;
      // left normal (−ty, tx): peaks alternate sides starting to the left of the travel direction
      points.push({ x: p.x - tg.y * amp * sign, y: p.y + tg.x * amp * sign });
      peakTangent.push(tg);
      spacing.push(len / (count + 1));
    }
  }
  if (!sp.closed) {
    points.push(cubics[segs - 1].p3);
    peakTangent.push(null);
    spacing.push(spacing[spacing.length - 1]);
  }
  if (!e.smooth) return { anchors: points.map((p) => makeAnchor(p)), closed: sp.closed };
  // wave: peaks run parallel to the path, the original anchors cross it (Catmull-Rom through their neighbours)
  const anchors = smoothThrough(points, sp.closed);
  points.forEach((p, i) => {
    const tg = peakTangent[i];
    if (!tg) return;
    const h = { x: tg.x * spacing[i] * 0.5, y: tg.y * spacing[i] * 0.5 };
    anchors[i] = makeAnchor(p, { x: -h.x, y: -h.y }, h, 'smooth');
  });
  return { anchors, closed: sp.closed };
}

export function zigZagSubPaths(sps: SubPath[], e: ZigZagEffect): SubPath[] {
  return sps.map((sp) => zigZagSubPath(sp, e));
}

// ---------------------------------------------------------------------------
// Pucker & Bloat
// ---------------------------------------------------------------------------

/**
 * Pucker & Bloat: anchors move towards the centre by `amount` % of their distance
 * (bloat, positive) while every segment bulges outward through the point its midpoint
 * reaches when pushed away from the centre by the same percentage; pucker (negative)
 * does the opposite — anchors out, segments in. Bloat 100 % turns a square into a
 * four-petal flower, 200 % sends the anchors through the centre (Illustrator's range).
 */
export function puckerBloatSubPath(sp: SubPath, amount: number, centre: Vec): SubPath {
  const a = amount / 100;
  const n = sp.anchors.length;
  if (n < 2 || Math.abs(a) < 1e-9) return sp;
  const moved = sp.anchors.map((an) => ({ x: an.point.x + (centre.x - an.point.x) * a, y: an.point.y + (centre.y - an.point.y) * a }));
  const segs = segmentCount(sp);
  const handleOut: Array<Vec | null> = new Array(n).fill(null);
  const handleIn: Array<Vec | null> = new Array(n).fill(null);
  for (let s = 0; s < segs; s++) {
    const i = s;
    const j = (s + 1) % n;
    const p0 = sp.anchors[i].point;
    const p3 = sp.anchors[j].point;
    // midpoint of the original segment (its curve midpoint for curved segments)
    const c: Cubic = { p0, p1: absHandleOut(sp.anchors[i]), p2: absHandleIn(sp.anchors[j]), p3 };
    const m = cubicPoint(c, 0.5);
    const target = { x: m.x + (m.x - centre.x) * a, y: m.y + (m.y - centre.y) * a };
    const mid = { x: (moved[i].x + moved[j].x) / 2, y: (moved[i].y + moved[j].y) / 2 };
    const d = norm({ x: m.x - centre.x, y: m.y - centre.y });
    const dir = Math.hypot(d.x, d.y) > 0 ? d : norm({ x: -(p3.y - p0.y), y: p3.x - p0.x });
    // B(0.5) = mid + 0.75·L·dir for parallel handles of length L along dir
    const L = ((target.x - mid.x) * dir.x + (target.y - mid.y) * dir.y) / 0.75;
    handleOut[i] = { x: dir.x * L, y: dir.y * L };
    handleIn[j] = { x: dir.x * L, y: dir.y * L };
  }
  const anchors = moved.map((p, i) => makeAnchor(p, handleIn[i], handleOut[i], 'corner'));
  return { anchors, closed: sp.closed };
}

export function puckerBloatSubPaths(sps: SubPath[], e: PuckerBloatEffect, frame: Rect): SubPath[] {
  const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  return sps.map((sp) => puckerBloatSubPath(sp, e.amount, centre));
}

// ---------------------------------------------------------------------------
// Roughen
// ---------------------------------------------------------------------------

/**
 * Roughen: the outline is resampled at `detail` points per inch (96 px) and every point
 * is moved by a random distance up to `size` (absolute, or a percentage of the frame's
 * longer side when `relative`). Corner points give a jagged edge, smooth points a wobbly
 * one. `seed` makes the randomness stable between renders.
 */
export function roughenSubPath(sp: SubPath, e: RoughenEffect, frame: Rect, rnd: () => number): SubPath {
  const segs = segmentCount(sp);
  if (segs < 1) return sp;
  const size = e.relative ? (Math.max(frame.width, frame.height) * e.size) / 100 : e.size;
  if (!(size > 1e-9)) return sp;
  const spacing = 96 / Math.max(0.1, e.detail);
  const cubics = subpathToCubics(sp);
  const points: Vec[] = [];
  const jitter = (p: Vec, tg: Vec): Vec => {
    const nrm = (rnd() * 2 - 1) * size;
    const tan = (rnd() * 2 - 1) * size * 0.5;
    return { x: p.x - tg.y * nrm + tg.x * tan, y: p.y + tg.x * nrm + tg.y * tan };
  };
  for (let s = 0; s < segs; s++) {
    const c = cubics[s];
    const len = cubicLength(c, 0.05);
    points.push(jitter(c.p0, tangentAt(c, 0)));
    const inner = Math.max(0, Math.round(len / spacing) - 1);
    for (let k = 1; k <= inner; k++) {
      const t = cubicTAtLength(c, (len * k) / (inner + 1));
      points.push(jitter(cubicPoint(c, t), tangentAt(c, t)));
    }
  }
  if (!sp.closed) {
    const c = cubics[segs - 1];
    points.push(jitter(c.p3, tangentAt(c, 1)));
  }
  if (e.smooth) return { anchors: smoothThrough(points, sp.closed), closed: sp.closed };
  return { anchors: points.map((p) => makeAnchor(p)), closed: sp.closed };
}

export function roughenSubPaths(sps: SubPath[], e: RoughenEffect, frame: Rect): SubPath[] {
  const rnd = seededRandom(e.seed);
  return sps.map((sp) => roughenSubPath(sp, e, frame, rnd));
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export const TRANSFORM_ORIGINS = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'] as const;
export type TransformOrigin = (typeof TRANSFORM_ORIGINS)[number];

export function originPoint(frame: Rect, origin: TransformOrigin): Vec {
  const fx = origin.endsWith('Left') || origin === 'left' ? 0 : origin.endsWith('Right') || origin === 'right' ? 1 : 0.5;
  const fy = origin.startsWith('top') ? 0 : origin.startsWith('bottom') ? 1 : 0.5;
  return { x: frame.x + frame.width * fx, y: frame.y + frame.height * fy };
}

/** The matrix of one Transform-effect step (Illustrator: reflect, scale, rotate about the origin, then move). */
export function transformStepMatrix(e: TransformEffect, frame: Rect): Matrix {
  const o = originPoint(frame, (e.origin ?? 'center') as TransformOrigin);
  const sx = ((e.scaleX ?? 100) / 100) * (e.reflectX ? -1 : 1);
  const sy = ((e.scaleY ?? 100) / 100) * (e.reflectY ? -1 : 1);
  // positive angles are counter-clockwise on screen
  return compose(translate(e.dx ?? 0, e.dy ?? 0), rotateM(-(e.angle ?? 0), o.x, o.y), scaleM(sx, sy, o.x, o.y));
}

/**
 * Transform: the geometry plus `copies` transformed copies (each copy applies the step once
 * more than the previous one). With 0 copies the transform applies to the object itself.
 */
export function transformEffectSubPaths(sps: SubPath[], e: TransformEffect, frame: Rect): SubPath[] {
  const step = transformStepMatrix(e, frame);
  const copies = Math.max(0, Math.min(500, Math.round(e.copies ?? 0)));
  if (copies === 0) return sps.map((sp) => transformSubPath(sp, step));
  const out: SubPath[] = [...sps];
  let m = step;
  for (let k = 1; k <= copies; k++) {
    for (const sp of sps) out.push(transformSubPath(sp, m));
    m = compose(step, m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tweak
// ---------------------------------------------------------------------------

/**
 * Tweak: anchor points and/or control points move by a random amount up to `horizontal`
 * and `vertical` (absolute, or a percentage of the frame size when `relative`).
 */
export function tweakSubPaths(sps: SubPath[], e: TweakEffect, frame: Rect): SubPath[] {
  const rnd = seededRandom(e.seed);
  const h = e.relative ? (frame.width * e.horizontal) / 100 : e.horizontal;
  const v = e.relative ? (frame.height * e.vertical) / 100 : e.vertical;
  if (!(Math.abs(h) > 1e-9 || Math.abs(v) > 1e-9)) return sps;
  const jitter = (): Vec => ({ x: (rnd() * 2 - 1) * h, y: (rnd() * 2 - 1) * v });
  return sps.map((sp) => ({
    closed: sp.closed,
    anchors: sp.anchors.map((a) => {
      const hin = a.handleIn ? absHandleIn(a) : null;
      const hout = a.handleOut ? absHandleOut(a) : null;
      const d = e.anchors ? jitter() : { x: 0, y: 0 };
      const p = { x: a.point.x + d.x, y: a.point.y + d.y };
      // handles keep their absolute position unless they are tweaked themselves
      const di = e.inControl ? jitter() : { x: 0, y: 0 };
      const dout = e.outControl ? jitter() : { x: 0, y: 0 };
      const nin = hin ? { x: hin.x + di.x - p.x, y: hin.y + di.y - p.y } : null;
      const nout = hout ? { x: hout.x + dout.x - p.x, y: hout.y + dout.y - p.y } : null;
      return makeAnchor(p, nin, nout, e.inControl || e.outControl ? 'corner' : a.kind);
    }),
  }));
}
