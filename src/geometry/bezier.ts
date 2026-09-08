import type { Vec, Rect } from '@/model/types';
import { rectFromPointList } from './vec';

/** Cubic Bezier segment defined by 4 absolute points. */
export interface Cubic {
  p0: Vec;
  p1: Vec;
  p2: Vec;
  p3: Vec;
}

export function cubicPoint(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const cc = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + cc * c.p2.x + d * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + cc * c.p2.y + d * c.p3.y,
  };
}

export function cubicDerivative(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = 3 * mt * mt;
  const b = 6 * mt * t;
  const cc = 3 * t * t;
  return {
    x: a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + cc * (c.p3.x - c.p2.x),
    y: a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + cc * (c.p3.y - c.p2.y),
  };
}

export function isLine(c: Cubic, eps = 1e-9): boolean {
  return (
    Math.abs(c.p1.x - c.p0.x) < eps &&
    Math.abs(c.p1.y - c.p0.y) < eps &&
    Math.abs(c.p2.x - c.p3.x) < eps &&
    Math.abs(c.p2.y - c.p3.y) < eps
  );
}

/** Split at t using de Casteljau; returns [left, right]. */
export function cubicSplit(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: Vec, b: Vec): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const p01 = lerp(c.p0, c.p1);
  const p12 = lerp(c.p1, c.p2);
  const p23 = lerp(c.p2, c.p3);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  return [
    { p0: c.p0, p1: p01, p2: p012, p3: mid },
    { p0: mid, p1: p123, p2: p23, p3: c.p3 },
  ];
}

/** Tight axis-aligned bounds of the curve (solves derivative roots). */
export function cubicBounds(c: Cubic): Rect {
  const pts: Vec[] = [c.p0, c.p3];
  for (const axis of ['x', 'y'] as const) {
    const a = -c.p0[axis] + 3 * c.p1[axis] - 3 * c.p2[axis] + c.p3[axis];
    const b = 2 * (c.p0[axis] - 2 * c.p1[axis] + c.p2[axis]);
    const cc = -c.p0[axis] + c.p1[axis];
    const roots: number[] = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) roots.push(-cc / b);
    } else {
      const disc = b * b - 4 * a * cc;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
      }
    }
    for (const t of roots) if (t > 0 && t < 1) pts.push(cubicPoint(c, t));
  }
  return rectFromPointList(pts)!;
}

/** Approximate arc length by adaptive subdivision. */
export function cubicLength(c: Cubic, tolerance = 0.05): number {
  if (isLine(c)) return Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y);
  const chord = Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y);
  const poly =
    Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y) +
    Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y) +
    Math.hypot(c.p3.x - c.p2.x, c.p3.y - c.p2.y);
  if (poly - chord < tolerance) return (poly + chord) / 2;
  const [l, r] = cubicSplit(c, 0.5);
  return cubicLength(l, tolerance) + cubicLength(r, tolerance);
}

/** Flatten into a polyline (does not include p0). */
export function cubicFlatten(c: Cubic, tolerance = 0.25, out: Vec[] = []): Vec[] {
  if (isLine(c)) {
    out.push(c.p3);
    return out;
  }
  // flatness: max distance of control points from the chord
  const dx = c.p3.x - c.p0.x;
  const dy = c.p3.y - c.p0.y;
  const d1 = Math.abs((c.p1.x - c.p3.x) * dy - (c.p1.y - c.p3.y) * dx);
  const d2 = Math.abs((c.p2.x - c.p3.x) * dy - (c.p2.y - c.p3.y) * dx);
  const dd = (d1 + d2) * (d1 + d2);
  if (dd < tolerance * (dx * dx + dy * dy) || dx * dx + dy * dy < 1e-6) {
    out.push(c.p3);
    return out;
  }
  const [l, r] = cubicSplit(c, 0.5);
  cubicFlatten(l, tolerance, out);
  cubicFlatten(r, tolerance, out);
  return out;
}

export interface NearestResult {
  t: number;
  point: Vec;
  distance: number;
}

/** Nearest point on the curve to `p` (coarse sampling + Newton refinement). */
export function cubicNearest(c: Cubic, p: Vec, samples = 24): NearestResult {
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const q = cubicPoint(c, t);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  // refine with a few Newton iterations on f(t) = (B(t)-p)·B'(t)
  let t = bestT;
  for (let i = 0; i < 8; i++) {
    const q = cubicPoint(c, t);
    const d1 = cubicDerivative(c, t);
    const d2 = cubicSecondDerivative(c, t);
    const f = (q.x - p.x) * d1.x + (q.y - p.y) * d1.y;
    const df = d1.x * d1.x + d1.y * d1.y + (q.x - p.x) * d2.x + (q.y - p.y) * d2.y;
    if (Math.abs(df) < 1e-12) break;
    const nt = t - f / df;
    if (nt < 0 || nt > 1) break;
    if (Math.abs(nt - t) < 1e-7) {
      t = nt;
      break;
    }
    t = nt;
  }
  t = Math.max(0, Math.min(1, t));
  const q = cubicPoint(c, t);
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  const q0 = cubicPoint(c, bestT);
  const d0 = Math.hypot(q0.x - p.x, q0.y - p.y);
  return d <= d0 ? { t, point: q, distance: d } : { t: bestT, point: q0, distance: d0 };
}

export function cubicSecondDerivative(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  return {
    x: 6 * mt * (c.p2.x - 2 * c.p1.x + c.p0.x) + 6 * t * (c.p3.x - 2 * c.p2.x + c.p1.x),
    y: 6 * mt * (c.p2.y - 2 * c.p1.y + c.p0.y) + 6 * t * (c.p3.y - 2 * c.p2.y + c.p1.y),
  };
}

/** Converts a quadratic (p0, ctrl, p1) into an equivalent cubic. */
export function quadToCubic(p0: Vec, ctrl: Vec, p1: Vec): Cubic {
  return {
    p0,
    p1: { x: p0.x + (2 / 3) * (ctrl.x - p0.x), y: p0.y + (2 / 3) * (ctrl.y - p0.y) },
    p2: { x: p1.x + (2 / 3) * (ctrl.x - p1.x), y: p1.y + (2 / 3) * (ctrl.y - p1.y) },
    p3: p1,
  };
}

/**
 * Convert an SVG elliptical arc (endpoint parameterization) into cubic Beziers.
 * Returns an array of cubics; empty if the arc is degenerate.
 */
export function arcToCubics(
  from: Vec,
  rx: number,
  ry: number,
  xAxisRotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: Vec,
): Cubic[] {
  if (Math.abs(from.x - to.x) < 1e-12 && Math.abs(from.y - to.y) < 1e-12) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12) {
    return [{ p0: from, p1: from, p2: to, p3: to }];
  }
  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  // Step 1: compute (x1', y1')
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  // Ensure radii are large enough
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  // Step 2: compute (cx', cy')
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  if (num < 0) num = 0;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(num / den);
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;
  // Step 3: compute (cx, cy)
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;
  // Step 4: angles
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const angle = (ax: number, ay: number, bx: number, by: number): number => {
    const d = ax * bx + ay * by;
    const l = Math.hypot(ax, ay) * Math.hypot(bx, by);
    let a = Math.acos(Math.max(-1, Math.min(1, d / l)));
    if (ax * by - ay * bx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, ux, uy);
  let dTheta = angle(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  // Split into segments of at most 90 degrees
  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segments;
  const t = ((4 / 3) * Math.tan(delta / 4));
  const cubics: Cubic[] = [];
  let th = theta1;
  let prev = from;
  for (let i = 0; i < segments; i++) {
    const cos1 = Math.cos(th);
    const sin1 = Math.sin(th);
    const th2 = th + delta;
    const cos2 = Math.cos(th2);
    const sin2 = Math.sin(th2);
    // endpoint
    const ex = cx + rx * cos2 * cosPhi - ry * sin2 * sinPhi;
    const ey = cy + rx * cos2 * sinPhi + ry * sin2 * cosPhi;
    // derivative at start & end
    const dx1 = -rx * sin1 * cosPhi - ry * cos1 * sinPhi;
    const dy1 = -rx * sin1 * sinPhi + ry * cos1 * cosPhi;
    const dx2b = -rx * sin2 * cosPhi - ry * cos2 * sinPhi;
    const dy2b = -rx * sin2 * sinPhi + ry * cos2 * cosPhi;
    const end = i === segments - 1 ? to : { x: ex, y: ey };
    cubics.push({
      p0: prev,
      p1: { x: prev.x + t * dx1, y: prev.y + t * dy1 },
      p2: { x: end.x - t * dx2b, y: end.y - t * dy2b },
      p3: end,
    });
    prev = end;
    th = th2;
  }
  return cubics;
}

/** Kappa for approximating a quarter circle with a cubic. */
export const KAPPA = 0.5522847498307936;

/**
 * Find intersections between two cubic curves (bezier clipping via subdivision).
 * Returns pairs of parameters [t1, t2].
 */
export function cubicIntersections(a: Cubic, b: Cubic, tolerance = 0.01): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const rec = (ca: Cubic, ta0: number, ta1: number, cb: Cubic, tb0: number, tb1: number, depth: number) => {
    const ba = cubicBounds(ca);
    const bb = cubicBounds(cb);
    if (
      ba.x > bb.x + bb.width ||
      bb.x > ba.x + ba.width ||
      ba.y > bb.y + bb.height ||
      bb.y > ba.y + ba.height
    )
      return;
    if (depth > 20 || (ba.width + ba.height < tolerance && bb.width + bb.height < tolerance)) {
      const ta = (ta0 + ta1) / 2;
      const tb = (tb0 + tb1) / 2;
      // dedupe
      if (!out.some(([x, y]) => Math.abs(x - ta) < 0.01 && Math.abs(y - tb) < 0.01)) out.push([ta, tb]);
      return;
    }
    const [a1, a2] = cubicSplit(ca, 0.5);
    const [b1, b2] = cubicSplit(cb, 0.5);
    const tam = (ta0 + ta1) / 2;
    const tbm = (tb0 + tb1) / 2;
    rec(a1, ta0, tam, b1, tb0, tbm, depth + 1);
    rec(a1, ta0, tam, b2, tbm, tb1, depth + 1);
    rec(a2, tam, ta1, b1, tb0, tbm, depth + 1);
    rec(a2, tam, ta1, b2, tbm, tb1, depth + 1);
  };
  rec(a, 0, 1, b, 0, 1, 0);
  return out;
}
