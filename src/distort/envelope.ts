/**
 * Envelope maps (pure): free distort (homography onto four corners), mesh
 * distort (bilinear grid) and Coons patches bounded by sampled curves.
 */
import type { Rect, Vec, SubPath, FreeDistortEffect, MeshDistortEffect, CoonsDistortEffect } from '@/model/types';
import { toUnit, fromUnit, mapSubPaths, type PointMap } from './map';
import { subpathToCubics } from '@/geometry/path';
import { cubicPoint } from '@/geometry/bezier';

// ---------------------------------------------------------------------------
// Homography: unit square → quadrilateral
// ---------------------------------------------------------------------------

export type Homography = [number, number, number, number, number, number, number, number, number];

/** Projective transform mapping (0,0),(1,0),(1,1),(0,1) onto the given corners (TL, TR, BR, BL). */
export function squareToQuad(c: [Vec, Vec, Vec, Vec]): Homography {
  const [p0, p1, p2, p3] = c;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    // affine
    return [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
  }
  const det = dx1 * dy2 - dx2 * dy1;
  const g = det !== 0 ? (dx3 * dy2 - dx2 * dy3) / det : 0;
  const h = det !== 0 ? (dx1 * dy3 - dx3 * dy1) / det : 0;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

export function applyHomography(H: Homography, u: number, v: number): Vec {
  const w = H[6] * u + H[7] * v + H[8];
  const d = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return { x: (H[0] * u + H[1] * v + H[2]) / d, y: (H[3] * u + H[4] * v + H[5]) / d };
}

export function freeDistortMap(effect: FreeDistortEffect, frame: Rect): PointMap {
  const H = squareToQuad(effect.corners.map((c) => fromUnit(frame, c)) as [Vec, Vec, Vec, Vec]);
  return (p) => {
    const u = toUnit(frame, p);
    return applyHomography(H, u.x, u.y);
  };
}

export function freeDistortSubPaths(sps: SubPath[], effect: FreeDistortEffect, frame: Rect): SubPath[] {
  return mapSubPaths(sps, freeDistortMap(effect, frame), frame);
}

export const IDENTITY_CORNERS: [Vec, Vec, Vec, Vec] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

// ---------------------------------------------------------------------------
// Mesh distort: bilinear cells
// ---------------------------------------------------------------------------

export function meshPoints(rows: number, cols: number): Vec[] {
  const out: Vec[] = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) out.push({ x: c / cols, y: r / rows });
  return out;
}

export function makeMeshDistort(rows: number, cols: number): MeshDistortEffect {
  const r = Math.max(1, Math.min(30, Math.round(rows)));
  const c = Math.max(1, Math.min(30, Math.round(cols)));
  return { type: 'meshDistort', enabled: true, rows: r, cols: c, points: meshPoints(r, c) };
}

export function meshDistortMap(effect: MeshDistortEffect, frame: Rect): PointMap {
  const { rows, cols, points } = effect;
  const at = (r: number, c: number) => points[Math.min(rows, Math.max(0, r)) * (cols + 1) + Math.min(cols, Math.max(0, c))];
  return (p) => {
    const u = toUnit(frame, p);
    // allow slight overshoot beyond the box by extrapolating the edge cells
    const fx = Math.max(0, Math.min(cols - 1e-9, u.x * cols));
    const fy = Math.max(0, Math.min(rows - 1e-9, u.y * rows));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = u.x * cols - c;
    const ty = u.y * rows - r;
    const p00 = at(r, c);
    const p01 = at(r, c + 1);
    const p10 = at(r + 1, c);
    const p11 = at(r + 1, c + 1);
    const x = (1 - tx) * (1 - ty) * p00.x + tx * (1 - ty) * p01.x + (1 - tx) * ty * p10.x + tx * ty * p11.x;
    const y = (1 - tx) * (1 - ty) * p00.y + tx * (1 - ty) * p01.y + (1 - tx) * ty * p10.y + tx * ty * p11.y;
    return fromUnit(frame, { x, y });
  };
}

export function meshDistortSubPaths(sps: SubPath[], effect: MeshDistortEffect, frame: Rect): SubPath[] {
  return mapSubPaths(sps, meshDistortMap(effect, frame), frame, Math.max(24, effect.rows * 6, effect.cols * 6));
}

// ---------------------------------------------------------------------------
// Coons patch from four sampled sides
// ---------------------------------------------------------------------------

function polyAt(pts: Vec[], t: number): Vec {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  const f = Math.max(0, Math.min(1, t)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
}

/** Coons map: sides are polylines in bbox units: top (left→right), right (top→bottom), bottom (left→right), left (top→bottom). */
export function coonsMap(effect: CoonsDistortEffect, frame: Rect): PointMap {
  const c00 = effect.top[0];
  const c01 = effect.top[effect.top.length - 1];
  const c10 = effect.bottom[0];
  const c11 = effect.bottom[effect.bottom.length - 1];
  return (p) => {
    const { x: u, y: v } = toUnit(frame, p);
    const T = polyAt(effect.top, u);
    const B = polyAt(effect.bottom, u);
    const L = polyAt(effect.left, v);
    const R = polyAt(effect.right, v);
    const x = (1 - v) * T.x + v * B.x + (1 - u) * L.x + u * R.x - ((1 - u) * (1 - v) * c00.x + u * (1 - v) * c01.x + (1 - u) * v * c10.x + u * v * c11.x);
    const y = (1 - v) * T.y + v * B.y + (1 - u) * L.y + u * R.y - ((1 - u) * (1 - v) * c00.y + u * (1 - v) * c01.y + (1 - u) * v * c10.y + u * v * c11.y);
    return fromUnit(frame, { x, y });
  };
}

export function coonsSubPaths(sps: SubPath[], effect: CoonsDistortEffect, frame: Rect): SubPath[] {
  return mapSubPaths(sps, coonsMap(effect, frame), frame, 32);
}

/**
 * Build a Coons effect from a closed envelope path (in the same space as the
 * content frame): the outline is sampled densely, the samples nearest to the
 * four frame corners split it into the four sides (bbox units).
 */
export function coonsFromPath(sp: SubPath, frame: Rect, samplesPerSide = 24): CoonsDistortEffect | null {
  if (sp.anchors.length < 3) return null;
  const cubics = subpathToCubics({ ...sp, closed: true });
  if (!cubics.length) return null;
  const N = Math.max(120, cubics.length * 40);
  let samples: Vec[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * cubics.length;
    const si = Math.min(cubics.length - 1, Math.floor(t));
    samples.push(cubicPoint(cubics[si], t - si));
  }
  // orientation: walk so that TL → TR → BR → BL is increasing
  let area = 0;
  for (let i = 0; i < N; i++) {
    const p = samples[i];
    const q = samples[(i + 1) % N];
    area += p.x * q.y - q.x * p.y;
  }
  if (area < 0) samples = samples.slice().reverse();
  const corners = [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x, y: frame.y + frame.height },
  ];
  const idx = corners.map((c) => {
    let best = 0;
    let bd = Infinity;
    samples.forEach((p, i) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  });
  const [tl, tr, br, bl] = idx;
  if (new Set(idx).size < 4) return null;
  const walk = (a: number, b: number): Vec[] => {
    let count = (b - a + N) % N;
    if (count === 0) count = N;
    const out: Vec[] = [];
    for (let i = 0; i <= samplesPerSide; i++) {
      const k = (a + Math.round((i / samplesPerSide) * count)) % N;
      out.push(samples[k]);
    }
    return out;
  };
  const unit = (pts: Vec[]) => pts.map((p) => toUnit(frame, p));
  const top = walk(tl, tr);
  const right = walk(tr, br);
  const bottom = walk(br, bl).reverse();
  const left = walk(bl, tl).reverse();
  return { type: 'coonsDistort', enabled: true, top: unit(top), right: unit(right), bottom: unit(bottom), left: unit(left) };
}
