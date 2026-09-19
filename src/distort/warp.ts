/**
 * Warp effect (Illustrator's 15 warp presets), reproduced from measurements of
 * Illustrator 2026 (`scripts/illustrator/warp-fixtures.mjs`, fixtures in `tests/fixtures/warp/`).
 *
 * Every warp is ONE bicubic Bézier patch over the object's frame: a 4×4 control net
 * P[j][c] (row j ↔ v, column c ↔ u) evaluated with Bernstein weights. A point at unit
 * coordinates (u, v) of the frame lands on the patch at (u, v) — straight axis-aligned
 * segments therefore become single cubics, exactly as Illustrator's Expand produces them.
 *
 * Construction, in frame pixels (y down):
 *  1. the "pure" net of the style for the bend (arcs: chord = frame width, angle = bend·180°,
 *     handles k = 4/3·tan(θ/4); the rest are simple multiples of W / H);
 *  2. the distortions, applied as scalings of the net's columns (horizontal distortion,
 *     factor 1 + h·(2u − 1) about the column's chord midpoint) and rows (vertical distortion,
 *     factor 1 + v·(2v − 1) about the row's chord midpoint), horizontal first. How the
 *     interior follows differs per style family:
 *       A  arc-like, flag, fish, rise — the top/bottom rows are curves, the sides stay straight
 *          lines between the corners and the interior is the bilinear Coons patch of the boundary;
 *       B  twist, fisheye, shells — every control point is scaled with its own row and column;
 *       C  wave, inflate, squeeze — the frame is scaled like B but the handles next to a boundary
 *          row/column follow that boundary's factor, and the style's own displacement is added
 *          afterwards scaled by the local column height (wave) or by the nearest edge (inflate).
 *  3. the vertical axis is the transposition of the horizontal case with the distortions swapped
 *     (and therefore applied in the opposite order); Illustrator additionally shifts the vertical
 *     Rise so that the top edge stays put.
 *
 * Pure maths: no React, no paper.js, so vitest can compare it with the fixtures.
 */
import type { Rect, Vec, WarpEffect, WarpStyle, SubPath } from '@/model/types';
import { toUnit, fromUnit, mapSubPaths, type PointMap } from './map';
import type { Cubic } from '@/geometry/bezier';

export const WARP_STYLES: Array<{ id: WarpStyle; label: string }> = [
  { id: 'arc', label: 'Arc' },
  { id: 'arcLower', label: 'Arc Lower' },
  { id: 'arcUpper', label: 'Arc Upper' },
  { id: 'arch', label: 'Arch' },
  { id: 'bulge', label: 'Bulge' },
  { id: 'shellLower', label: 'Shell Lower' },
  { id: 'shellUpper', label: 'Shell Upper' },
  { id: 'flag', label: 'Flag' },
  { id: 'wave', label: 'Wave' },
  { id: 'fish', label: 'Fish' },
  { id: 'rise', label: 'Rise' },
  { id: 'fisheye', label: 'Fisheye' },
  { id: 'inflate', label: 'Inflate' },
  { id: 'squeeze', label: 'Squeeze' },
  { id: 'twist', label: 'Twist' },
];

/** 16 control points, row-major: index = row * 4 + column; frame-relative pixels. */
export type WarpNet = Vec[];

type Family = 'A' | 'B' | 'C';
const FAMILY: Record<WarpStyle, Family> = {
  arc: 'A', arcLower: 'A', arcUpper: 'A', arch: 'A', bulge: 'A', flag: 'A', fish: 'A', rise: 'A',
  twist: 'B', fisheye: 'B', shellUpper: 'B', shellLower: 'B',
  wave: 'C', inflate: 'C', squeeze: 'C',
};

const T = [0, 1 / 3, 2 / 3, 1];
const idx = (row: number, col: number) => row * 4 + col;
const NEAREST = [0, 0, 3, 3]; // boundary row/column a handle belongs to

function identityNet(W: number, H: number): WarpNet {
  const net: WarpNet = [];
  for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) net.push({ x: T[c] * W, y: T[j] * H });
  return net;
}

/** A row that is a circular arc: centre (W/2, yc), radius R, apex towards −y when `up`. */
function arcRow(W: number, yc: number, R: number, S: number, C: number, k: number, up: boolean): Vec[] {
  const sy = up ? -1 : 1;
  const p0 = { x: W / 2 - R * S, y: yc + sy * R * C };
  const p3 = { x: W / 2 + R * S, y: yc + sy * R * C };
  return [p0, { x: p0.x + k * R * C, y: p0.y + sy * k * R * S }, { x: p3.x - k * R * C, y: p3.y + sy * k * R * S }, p3];
}

function setRow(net: WarpNet, row: number, pts: Vec[]): void {
  pts.forEach((p, c) => (net[idx(row, c)] = { x: p.x, y: p.y }));
}

function flipVertical(net: WarpNet, H: number): WarpNet {
  const out: WarpNet = new Array(16);
  for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) out[idx(3 - j, c)] = { x: net[idx(j, c)].x, y: H - net[idx(j, c)].y };
  return out;
}

/** The undistorted net of a style (horizontal axis), bend b in −1..1. */
export function pureWarpNet(style: WarpStyle, b: number, W: number, H: number): WarpNet {
  const net = identityNet(W, H);
  if (Math.abs(b) < 1e-9) return net;
  const a = Math.abs(b);
  const theta = a * Math.PI; // total arc angle
  const S = Math.sin(theta / 2);
  const C = Math.cos(theta / 2);
  const k = (4 / 3) * Math.tan(theta / 4); // Bézier handle factor of the arc
  const r = W / 2 / S; // radius of an arc whose chord is the frame width
  const pos = b > 0;
  switch (style) {
    case 'arc': {
      // base arc through the bottom corners and the concentric arc H further out; b < 0 mirrors
      const yc = H + r * C;
      setRow(net, 3, arcRow(W, yc, r, S, C, k, true));
      setRow(net, 0, arcRow(W, yc, r + H, S, C, k, true));
      return pos ? net : flipVertical(net, H);
    }
    case 'arcLower':
      setRow(net, 3, pos ? arcRow(W, H - r * C, r, S, C, k, false) : arcRow(W, H + r * C, r, S, C, k, true));
      return net;
    case 'arcUpper':
      setRow(net, 0, pos ? arcRow(W, r * C, r, S, C, k, true) : arcRow(W, -r * C, r, S, C, k, false));
      return net;
    case 'arch':
      for (const j of [0, 3]) setRow(net, j, pos ? arcRow(W, T[j] * H + r * C, r, S, C, k, true) : arcRow(W, T[j] * H - r * C, r, S, C, k, false));
      return net;
    case 'bulge':
      setRow(net, 0, pos ? arcRow(W, r * C, r, S, C, k, true) : arcRow(W, -r * C, r, S, C, k, false));
      setRow(net, 3, pos ? arcRow(W, H - r * C, r, S, C, k, false) : arcRow(W, H + r * C, r, S, C, k, true));
      return net;
    case 'shellUpper':
    case 'shellLower': {
      // the outer arc of 'arc' (b > 0) or the base arc bulging inwards (b < 0) on one edge; the
      // side handles keep their length and turn by the arc's half angle; interior untouched
      if (pos) {
        setRow(net, 0, arcRow(W, H + r * C, r + H, S, C, k, true));
        net[idx(1, 0)] = { x: net[idx(0, 0)].x + (H / 3) * S, y: net[idx(0, 0)].y + (H / 3) * C };
        net[idx(1, 3)] = { x: net[idx(0, 3)].x - (H / 3) * S, y: net[idx(0, 3)].y + (H / 3) * C };
      } else {
        setRow(net, 0, arcRow(W, -r * C, r, S, C, k, false));
        net[idx(1, 0)] = { x: net[idx(0, 0)].x - (H / 3) * S, y: net[idx(0, 0)].y + (H / 3) * C };
        net[idx(1, 3)] = { x: net[idx(0, 3)].x + (H / 3) * S, y: net[idx(0, 3)].y + (H / 3) * C };
      }
      return style === 'shellUpper' ? net : flipVertical(net, H);
    }
    case 'flag':
      for (let j = 0; j < 4; j++) {
        net[idx(j, 1)].y += 2 * b * H;
        net[idx(j, 2)].y -= 2 * b * H;
      }
      return net;
    case 'fish': {
      const g = [-1, -1 / 3, 1 / 3, 1];
      for (let j = 0; j < 4; j++) {
        net[idx(j, 1)].y += 2 * b * H * g[j];
        net[idx(j, 2)].y -= 2 * b * H * g[j];
      }
      return net;
    }
    case 'rise':
      for (let j = 0; j < 4; j++) {
        net[idx(j, 0)].y += 2 * b * H;
        net[idx(j, 1)].y += 2 * b * H;
      }
      return net;
    case 'wave': {
      const g = [0, 1, 1, 0];
      for (let j = 0; j < 4; j++) {
        net[idx(j, 1)].y += (4 / 3) * b * H * g[j];
        net[idx(j, 2)].y -= (4 / 3) * b * H * g[j];
      }
      return net;
    }
    case 'fisheye': {
      const d = (2 / 3) * b;
      net[idx(1, 1)].x -= d * W; net[idx(1, 1)].y -= d * H;
      net[idx(1, 2)].x += d * W; net[idx(1, 2)].y -= d * H;
      net[idx(2, 1)].x -= d * W; net[idx(2, 1)].y += d * H;
      net[idx(2, 2)].x += d * W; net[idx(2, 2)].y += d * H;
      return net;
    }
    case 'inflate':
    case 'squeeze': {
      const sx = style === 'inflate' ? -1 : 1;
      const lin = [1, 1 / 3, -1 / 3, -1];
      const mid = [0, 1, 1, 0];
      for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) {
        net[idx(j, c)].x += sx * (b / 3) * W * lin[c] * mid[j];
        net[idx(j, c)].y -= (b / 3) * H * mid[c] * lin[j];
      }
      return net;
    }
    case 'twist':
      if (pos) {
        net[idx(1, 1)].x += a * W; net[idx(1, 2)].y += a * H;
        net[idx(2, 1)].y -= a * H; net[idx(2, 2)].x -= a * W;
      } else {
        net[idx(1, 1)].y += a * H; net[idx(1, 2)].x -= a * W;
        net[idx(2, 1)].x += a * W; net[idx(2, 2)].y -= a * H;
      }
      return net;
  }
  return net;
}

function scaleAbout(p: Vec, m: Vec, s: number): Vec {
  return { x: m.x + (p.x - m.x) * s, y: m.y + (p.y - m.y) * s };
}

/** Scale every column about the midpoint of its two end points. */
function scaleColumns(net: WarpNet, k: number[], rows: number[]): void {
  for (let c = 0; c < 4; c++) {
    const a = net[idx(0, c)];
    const b = net[idx(3, c)];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (const j of rows) net[idx(j, c)] = scaleAbout(net[idx(j, c)], m, k[c]);
  }
}

/** Scale every row about the midpoint of its two end points. */
function scaleRows(net: WarpNet, w: number[], rows: number[]): void {
  for (const j of rows) {
    const a = net[idx(j, 0)];
    const b = net[idx(j, 3)];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (let c = 0; c < 4; c++) net[idx(j, c)] = scaleAbout(net[idx(j, c)], m, w[j]);
  }
}

/** Interior control points of the bilinearly blended Coons patch spanned by the boundary. */
function coonsInterior(net: WarpNet): void {
  const P = (j: number, c: number) => net[idx(j, c)];
  const inner = (j: number, c: number): Vec => {
    const [ja, jb] = j === 1 ? [0, 3] : [3, 0];
    const [ca, cb] = c === 1 ? [0, 3] : [3, 0];
    const f = (key: 'x' | 'y') => (6 * (P(ja, c)[key] + P(j, ca)[key]) + 3 * (P(jb, c)[key] + P(j, cb)[key]) - 4 * P(ja, ca)[key] - 2 * (P(ja, cb)[key] + P(jb, ca)[key]) - P(jb, cb)[key]) / 9;
    return { x: f('x'), y: f('y') };
  };
  const pts = [inner(1, 1), inner(1, 2), inner(2, 1), inner(2, 2)];
  net[idx(1, 1)] = pts[0];
  net[idx(1, 2)] = pts[1];
  net[idx(2, 1)] = pts[2];
  net[idx(2, 2)] = pts[3];
}

/**
 * The control net of a horizontal warp with distortions h, v (−1..1). `columnsFirst` is the
 * order of the two scalings: horizontal distortion first for a horizontal warp, the other way
 * round when this is the transposed half of a vertical warp.
 */
function distortedNet(style: WarpStyle, b: number, W: number, H: number, h: number, v: number, columnsFirst: boolean): WarpNet {
  const k = T.map((u) => 1 + h * (2 * u - 1));
  const w = T.map((t) => 1 + v * (2 * t - 1));
  const all = [0, 1, 2, 3];
  const ends = [0, 3];
  const net = pureWarpNet(style, b, W, H);
  switch (FAMILY[style]) {
    case 'A': {
      if (columnsFirst) { scaleColumns(net, k, ends); scaleRows(net, w, ends); }
      else { scaleRows(net, w, ends); scaleColumns(net, k, ends); }
      for (const c of ends) for (const j of [1, 2]) {
        const a = net[idx(0, c)];
        const z = net[idx(3, c)];
        net[idx(j, c)] = { x: a.x + (z.x - a.x) * T[j], y: a.y + (z.y - a.y) * T[j] };
      }
      coonsInterior(net);
      return net;
    }
    case 'B':
      if (columnsFirst) { scaleColumns(net, k, all); scaleRows(net, w, all); }
      else { scaleRows(net, w, all); scaleColumns(net, k, all); }
      return net;
    case 'C': {
      const id = identityNet(W, H);
      const own = net.map((p, i) => ({ x: p.x - id[i].x, y: p.y - id[i].y }));
      const frame = identityNet(W, H);
      if (columnsFirst) {
        scaleColumns(frame, k, all);
        for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) {
          const p = frame[idx(j, c)];
          frame[idx(j, c)] = { x: W / 2 + (p.x - W / 2) * w[j], y: T[j] * H + (p.y - T[j] * H) * w[NEAREST[j]] };
        }
      } else {
        scaleRows(frame, w, all);
        // the wave's boundary points are column anchors (own column), inflate's are row handles
        const across = style === 'wave' ? all : NEAREST;
        for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) {
          const p = frame[idx(j, c)];
          frame[idx(j, c)] = { x: T[c] * W + (p.x - T[c] * W) * k[across[c]], y: H / 2 + (p.y - H / 2) * k[c] };
        }
      }
      return frame.map((p, i) => {
        const j = Math.floor(i / 4);
        const c = i % 4;
        const sx = style === 'wave' ? 0 : k[NEAREST[c]];
        const sy = style === 'wave' ? k[c] : w[NEAREST[j]];
        return { x: p.x + own[i].x * sx, y: p.y + own[i].y * sy };
      });
    }
  }
}

/** The control net of a warp effect over a width × height frame (frame-relative pixels). */
export function warpNet(effect: Pick<WarpEffect, 'style' | 'bend' | 'horizontal' | 'hDistort' | 'vDistort'>, width: number, height: number): WarpNet {
  const b = Math.max(-1, Math.min(1, effect.bend / 100));
  const h = Math.max(-1, Math.min(1, effect.hDistort / 100));
  const v = Math.max(-1, Math.min(1, effect.vDistort / 100));
  if (effect.horizontal) return distortedNet(effect.style, b, width, height, h, v, true);
  // vertical axis: solve the transposed problem (distortions swap roles, so the order flips)
  const t = distortedNet(effect.style, b, height, width, v, h, false);
  const out: WarpNet = new Array(16);
  for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) out[idx(c, j)] = { x: t[idx(j, c)].y, y: t[idx(j, c)].x };
  if (effect.style === 'rise') for (const p of out) p.x -= 2 * b * width;
  return out;
}

const bernstein = (t: number) => [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3];

/** Evaluate the patch at unit coordinates (u, v) → frame-relative pixels. */
export function evalWarpNet(net: WarpNet, u: number, v: number): Vec {
  const bu = bernstein(u);
  const bv = bernstein(v);
  let x = 0;
  let y = 0;
  for (let j = 0; j < 4; j++) for (let c = 0; c < 4; c++) {
    const wgt = bu[c] * bv[j];
    x += wgt * net[idx(j, c)].x;
    y += wgt * net[idx(j, c)].y;
  }
  return { x, y };
}

/** Undistorted warp of a unit point, horizontal axis; W/H are the frame size (frame-relative result). */
export function warpUnit(style: WarpStyle, bend: number, u: number, v: number, W: number, H: number): Vec {
  return evalWarpNet(warpNet({ style, bend, horizontal: true, hDistort: 0, vDistort: 0 }, W, H), u, v);
}

/** Point map of a warp effect over a frame. */
export function warpMap(effect: WarpEffect, frame: Rect): PointMap {
  const W = Math.max(frame.width, 1e-6);
  const H = Math.max(frame.height, 1e-6);
  const net = warpNet(effect, W, H);
  return (p: Vec) => {
    const u = toUnit(frame, p);
    const out = evalWarpNet(net, u.x, u.y);
    return { x: frame.x + out.x, y: frame.y + out.y };
  };
}

/** The cubic Bézier of the patch along a row (v fixed) or a column (u fixed), then restricted to [t0, t1]. */
function isoCurve(net: WarpNet, fixed: number, alongU: boolean): Vec[] {
  const bw = bernstein(fixed);
  const pts: Vec[] = [];
  for (let i = 0; i < 4; i++) {
    let x = 0;
    let y = 0;
    for (let m = 0; m < 4; m++) {
      const p = alongU ? net[idx(m, i)] : net[idx(i, m)];
      x += bw[m] * p.x;
      y += bw[m] * p.y;
    }
    pts.push({ x, y });
  }
  return pts;
}

function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** de Casteljau split of a cubic at t: [left, right]. */
function splitCubic(p: Vec[], t: number): [Vec[], Vec[]] {
  const a = lerp(p[0], p[1], t);
  const b = lerp(p[1], p[2], t);
  const c = lerp(p[2], p[3], t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const m = lerp(d, e, t);
  return [[p[0], a, d, m], [m, e, c, p[3]]];
}

/** The part of a cubic between parameters t0 ≤ t1. */
function cubicSlice(p: Vec[], t0: number, t1: number): Vec[] {
  const right = t0 > 0 ? splitCubic(p, t0)[1] : p;
  const u = t0 >= 1 ? 1 : (t1 - t0) / (1 - t0);
  return u < 1 ? splitCubic(right, u)[0] : right;
}

/**
 * Exact image of a straight segment that runs along the frame's u or v axis: a single cubic on
 * the patch's iso-curve (what Illustrator's Expand yields for rectangle edges). Null otherwise,
 * in which case the caller subdivides and maps the control points.
 */
export function warpExactSegment(net: WarpNet, frame: Rect): (c: Cubic) => Cubic | null {
  const eps = 1e-6;
  return (c: Cubic) => {
    const chord = { x: c.p3.x - c.p0.x, y: c.p3.y - c.p0.y };
    const len2 = chord.x * chord.x + chord.y * chord.y;
    if (len2 < 1e-12) return null;
    const straight = (h: Vec) => Math.abs((h.x - c.p0.x) * chord.y - (h.y - c.p0.y) * chord.x) < 1e-6 * len2;
    if (!straight(c.p1) || !straight(c.p2)) return null;
    const a = toUnit(frame, c.p0);
    const b = toUnit(frame, c.p3);
    let iso: Vec[];
    let t0: number;
    let t1: number;
    if (Math.abs(a.y - b.y) < eps) { iso = isoCurve(net, a.y, true); t0 = a.x; t1 = b.x; }
    else if (Math.abs(a.x - b.x) < eps) { iso = isoCurve(net, a.x, false); t0 = a.y; t1 = b.y; }
    else return null;
    if (t0 < -eps || t1 < -eps || t0 > 1 + eps || t1 > 1 + eps) return null;
    const reversed = t1 < t0;
    const part = cubicSlice(iso, Math.min(t0, t1), Math.max(t0, t1));
    const q = reversed ? [part[3], part[2], part[1], part[0]] : part;
    const w = (p: Vec) => ({ x: frame.x + p.x, y: frame.y + p.y });
    return { p0: w(q[0]), p1: w(q[1]), p2: w(q[2]), p3: w(q[3]) };
  };
}

export function warpSubPaths(sps: SubPath[], effect: WarpEffect, frame: Rect): SubPath[] {
  if (Math.abs(effect.bend) < 1e-6 && !effect.hDistort && !effect.vDistort) return sps;
  const W = Math.max(frame.width, 1e-6);
  const H = Math.max(frame.height, 1e-6);
  const net = warpNet(effect, W, H);
  const fn: PointMap = (p) => {
    const u = toUnit(frame, p);
    const out = evalWarpNet(net, u.x, u.y);
    return { x: frame.x + out.x, y: frame.y + out.y };
  };
  return mapSubPaths(sps, fn, frame, 24, warpExactSegment(net, frame));
}

export { fromUnit };
