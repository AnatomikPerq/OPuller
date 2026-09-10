/**
 * Potrace in TypeScript: turns a binary bitmap into smooth closed Bézier
 * outlines (Peter Selinger's algorithm — path decomposition, optimal
 * polygons, vertex adjustment, corner detection and curve optimisation).
 *
 * Pure code without DOM or paper.js so it runs in a Web Worker and in vitest.
 * Coordinates are pixel units of the bitmap (y down); outer contours run one
 * way and holes the other so the result fills with the nonzero rule.
 */
import type { SubPath, Anchor, Vec } from '@/model/types';

export type TurnPolicy = 'black' | 'white' | 'left' | 'right' | 'minority' | 'majority';

export interface PotraceOptions {
  /** how ambiguous corners are resolved (default minority) */
  turnPolicy?: TurnPolicy;
  /** suppress speckles of up to this many pixels (default 2) */
  turdSize?: number;
  /** corner threshold 0 (all corners) .. 4/3 (no corners); default 1 */
  alphaMax?: number;
  /** run the curve optimisation pass (default true) */
  optCurve?: boolean;
  /** curve optimisation tolerance (default 0.2) */
  optTolerance?: number;
}

/** A binary bitmap: `data[y * width + x]` is 1 for foreground. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

interface Pt {
  x: number;
  y: number;
}

interface Sums {
  x: number;
  y: number;
  xy: number;
  x2: number;
  y2: number;
}

interface Curve {
  n: number;
  tag: Array<'CURVE' | 'CORNER'>;
  /** 3 control points per segment */
  c: Pt[];
  alphaCurve: number;
  vertex: Pt[];
  alpha: number[];
  alpha0: number[];
  beta: number[];
}

interface TracePath {
  area: number;
  len: number;
  pt: Pt[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sign: '+' | '-';
  x0: number;
  y0: number;
  sums: Sums[];
  lon: number[];
  po: number[];
  m: number;
  curve: Curve;
}

interface Quad {
  data: number[];
}

interface Opti {
  pen: number;
  c: [Pt, Pt];
  t: number;
  s: number;
  alpha: number;
}

const P = (x: number, y: number): Pt => ({ x, y });

function makeCurve(n: number): Curve {
  return { n, tag: new Array(n), c: new Array(n * 3), alphaCurve: 0, vertex: new Array(n), alpha: new Array(n), alpha0: new Array(n), beta: new Array(n) };
}

function quadAt(q: Quad, x: number, y: number): number {
  return q.data[x * 3 + y];
}

function mod(a: number, n: number): number {
  return a >= n ? a % n : a >= 0 ? a : n - 1 - ((-1 - a) % n);
}

function xprod(p1: Pt, p2: Pt): number {
  return p1.x * p2.y - p1.y * p2.x;
}

function cyclic(a: number, b: number, c: number): boolean {
  if (a <= c) return a <= b && b < c;
  return a <= b || b < c;
}

function sign(i: number): number {
  return i > 0 ? 1 : i < 0 ? -1 : 0;
}

function quadform(Q: Quad, w: Pt): number {
  const v = [w.x, w.y, 1];
  let sum = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sum += v[i] * quadAt(Q, i, j) * v[j];
  return sum;
}

function interval(lambda: number, a: Pt, b: Pt): Pt {
  return P(a.x + lambda * (b.x - a.x), a.y + lambda * (b.y - a.y));
}

function dorthInfty(p0: Pt, p2: Pt): Pt {
  return P(-sign(p2.y - p0.y), sign(p2.x - p0.x));
}

function ddenom(p0: Pt, p2: Pt): number {
  const r = dorthInfty(p0, p2);
  return r.y * (p2.x - p0.x) - r.x * (p2.y - p0.y);
}

function dpara(p0: Pt, p1: Pt, p2: Pt): number {
  const x1 = p1.x - p0.x;
  const y1 = p1.y - p0.y;
  const x2 = p2.x - p0.x;
  const y2 = p2.y - p0.y;
  return x1 * y2 - x2 * y1;
}

function cprod(p0: Pt, p1: Pt, p2: Pt, p3: Pt): number {
  const x1 = p1.x - p0.x;
  const y1 = p1.y - p0.y;
  const x2 = p3.x - p2.x;
  const y2 = p3.y - p2.y;
  return x1 * y2 - x2 * y1;
}

function iprod(p0: Pt, p1: Pt, p2: Pt): number {
  const x1 = p1.x - p0.x;
  const y1 = p1.y - p0.y;
  const x2 = p2.x - p0.x;
  const y2 = p2.y - p0.y;
  return x1 * x2 + y1 * y2;
}

function iprod1(p0: Pt, p1: Pt, p2: Pt, p3: Pt): number {
  const x1 = p1.x - p0.x;
  const y1 = p1.y - p0.y;
  const x2 = p3.x - p2.x;
  const y2 = p3.y - p2.y;
  return x1 * x2 + y1 * y2;
}

function ddist(p: Pt, q: Pt): number {
  return Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
}

function bezier(t: number, p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt {
  const s = 1 - t;
  return P(s * s * s * p0.x + 3 * (s * s * t) * p1.x + 3 * (t * t * s) * p2.x + t * t * t * p3.x, s * s * s * p0.y + 3 * (s * s * t) * p1.y + 3 * (t * t * s) * p2.y + t * t * t * p3.y);
}

function tangent(p0: Pt, p1: Pt, p2: Pt, p3: Pt, q0: Pt, q1: Pt): number {
  const A = cprod(p0, p1, q0, q1);
  const B = cprod(p1, p2, q0, q1);
  const C = cprod(p2, p3, q0, q1);
  const a = A - 2 * B + C;
  const b = -2 * A + 2 * B;
  const c = A;
  const d = b * b - 4 * a * c;
  if (a === 0 || d < 0) return -1;
  const s = Math.sqrt(d);
  const r1 = (-b + s) / (2 * a);
  const r2 = (-b - s) / (2 * a);
  if (r1 >= 0 && r1 <= 1) return r1;
  if (r2 >= 0 && r2 <= 1) return r2;
  return -1;
}

// ---------------------------------------------------------------------------
// Bitmap helpers
// ---------------------------------------------------------------------------

class Bits {
  constructor(
    readonly w: number,
    readonly h: number,
    readonly data: Uint8Array,
  ) {}

  at(x: number, y: number): boolean {
    return x >= 0 && x < this.w && y >= 0 && y < this.h && this.data[this.w * y + x] === 1;
  }

  flip(x: number, y: number): void {
    const i = this.w * y + x;
    this.data[i] = this.data[i] === 1 ? 0 : 1;
  }

  copy(): Bits {
    return new Bits(this.w, this.h, new Uint8Array(this.data));
  }
}

// ---------------------------------------------------------------------------
// Path decomposition
// ---------------------------------------------------------------------------

function majority(bm: Bits, x: number, y: number): number {
  for (let i = 2; i < 5; i++) {
    let ct = 0;
    for (let a = -i + 1; a <= i - 1; a++) {
      ct += bm.at(x + a, y + i - 1) ? 1 : -1;
      ct += bm.at(x + i - 1, y + a - 1) ? 1 : -1;
      ct += bm.at(x + a - 1, y - i) ? 1 : -1;
      ct += bm.at(x - i, y + a) ? 1 : -1;
    }
    if (ct > 0) return 1;
    if (ct < 0) return 0;
  }
  return 0;
}

function findPath(bm: Bits, bm1: Bits, start: Pt, turnPolicy: TurnPolicy): TracePath {
  const path: TracePath = { area: 0, len: 0, pt: [], minX: 100000, minY: 100000, maxX: -1, maxY: -1, sign: bm.at(start.x, start.y) ? '+' : '-', x0: 0, y0: 0, sums: [], lon: [], po: [], m: 0, curve: makeCurve(0) };
  let x = start.x;
  let y = start.y;
  let dirx = 0;
  let diry = 1;
  for (;;) {
    path.pt.push(P(x, y));
    if (x > path.maxX) path.maxX = x;
    if (x < path.minX) path.minX = x;
    if (y > path.maxY) path.maxY = y;
    if (y < path.minY) path.minY = y;
    path.len++;
    x += dirx;
    y += diry;
    path.area -= x * diry;
    if (x === start.x && y === start.y) break;
    const l = bm1.at(x + (dirx + diry - 1) / 2, y + (diry - dirx - 1) / 2);
    const r = bm1.at(x + (dirx - diry - 1) / 2, y + (diry + dirx - 1) / 2);
    if (r && !l) {
      if (turnPolicy === 'right' || (turnPolicy === 'black' && path.sign === '+') || (turnPolicy === 'white' && path.sign === '-') || (turnPolicy === 'majority' && majority(bm1, x, y)) || (turnPolicy === 'minority' && !majority(bm1, x, y))) {
        const tmp = dirx;
        dirx = -diry;
        diry = tmp;
      } else {
        const tmp = dirx;
        dirx = diry;
        diry = -tmp;
      }
    } else if (r) {
      const tmp = dirx;
      dirx = -diry;
      diry = tmp;
    } else if (!l) {
      const tmp = dirx;
      dirx = diry;
      diry = -tmp;
    }
  }
  return path;
}

function xorPath(bm1: Bits, path: TracePath): void {
  let y1 = path.pt[0].y;
  const len = path.len;
  for (let i = 1; i < len; i++) {
    const x = path.pt[i].x;
    const y = path.pt[i].y;
    if (y !== y1) {
      const minY = y1 < y ? y1 : y;
      const maxX = path.maxX;
      for (let j = x; j < maxX; j++) bm1.flip(j, minY);
      y1 = y;
    }
  }
}

function bitmapToPathList(bm: Bits, turnPolicy: TurnPolicy, turdSize: number): TracePath[] {
  const bm1 = bm.copy();
  const list: TracePath[] = [];
  const size = bm1.w * bm1.h;
  let i = 0;
  for (;;) {
    while (i < size && bm1.data[i] !== 1) i++;
    if (i >= size) break;
    const start = P(i % bm1.w, Math.floor(i / bm1.w));
    const path = findPath(bm, bm1, start, turnPolicy);
    xorPath(bm1, path);
    if (path.area > turdSize) list.push(path);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Polygon fitting
// ---------------------------------------------------------------------------

function calcSums(path: TracePath): void {
  path.x0 = path.pt[0].x;
  path.y0 = path.pt[0].y;
  const s: Sums[] = [{ x: 0, y: 0, xy: 0, x2: 0, y2: 0 }];
  for (let i = 0; i < path.len; i++) {
    const x = path.pt[i].x - path.x0;
    const y = path.pt[i].y - path.y0;
    s.push({ x: s[i].x + x, y: s[i].y + y, xy: s[i].xy + x * y, x2: s[i].x2 + x * x, y2: s[i].y2 + y * y });
  }
  path.sums = s;
}

function calcLon(path: TracePath): void {
  const n = path.len;
  const pt = path.pt;
  const pivk: number[] = new Array(n);
  const nc: number[] = new Array(n);
  const ct = [0, 0, 0, 0];
  path.lon = new Array(n);
  const constraint = [P(0, 0), P(0, 0)];
  const cur = P(0, 0);
  const off = P(0, 0);
  const dk = P(0, 0);
  let k = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (pt[i].x !== pt[k].x && pt[i].y !== pt[k].y) k = i + 1;
    nc[i] = k;
  }
  for (let i = n - 1; i >= 0; i--) {
    ct[0] = ct[1] = ct[2] = ct[3] = 0;
    let dir = (3 + 3 * (pt[mod(i + 1, n)].x - pt[i].x) + (pt[mod(i + 1, n)].y - pt[i].y)) / 2;
    ct[dir]++;
    constraint[0].x = 0;
    constraint[0].y = 0;
    constraint[1].x = 0;
    constraint[1].y = 0;
    k = nc[i];
    let k1 = i;
    let foundk = 0;
    for (;;) {
      foundk = 0;
      dir = (3 + 3 * sign(pt[k].x - pt[k1].x) + sign(pt[k].y - pt[k1].y)) / 2;
      ct[dir]++;
      if (ct[0] && ct[1] && ct[2] && ct[3]) {
        pivk[i] = k1;
        foundk = 1;
        break;
      }
      cur.x = pt[k].x - pt[i].x;
      cur.y = pt[k].y - pt[i].y;
      if (xprod(constraint[0], cur) < 0 || xprod(constraint[1], cur) > 0) break;
      if (Math.abs(cur.x) <= 1 && Math.abs(cur.y) <= 1) {
        /* no constraint */
      } else {
        off.x = cur.x + (cur.y >= 0 && (cur.y > 0 || cur.x < 0) ? 1 : -1);
        off.y = cur.y + (cur.x <= 0 && (cur.x < 0 || cur.y < 0) ? 1 : -1);
        if (xprod(constraint[0], off) >= 0) {
          constraint[0].x = off.x;
          constraint[0].y = off.y;
        }
        off.x = cur.x + (cur.y <= 0 && (cur.y < 0 || cur.x < 0) ? 1 : -1);
        off.y = cur.y + (cur.x >= 0 && (cur.x > 0 || cur.y < 0) ? 1 : -1);
        if (xprod(constraint[1], off) <= 0) {
          constraint[1].x = off.x;
          constraint[1].y = off.y;
        }
      }
      k1 = k;
      k = nc[k1];
      if (!cyclic(k, i, k1)) break;
    }
    if (foundk === 0) {
      dk.x = sign(pt[k].x - pt[k1].x);
      dk.y = sign(pt[k].y - pt[k1].y);
      cur.x = pt[k1].x - pt[i].x;
      cur.y = pt[k1].y - pt[i].y;
      const a = xprod(constraint[0], cur);
      const b = xprod(constraint[0], dk);
      const c = xprod(constraint[1], cur);
      const d = xprod(constraint[1], dk);
      let j = 10000000;
      if (b < 0) j = Math.floor(a / -b);
      if (d > 0) j = Math.min(j, Math.floor(-c / d));
      pivk[i] = mod(k1 + j, n);
    }
  }
  let j = pivk[n - 1];
  path.lon[n - 1] = j;
  for (let i = n - 2; i >= 0; i--) {
    if (cyclic(i + 1, pivk[i], j)) j = pivk[i];
    path.lon[i] = j;
  }
  for (let i = n - 1; cyclic(mod(i + 1, n), j, path.lon[i]); i--) path.lon[i] = j;
}

function penalty3(path: TracePath, i: number, j: number): number {
  const n = path.len;
  const pt = path.pt;
  const sums = path.sums;
  let r = 0;
  if (j >= n) {
    j -= n;
    r = 1;
  }
  let x: number, y: number, x2: number, xy: number, y2: number, k: number;
  if (r === 0) {
    x = sums[j + 1].x - sums[i].x;
    y = sums[j + 1].y - sums[i].y;
    x2 = sums[j + 1].x2 - sums[i].x2;
    xy = sums[j + 1].xy - sums[i].xy;
    y2 = sums[j + 1].y2 - sums[i].y2;
    k = j + 1 - i;
  } else {
    x = sums[j + 1].x - sums[i].x + sums[n].x;
    y = sums[j + 1].y - sums[i].y + sums[n].y;
    x2 = sums[j + 1].x2 - sums[i].x2 + sums[n].x2;
    xy = sums[j + 1].xy - sums[i].xy + sums[n].xy;
    y2 = sums[j + 1].y2 - sums[i].y2 + sums[n].y2;
    k = j + 1 - i + n;
  }
  const px = (pt[i].x + pt[j].x) / 2 - pt[0].x;
  const py = (pt[i].y + pt[j].y) / 2 - pt[0].y;
  const ey = pt[j].x - pt[i].x;
  const ex = -(pt[j].y - pt[i].y);
  const a = (x2 - 2 * x * px) / k + px * px;
  const b = (xy - x * py - y * px) / k + px * py;
  const c = (y2 - 2 * y * py) / k + py * py;
  const s = ex * ex * a + 2 * ex * ey * b + ey * ey * c;
  return Math.sqrt(s);
}

function bestPolygon(path: TracePath): void {
  const n = path.len;
  const pen: number[] = new Array(n + 1);
  const prev: number[] = new Array(n + 1);
  const clip0: number[] = new Array(n);
  const clip1: number[] = new Array(n + 1);
  const seg0: number[] = new Array(n + 1);
  const seg1: number[] = new Array(n + 1);
  for (let i = 0; i < n; i++) {
    let c = mod(path.lon[mod(i - 1, n)] - 1, n);
    if (c === i) c = mod(i + 1, n);
    if (c < i) clip0[i] = n;
    else clip0[i] = c;
  }
  let j = 1;
  for (let i = 0; i < n; i++) {
    while (j <= clip0[i]) {
      clip1[j] = i;
      j++;
    }
  }
  let i = 0;
  for (j = 0; i < n; j++) {
    seg0[j] = i;
    i = clip0[i];
  }
  seg0[j] = n;
  const m = j;
  i = n;
  for (j = m; j > 0; j--) {
    seg1[j] = i;
    i = clip1[i];
  }
  seg1[0] = 0;
  pen[0] = 0;
  for (j = 1; j <= m; j++) {
    for (i = seg1[j]; i <= seg0[j]; i++) {
      let best = -1;
      for (let k = seg0[j - 1]; k >= clip1[i]; k--) {
        const thispen = penalty3(path, k, i) + pen[k];
        if (best < 0 || thispen < best) {
          prev[i] = k;
          best = thispen;
        }
      }
      pen[i] = best;
    }
  }
  path.m = m;
  path.po = new Array(m);
  for (i = n, j = m - 1; i > 0; j--) {
    i = prev[i];
    path.po[j] = i;
  }
}

function pointslope(path: TracePath, i: number, j: number, ctr: Pt, dir: Pt): void {
  const n = path.len;
  const sums = path.sums;
  let r = 0;
  while (j >= n) {
    j -= n;
    r += 1;
  }
  while (i >= n) {
    i -= n;
    r -= 1;
  }
  while (j < 0) {
    j += n;
    r -= 1;
  }
  while (i < 0) {
    i += n;
    r += 1;
  }
  const x = sums[j + 1].x - sums[i].x + r * sums[n].x;
  const y = sums[j + 1].y - sums[i].y + r * sums[n].y;
  const x2 = sums[j + 1].x2 - sums[i].x2 + r * sums[n].x2;
  const xy = sums[j + 1].xy - sums[i].xy + r * sums[n].xy;
  const y2 = sums[j + 1].y2 - sums[i].y2 + r * sums[n].y2;
  const k = j + 1 - i + r * n;
  ctr.x = x / k;
  ctr.y = y / k;
  let a = (x2 - (x * x) / k) / k;
  const b = (xy - (x * y) / k) / k;
  let c = (y2 - (y * y) / k) / k;
  const lambda2 = (a + c + Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;
  a -= lambda2;
  c -= lambda2;
  let l: number;
  if (Math.abs(a) >= Math.abs(c)) {
    l = Math.sqrt(a * a + b * b);
    if (l !== 0) {
      dir.x = -b / l;
      dir.y = a / l;
    }
  } else {
    l = Math.sqrt(c * c + b * b);
    if (l !== 0) {
      dir.x = -c / l;
      dir.y = b / l;
    }
  }
  if (l === 0) {
    dir.x = 0;
    dir.y = 0;
  }
}

function adjustVertices(path: TracePath): void {
  const m = path.m;
  const po = path.po;
  const n = path.len;
  const pt = path.pt;
  const x0 = path.x0;
  const y0 = path.y0;
  const ctr: Pt[] = new Array(m);
  const dir: Pt[] = new Array(m);
  const q: Quad[] = new Array(m);
  const v = [0, 0, 0];
  const s = P(0, 0);
  path.curve = makeCurve(m);
  for (let i = 0; i < m; i++) {
    let j = po[mod(i + 1, m)];
    j = mod(j - po[i], n) + po[i];
    ctr[i] = P(0, 0);
    dir[i] = P(0, 0);
    pointslope(path, po[i], j, ctr[i], dir[i]);
  }
  for (let i = 0; i < m; i++) {
    q[i] = { data: new Array(9).fill(0) };
    const d = dir[i].x * dir[i].x + dir[i].y * dir[i].y;
    if (d === 0) {
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) q[i].data[j * 3 + k] = 0;
    } else {
      v[0] = dir[i].y;
      v[1] = -dir[i].x;
      v[2] = -v[1] * ctr[i].y - v[0] * ctr[i].x;
      for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) q[i].data[l * 3 + k] = (v[l] * v[k]) / d;
    }
  }
  for (let i = 0; i < m; i++) {
    const Q: Quad = { data: new Array(9).fill(0) };
    const w = P(0, 0);
    s.x = pt[po[i]].x - x0;
    s.y = pt[po[i]].y - y0;
    const j = mod(i - 1, m);
    for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) Q.data[l * 3 + k] = quadAt(q[j], l, k) + quadAt(q[i], l, k);
    for (;;) {
      const det = quadAt(Q, 0, 0) * quadAt(Q, 1, 1) - quadAt(Q, 0, 1) * quadAt(Q, 1, 0);
      if (det !== 0) {
        w.x = (-quadAt(Q, 0, 2) * quadAt(Q, 1, 1) + quadAt(Q, 1, 2) * quadAt(Q, 0, 1)) / det;
        w.y = (quadAt(Q, 0, 2) * quadAt(Q, 1, 0) - quadAt(Q, 1, 2) * quadAt(Q, 0, 0)) / det;
        break;
      }
      if (quadAt(Q, 0, 0) > quadAt(Q, 1, 1)) {
        v[0] = -quadAt(Q, 0, 1);
        v[1] = quadAt(Q, 0, 0);
      } else if (quadAt(Q, 1, 1)) {
        v[0] = -quadAt(Q, 1, 1);
        v[1] = quadAt(Q, 1, 0);
      } else {
        v[0] = 1;
        v[1] = 0;
      }
      const d = v[0] * v[0] + v[1] * v[1];
      v[2] = -v[1] * s.y - v[0] * s.x;
      for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) Q.data[l * 3 + k] += (v[l] * v[k]) / d;
    }
    let dx = Math.abs(w.x - s.x);
    let dy = Math.abs(w.y - s.y);
    if (dx <= 0.5 && dy <= 0.5) {
      path.curve.vertex[i] = P(w.x + x0, w.y + y0);
      continue;
    }
    let min = quadform(Q, s);
    let xmin = s.x;
    let ymin = s.y;
    if (quadAt(Q, 0, 0) !== 0) {
      for (let z = 0; z < 2; z++) {
        w.y = s.y - 0.5 + z;
        w.x = -(quadAt(Q, 0, 1) * w.y + quadAt(Q, 0, 2)) / quadAt(Q, 0, 0);
        dx = Math.abs(w.x - s.x);
        const cand = quadform(Q, w);
        if (dx <= 0.5 && cand < min) {
          min = cand;
          xmin = w.x;
          ymin = w.y;
        }
      }
    }
    if (quadAt(Q, 1, 1) !== 0) {
      for (let z = 0; z < 2; z++) {
        w.x = s.x - 0.5 + z;
        w.y = -(quadAt(Q, 1, 0) * w.x + quadAt(Q, 1, 2)) / quadAt(Q, 1, 1);
        dy = Math.abs(w.y - s.y);
        const cand = quadform(Q, w);
        if (dy <= 0.5 && cand < min) {
          min = cand;
          xmin = w.x;
          ymin = w.y;
        }
      }
    }
    for (let l = 0; l < 2; l++) {
      for (let k = 0; k < 2; k++) {
        w.x = s.x - 0.5 + l;
        w.y = s.y - 0.5 + k;
        const cand = quadform(Q, w);
        if (cand < min) {
          min = cand;
          xmin = w.x;
          ymin = w.y;
        }
      }
    }
    path.curve.vertex[i] = P(xmin + x0, ymin + y0);
  }
}

function reversePath(path: TracePath): void {
  const curve = path.curve;
  const m = curve.n;
  const v = curve.vertex;
  for (let i = 0, j = m - 1; i < j; i++, j--) {
    const tmp = v[i];
    v[i] = v[j];
    v[j] = tmp;
  }
}

function smooth(path: TracePath, alphaMax: number): void {
  const m = path.curve.n;
  const curve = path.curve;
  for (let i = 0; i < m; i++) {
    const j = mod(i + 1, m);
    const k = mod(i + 2, m);
    const p4 = interval(1 / 2, curve.vertex[k], curve.vertex[j]);
    const denom = ddenom(curve.vertex[i], curve.vertex[k]);
    let alpha: number;
    if (denom !== 0) {
      let dd = dpara(curve.vertex[i], curve.vertex[j], curve.vertex[k]) / denom;
      dd = Math.abs(dd);
      alpha = dd > 1 ? 1 - 1 / dd : 0;
      alpha = alpha / 0.75;
    } else alpha = 4 / 3;
    curve.alpha0[j] = alpha;
    if (alpha >= alphaMax) {
      curve.tag[j] = 'CORNER';
      curve.c[3 * j + 1] = curve.vertex[j];
      curve.c[3 * j + 2] = p4;
    } else {
      if (alpha < 0.55) alpha = 0.55;
      else if (alpha > 1) alpha = 1;
      const p2 = interval(0.5 + 0.5 * alpha, curve.vertex[i], curve.vertex[j]);
      const p3 = interval(0.5 + 0.5 * alpha, curve.vertex[k], curve.vertex[j]);
      curve.tag[j] = 'CURVE';
      curve.c[3 * j + 0] = p2;
      curve.c[3 * j + 1] = p3;
      curve.c[3 * j + 2] = p4;
    }
    curve.alpha[j] = alpha;
    curve.beta[j] = 0.5;
  }
  curve.alphaCurve = 1;
}

function optiPenalty(path: TracePath, i: number, j: number, res: Opti, optTolerance: number, convc: number[], areac: number[]): number {
  const m = path.curve.n;
  const curve = path.curve;
  const vertex = curve.vertex;
  if (i === j) return 1;
  let k = i;
  const i1 = mod(i + 1, m);
  let k1 = mod(k + 1, m);
  const conv = convc[k1];
  if (conv === 0) return 1;
  let d = ddist(vertex[i], vertex[i1]);
  for (k = k1; k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const k2 = mod(k + 2, m);
    if (convc[k1] !== conv) return 1;
    if (sign(cprod(vertex[i], vertex[i1], vertex[k1], vertex[k2])) !== conv) return 1;
    if (iprod1(vertex[i], vertex[i1], vertex[k1], vertex[k2]) < d * ddist(vertex[k1], vertex[k2]) * -0.999847695156) return 1;
  }
  const p0 = { ...curve.c[mod(i, m) * 3 + 2] };
  let p1 = { ...vertex[mod(i + 1, m)] };
  let p2 = { ...vertex[mod(j, m)] };
  const p3 = { ...curve.c[mod(j, m) * 3 + 2] };
  let area = areac[j] - areac[i];
  area -= dpara(vertex[0], curve.c[i * 3 + 2], curve.c[j * 3 + 2]) / 2;
  if (i >= j) area += areac[m];
  const A1 = dpara(p0, p1, p2);
  const A2 = dpara(p0, p1, p3);
  const A3 = dpara(p0, p2, p3);
  const A4 = A1 + A3 - A2;
  if (A2 === A1) return 1;
  const t = A3 / (A3 - A4);
  const s = A2 / (A2 - A1);
  const A = (A2 * t) / 2;
  if (A === 0) return 1;
  const R = area / A;
  const alpha = 2 - Math.sqrt(4 - R / 0.3);
  res.c[0] = interval(t * alpha, p0, p1);
  res.c[1] = interval(s * alpha, p3, p2);
  res.alpha = alpha;
  res.t = t;
  res.s = s;
  p1 = { ...res.c[0] };
  p2 = { ...res.c[1] };
  res.pen = 0;
  for (k = mod(i + 1, m); k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const tt = tangent(p0, p1, p2, p3, vertex[k], vertex[k1]);
    if (tt < -0.5) return 1;
    const pt = bezier(tt, p0, p1, p2, p3);
    d = ddist(vertex[k], vertex[k1]);
    if (d === 0) return 1;
    const d1 = dpara(vertex[k], vertex[k1], pt) / d;
    if (Math.abs(d1) > optTolerance) return 1;
    if (iprod(vertex[k], vertex[k1], pt) < 0 || iprod(vertex[k1], vertex[k], pt) < 0) return 1;
    res.pen += d1 * d1;
  }
  for (k = i; k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const tt = tangent(p0, p1, p2, p3, curve.c[k * 3 + 2], curve.c[k1 * 3 + 2]);
    if (tt < -0.5) return 1;
    const pt = bezier(tt, p0, p1, p2, p3);
    d = ddist(curve.c[k * 3 + 2], curve.c[k1 * 3 + 2]);
    if (d === 0) return 1;
    let d1 = dpara(curve.c[k * 3 + 2], curve.c[k1 * 3 + 2], pt) / d;
    let d2 = dpara(curve.c[k * 3 + 2], curve.c[k1 * 3 + 2], vertex[k1]) / d;
    d2 *= 0.75 * curve.alpha[k1];
    if (d2 < 0) {
      d1 = -d1;
      d2 = -d2;
    }
    if (d1 < d2 - optTolerance) return 1;
    if (d1 < d2) res.pen += (d1 - d2) * (d1 - d2);
  }
  return 0;
}

function optiCurve(path: TracePath, optTolerance: number): void {
  const curve = path.curve;
  const m = curve.n;
  const vert = curve.vertex;
  const pt: number[] = new Array(m + 1);
  const pen: number[] = new Array(m + 1);
  const len: number[] = new Array(m + 1);
  const opt: Opti[] = new Array(m + 1);
  const convc: number[] = new Array(m);
  const areac: number[] = new Array(m + 1);
  const newOpti = (): Opti => ({ pen: 0, c: [P(0, 0), P(0, 0)], t: 0, s: 0, alpha: 0 });
  let o = newOpti();
  for (let i = 0; i < m; i++) {
    if (curve.tag[i] === 'CURVE') convc[i] = sign(dpara(vert[mod(i - 1, m)], vert[i], vert[mod(i + 1, m)]));
    else convc[i] = 0;
  }
  let area = 0;
  areac[0] = 0;
  const p0 = curve.vertex[0];
  for (let i = 0; i < m; i++) {
    const i1 = mod(i + 1, m);
    if (curve.tag[i1] === 'CURVE') {
      const alpha = curve.alpha[i1];
      area += (0.3 * alpha * (4 - alpha) * dpara(curve.c[i * 3 + 2], vert[i1], curve.c[i1 * 3 + 2])) / 2;
      area += dpara(p0, curve.c[i * 3 + 2], curve.c[i1 * 3 + 2]) / 2;
    }
    areac[i + 1] = area;
  }
  pt[0] = -1;
  pen[0] = 0;
  len[0] = 0;
  for (let j = 1; j <= m; j++) {
    pt[j] = j - 1;
    pen[j] = pen[j - 1];
    len[j] = len[j - 1] + 1;
    for (let i = j - 2; i >= 0; i--) {
      const r = optiPenalty(path, i, mod(j, m), o, optTolerance, convc, areac);
      if (r) break;
      if (len[j] > len[i] + 1 || (len[j] === len[i] + 1 && pen[j] > pen[i] + o.pen)) {
        pt[j] = i;
        pen[j] = pen[i] + o.pen;
        len[j] = len[i] + 1;
        opt[j] = o;
        o = newOpti();
      }
    }
  }
  const om = len[m];
  const ocurve = makeCurve(om);
  const s: number[] = new Array(om);
  const t: number[] = new Array(om);
  let j = m;
  for (let i = om - 1; i >= 0; i--) {
    if (pt[j] === j - 1) {
      ocurve.tag[i] = curve.tag[mod(j, m)];
      ocurve.c[i * 3 + 0] = curve.c[mod(j, m) * 3 + 0];
      ocurve.c[i * 3 + 1] = curve.c[mod(j, m) * 3 + 1];
      ocurve.c[i * 3 + 2] = curve.c[mod(j, m) * 3 + 2];
      ocurve.vertex[i] = curve.vertex[mod(j, m)];
      ocurve.alpha[i] = curve.alpha[mod(j, m)];
      ocurve.alpha0[i] = curve.alpha0[mod(j, m)];
      ocurve.beta[i] = curve.beta[mod(j, m)];
      s[i] = t[i] = 1;
    } else {
      ocurve.tag[i] = 'CURVE';
      ocurve.c[i * 3 + 0] = opt[j].c[0];
      ocurve.c[i * 3 + 1] = opt[j].c[1];
      ocurve.c[i * 3 + 2] = curve.c[mod(j, m) * 3 + 2];
      ocurve.vertex[i] = interval(opt[j].s, curve.c[mod(j, m) * 3 + 2], vert[mod(j, m)]);
      ocurve.alpha[i] = opt[j].alpha;
      ocurve.alpha0[i] = opt[j].alpha;
      s[i] = opt[j].s;
      t[i] = opt[j].t;
    }
    j = pt[j];
  }
  for (let i = 0; i < om; i++) {
    const i1 = mod(i + 1, om);
    ocurve.beta[i] = s[i] / (s[i] + t[i1]);
  }
  ocurve.alphaCurve = 1;
  path.curve = ocurve;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function curveToSubPath(curve: Curve): SubPath | null {
  const n = curve.n;
  if (n < 1) return null;
  const start = curve.c[(n - 1) * 3 + 2];
  const anchors: Anchor[] = [{ point: P(start.x, start.y), handleIn: null, handleOut: null, kind: 'corner' }];
  for (let i = 0; i < n; i++) {
    const last = anchors[anchors.length - 1];
    if (curve.tag[i] === 'CURVE') {
      const c1 = curve.c[i * 3 + 0];
      const c2 = curve.c[i * 3 + 1];
      const end = curve.c[i * 3 + 2];
      last.handleOut = { x: c1.x - last.point.x, y: c1.y - last.point.y };
      anchors.push({ point: P(end.x, end.y), handleIn: { x: c2.x - end.x, y: c2.y - end.y }, handleOut: null, kind: 'corner' });
    } else {
      const mid = curve.c[i * 3 + 1];
      const end = curve.c[i * 3 + 2];
      anchors.push({ point: P(mid.x, mid.y), handleIn: null, handleOut: null, kind: 'corner' });
      anchors.push({ point: P(end.x, end.y), handleIn: null, handleOut: null, kind: 'corner' });
    }
  }
  // the last anchor coincides with the first: merge it (closing the loop)
  const end = anchors.pop()!;
  anchors[0].handleIn = end.handleIn;
  // drop zero-length steps
  const cleaned: Anchor[] = [];
  for (const a of anchors) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.abs(prev.point.x - a.point.x) < 1e-9 && Math.abs(prev.point.y - a.point.y) < 1e-9 && !prev.handleOut && !a.handleIn) {
      prev.handleOut = a.handleOut;
      continue;
    }
    cleaned.push(a);
  }
  if (cleaned.length > 1) {
    const f = cleaned[0];
    const l = cleaned[cleaned.length - 1];
    if (Math.abs(f.point.x - l.point.x) < 1e-9 && Math.abs(f.point.y - l.point.y) < 1e-9 && !l.handleOut && !f.handleIn) {
      f.handleIn = l.handleIn;
      cleaned.pop();
    }
  }
  // corner segments end at the midpoints of straight runs: drop collinear points
  for (let i = cleaned.length - 1; i >= 0 && cleaned.length > 3; i--) {
    const a = cleaned[i];
    if (a.handleIn || a.handleOut) continue;
    const prev = cleaned[(i - 1 + cleaned.length) % cleaned.length];
    const next = cleaned[(i + 1) % cleaned.length];
    if (prev.handleOut || next.handleIn) continue;
    const ux = a.point.x - prev.point.x;
    const uy = a.point.y - prev.point.y;
    const vx = next.point.x - a.point.x;
    const vy = next.point.y - a.point.y;
    const cross = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy;
    if (Math.abs(cross) < 1e-6 * Math.max(1, Math.hypot(ux, uy) * Math.hypot(vx, vy)) && dot > 0) cleaned.splice(i, 1);
  }
  for (const a of cleaned) {
    if (a.handleIn && a.handleOut) {
      const li = Math.hypot(a.handleIn.x, a.handleIn.y);
      const lo = Math.hypot(a.handleOut.x, a.handleOut.y);
      if (li > 1e-9 && lo > 1e-9) {
        const cross = (a.handleIn.x * a.handleOut.y - a.handleIn.y * a.handleOut.x) / (li * lo);
        const dot = (a.handleIn.x * a.handleOut.x + a.handleIn.y * a.handleOut.y) / (li * lo);
        a.kind = Math.abs(cross) < 1e-3 && dot < 0 ? 'smooth' : 'corner';
      }
    }
  }
  if (cleaned.length < 2) return null;
  return { anchors: cleaned, closed: true };
}

/** Trace a binary bitmap into closed subpaths (pixel coordinates). */
export function traceBitmap(bitmap: Bitmap, options: PotraceOptions = {}): SubPath[] {
  const turnPolicy = options.turnPolicy ?? 'minority';
  const turdSize = options.turdSize ?? 2;
  const alphaMax = options.alphaMax ?? 1;
  const optCurve = options.optCurve ?? true;
  const optTolerance = options.optTolerance ?? 0.2;
  const bm = new Bits(bitmap.width, bitmap.height, bitmap.data);
  const list = bitmapToPathList(bm, turnPolicy, turdSize);
  const out: SubPath[] = [];
  for (const path of list) {
    calcSums(path);
    calcLon(path);
    bestPolygon(path);
    adjustVertices(path);
    if (path.sign === '-') reversePath(path);
    smooth(path, alphaMax);
    if (optCurve) optiCurve(path, optTolerance);
    const sp = curveToSubPath(path.curve);
    if (sp) out.push(sp);
  }
  return out;
}

/** Signed area of a closed polygon through the anchor points (for tests / ordering). */
export function polygonArea(points: Vec[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
