/**
 * Effect > Distort & Transform: Zig Zag, Pucker & Bloat, Roughen, Transform, Tweak —
 * live geometry effects (Illustrator's set), as pure subpath → subpath functions.
 * No React, no paper.js, so vitest covers them.
 */
import type { SubPath, Anchor, Vec, Rect, Matrix, ZigZagEffect, PuckerBloatEffect, RoughenEffect, TransformEffect, TweakEffect } from '@/model/types';
import { subpathToCubics, segmentCount, absHandleIn, absHandleOut, anchor as makeAnchor, transformSubPath } from '@/geometry/path';
import { cubicPoint, cubicDerivative, cubicLength, cubicTAtLength, cubicSplit, type Cubic } from '@/geometry/bezier';
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
 * Zig Zag, as Illustrator does it (measured through scripts/illustrator/effect-fixtures.mjs,
 * fixtures in tests/fixtures/effects/zigZag.json). Every segment gets `ridges` peaks at equal
 * arc-length spacing s = L / (ridges + 1), and the anchors take part as well: all points of the
 * result — anchors and peaks alike — are pushed off the path alternately (the first anchor to
 * one side, the next point to the other, …) by `size` along the local normal. A peak's normal
 * is the curve normal; an anchor's is the weighted mean of the normals of its two sides, the
 * weight of a straight side being its spacing s and of a curved side the length of the handle
 * its first (last) Bézier piece keeps after the split — a corner between a short and a long
 * edge therefore leans towards the long one. Smooth mode adds handles: s/2 along the path on
 * straight sides, the handles of the pieces between the peaks (de Casteljau) on curved sides,
 * so a circle stays a circle at size 0; a handle that sits on its anchor counts as straight.
 * (Illustrator itself puts the very last point of a closed path slightly off; that is not
 * reproduced.) `relative` keeps OPuller's meaning — size as % of the segment length — because
 * Illustrator's dialog bakes its relative size into an absolute amount.
 */
export function zigZagSubPath(sp: SubPath, e: ZigZagEffect): SubPath {
  const segs = segmentCount(sp);
  const ridges = Math.max(0, Math.round(e.ridges));
  if (segs < 1 || ridges === 0 || !(Math.abs(e.size) > 1e-9)) return sp;
  const n = sp.anchors.length;
  const cubics = subpathToCubics(sp);
  const EPS = 1e-9;
  const len = (v: Vec) => Math.hypot(v.x, v.y);
  const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
  const perp = (d: Vec): Vec => ({ x: -d.y, y: d.x });

  /** One segment split at its peaks: the pieces between consecutive points (a straight segment keeps `pieces` empty). */
  interface Seg {
    straight: boolean;
    dir: Vec; // unit direction of a straight segment
    spacing: number;
    amp: number;
    peaks: Vec[];
    normals: Vec[]; // unit normal at every peak
    pieces: Cubic[]; // ridges + 1 pieces for a curved segment
  }
  const segments: Seg[] = cubics.map((c) => {
    const straight = len(sub(c.p1, c.p0)) < EPS && len(sub(c.p3, c.p2)) < EPS;
    const L = cubicLength(c, 0.01);
    const spacing = L / (ridges + 1);
    const amp = e.relative ? (L * e.size) / 100 : e.size;
    const dir = norm(sub(c.p3, c.p0));
    const peaks: Vec[] = [];
    const normals: Vec[] = [];
    const pieces: Cubic[] = [];
    if (straight || L < EPS) {
      for (let k = 1; k <= ridges; k++) {
        peaks.push({ x: c.p0.x + dir.x * spacing * k, y: c.p0.y + dir.y * spacing * k });
        normals.push(perp(dir));
      }
    } else {
      // split at the arc-length-uniform parameters, piece by piece (de Casteljau)
      let rest = c;
      for (let k = 1; k <= ridges; k++) {
        const t = cubicTAtLength(rest, spacing);
        const [left, right] = cubicSplit(rest, t);
        pieces.push(left);
        peaks.push(right.p0);
        normals.push(perp(tangentAt(c, cubicTAtLength(c, spacing * k))));
        rest = right;
      }
      pieces.push(rest);
    }
    return { straight, dir, spacing, amp, peaks, normals, pieces };
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

  const points: Vec[] = [];
  const normals: Vec[] = [];
  const handleIn: Array<Vec | null> = [];
  const handleOut: Array<Vec | null> = [];
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
    points.push(p);
    normals.push(nrm);
    const spacingIn = hasIn ? segments[(i - 1 + segs) % segs].spacing : 0;
    const spacingOut = hasOut ? segments[i % segs].spacing : 0;
    handleIn.push(!sIn ? null : sIn.degenerate ? { x: -tangent.x * spacingIn * 0.5, y: -tangent.y * spacingIn * 0.5 } : sIn.handle);
    handleOut.push(!sOut ? null : sOut.degenerate ? { x: tangent.x * spacingOut * 0.5, y: tangent.y * spacingOut * 0.5 } : sOut.handle);
  };
  const amps: number[] = [];
  for (let s = 0; s < segs; s++) {
    pushAnchor(s);
    amps.push(s === 0 ? segments[0].amp : (segments[s - 1].amp + segments[s].amp) / 2);
    const g = segments[s];
    for (let k = 0; k < ridges; k++) {
      points.push(g.peaks[k]);
      normals.push(g.normals[k]);
      amps.push(g.amp);
      if (g.straight) {
        handleIn.push({ x: -g.dir.x * g.spacing * 0.5, y: -g.dir.y * g.spacing * 0.5 });
        handleOut.push({ x: g.dir.x * g.spacing * 0.5, y: g.dir.y * g.spacing * 0.5 });
      } else {
        handleIn.push(sub(g.pieces[k].p2, g.pieces[k].p3));
        handleOut.push(sub(g.pieces[k + 1].p1, g.pieces[k + 1].p0));
      }
    }
  }
  if (!sp.closed) {
    pushAnchor(n - 1);
    amps.push(segments[segs - 1].amp);
  }
  const anchors = points.map((p, i) => {
    const sign = i % 2 === 0 ? -1 : 1;
    const q = { x: p.x + normals[i].x * amps[i] * sign, y: p.y + normals[i].y * amps[i] * sign };
    if (!e.smooth) return makeAnchor(q, null, null, 'corner');
    const hin = handleIn[i];
    const hout = handleOut[i];
    return makeAnchor(q, hin, hout, kindFor(hin, hout));
  });
  return { anchors, closed: sp.closed };
}

export function zigZagSubPaths(sps: SubPath[], e: ZigZagEffect): SubPath[] {
  return sps.map((sp) => zigZagSubPath(sp, e));
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
