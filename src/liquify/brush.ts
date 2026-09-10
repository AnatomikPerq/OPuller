/**
 * Liquify brushes (Illustrator's Warp / Twirl / Pucker / Bloat / Scallop /
 * Crystallize / Wrinkle tools): pure maths shared by the canvas tools and the
 * scripting API.
 *
 * A brush is an ellipse in world units. Every step of a gesture displaces the
 * anchors (and handle end points) of the touched subpaths by a vector field
 * that fades out towards the edge of the brush. Segments passing through the
 * brush are subdivided first (the "Detail" option sets the spacing) so the
 * deformation can be represented; the tool re-fits the touched anchors
 * afterwards ("Simplify").
 *
 * No React and no paper.js here so vitest can cover it.
 */
import type { SubPath, Anchor, Vec } from '@/model/types';
import type { Cubic } from '@/geometry/bezier';
import { cubicSplit, cubicLength, cubicPoint } from '@/geometry/bezier';
import { segmentCount, segmentCubic, hasHandle, inferAnchorKind } from '@/geometry/path';

export type LiquifyKind = 'warp' | 'twirl' | 'pucker' | 'bloat' | 'scallop' | 'crystallize' | 'wrinkle';

export const LIQUIFY_KINDS: LiquifyKind[] = ['warp', 'twirl', 'pucker', 'bloat', 'scallop', 'crystallize', 'wrinkle'];

/** An elliptical brush in world units; `angle` in degrees, counter-clockwise positive (Illustrator). */
export interface Brush {
  x: number;
  y: number;
  /** half width / half height */
  rx: number;
  ry: number;
  angle: number;
}

/** Options shared by all liquify tools ("Global Brush Dimensions"). */
export interface GlobalBrushOptions {
  width: number;
  height: number;
  angle: number;
  /** 1..100 */
  intensity: number;
  usePressure: boolean;
}

/** Options of one liquify tool (global + tool specific). */
export interface LiquifyOptions extends GlobalBrushOptions {
  /** 1..50: density of anchors added under the brush (points per brush width) */
  detail: number;
  /** 0..100: how much the touched portion is simplified after the gesture */
  simplify: number;
  /** twirl: degrees, negative = clockwise */
  rate: number;
  /** scallop / crystallize / wrinkle: 1..15 */
  complexity: number;
  /** wrinkle: 0..100 */
  horizontal: number;
  vertical: number;
  /** scallop / crystallize / wrinkle: what the brush moves */
  affectAnchors: boolean;
  affectIn: boolean;
  affectOut: boolean;
}

export const GLOBAL_DEFAULTS: GlobalBrushOptions = { width: 100, height: 100, angle: 0, intensity: 50, usePressure: false };

export const TOOL_DEFAULTS: Record<LiquifyKind, LiquifyOptions> = {
  warp: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 50, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: true, affectOut: true },
  twirl: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 50, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: true, affectOut: true },
  pucker: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 50, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: true, affectOut: true },
  bloat: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 50, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: true, affectOut: true },
  scallop: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 0, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: false, affectOut: false },
  crystallize: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 0, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: false, affectOut: false },
  wrinkle: { ...GLOBAL_DEFAULTS, detail: 2, simplify: 0, rate: 40, complexity: 2, horizontal: 0, vertical: 100, affectAnchors: true, affectIn: false, affectOut: false },
};

export const GLOBAL_KEYS: Array<keyof GlobalBrushOptions> = ['width', 'height', 'angle', 'intensity', 'usePressure'];

/** Per step strength of the timed tools (applied ~25 times per second while the button is held). */
export const STEP = { twirl: 0.1, pucker: 0.06, bloat: 0.06, scallop: 0.03, crystallize: 0.03, wrinkle: 0.03 } as const;

/** One deformation step. */
export interface DeformParams {
  kind: LiquifyKind;
  brush: Brush;
  /** 0..1 (intensity × pressure) */
  strength: number;
  /** warp: pointer movement of this step (world units) */
  delta?: Vec;
  /** twirl: degrees per second at full strength (negative = clockwise) */
  rate?: number;
  /** scallop / crystallize / wrinkle: 1..15 */
  complexity?: number;
  /** wrinkle: 0..1 */
  horizontal?: number;
  vertical?: number;
  /** random phase of the detail tools (0..1) */
  seed?: number;
  /** spacing of anchors added under the brush (world units) */
  spacing: number;
  affectAnchors?: boolean;
  affectIn?: boolean;
  affectOut?: boolean;
}

// ---------------------------------------------------------------------------
// Brush frame
// ---------------------------------------------------------------------------

interface Frame {
  c: Vec;
  /** unit vectors of the width / height axes */
  e1: Vec;
  e2: Vec;
  rx: number;
  ry: number;
  /** axis aligned half extents (bounding box of the ellipse) */
  hx: number;
  hy: number;
}

export function brushFrame(b: Brush): Frame {
  const t = (b.angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const rx = Math.max(0.5, b.rx);
  const ry = Math.max(0.5, b.ry);
  return {
    c: { x: b.x, y: b.y },
    // counter-clockwise on a y-down screen
    e1: { x: cos, y: -sin },
    e2: { x: sin, y: cos },
    rx,
    ry,
    hx: Math.hypot(rx * cos, ry * sin),
    hy: Math.hypot(rx * sin, ry * cos),
  };
}

/** Normalised distance from the brush centre (1 = on the ellipse edge). */
export function brushDistance(f: Frame, p: Vec): number {
  const dx = p.x - f.c.x;
  const dy = p.y - f.c.y;
  const u = (dx * f.e1.x + dy * f.e1.y) / f.rx;
  const v = (dx * f.e2.x + dy * f.e2.y) / f.ry;
  return Math.hypot(u, v);
}

/** Smooth falloff: 1 at the centre, 0 at the edge. */
export function falloff(r: number): number {
  if (r >= 1) return 0;
  const t = 1 - r * r;
  return t * t;
}

/** Outline of the brush as a polygon (world units), for overlays. */
export function brushOutline(b: Brush, steps = 48): Vec[] {
  const f = brushFrame(b);
  const out: Vec[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const u = Math.cos(a) * f.rx;
    const v = Math.sin(a) * f.ry;
    out.push({ x: f.c.x + f.e1.x * u + f.e2.x * v, y: f.c.y + f.e1.y * u + f.e2.y * v });
  }
  return out;
}

/** Axis-aligned bounds of the brush. */
export function brushBounds(b: Brush): { x: number; y: number; width: number; height: number } {
  const f = brushFrame(b);
  return { x: f.c.x - f.hx, y: f.c.y - f.hy, width: f.hx * 2, height: f.hy * 2 };
}

/** Anchor spacing under the brush for a Detail value (1..50). */
export function spacingFor(width: number, height: number, detail: number): number {
  const d = Math.max(1, Math.min(50, detail));
  const size = Math.max(2, Math.min(width, height));
  return Math.max(0.75, size / (d * 2));
}

/** Simplify tolerance in world units for a Simplify value (0..100). */
export function simplifyTolerance(simplify: number): number {
  return Math.max(0, Math.min(100, simplify)) * 0.03;
}

// ---------------------------------------------------------------------------
// Displacement fields
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;

/** 0..1 profile with `count` bumps per turn (scallop). */
function bumps(alpha: number, count: number, seed: number): number {
  const k = count;
  const phase = seed * TWO_PI;
  const main = 0.5 + 0.5 * Math.cos(k * alpha + phase);
  const mod = 0.8 + 0.2 * Math.cos(1.7 * k * alpha + phase * 2.3);
  return main * mod;
}

/** 0..1 profile with `count` sharp spikes per turn (crystallize). */
function spikes(alpha: number, count: number, seed: number): number {
  const x = (count * alpha) / TWO_PI + seed;
  const t = x - Math.floor(x);
  const spike = Math.max(0, 1 - Math.abs(t - 0.5) * 3);
  const mod = 0.7 + 0.3 * Math.cos(2.9 * count * alpha + seed * 5.1);
  return spike * mod;
}

export function ripplesPerTurn(complexity: number): number {
  return 3 + Math.max(1, Math.min(15, complexity)) * 3;
}

/**
 * Displacement of a world point for one step. Returns null when the point is
 * outside the brush.
 */
export function displacement(f: Frame, p: Vec, params: DeformParams): Vec | null {
  const r = brushDistance(f, p);
  if (r >= 1) return null;
  const w = falloff(r) * params.strength;
  if (w <= 0) return null;
  const dx = p.x - f.c.x;
  const dy = p.y - f.c.y;
  const R = Math.min(f.rx, f.ry);
  switch (params.kind) {
    case 'warp': {
      const d = params.delta ?? { x: 0, y: 0 };
      return { x: d.x * w, y: d.y * w };
    }
    case 'twirl': {
      const deg = (params.rate ?? 40) * w * STEP.twirl;
      const phi = (deg * Math.PI) / 180;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      // counter-clockwise on screen for positive angles
      const nx = dx * cos + dy * sin;
      const ny = -dx * sin + dy * cos;
      return { x: nx - dx, y: ny - dy };
    }
    case 'pucker': {
      const k = w * STEP.pucker;
      return { x: -dx * k, y: -dy * k };
    }
    case 'bloat': {
      const k = w * STEP.bloat;
      return { x: dx * k, y: dy * k };
    }
    case 'scallop':
    case 'crystallize': {
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return null;
      const alpha = Math.atan2(dy, dx);
      const count = ripplesPerTurn(params.complexity ?? 2);
      const seed = params.seed ?? 0;
      const profile = params.kind === 'scallop' ? bumps(alpha, count, seed) : spikes(alpha, count, seed);
      const mag = R * STEP[params.kind] * w * profile;
      const sign = params.kind === 'scallop' ? -1 : 1;
      return { x: (dx / len) * mag * sign, y: (dy / len) * mag * sign };
    }
    case 'wrinkle': {
      const count = ripplesPerTurn(params.complexity ?? 2) / 2;
      const seed = (params.seed ?? 0) * TWO_PI;
      const h = params.horizontal ?? 0;
      const v = params.vertical ?? 1;
      const mag = R * STEP.wrinkle * w;
      const nx = Math.sin((count * dy) / R + seed) * h;
      const ny = Math.sin((count * dx) / R + seed * 1.7 + 1) * v;
      return { x: nx * mag, y: ny * mag };
    }
  }
}

// ---------------------------------------------------------------------------
// Subdivision
// ---------------------------------------------------------------------------

function nearBrush(f: Frame, c: Cubic): boolean {
  // quick reject with the control polygon bounds against the brush bounds
  const minX = Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x);
  const maxX = Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x);
  const minY = Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y);
  const maxY = Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y);
  if (maxX < f.c.x - f.hx || minX > f.c.x + f.hx || maxY < f.c.y - f.hy || minY > f.c.y + f.hy) return false;
  for (let i = 0; i <= 8; i++) {
    if (brushDistance(f, cubicPoint(c, i / 8)) < 1.05) return true;
  }
  return false;
}

/** Split a cubic into n pieces of equal parameter length. */
function splitEven(c: Cubic, n: number): Cubic[] {
  const out: Cubic[] = [];
  let rest = c;
  for (let k = 1; k < n; k++) {
    const [l, r] = cubicSplit(rest, 1 / (n - k + 1));
    out.push(l);
    rest = r;
  }
  out.push(rest);
  return out;
}

function straight(a: Anchor, b: Anchor): boolean {
  return !hasHandle(a.handleOut) && !hasHandle(b.handleIn);
}

/**
 * Per-anchor gesture flag: 0 = original and untouched, 1 = inserted on a
 * curve, 2 = moved, 3 = inserted on a straight segment (collinear handles).
 */
export type TouchFlag = 0 | 1 | 2 | 3;

/**
 * Subdivide the segments of a subpath that pass through the brush so that no
 * segment under the brush is longer than `spacing`. `touched` (one flag per
 * anchor) is kept in sync; inserted anchors are flagged 1.
 */
export function subdivideUnderBrush(sp: SubPath, brush: Brush, spacing: number, touched?: TouchFlag[]): { sp: SubPath; touched: TouchFlag[]; inserted: number } {
  const f = brushFrame(brush);
  const n = segmentCount(sp);
  const N = sp.anchors.length;
  const flags = touched && touched.length === N ? touched.slice() : new Array<TouchFlag>(N).fill(0);
  if (n === 0) return { sp, touched: flags, inserted: 0 };
  const minSpacing = Math.max(0.25, spacing);
  // pieces per segment (null = untouched)
  const splits: Array<Cubic[] | null> = new Array(n).fill(null);
  const lines: boolean[] = new Array(n).fill(false);
  let any = false;
  for (let i = 0; i < n; i++) {
    const c = segmentCubic(sp, i);
    if (!nearBrush(f, c)) continue;
    const len = cubicLength(c);
    const pieces = Math.min(64, Math.floor(len / minSpacing));
    if (pieces < 2) continue;
    const a = sp.anchors[i];
    const b = sp.anchors[(i + 1) % N];
    lines[i] = straight(a, b);
    if (lines[i]) {
      // even spacing by distance along the line; the pieces get collinear
      // handles at the thirds so the brush can bend them into curves
      const parts: Cubic[] = [];
      const dx = b.point.x - a.point.x;
      const dy = b.point.y - a.point.y;
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const p0 = { x: a.point.x + dx * t0, y: a.point.y + dy * t0 };
        const p3 = { x: a.point.x + dx * t1, y: a.point.y + dy * t1 };
        const p1 = { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 };
        const p2 = { x: p0.x + ((p3.x - p0.x) * 2) / 3, y: p0.y + ((p3.y - p0.y) * 2) / 3 };
        parts.push({ p0, p1, p2, p3 });
      }
      splits[i] = parts;
    } else splits[i] = splitEven(c, pieces);
    any = true;
  }
  if (!any) return { sp, touched: flags, inserted: 0 };
  const anchors: Anchor[] = [];
  const outFlags: TouchFlag[] = [];
  let inserted = 0;
  for (let i = 0; i < N; i++) {
    const a = sp.anchors[i];
    const prevSeg = i > 0 ? i - 1 : sp.closed ? n - 1 : -1;
    let handleIn: Vec | null = a.handleIn ? { ...a.handleIn } : null;
    let handleOut: Vec | null = a.handleOut ? { ...a.handleOut } : null;
    if (prevSeg >= 0 && splits[prevSeg]) {
      const last = splits[prevSeg]![splits[prevSeg]!.length - 1];
      handleIn = { x: last.p2.x - a.point.x, y: last.p2.y - a.point.y };
    }
    if (i < n && splits[i]) {
      const first = splits[i]![0];
      handleOut = { x: first.p1.x - a.point.x, y: first.p1.y - a.point.y };
    }
    const cur: Anchor = { point: { ...a.point }, handleIn, handleOut, kind: a.kind };
    inferAnchorKind(cur);
    anchors.push(cur);
    outFlags.push(flags[i]);
    if (i >= n || !splits[i]) continue;
    const parts = splits[i]!;
    for (let k = 1; k < parts.length; k++) {
      const prev = parts[k - 1];
      const next = parts[k];
      const pt = { x: prev.p3.x, y: prev.p3.y };
      const na: Anchor = { point: pt, handleIn: { x: prev.p2.x - pt.x, y: prev.p2.y - pt.y }, handleOut: { x: next.p1.x - pt.x, y: next.p1.y - pt.y }, kind: 'smooth' };
      anchors.push(na);
      outFlags.push(lines[i] ? 3 : 1);
      inserted++;
    }
  }
  return { sp: { anchors, closed: sp.closed }, touched: outFlags, inserted };
}

// ---------------------------------------------------------------------------
// Deformation
// ---------------------------------------------------------------------------

/**
 * Apply one deformation step to subpaths (world units). Segments under the
 * brush are subdivided first. Returns the new subpaths, the touched flags per
 * subpath (one per anchor) and whether anything moved.
 */
export function deformSubPaths(sps: SubPath[], params: DeformParams, touched?: TouchFlag[][]): { sps: SubPath[]; touched: TouchFlag[][]; changed: boolean } {
  const f = brushFrame(params.brush);
  const outSps: SubPath[] = [];
  const outTouched: TouchFlag[][] = [];
  let changed = false;
  const affectAnchors = params.affectAnchors !== false;
  const affectIn = params.affectIn !== false;
  const affectOut = params.affectOut !== false;
  sps.forEach((sp0, si) => {
    const sub = subdivideUnderBrush(sp0, params.brush, params.spacing, touched?.[si]);
    const sp = sub.sp;
    const flags = sub.touched;
    if (sub.inserted) changed = true;
    for (let i = 0; i < sp.anchors.length; i++) {
      const a = sp.anchors[i];
      const p = a.point;
      const dp = affectAnchors ? displacement(f, p, params) : null;
      const inAbs = hasHandle(a.handleIn) ? { x: p.x + a.handleIn.x, y: p.y + a.handleIn.y } : null;
      const outAbs = hasHandle(a.handleOut) ? { x: p.x + a.handleOut.x, y: p.y + a.handleOut.y } : null;
      const dIn = inAbs && affectIn ? displacement(f, inAbs, params) : null;
      const dOut = outAbs && affectOut ? displacement(f, outAbs, params) : null;
      if (!dp && !dIn && !dOut) continue;
      const np = dp ? { x: p.x + dp.x, y: p.y + dp.y } : p;
      let moved = !!dp && (Math.abs(dp.x) > 1e-9 || Math.abs(dp.y) > 1e-9);
      if (inAbs) {
        const ni = dIn ? { x: inAbs.x + dIn.x, y: inAbs.y + dIn.y } : inAbs;
        a.handleIn = { x: ni.x - np.x, y: ni.y - np.y };
        if (dIn && (Math.abs(dIn.x) > 1e-9 || Math.abs(dIn.y) > 1e-9)) moved = true;
      }
      if (outAbs) {
        const no = dOut ? { x: outAbs.x + dOut.x, y: outAbs.y + dOut.y } : outAbs;
        a.handleOut = { x: no.x - np.x, y: no.y - np.y };
        if (dOut && (Math.abs(dOut.x) > 1e-9 || Math.abs(dOut.y) > 1e-9)) moved = true;
      }
      a.point = np;
      if (moved) {
        flags[i] = 2;
        changed = true;
        inferAnchorKind(a);
      }
    }
    outSps.push(sp);
    outTouched.push(flags);
  });
  return { sps: outSps, touched: outTouched, changed };
}

/**
 * Contiguous runs of anchors the gesture touched (moved or inserted), rotated
 * so that no run wraps (closed subpaths). Used by the Simplify pass.
 */
export function touchedRuns(sp: SubPath, touched: TouchFlag[]): { sp: SubPath; touched: TouchFlag[]; runs: Array<{ i: number; j: number }>; whole: boolean } {
  const N = sp.anchors.length;
  if (!N || touched.length !== N) return { sp, touched, runs: [], whole: false };
  const on = (t: TouchFlag) => t > 0;
  if (touched.every(on)) return { sp, touched, runs: [], whole: true };
  if (!touched.some(on)) return { sp, touched, runs: [], whole: false };
  let anchors = sp.anchors;
  let flags = touched;
  if (sp.closed) {
    const u = touched.findIndex((t) => !on(t));
    if (u > 0) {
      anchors = anchors.slice(u).concat(anchors.slice(0, u));
      flags = touched.slice(u).concat(touched.slice(0, u));
    }
  }
  const runs: Array<{ i: number; j: number }> = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const hit = i < flags.length && on(flags[i]);
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) {
      runs.push({ i: start, j: i - 1 });
      start = -1;
    }
  }
  return { sp: { anchors, closed: sp.closed }, touched: flags, runs, whole: false };
}

function collinearWith(h: Vec | null, dir: Vec): boolean {
  if (!hasHandle(h)) return true;
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-9) return false;
  const cross = (h.x * dir.y - h.y * dir.x) / len;
  const dot = (h.x * dir.x + h.y * dir.y) / len;
  return Math.abs(cross) < 1e-6 && dot > 0;
}

/**
 * Drop anchors the brush inserted on straight segments but never moved (they
 * are collinear with their neighbours) and turn the collinear handles left on
 * unmoved straight stretches back into plain lines. Keeps the flags in sync.
 */
export function dropUnusedInserted(sp: SubPath, touched: TouchFlag[]): { sp: SubPath; touched: TouchFlag[] } {
  const N = sp.anchors.length;
  if (touched.length !== N || !touched.includes(3)) return { sp, touched };
  const keep: boolean[] = new Array(N).fill(true);
  for (let i = 0; i < N; i++) {
    if (touched[i] !== 3) continue;
    const first = !sp.closed && i === 0;
    const last = !sp.closed && i === N - 1;
    if (first || last) continue;
    const pi = (i - 1 + N) % N;
    const ni = (i + 1) % N;
    // the neighbours must not have moved (otherwise this point is a kink)
    if (touched[pi] === 2 || touched[ni] === 2) continue;
    keep[i] = false;
  }
  const anchors = sp.anchors.filter((_, i) => keep[i]).map((a) => ({ point: { ...a.point }, handleIn: a.handleIn ? { ...a.handleIn } : null, handleOut: a.handleOut ? { ...a.handleOut } : null, kind: a.kind }));
  const flags = touched.filter((_, i) => keep[i]);
  // straighten unmoved stretches whose handles are still collinear
  const M = anchors.length;
  const segs = sp.closed ? M : M - 1;
  for (let i = 0; i < segs; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % M];
    if (flags[i] === 2 || flags[(i + 1) % M] === 2) continue;
    const dir = { x: b.point.x - a.point.x, y: b.point.y - a.point.y };
    if (!hasHandle(a.handleOut) && !hasHandle(b.handleIn)) continue;
    if (collinearWith(a.handleOut, dir) && collinearWith(b.handleIn, { x: -dir.x, y: -dir.y })) {
      a.handleOut = null;
      b.handleIn = null;
    }
  }
  for (const a of anchors) inferAnchorKind(a);
  return { sp: { anchors, closed: sp.closed }, touched: flags };
}
