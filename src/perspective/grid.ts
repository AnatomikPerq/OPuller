/**
 * Perspective grid maths (pure): one-, two- and three-point grids made of a
 * left wall, a right wall and a floor that meet at the corner (station) line.
 *
 * Plane coordinates are (u, v) in units of the grid extent / height:
 * - walls: u runs along the receding direction (0 at the corner line, 1 at the
 *   far edge), v up the wall (0 = ground line, 1 = wall height);
 * - floor: u runs along the right wall, v along the left wall.
 *
 * "Flat" rectangles are the pre-projection rectangles in world units: for the
 * walls x is measured from the corner line and y from the ground line, for
 * the floor both axes are measured from the corner (the floor is seen as if
 * folded up onto the picture plane).
 */
import type { PerspectiveGrid, PerspectivePlane, Vec, Rect } from '@/model/types';

export type PlaneId = PerspectivePlane;

export const PLANES: PlaneId[] = ['left', 'floor', 'right'];
export const PLANE_COLORS: Record<PlaneId, string> = { left: '#3b9cf5', right: '#ff9f43', floor: '#37c66b' };
export const PLANE_LABELS: Record<PlaneId, string> = { left: 'Left plane', floor: 'Horizontal plane', right: 'Right plane' };

/** Smallest plane coordinate accepted in front of the corner line (beyond it the projection flips). */
const MIN_A = -0.6;

export function defaultGrid(artboard: Rect | null, type: 1 | 2 | 3 = 2): PerspectiveGrid {
  const ab = artboard ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const cx = ab.x + ab.width / 2;
  const horizon = ab.y + ab.height * 0.42;
  const ground = ab.y + ab.height * 0.86;
  const spread = ab.width * 0.62;
  const g: PerspectiveGrid = {
    type,
    horizon,
    vpLeft: type === 1 ? cx : cx - spread,
    vpRight: type === 1 ? cx : cx + spread,
    ground,
    corner: cx,
    extent: Math.round(ab.width * 0.3),
    height: Math.round(ab.height * 0.42),
    cell: Math.round(Math.max(20, ab.width / 40)),
    opacity: 0.55,
  };
  if (type === 3) g.vpVertical = ab.y + ab.height * 2.4;
  return g;
}

/**
 * Foreshortening: a flat distance `a` (units of the extent) along a wall whose
 * vanishing point is `D` world units from the wall origin → interpolation
 * factor towards the vanishing point. Near the origin the scale is 1:1.
 */
export function depth(a: number, extent: number, D: number): number {
  const d = Math.max(MIN_A, a) * extent;
  return d / (d + D);
}

export function inverseDepth(t: number, extent: number, D: number): number {
  return t >= 1 ? 1e6 : (D * t) / (1 - t) / extent;
}

/** Distance from a wall's origin to its vanishing point. */
export function vpDistance(g: PerspectiveGrid, plane: 'left' | 'right'): number {
  const vp = plane === 'right' ? g.vpRight : g.vpLeft;
  return Math.max(1, Math.abs(vp - wallOrigin(g, plane)));
}

/** Three-point grids: vertical lines converge towards the vertical vanishing point. */
function converge(g: PerspectiveGrid, x: number, y: number, yGround: number): number {
  if (g.type !== 3 || g.vpVertical === undefined) return x;
  const span = yGround - g.vpVertical;
  if (Math.abs(span) < 1e-6) return x;
  const k = (yGround - y) / span;
  return x + (g.corner - x) * k;
}

/** x where the ground line of a wall starts (the corner line, or the corner ± extent for one-point grids). */
function wallOrigin(g: PerspectiveGrid, plane: 'left' | 'right'): number {
  if (g.type !== 1) return g.corner;
  return plane === 'right' ? g.corner + g.extent : g.corner - g.extent;
}

/** World point of a wall at plane coordinates (u along the wall, v up). */
export function wallPoint(g: PerspectiveGrid, plane: 'left' | 'right', u: number, v: number): Vec {
  const vp = plane === 'right' ? g.vpRight : g.vpLeft;
  const x0 = wallOrigin(g, plane);
  const t = depth(u, g.extent, Math.max(1, Math.abs(vp - x0)));
  const x = x0 + (vp - x0) * t;
  const yGround = g.ground + (g.horizon - g.ground) * t;
  const top = g.ground - g.height;
  const yTop = top + (g.horizon - top) * t;
  const y = yGround + (yTop - yGround) * v;
  return { x: converge(g, x, y, yGround), y };
}

function intersect(p1: Vec, p2: Vec, p3: Vec, p4: Vec): Vec | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/** World point of the floor: `u` along the right wall, `v` along the left wall. */
export function floorPoint(g: PerspectiveGrid, u: number, v: number): Vec {
  const gl = wallPoint(g, 'left', v, 0);
  const gr = wallPoint(g, 'right', u, 0);
  if (g.type === 1) {
    // one point: depth from the mean of both coordinates, the width shrinks with depth
    const t = depth((u + v) / 2, g.extent, g.extent);
    const y = g.ground + (g.horizon - g.ground) * t;
    const x = g.corner + ((u - v) / 2) * g.extent * (1 - t);
    return { x, y };
  }
  // the floor point lies on the line from the left VP through the right wall's ground point
  // and on the line from the right VP through the left wall's ground point
  const p = intersect({ x: g.vpLeft, y: g.horizon }, gr, { x: g.vpRight, y: g.horizon }, gl);
  return p ?? { x: (gl.x + gr.x) / 2, y: (gl.y + gr.y) / 2 };
}

/** World point for plane coordinates. */
export function planePoint(g: PerspectiveGrid, plane: PlaneId, u: number, v: number): Vec {
  return plane === 'floor' ? floorPoint(g, u, v) : wallPoint(g, plane, u, v);
}

/** Flat (pre-projection) world point → plane coordinates. */
export function flatToPlane(g: PerspectiveGrid, plane: PlaneId, p: Vec): { u: number; v: number } {
  if (plane === 'floor') return { u: (p.x - g.corner) / g.extent, v: (g.ground - p.y) / g.extent };
  const sign = plane === 'right' ? 1 : -1;
  return { u: ((p.x - g.corner) * sign) / g.extent, v: (g.ground - p.y) / g.height };
}

/** Plane coordinates → flat world point. */
export function planeToFlat(g: PerspectiveGrid, plane: PlaneId, u: number, v: number): Vec {
  if (plane === 'floor') return { x: g.corner + u * g.extent, y: g.ground - v * g.extent };
  const sign = plane === 'right' ? 1 : -1;
  return { x: g.corner + u * g.extent * sign, y: g.ground - v * g.height };
}

/** Flat world point → projected world point on the plane. */
export function projectPoint(g: PerspectiveGrid, plane: PlaneId, p: Vec): Vec {
  const { u, v } = flatToPlane(g, plane, p);
  return planePoint(g, plane, u, v);
}

/**
 * Inverse projection: plane coordinates of a world point (numeric: analytic
 * guess for the walls, then a shrinking pattern search on all planes).
 */
export function planeCoords(g: PerspectiveGrid, plane: PlaneId, p: Vec): { u: number; v: number } {
  let u = 0.5;
  let v = 0.5;
  if (plane !== 'floor') {
    const vp = plane === 'right' ? g.vpRight : g.vpLeft;
    const x0 = wallOrigin(g, plane);
    const span = vp - x0;
    const t = Math.abs(span) < 1e-9 ? 0 : Math.max(-3, Math.min(0.995, (p.x - x0) / span));
    u = inverseDepth(t, g.extent, Math.max(1, Math.abs(span)));
    const yGround = g.ground + (g.horizon - g.ground) * t;
    const top = g.ground - g.height;
    const yTop = top + (g.horizon - top) * t;
    v = Math.abs(yTop - yGround) < 1e-9 ? 0 : (p.y - yGround) / (yTop - yGround);
    if (g.type !== 3) return { u, v };
  } else {
    // coarse search over the floor
    let best = Infinity;
    for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
      const cu = -0.5 + (i / 20) * 3.5;
      const cv = -0.5 + (j / 20) * 3.5;
      const q = floorPoint(g, cu, cv);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) {
        best = d;
        u = cu;
        v = cv;
      }
    }
  }
  // refine
  let step = 0.25;
  let bestD = dist(planePoint(g, plane, u, v), p);
  for (let iter = 0; iter < 60 && step > 1e-6; iter++) {
    let improved = false;
    for (const [du, dv] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const cu = Math.max(MIN_A, u + du);
      const cv = v + dv;
      const d = dist(planePoint(g, plane, cu, cv), p);
      if (d < bestD - 1e-9) {
        bestD = d;
        u = cu;
        v = cv;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return { u, v };
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Projected world point → flat world point on the plane. */
export function unprojectPoint(g: PerspectiveGrid, plane: PlaneId, p: Vec): Vec {
  const { u, v } = planeCoords(g, plane, p);
  return planeToFlat(g, plane, u, v);
}

/** Corners (TL, TR, BR, BL) of a flat rectangle projected onto a plane. */
export function projectRect(g: PerspectiveGrid, plane: PlaneId, rect: Rect): [Vec, Vec, Vec, Vec] {
  const corners: Vec[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  return corners.map((c) => projectPoint(g, plane, c)) as [Vec, Vec, Vec, Vec];
}

/** Free-distort corners (bbox units of `rect`) that put the flat rectangle onto the plane. */
export function attachCorners(g: PerspectiveGrid, plane: PlaneId, rect: Rect): [Vec, Vec, Vec, Vec] {
  const q = projectRect(g, plane, rect);
  const w = Math.max(rect.width, 1e-6);
  const h = Math.max(rect.height, 1e-6);
  return q.map((p) => ({ x: (p.x - rect.x) / w, y: (p.y - rect.y) / h })) as [Vec, Vec, Vec, Vec];
}

/** Grid lines of a plane as world polylines (for drawing), plus the plane outline. */
export function planeLines(g: PerspectiveGrid, plane: PlaneId): { lines: Vec[][]; outline: Vec[] } {
  const lines: Vec[][] = [];
  const nA = Math.max(1, Math.min(200, Math.round(g.extent / Math.max(1, g.cell))));
  const nB = Math.max(1, Math.min(200, Math.round(g.height / Math.max(1, g.cell))));
  const curved = g.type === 3;
  const poly = (f: (s: number) => Vec, segs = curved ? 8 : 1): Vec[] => Array.from({ length: segs + 1 }, (_, i) => f(i / segs));
  if (plane === 'floor') {
    for (let i = 0; i <= nA; i++) {
      const a = i / nA;
      lines.push([floorPoint(g, a, 0), floorPoint(g, a, 1)]);
      lines.push([floorPoint(g, 0, a), floorPoint(g, 1, a)]);
    }
    return { lines, outline: [floorPoint(g, 0, 0), floorPoint(g, 1, 0), floorPoint(g, 1, 1), floorPoint(g, 0, 1)] };
  }
  for (let i = 0; i <= nA; i++) {
    const a = i / nA;
    lines.push(poly((s) => wallPoint(g, plane, a, s)));
  }
  for (let j = 0; j <= nB; j++) {
    const b = j / nB;
    lines.push(poly((s) => wallPoint(g, plane, s, b)));
  }
  const outline = [...poly((s) => wallPoint(g, plane, s, 0)), ...poly((s) => wallPoint(g, plane, 1 - s, 1))];
  return { lines, outline };
}

export type GridHandle = 'vpLeft' | 'vpRight' | 'horizon' | 'origin' | 'height' | 'extentLeft' | 'extentRight' | 'vpVertical';

/** Handle positions (world) of the grid used by the Perspective Grid tool. */
export function gridHandles(g: PerspectiveGrid): Array<{ id: GridHandle; point: Vec; title: string }> {
  const out: Array<{ id: GridHandle; point: Vec; title: string }> = [
    { id: 'origin', point: { x: g.corner, y: g.ground }, title: 'Grid origin (corner and ground line)' },
    { id: 'height', point: { x: g.corner, y: g.ground - g.height }, title: 'Wall height' },
    { id: 'extentRight', point: wallPoint(g, 'right', 1, 0), title: 'Grid extent' },
    { id: 'extentLeft', point: wallPoint(g, 'left', 1, 0), title: 'Grid extent' },
    { id: 'horizon', point: { x: g.corner, y: g.horizon }, title: 'Horizon height' },
  ];
  if (g.type === 1) out.push({ id: 'vpRight', point: { x: g.vpRight, y: g.horizon }, title: 'Vanishing point' });
  else out.push({ id: 'vpLeft', point: { x: g.vpLeft, y: g.horizon }, title: 'Left vanishing point' }, { id: 'vpRight', point: { x: g.vpRight, y: g.horizon }, title: 'Right vanishing point' });
  if (g.type === 3) out.push({ id: 'vpVertical', point: { x: g.corner, y: g.vpVertical ?? g.ground + g.height * 3 }, title: 'Vertical vanishing point' });
  return out;
}

/** Apply a handle drag: the handle moves to world point `p`. */
export function dragHandle(g: PerspectiveGrid, handle: GridHandle, p: Vec, shift = false): PerspectiveGrid {
  const next = { ...g };
  switch (handle) {
    case 'vpLeft':
      next.vpLeft = Math.min(p.x, g.corner - 1);
      if (!shift) next.horizon = p.y;
      break;
    case 'vpRight':
      if (g.type === 1) {
        next.vpLeft = p.x;
        next.vpRight = p.x;
      } else next.vpRight = Math.max(p.x, g.corner + 1);
      if (!shift) next.horizon = p.y;
      break;
    case 'horizon':
      next.horizon = p.y;
      break;
    case 'origin': {
      const dx = p.x - g.corner;
      next.corner = p.x;
      next.ground = p.y;
      // the vanishing points travel with the origin (the grid moves as a whole)
      next.vpLeft = g.vpLeft + dx;
      next.vpRight = g.vpRight + dx;
      next.horizon = g.horizon + (p.y - g.ground);
      if (g.vpVertical !== undefined) next.vpVertical = g.vpVertical + (p.y - g.ground);
      break;
    }
    case 'height':
      next.height = Math.max(10, g.ground - p.y);
      break;
    case 'extentRight':
    case 'extentLeft': {
      const plane = handle === 'extentRight' ? 'right' : 'left';
      const { u } = planeCoords(g, plane, p);
      next.extent = Math.max(10, g.extent * Math.max(0.05, u));
      break;
    }
    case 'vpVertical':
      next.vpVertical = p.y;
      break;
  }
  return next;
}

export function withType(g: PerspectiveGrid, type: 1 | 2 | 3): PerspectiveGrid {
  const next: PerspectiveGrid = { ...g, type };
  if (type === 1) {
    next.vpLeft = g.corner;
    next.vpRight = g.corner;
  } else if (g.type === 1) {
    next.vpLeft = g.corner - g.extent * 2;
    next.vpRight = g.corner + g.extent * 2;
  }
  if (type === 3 && next.vpVertical === undefined) next.vpVertical = g.ground + g.height * 3;
  if (type !== 3) delete next.vpVertical;
  return next;
}

/** Ground-line direction of a plane at the flat point (for cursor hints); unit vector in world space. */
export function planeAxis(g: PerspectiveGrid, plane: PlaneId, p: Vec): Vec {
  const q0 = projectPoint(g, plane, p);
  const q1 = projectPoint(g, plane, { x: p.x + 1, y: p.y });
  const d = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1;
  return { x: (q1.x - q0.x) / d, y: (q1.y - q0.y) / d };
}
