import type { SubPath, LiveShape, Vec, Anchor } from '@/model/types';
import { KAPPA } from './bezier';
import { anchor } from './path';

/**
 * Rectangle with per-corner radii (top-left, top-right, bottom-right, bottom-left),
 * origin at (0,0), extending to (width,height).
 */
export function rectSubPath(width: number, height: number, radii: [number, number, number, number] = [0, 0, 0, 0]): SubPath {
  const maxR = Math.min(Math.abs(width), Math.abs(height)) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, maxR)));
  const k = 1 - KAPPA;
  const anchors: Anchor[] = [];
  const w = width;
  const h = height;
  if (tl + tr + br + bl === 0) {
    return {
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: w, y: 0 }), anchor({ x: w, y: h }), anchor({ x: 0, y: h })],
      closed: true,
    };
  }
  // top-left corner
  if (tl > 0) {
    anchors.push(anchor({ x: 0, y: tl }, null, { x: 0, y: -tl * (1 - k) }, 'corner'));
    anchors.push(anchor({ x: tl, y: 0 }, { x: -tl * (1 - k), y: 0 }, null, 'corner'));
  } else anchors.push(anchor({ x: 0, y: 0 }));
  // top-right
  if (tr > 0) {
    anchors.push(anchor({ x: w - tr, y: 0 }, null, { x: tr * (1 - k), y: 0 }, 'corner'));
    anchors.push(anchor({ x: w, y: tr }, { x: 0, y: -tr * (1 - k) }, null, 'corner'));
  } else anchors.push(anchor({ x: w, y: 0 }));
  // bottom-right
  if (br > 0) {
    anchors.push(anchor({ x: w, y: h - br }, null, { x: 0, y: br * (1 - k) }, 'corner'));
    anchors.push(anchor({ x: w - br, y: h }, { x: br * (1 - k), y: 0 }, null, 'corner'));
  } else anchors.push(anchor({ x: w, y: h }));
  // bottom-left
  if (bl > 0) {
    anchors.push(anchor({ x: bl, y: h }, null, { x: -bl * (1 - k), y: 0 }, 'corner'));
    anchors.push(anchor({ x: 0, y: h - bl }, { x: 0, y: bl * (1 - k) }, null, 'corner'));
  } else anchors.push(anchor({ x: 0, y: h }));
  return { anchors, closed: true };
}

/** Ellipse centred at the origin. */
export function ellipseSubPath(rx: number, ry: number, cx = 0, cy = 0): SubPath {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    closed: true,
    anchors: [
      anchor({ x: cx, y: cy - ry }, { x: -kx, y: 0 }, { x: kx, y: 0 }, 'smooth'),
      anchor({ x: cx + rx, y: cy }, { x: 0, y: -ky }, { x: 0, y: ky }, 'smooth'),
      anchor({ x: cx, y: cy + ry }, { x: kx, y: 0 }, { x: -kx, y: 0 }, 'smooth'),
      anchor({ x: cx - rx, y: cy }, { x: 0, y: ky }, { x: 0, y: -ky }, 'smooth'),
    ],
  };
}

/** Regular polygon centred at the origin, first vertex at the top. */
export function polygonSubPath(sides: number, radius: number, rotationDeg = 0): SubPath {
  sides = Math.max(3, Math.round(sides));
  const anchors: Anchor[] = [];
  const start = -Math.PI / 2 + (rotationDeg * Math.PI) / 180;
  for (let i = 0; i < sides; i++) {
    const a = start + (i * 2 * Math.PI) / sides;
    anchors.push(anchor({ x: Math.cos(a) * radius, y: Math.sin(a) * radius }));
  }
  return { anchors, closed: true };
}

/** Star centred at the origin. */
export function starSubPath(points: number, outerRadius: number, innerRadius: number, rotationDeg = 0): SubPath {
  points = Math.max(3, Math.round(points));
  const anchors: Anchor[] = [];
  const start = -Math.PI / 2 + (rotationDeg * Math.PI) / 180;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const a = start + (i * Math.PI) / points;
    anchors.push(anchor({ x: Math.cos(a) * r, y: Math.sin(a) * r }));
  }
  return { anchors, closed: true };
}

export function lineSubPath(a: Vec, b: Vec): SubPath {
  return { anchors: [anchor(a), anchor(b)], closed: false };
}

/**
 * Logarithmic-ish spiral approximated by quarter-circle arcs whose radius
 * decays by `decay` (0..1, e.g. 0.8) every quarter turn.
 */
export function spiralSubPath(radius: number, decay: number, segments: number, clockwise = true): SubPath {
  segments = Math.max(1, Math.round(segments));
  decay = Math.min(0.999, Math.max(0.05, decay));
  const anchors: Anchor[] = [];
  let r = radius;
  const dir = clockwise ? 1 : -1;
  // Build from the outside in: each quarter arc from angle a to a+90deg
  let angle = 0;
  let cx = 0;
  let cy = 0;
  // start point
  let p = { x: cx + r, y: cy };
  const pts: { p: Vec; hIn: Vec; hOut: Vec }[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = angle;
    const a1 = angle + (dir * Math.PI) / 2;
    const k = KAPPA * r;
    const t0 = { x: -Math.sin(a0) * dir, y: Math.cos(a0) * dir };
    const t1 = { x: -Math.sin(a1) * dir, y: Math.cos(a1) * dir };
    const p1 = { x: cx + Math.cos(a1) * r, y: cy + Math.sin(a1) * r };
    if (i === 0) pts.push({ p, hIn: { x: 0, y: 0 }, hOut: { x: t0.x * k, y: t0.y * k } });
    else pts[pts.length - 1].hOut = { x: t0.x * k, y: t0.y * k };
    pts.push({ p: p1, hIn: { x: -t1.x * k, y: -t1.y * k }, hOut: { x: 0, y: 0 } });
    // next quarter has a smaller radius; keep the same tangent continuity by moving the centre
    const nr = r * decay;
    // new centre so that the arc continues from p1 with radius nr
    cx = p1.x - Math.cos(a1) * nr;
    cy = p1.y - Math.sin(a1) * nr;
    r = nr;
    angle = a1;
    p = p1;
  }
  for (const q of pts) anchors.push(anchor(q.p, q.hIn, q.hOut, 'smooth'));
  return { anchors, closed: false };
}

/** Elliptical arc (angles in degrees, clockwise on screen). */
export function arcSubPath(rx: number, ry: number, startDeg: number, endDeg: number, pie = false): SubPath {
  let a0 = (startDeg * Math.PI) / 180;
  let a1 = (endDeg * Math.PI) / 180;
  if (a1 <= a0) a1 += Math.PI * 2;
  const sweep = a1 - a0;
  const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
  const delta = sweep / n;
  const t = (4 / 3) * Math.tan(delta / 4);
  const anchors: Anchor[] = [];
  let a = a0;
  const pt = (ang: number): Vec => ({ x: Math.cos(ang) * rx, y: Math.sin(ang) * ry });
  const tan = (ang: number): Vec => ({ x: -Math.sin(ang) * rx, y: Math.cos(ang) * ry });
  anchors.push(anchor(pt(a), null, { x: tan(a).x * t, y: tan(a).y * t }, 'corner'));
  for (let i = 0; i < n; i++) {
    const na = a + delta;
    const last = anchors[anchors.length - 1];
    last.handleOut = { x: tan(a).x * t, y: tan(a).y * t };
    anchors.push(anchor(pt(na), { x: -tan(na).x * t, y: -tan(na).y * t }, null, 'smooth'));
    a = na;
  }
  anchors[anchors.length - 1].kind = 'corner';
  anchors[0].kind = 'corner';
  if (pie) {
    anchors.push(anchor({ x: 0, y: 0 }));
    return { anchors, closed: true };
  }
  return { anchors, closed: Math.abs(sweep - Math.PI * 2) < 1e-6 };
}

/** Generate the local geometry for a live shape. */
export function liveShapeSubPaths(shape: LiveShape): SubPath[] {
  switch (shape.kind) {
    case 'rect':
      return [rectSubPath(shape.width, shape.height, shape.radii)];
    case 'ellipse':
      return [ellipseSubPath(shape.rx, shape.ry)];
    case 'polygon':
      return [polygonSubPath(shape.sides, shape.radius)];
    case 'star':
      return [starSubPath(shape.points, shape.outerRadius, shape.innerRadius)];
    case 'line':
      return [lineSubPath({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 })];
    case 'spiral':
      return [spiralSubPath(shape.radius, shape.decay, shape.segments, shape.clockwise)];
    case 'arc':
      return [arcSubPath(shape.rx, shape.ry, shape.startAngle, shape.endAngle, shape.pie)];
  }
}

/** Rounded polygon: apply corner radius to every corner of a polyline subpath. */
export function roundCorners(sp: SubPath, radius: number): SubPath {
  if (radius <= 0) return sp;
  const n = sp.anchors.length;
  if (n < 3) return sp;
  const out: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    const cur = sp.anchors[i];
    const hasPrev = sp.closed || i > 0;
    const hasNext = sp.closed || i < n - 1;
    const prev = sp.anchors[(i - 1 + n) % n];
    const next = sp.anchors[(i + 1) % n];
    const isCorner = !cur.handleIn && !cur.handleOut;
    if (!hasPrev || !hasNext || !isCorner) {
      out.push({ ...cur, point: { ...cur.point } });
      continue;
    }
    const v1 = { x: prev.point.x - cur.point.x, y: prev.point.y - cur.point.y };
    const v2 = { x: next.point.x - cur.point.x, y: next.point.y - cur.point.y };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 1e-9 || l2 < 1e-9) {
      out.push({ ...cur });
      continue;
    }
    const u1 = { x: v1.x / l1, y: v1.y / l1 };
    const u2 = { x: v2.x / l2, y: v2.y / l2 };
    const cosTheta = u1.x * u2.x + u1.y * u2.y;
    const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
    if (theta > Math.PI - 1e-6 || theta < 1e-6) {
      out.push({ ...cur });
      continue;
    }
    const tangentLen = Math.min(radius / Math.tan(theta / 2), l1 / 2, l2 / 2);
    const rEff = tangentLen * Math.tan(theta / 2);
    const p1 = { x: cur.point.x + u1.x * tangentLen, y: cur.point.y + u1.y * tangentLen };
    const p2 = { x: cur.point.x + u2.x * tangentLen, y: cur.point.y + u2.y * tangentLen };
    // handle length for a circular arc of angle (pi - theta)
    const arcAngle = Math.PI - theta;
    const k = (4 / 3) * Math.tan(arcAngle / 4) * rEff;
    out.push(anchor(p1, null, { x: -u1.x * k, y: -u1.y * k }, 'corner'));
    out.push(anchor(p2, { x: -u2.x * k, y: -u2.y * k }, null, 'corner'));
  }
  return { anchors: out, closed: sp.closed };
}
