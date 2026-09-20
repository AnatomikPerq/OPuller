/**
 * Effect > Distort & Transform: Zig Zag, Pucker & Bloat, Roughen, Transform, Tweak —
 * live geometry effects (Illustrator's set), as pure subpath → subpath functions.
 * No React, no paper.js, so vitest covers them.
 */
import type { SubPath, Vec, Rect, Matrix, ZigZagEffect, PuckerBloatEffect, RoughenEffect, TransformEffect, TweakEffect } from '@/model/types';
import { subpathToCubics, segmentCount, absHandleIn, absHandleOut, anchor as makeAnchor, transformSubPath } from '@/geometry/path';
import { cubicDerivative, cubicLength, cubicTAtLength, cubicSplit, type Cubic } from '@/geometry/bezier';
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

// ---------------------------------------------------------------------------
// Resampling shared by Zig Zag and Roughen
// ---------------------------------------------------------------------------

/** A subpath resampled the way Illustrator's Zig Zag / Roughen do it (see `resampleSubPath`). */
interface Resampled {
  /** original anchors and inserted points, in path order */
  points: Vec[];
  /** unit normal at every point */
  normals: Vec[];
  /** smooth-mode handles (relative) */
  handleIn: Array<Vec | null>;
  handleOut: Array<Vec | null>;
  /** index of the original anchor a point is, or −1 for an inserted point */
  anchor: number[];
  /** the segment an inserted point lies on (the outgoing one for an anchor) */
  segment: number[];
  /** arc length of every segment */
  lengths: number[];
}

/**
 * Resample a subpath with `count(L, s)` inserted points on segment s (length L), spaced by equal
 * arc length. The normal at an inserted point is the curve normal; at an anchor it is the weighted
 * mean of the normals of its two sides, the weight of a straight side being its spacing and of a
 * curved side the length of the handle its first (last) Bézier piece keeps after the split — a
 * corner between a short and a long edge leans towards the long one. Smooth handles are half the
 * spacing along the path on straight sides and the handles of the pieces between the points (de
 * Casteljau) on curved sides, so a circle stays a circle when nothing moves; a handle that sits on
 * its anchor counts as straight. Measured on Illustrator 2026 (tests/fixtures/effects/zigZag.json).
 */
function resampleSubPath(sp: SubPath, count: (L: number, s: number) => number): Resampled | null {
  const segs = segmentCount(sp);
  if (segs < 1) return null;
  const n = sp.anchors.length;
  const cubics = subpathToCubics(sp);
  const EPS = 1e-9;
  const len = (v: Vec) => Math.hypot(v.x, v.y);
  const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
  const perp = (d: Vec): Vec => ({ x: -d.y, y: d.x });

  /** One segment split at its inserted points: the pieces between consecutive points (a straight segment keeps `pieces` empty). */
  interface Seg {
    straight: boolean;
    dir: Vec; // unit direction of a straight segment
    spacing: number;
    length: number;
    inner: number;
    peaks: Vec[];
    normals: Vec[]; // unit normal at every inserted point
    pieces: Cubic[]; // inner + 1 pieces for a curved segment
  }
  const segments: Seg[] = cubics.map((c, s) => {
    const straight = len(sub(c.p1, c.p0)) < EPS && len(sub(c.p3, c.p2)) < EPS;
    const L = cubicLength(c, 0.01);
    const inner = Math.max(0, Math.round(count(L, s)));
    const spacing = L / (inner + 1);
    const dir = norm(sub(c.p3, c.p0));
    const peaks: Vec[] = [];
    const normals: Vec[] = [];
    const pieces: Cubic[] = [];
    if (straight || L < EPS) {
      for (let k = 1; k <= inner; k++) {
        peaks.push({ x: c.p0.x + dir.x * spacing * k, y: c.p0.y + dir.y * spacing * k });
        normals.push(perp(dir));
      }
    } else {
      // split at the arc-length-uniform parameters, piece by piece (de Casteljau)
      let rest = c;
      for (let k = 1; k <= inner; k++) {
        const t = cubicTAtLength(rest, spacing);
        const [left, right] = cubicSplit(rest, t);
        pieces.push(left);
        peaks.push(right.p0);
        normals.push(perp(tangentAt(c, cubicTAtLength(c, spacing * k))));
        rest = right;
      }
      pieces.push(rest);
    }
    return { straight, dir, spacing, length: L, inner, peaks, normals, pieces };
  });

  /** Tangent direction, weight and smooth-mode handle of the side of an anchor that starts segment s (out) or ends it (in). */
  const side = (s: number, out: boolean): { dir: Vec; weight: number; handle: Vec | null; degenerate: boolean } => {
    const g = segments[s];
    if (g.straight) return { dir: out ? g.dir : { x: -g.dir.x, y: -g.dir.y }, weight: g.spacing, handle: null, degenerate: true };
    const piece = out ? g.pieces[0] : g.pieces[g.pieces.length - 1];
    const a = out ? piece.p0 : piece.p3;
    const h1 = sub(out ? piece.p1 : piece.p2, a);
    if (len(h1) > EPS) return { dir: norm(h1), weight: len(h1), handle: h1, degenerate: false };
    // a handle on its anchor: the direction and weight come from the next control point, the smooth handle is spacing / 2
    const h2 = sub(out ? piece.p2 : piece.p1, a);
    return { dir: norm(h2), weight: len(h2), handle: null, degenerate: true };
  };

  const out: Resampled = { points: [], normals: [], handleIn: [], handleOut: [], anchor: [], segment: [], lengths: segments.map((g) => g.length) };
  const pushAnchor = (i: number) => {
    const p = sp.anchors[i].point;
    const hasIn = sp.closed || i > 0;
    const hasOut = sp.closed || i < n - 1;
    const sIn = hasIn ? side((i - 1 + segs) % segs, false) : null;
    const sOut = hasOut ? side(i % segs, true) : null;
    // unit normals of both sides (the incoming side's tangent points back along the path), weighted
    let nx = 0;
    let ny = 0;
    if (sIn) {
      const t = { x: -sIn.dir.x, y: -sIn.dir.y };
      nx += -t.y * sIn.weight;
      ny += t.x * sIn.weight;
    }
    if (sOut) {
      nx += -sOut.dir.y * sOut.weight;
      ny += sOut.dir.x * sOut.weight;
    }
    const nrm = norm({ x: nx, y: ny });
    const tangent = { x: nrm.y, y: -nrm.x };
    out.points.push(p);
    out.normals.push(nrm);
    out.anchor.push(i);
    out.segment.push(hasOut ? i % segs : (i - 1 + segs) % segs);
    const spacingIn = hasIn ? segments[(i - 1 + segs) % segs].spacing : 0;
    const spacingOut = hasOut ? segments[i % segs].spacing : 0;
    out.handleIn.push(!sIn ? null : sIn.degenerate ? { x: -tangent.x * spacingIn * 0.5, y: -tangent.y * spacingIn * 0.5 } : sIn.handle);
    out.handleOut.push(!sOut ? null : sOut.degenerate ? { x: tangent.x * spacingOut * 0.5, y: tangent.y * spacingOut * 0.5 } : sOut.handle);
  };
  for (let s = 0; s < segs; s++) {
    pushAnchor(s);
    const g = segments[s];
    for (let k = 0; k < g.inner; k++) {
      out.points.push(g.peaks[k]);
      out.normals.push(g.normals[k]);
      out.anchor.push(-1);
      out.segment.push(s);
      if (g.straight) {
        out.handleIn.push({ x: -g.dir.x * g.spacing * 0.5, y: -g.dir.y * g.spacing * 0.5 });
        out.handleOut.push({ x: g.dir.x * g.spacing * 0.5, y: g.dir.y * g.spacing * 0.5 });
      } else {
        out.handleIn.push(sub(g.pieces[k].p2, g.pieces[k].p3));
        out.handleOut.push(sub(g.pieces[k + 1].p1, g.pieces[k + 1].p0));
      }
    }
  }
  if (!sp.closed) pushAnchor(n - 1);
  return out;
}

/** Anchors of a resampled subpath after moving every point by `offset(i)` along its normal (smooth mode keeps the handles). */
function displaced(r: Resampled, closed: boolean, smooth: boolean, offset: (i: number) => number): SubPath {
  const anchors = r.points.map((p, i) => {
    const d = offset(i);
    const q = { x: p.x + r.normals[i].x * d, y: p.y + r.normals[i].y * d };
    if (!smooth) return makeAnchor(q, null, null, 'corner');
    const hin = r.handleIn[i];
    const hout = r.handleOut[i];
    return makeAnchor(q, hin, hout, kindFor(hin, hout));
  });
  return { anchors, closed };
}

// ---------------------------------------------------------------------------
// Zig Zag
// ---------------------------------------------------------------------------

/**
 * Zig Zag, as Illustrator does it (measured through scripts/illustrator/effect-fixtures.mjs,
 * fixtures in tests/fixtures/effects/zigZag.json). Every segment gets `ridges` peaks at equal
 * arc-length spacing, and the anchors take part as well: all points of the result — anchors and
 * peaks alike — are pushed off the path alternately (the first anchor to one side, the next
 * point to the other, …) by `size` along the local normal (see `resampleSubPath` for the normals
 * and the smooth-mode handles). Illustrator itself puts the very last point of a closed path
 * slightly off; that is not reproduced. `relative` keeps OPuller's meaning — size as % of the
 * segment length — because Illustrator's dialog bakes its relative size into an absolute amount.
 */
export function zigZagSubPath(sp: SubPath, e: ZigZagEffect): SubPath {
  const ridges = Math.max(0, Math.round(e.ridges));
  if (ridges === 0 || !(Math.abs(e.size) > 1e-9)) return sp;
  const r = resampleSubPath(sp, () => ridges);
  if (!r) return sp;
  const segs = r.lengths.length;
  const ampOf = (s: number) => (e.relative ? (r.lengths[s] * e.size) / 100 : e.size);
  return displaced(r, sp.closed, e.smooth, (i) => {
    const sign = i % 2 === 0 ? -1 : 1;
    const a = r.anchor[i];
    // an anchor between two segments takes the mean of their amplitudes (relative mode)
    const amp = a < 0 ? ampOf(r.segment[i]) : sp.closed || (a > 0 && a < sp.anchors.length - 1) ? (ampOf((a - 1 + segs) % segs) + ampOf(a % segs)) / 2 : ampOf(r.segment[i]);
    return sign * amp;
  });
}

export function zigZagSubPaths(sps: SubPath[], e: ZigZagEffect): SubPath[] {
  return sps.map((sp) => zigZagSubPath(sp, e));
}

// ---------------------------------------------------------------------------
// Roughen
// ---------------------------------------------------------------------------

/**
 * Roughen, structured like Illustrator's (measured on Illustrator 2026 with a negligible size):
 * every segment of length L is cut into round(L · detail / 72) equal arc-length pieces — Illustrator
 * counts `detail` points per inch of 72 units — and every point, the anchors included, moves along
 * its normal (see `resampleSubPath`) by a random amount up to `size`: px, or `size` % of the object's
 * longer side when `relative`. Smooth mode keeps the handles of the resampling, so the outline
 * wobbles instead of jagging. The random sequence itself is OPuller's own (`seed` keeps it stable).
 */
export function roughenSubPath(sp: SubPath, e: RoughenEffect, frame: Rect, rnd: () => number): SubPath {
  const size = e.relative ? (Math.max(frame.width, frame.height) * e.size) / 100 : e.size;
  if (!(size > 1e-9)) return sp;
  const detail = Math.max(0.1, e.detail);
  const r = resampleSubPath(sp, (L) => Math.max(1, Math.round((L * detail) / 72)) - 1);
  if (!r) return sp;
  return displaced(r, sp.closed, e.smooth, () => (rnd() * 2 - 1) * size);
}

export function roughenSubPaths(sps: SubPath[], e: RoughenEffect, frame: Rect): SubPath[] {
  const rnd = seededRandom(e.seed);
  return sps.map((sp) => roughenSubPath(sp, e, frame, rnd));
}

// ---------------------------------------------------------------------------
// Pucker & Bloat
// ---------------------------------------------------------------------------

/** Anchor kind from its handles: smooth when both exist and are opposite and collinear. */
function kindFor(hin: Vec | null, hout: Vec | null): 'corner' | 'smooth' {
  if (!hin || !hout) return 'corner';
  const dot = hin.x * hout.x + hin.y * hout.y;
  const cross = hin.x * hout.y - hin.y * hout.x;
  return dot < 0 && Math.abs(cross) <= 1e-6 * Math.hypot(hin.x, hin.y) * Math.hypot(hout.x, hout.y) ? 'smooth' : 'corner';
}

/**
 * Pucker & Bloat, exactly as Illustrator does it (measured through scripts/illustrator/
 * effect-fixtures.mjs, fixtures in tests/fixtures/effects/puckerBloat.json): with C the
 * centre of the object's tight bounds and a = amount / 100, every anchor moves towards C
 * (P′ = P + a·(C − P)) while every handle end moves away from it by the same factor
 * (H′ = H + a·(H − C)); a handle that sits on its anchor ends up at P − a·(C − P), so a
 * square's corners grow the diagonal "petal" handles. Bloat (positive) rounds segments
 * outward, pucker (negative) draws them inward, 200 % sends the anchors through the centre.
 */
export function puckerBloatSubPath(sp: SubPath, amount: number, centre: Vec): SubPath {
  const a = amount / 100;
  if (sp.anchors.length < 2 || Math.abs(a) < 1e-9) return sp;
  const anchors = sp.anchors.map((an) => {
    const p = an.point;
    const moved = { x: p.x + (centre.x - p.x) * a, y: p.y + (centre.y - p.y) * a };
    const handle = (h: Vec | null): Vec => {
      const abs = h ? { x: p.x + h.x, y: p.y + h.y } : p;
      return { x: abs.x + (abs.x - centre.x) * a - moved.x, y: abs.y + (abs.y - centre.y) * a - moved.y };
    };
    const hin = handle(an.handleIn);
    const hout = handle(an.handleOut);
    return makeAnchor(moved, hin, hout, kindFor(hin, hout));
  });
  return { anchors, closed: sp.closed };
}

export function puckerBloatSubPaths(sps: SubPath[], e: PuckerBloatEffect, frame: Rect): SubPath[] {
  const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  return sps.map((sp) => puckerBloatSubPath(sp, e.amount, centre));
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
