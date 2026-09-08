/**
 * Spine sampling and "bending" of artwork along a path (pure geometry used by
 * art and pattern brushes). A Spine is a dense polyline approximation of a
 * subpath with cumulative arc lengths; `at(s)` returns the point, unit tangent
 * and normal at an arc length (extrapolating beyond the ends).
 */
import type { SubPath, Vec, Anchor, Rect } from '@/model/types';
import { subpathToCubics } from '@/geometry/path';
import { cubicPoint, cubicDerivative, cubicLength, cubicSplit, type Cubic } from '@/geometry/bezier';

export interface SpinePoint {
  point: Vec;
  tangent: Vec;
  normal: Vec;
}

export class Spine {
  readonly pts: Vec[] = [];
  readonly cum: number[] = [];
  readonly length: number;
  readonly closed: boolean;

  constructor(sp: SubPath, maxStep = 3) {
    this.closed = sp.closed;
    const cubics = subpathToCubics(sp);
    if (!cubics.length) {
      const p = sp.anchors[0]?.point ?? { x: 0, y: 0 };
      this.pts.push(p, { x: p.x + 1e-6, y: p.y });
      this.cum.push(0, 1e-6);
      this.length = 1e-6;
      return;
    }
    let acc = 0;
    cubics.forEach((c, i) => {
      const len = cubicLength(c);
      const n = Math.max(2, Math.min(96, Math.ceil(len / maxStep)));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        const p = cubicPoint(c, t);
        if (this.pts.length) {
          const l = this.pts[this.pts.length - 1];
          acc += Math.hypot(p.x - l.x, p.y - l.y);
        }
        this.pts.push(p);
        this.cum.push(acc);
      }
    });
    this.length = acc;
  }

  /** Point / tangent / normal at arc length `s` (clamped inside, extrapolated outside). */
  at(s: number): SpinePoint {
    const pts = this.pts;
    const cum = this.cum;
    const n = pts.length;
    if (n < 2) return { point: pts[0] ?? { x: 0, y: 0 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: 1 } };
    let i: number;
    if (s <= 0) i = 0;
    else if (s >= this.length) i = n - 2;
    else {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    const a = pts[i];
    const b = pts[i + 1];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1e-9;
    dx /= l;
    dy /= l;
    const segLen = cum[i + 1] - cum[i] || 1e-9;
    const t = (s - cum[i]) / segLen;
    const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    // smooth the tangent with the neighbouring segments
    let tx = dx;
    let ty = dy;
    if (t > 0.5 && i + 2 < n) {
      const c = pts[i + 2];
      const l2 = Math.hypot(c.x - b.x, c.y - b.y) || 1e-9;
      const w = (t - 0.5) * 2 * 0.5;
      tx = dx * (1 - w) + ((c.x - b.x) / l2) * w;
      ty = dy * (1 - w) + ((c.y - b.y) / l2) * w;
    } else if (t < 0.5 && i > 0) {
      const z = pts[i - 1];
      const l0 = Math.hypot(a.x - z.x, a.y - z.y) || 1e-9;
      const w = (0.5 - t) * 2 * 0.5;
      tx = dx * (1 - w) + ((a.x - z.x) / l0) * w;
      ty = dy * (1 - w) + ((a.y - z.y) / l0) * w;
    }
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    return { point, tangent: { x: tx, y: ty }, normal: { x: -ty, y: tx } };
  }
}

export interface BendOptions {
  /** artwork box: x range mapped onto [s0, s1], y measured from cy */
  box: Rect;
  s0: number;
  s1: number;
  /** multiplier of the perpendicular offset */
  widthScale: number;
  flipAlong?: boolean;
  flipAcross?: boolean;
}

/** Map an artwork point onto the spine. */
export function bendPoint(spine: Spine, p: Vec, o: BendOptions): Vec {
  let u = o.box.width > 1e-9 ? (p.x - o.box.x) / o.box.width : 0;
  if (o.flipAlong) u = 1 - u;
  const s = o.s0 + u * (o.s1 - o.s0);
  const cy = o.box.y + o.box.height / 2;
  let v = (p.y - cy) * o.widthScale;
  if (o.flipAcross) v = -v;
  const sp = spine.at(s);
  // extrapolate beyond the spine ends along the end tangents
  let px = sp.point.x;
  let py = sp.point.y;
  if (s < 0) {
    px += sp.tangent.x * s;
    py += sp.tangent.y * s;
  } else if (s > spine.length) {
    px += sp.tangent.x * (s - spine.length);
    py += sp.tangent.y * (s - spine.length);
  }
  return { x: px + sp.normal.x * v, y: py + sp.normal.y * v };
}

/** Split cubics so that no piece spans more than `maxU` of the box width (keeps the bend smooth). */
function subdivide(cubics: Cubic[], box: Rect, maxU = 1 / 24): Cubic[] {
  const out: Cubic[] = [];
  const w = Math.max(box.width, 1e-9);
  for (const c of cubics) {
    const xs = [c.p0.x, c.p1.x, c.p2.x, c.p3.x];
    const extent = (Math.max(...xs) - Math.min(...xs)) / w;
    const pieces = Math.max(1, Math.min(32, Math.ceil(extent / maxU)));
    if (pieces === 1) {
      out.push(c);
      continue;
    }
    let rest = c;
    for (let i = 0; i < pieces - 1; i++) {
      const t = 1 / (pieces - i);
      const [l, r] = cubicSplit(rest, t);
      out.push(l);
      rest = r;
    }
    out.push(rest);
  }
  return out;
}

/** Bend a subpath (artwork space) along the spine. */
export function bendSubPath(spine: Spine, sp: SubPath, o: BendOptions): SubPath {
  const cubics = subdivide(subpathToCubics(sp), o.box);
  if (!cubics.length) {
    return { anchors: sp.anchors.map((a) => ({ point: bendPoint(spine, a.point, o), handleIn: null, handleOut: null, kind: 'corner' as const })), closed: sp.closed };
  }
  const mapped = cubics.map((c) => ({ p0: bendPoint(spine, c.p0, o), p1: bendPoint(spine, c.p1, o), p2: bendPoint(spine, c.p2, o), p3: bendPoint(spine, c.p3, o) }));
  const anchors: Anchor[] = [];
  mapped.forEach((c, i) => {
    const prev = mapped[i - 1];
    anchors.push({ point: c.p0, handleIn: prev ? { x: prev.p2.x - c.p0.x, y: prev.p2.y - c.p0.y } : null, handleOut: { x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y }, kind: 'smooth' });
  });
  const last = mapped[mapped.length - 1];
  if (sp.closed) {
    anchors[0].handleIn = { x: last.p2.x - anchors[0].point.x, y: last.p2.y - anchors[0].point.y };
  } else {
    anchors.push({ point: last.p3, handleIn: { x: last.p2.x - last.p3.x, y: last.p2.y - last.p3.y }, handleOut: null, kind: 'smooth' });
  }
  // straight pieces keep zero-length handles (null) for cleanliness
  for (const a of anchors) {
    if (a.handleIn && Math.hypot(a.handleIn.x, a.handleIn.y) < 1e-6) a.handleIn = null;
    if (a.handleOut && Math.hypot(a.handleOut.x, a.handleOut.y) < 1e-6) a.handleOut = null;
    if (!a.handleIn || !a.handleOut) a.kind = 'corner';
  }
  return { anchors, closed: sp.closed };
}

export function bendSubPaths(spine: Spine, sps: SubPath[], o: BendOptions): SubPath[] {
  return sps.map((sp) => bendSubPath(spine, sp, o));
}

/** Deterministic pseudo random generator (xorshift) for scatter brushes. */
export function seeded(seed: string | number): () => number {
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0 || 7;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}
