/**
 * Centerline ("Strokes") tracing for Image Trace: thin features of a bitmap
 * become open stroked paths instead of filled outlines.
 *
 * Pipeline: distance transform (local thickness) → Zhang-Suen skeleton of the
 * foreground → skeleton graph (end points / junctions) → every branch is
 * classified by its median thickness and length: thin, elongated branches
 * become strokes (Douglas-Peucker + least-squares Bézier fitting, Schneider),
 * the remaining branches rebuild the thick regions (union of their maximal
 * discs) that the fill tracer keeps.
 *
 * Pure code (no DOM) so it runs in the trace worker and in vitest.
 */
import type { SubPath, Anchor, Vec } from '@/model/types';

export interface TracedStroke {
  subpath: SubPath;
  /** stroke width in pixels */
  width: number;
  /** length of the skeleton in pixels */
  length: number;
}

export interface StrokeTraceOptions {
  /** features wider than this are fills, thinner ones strokes (px) */
  maxWeight: number;
  /** strokes shorter than this are dropped (px) */
  minLength: number;
  /** curve fitting tolerance (px) */
  tolerance: number;
}

const INF = 1 << 29;

// ---------------------------------------------------------------------------
// Distance transform (chamfer 3-4, accurate to ~8 %)
// ---------------------------------------------------------------------------

/**
 * Distance (px) from every pixel to the nearest seed pixel (`seed[i] !== 0`);
 * the image border is not a seed. With `offset`, seed i starts at offset[i]
 * instead of 0, so the result is min over seeds of (distance + offset) — e.g.
 * negative radii give the union of discs (≤ 0 inside).
 */
export function chamferDistance(seed: Uint8Array, w: number, h: number, offset?: Float32Array): Float32Array {
  const n = w * h;
  const d = new Int32Array(n);
  for (let i = 0; i < n; i++) d[i] = seed[i] ? (offset ? Math.round(offset[i] * 3) : 0) : INF;
  // forward pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  // backward pass
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      const i = row + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = d[i] >= INF ? 1e6 : d[i] / 3;
  return out;
}

// ---------------------------------------------------------------------------
// Thinning (Zhang-Suen)
// ---------------------------------------------------------------------------

/**
 * One-pixel-wide skeleton of a mask (8-connected). Only pixels next to a
 * deletion are re-examined, so the cost is proportional to the area rather
 * than area × thickness.
 */
export function thinZhangSuen(mask: Uint8Array, w: number, h: number): Uint8Array {
  const s = new Uint8Array(mask);
  const n = w * h;
  // pixels on the image border cannot be evaluated with a full neighbourhood: clear them
  for (let x = 0; x < w; x++) {
    s[x] = 0;
    s[(h - 1) * w + x] = 0;
  }
  for (let y = 0; y < h; y++) {
    s[y * w] = 0;
    s[y * w + w - 1] = 0;
  }
  let active: number[] = [];
  for (let i = 0; i < n; i++) if (s[i]) active.push(i);
  const stamp = new Int32Array(n);
  let round = 0;
  const deletable = (i: number, step: number): boolean => {
    const p2 = s[i - w];
    const p3 = s[i - w + 1];
    const p4 = s[i + 1];
    const p5 = s[i + w + 1];
    const p6 = s[i + w];
    const p7 = s[i + w - 1];
    const p8 = s[i - 1];
    const p9 = s[i - w - 1];
    const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
    if (b < 2 || b > 6) return false;
    let a = 0;
    if (!p2 && p3) a++;
    if (!p3 && p4) a++;
    if (!p4 && p5) a++;
    if (!p5 && p6) a++;
    if (!p6 && p7) a++;
    if (!p7 && p8) a++;
    if (!p8 && p9) a++;
    if (!p9 && p2) a++;
    if (a !== 1) return false;
    if (step === 0) return p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0;
    return p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0;
  };
  const offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  // neighbours of the deletions of the last two sub-iterations are the candidates
  let recent1: number[] = [];
  let recent2: number[] = [];
  let first = true;
  for (let iter = 0; iter < 4096; iter++) {
    let changed = false;
    for (let step = 0; step < 2; step++) {
      round++;
      let candidates: number[];
      if (first) candidates = active;
      else {
        candidates = [];
        for (const list of [recent1, recent2]) {
          for (const i of list) {
            if (stamp[i] === round || !s[i]) continue;
            stamp[i] = round;
            candidates.push(i);
          }
        }
      }
      const toDelete: number[] = [];
      for (const i of candidates) {
        if (!s[i]) continue;
        const x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) continue;
        if (deletable(i, step)) toDelete.push(i);
      }
      // delete one by one, re-checking against the updated image: the parallel
      // rule alone wipes out 2×2 blocks (and with them the last pixels of blobs)
      const deleted: number[] = [];
      for (const i of toDelete) {
        if (!deletable(i, step)) continue;
        s[i] = 0;
        deleted.push(i);
      }
      const touched: number[] = [];
      for (const i of deleted) for (const o of offsets) if (s[i + o]) touched.push(i + o);
      recent2 = recent1;
      recent1 = touched;
      if (deleted.length) changed = true;
    }
    if (first) {
      first = false;
      active = [];
    }
    if (!changed) break;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Skeleton graph → polylines
// ---------------------------------------------------------------------------

export interface SkeletonPolyline {
  /** pixel indices */
  pixels: number[];
  closed: boolean;
  /** whether the start / end sit on a junction (degree >= 3) */
  startJunction: boolean;
  endJunction: boolean;
}

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Skeleton neighbours of a pixel as graph edges: a diagonal neighbour does not
 * count when one of the two orthogonal pixels bridging it is set (otherwise
 * every staircase of the skeleton would look like a chain of tiny triangles).
 */
export function skelNeighbours(skel: Uint8Array, w: number, h: number, i: number, out: number[]): number {
  out.length = 0;
  const x = i % w;
  const y = (i - x) / w;
  for (let k = 0; k < 8; k++) {
    const dx = DX[k];
    const dy = DY[k];
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const j = ny * w + nx;
    if (!skel[j]) continue;
    if (dx !== 0 && dy !== 0) {
      if (skel[y * w + nx] || skel[ny * w + x]) continue; // bridged by an orthogonal step
    }
    out.push(j);
  }
  return out.length;
}

/** Trace the skeleton into polylines between end points and junctions (plus closed loops). */
export function skeletonPolylines(skel: Uint8Array, w: number, h: number): SkeletonPolyline[] {
  const n = w * h;
  const deg = new Uint8Array(n);
  const neighbours = (i: number, out: number[]): number => skelNeighbours(skel, w, h, i, out);
  const tmp: number[] = [];
  for (let i = 0; i < n; i++) if (skel[i]) deg[i] = neighbours(i, tmp);
  const visited = new Uint8Array(n);
  const out: SkeletonPolyline[] = [];
  const edgeKeys = new Set<string>();
  const isNode = (i: number) => deg[i] !== 2;
  const walk = (start: number, first: number): SkeletonPolyline | null => {
    const pixels = [start, first];
    let prev = start;
    let cur = first;
    if (isNode(first)) {
      const key = start < first ? `${start}-${first}` : `${first}-${start}`;
      if (edgeKeys.has(key)) return null;
      edgeKeys.add(key);
      return { pixels, closed: false, startJunction: deg[start] >= 3, endJunction: deg[first] >= 3 };
    }
    if (visited[first]) return null;
    visited[first] = 1;
    for (let guard = 0; guard < n; guard++) {
      neighbours(cur, tmp);
      let next = -1;
      let nodeNext = -1;
      for (const j of tmp) {
        if (j === prev) continue;
        if (isNode(j)) {
          if (nodeNext < 0) nodeNext = j;
          continue;
        }
        if (!visited[j]) {
          next = j;
          break;
        }
      }
      if (next < 0) {
        if (nodeNext >= 0) {
          pixels.push(nodeNext);
          return { pixels, closed: false, startJunction: deg[start] >= 3, endJunction: deg[nodeNext] >= 3 };
        }
        // dead end (all neighbours visited): open polyline
        return { pixels, closed: false, startJunction: deg[start] >= 3, endJunction: false };
      }
      visited[next] = 1;
      pixels.push(next);
      prev = cur;
      cur = next;
    }
    return { pixels, closed: false, startJunction: deg[start] >= 3, endJunction: false };
  };
  for (let i = 0; i < n; i++) {
    if (!skel[i] || !isNode(i)) continue;
    if (deg[i] === 0) {
      out.push({ pixels: [i], closed: false, startJunction: false, endJunction: false });
      continue;
    }
    neighbours(i, tmp);
    for (const j of tmp.slice()) {
      const p = walk(i, j);
      if (p && p.pixels.length >= 2) out.push(p);
    }
  }
  // closed loops of degree-2 pixels
  for (let i = 0; i < n; i++) {
    if (!skel[i] || deg[i] !== 2 || visited[i]) continue;
    const pixels = [i];
    visited[i] = 1;
    let prev = -1;
    let cur = i;
    for (let guard = 0; guard < n; guard++) {
      neighbours(cur, tmp);
      let next = -1;
      for (const j of tmp) {
        if (j !== prev && !visited[j]) {
          next = j;
          break;
        }
      }
      if (next < 0) break;
      visited[next] = 1;
      pixels.push(next);
      prev = cur;
      cur = next;
    }
    if (pixels.length >= 3) out.push({ pixels, closed: true, startJunction: false, endJunction: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skeleton clean-up: smoothing, spur pruning, branch merging
// ---------------------------------------------------------------------------

/** 3×3 majority filter: removes single-pixel bumps and notches that would grow skeleton spurs. */
export function majority3x3(mask: Uint8Array, w: number, h: number, passes = 1): Uint8Array {
  let cur = mask;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Uint8Array(cur);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const c = cur[i - w - 1] + cur[i - w] + cur[i - w + 1] + cur[i - 1] + cur[i] + cur[i + 1] + cur[i + w - 1] + cur[i + w] + cur[i + w + 1];
        out[i] = c >= 5 ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}

interface Branch {
  pixels: number[];
  a: string;
  b: string;
  alive: boolean;
}

/**
 * Clean the skeleton graph: junction pixels that touch each other form one
 * node, spurs (end point → junction) shorter than `spurLength(width)` are
 * removed and branches that meet at a node with nothing else left are joined
 * into one polyline. Closed loops pass through unchanged.
 */
export function cleanSkeletonBranches(polys: SkeletonPolyline[], skel: Uint8Array, w: number, h: number, distBg: Float32Array, spurLength: (width: number) => number): SkeletonPolyline[] {
  const n = w * h;
  const deg = new Uint8Array(n);
  const tmpN: number[] = [];
  for (let i = 0; i < n; i++) if (skel[i]) deg[i] = skelNeighbours(skel, w, h, i, tmpN);
  // union-find over touching junction pixels
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = i;
    while (parent.get(c) !== r) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < n; i++) if (skel[i] && deg[i] >= 3) parent.set(i, i);
  for (const i of Array.from(parent.keys())) {
    skelNeighbours(skel, w, h, i, tmpN);
    for (const j of tmpN) if (parent.has(j)) union(i, j);
  }
  const nodeOf = (pixel: number): string => (parent.has(pixel) ? `J${find(pixel)}` : `E${pixel}`);
  const branches: Branch[] = [];
  const closed: SkeletonPolyline[] = [];
  for (const poly of polys) {
    if (poly.closed) {
      closed.push(poly);
      continue;
    }
    branches.push({ pixels: poly.pixels, a: nodeOf(poly.pixels[0]), b: nodeOf(poly.pixels[poly.pixels.length - 1]), alive: true });
  }
  // tiny connectors between two junction nodes: merge the nodes
  for (const br of branches) {
    if (br.a.startsWith('J') && br.b.startsWith('J') && br.pixels.length <= 3 && br.a !== br.b) {
      union(Number(br.a.slice(1)), Number(br.b.slice(1)));
    }
  }
  for (const br of branches) {
    br.a = nodeOf(br.pixels[0]);
    br.b = nodeOf(br.pixels[br.pixels.length - 1]);
    if (br.a === br.b && br.a.startsWith('J') && br.pixels.length <= 3) br.alive = false;
  }
  const widthOf = (pixels: number[]): number => {
    const ws = pixels.map((i) => Math.max(1, 2 * distBg[i] - 1)).sort((x, y) => x - y);
    return ws[Math.floor(ws.length / 2)];
  };
  const lengthOf = (pixels: number[]): number => {
    let l = 0;
    for (let i = 1; i < pixels.length; i++) {
      const dx = (pixels[i] % w) - (pixels[i - 1] % w);
      const dy = Math.floor(pixels[i] / w) - Math.floor(pixels[i - 1] / w);
      l += Math.hypot(dx, dy);
    }
    return l;
  };
  const incidence = (): Map<string, Branch[]> => {
    const m = new Map<string, Branch[]>();
    for (const br of branches) {
      if (!br.alive) continue;
      for (const key of [br.a, br.b]) {
        if (!key.startsWith('J')) continue;
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(br);
      }
    }
    return m;
  };
  for (let guard = 0; guard < 256; guard++) {
    let changed = false;
    // bubbles: two short branches between the same two nodes (a hole in the skeleton): keep one
    const pairs = new Map<string, Branch>();
    for (const br of branches) {
      if (!br.alive || !br.a.startsWith('J') || !br.b.startsWith('J') || br.a === br.b) continue;
      if (lengthOf(br.pixels) > 12) continue;
      const key = br.a < br.b ? `${br.a}|${br.b}` : `${br.b}|${br.a}`;
      const other = pairs.get(key);
      if (other) {
        br.alive = false;
        changed = true;
      } else pairs.set(key, br);
    }
    // prune spurs
    for (const br of branches) {
      if (!br.alive) continue;
      const aJ = br.a.startsWith('J');
      const bJ = br.b.startsWith('J');
      if (aJ === bJ) continue;
      if (lengthOf(br.pixels) < spurLength(widthOf(br.pixels))) {
        br.alive = false;
        changed = true;
      }
    }
    // merge through nodes that have exactly two branches left
    const inc = incidence();
    for (const [key, list] of inc) {
      if (list.length !== 2 || list[0] === list[1]) continue;
      const [p, q] = list;
      // orient p so that it ends at the node, q so that it starts there
      const pp = p.b === key ? p.pixels : p.pixels.slice().reverse();
      const pa = p.b === key ? p.a : p.b;
      const qq = q.a === key ? q.pixels : q.pixels.slice().reverse();
      const qb = q.a === key ? q.b : q.a;
      p.alive = false;
      q.alive = false;
      const pixels = pp[pp.length - 1] === qq[0] ? pp.concat(qq.slice(1)) : pp.concat(qq);
      branches.push({ pixels, a: pa, b: qb, alive: true });
      changed = true;
      break; // incidence is stale now: recompute
    }
    if (!changed) break;
  }
  const inc = incidence();
  const out: SkeletonPolyline[] = closed.slice();
  for (const br of branches) {
    if (!br.alive) continue;
    if (br.pixels.length < 2) {
      out.push({ pixels: br.pixels, closed: false, startJunction: false, endJunction: false });
      continue;
    }
    // a branch that leaves a node and comes back with nothing else attached is a loop
    if (br.a === br.b && br.a.startsWith('J') && (inc.get(br.a)?.length ?? 0) === 2 && br.pixels.length >= 4) {
      out.push({ pixels: br.pixels.slice(0, -1), closed: true, startJunction: false, endJunction: false });
      continue;
    }
    const startJunction = br.a.startsWith('J') && (inc.get(br.a)?.length ?? 0) >= 2;
    const endJunction = br.b.startsWith('J') && (inc.get(br.b)?.length ?? 0) >= 2;
    out.push({ pixels: br.pixels, closed: false, startJunction, endJunction });
  }
  return out;
}

/**
 * Thickness of the shape at a skeleton pixel, measured along the normal of the
 * branch (exact for even and odd widths, unlike twice the distance transform).
 */
export function measureWidth(fg: Uint8Array, w: number, h: number, pixels: number[], k: number, maxWidth: number): number {
  const i = pixels[k];
  const x = (i % w) + 0.5;
  const y = Math.floor(i / w) + 0.5;
  const j0 = pixels[Math.max(0, k - 2)];
  const j1 = pixels[Math.min(pixels.length - 1, k + 2)];
  let tx = (j1 % w) - (j0 % w);
  let ty = Math.floor(j1 / w) - Math.floor(j0 / w);
  const tl = Math.hypot(tx, ty);
  if (tl < 1e-9) return 1;
  tx /= tl;
  ty /= tl;
  const nx = -ty;
  const ny = tx;
  const inside = (px: number, py: number): boolean => {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    return ix >= 0 && iy >= 0 && ix < w && iy < h && fg[iy * w + ix] === 1;
  };
  const limit = Math.max(2, maxWidth * 2);
  let a = 0;
  while (a < limit && inside(x + nx * (a + 0.25), y + ny * (a + 0.25))) a += 0.25;
  let b = 0;
  while (b < limit && inside(x - nx * (b + 0.25), y - ny * (b + 0.25))) b += 0.25;
  return Math.max(1, a + b);
}

// ---------------------------------------------------------------------------
// Polyline simplification and curve fitting
// ---------------------------------------------------------------------------

function pointLineDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Weighted moving average over ±2 points; end points of open polylines stay put. Removes pixel staircases. */
export function smoothPolyline(pts: Vec[], closed: boolean): Vec[] {
  const n = pts.length;
  if (n < 5) return pts.slice();
  const weights = [1, 2, 3, 2, 1];
  const out: Vec[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i < 2 || i > n - 3)) {
      out[i] = { ...pts[i] };
      continue;
    }
    let x = 0;
    let y = 0;
    let ws = 0;
    for (let k = -2; k <= 2; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      const wgt = weights[k + 2];
      x += pts[j].x * wgt;
      y += pts[j].y * wgt;
      ws += wgt;
    }
    out[i] = { x: x / ws, y: y / ws };
  }
  return out;
}

/** Douglas-Peucker simplification. */
export function simplifyPolyline(pts: Vec[], tolerance: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = pointLineDistance(pts[i], pts[a], pts[b]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

type Cubic = [Vec, Vec, Vec, Vec];

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const norm = (a: Vec): Vec => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

function bezierPoint(c: Cubic, t: number): Vec {
  const s = 1 - t;
  return {
    x: s * s * s * c[0].x + 3 * s * s * t * c[1].x + 3 * s * t * t * c[2].x + t * t * t * c[3].x,
    y: s * s * s * c[0].y + 3 * s * s * t * c[1].y + 3 * s * t * t * c[2].y + t * t * t * c[3].y,
  };
}

function bezierDerivative(c: Cubic, t: number): Vec {
  const s = 1 - t;
  return {
    x: 3 * s * s * (c[1].x - c[0].x) + 6 * s * t * (c[2].x - c[1].x) + 3 * t * t * (c[3].x - c[2].x),
    y: 3 * s * s * (c[1].y - c[0].y) + 6 * s * t * (c[2].y - c[1].y) + 3 * t * t * (c[3].y - c[2].y),
  };
}

function bezierSecond(c: Cubic, t: number): Vec {
  const s = 1 - t;
  return {
    x: 6 * s * (c[2].x - 2 * c[1].x + c[0].x) + 6 * t * (c[3].x - 2 * c[2].x + c[1].x),
    y: 6 * s * (c[2].y - 2 * c[1].y + c[0].y) + 6 * t * (c[3].y - 2 * c[2].y + c[1].y),
  };
}

function chordParams(pts: Vec[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(pts: Vec[], u: number[], t1: Vec, t2: Vec): Cubic {
  const first = pts[0];
  const last = pts[pts.length - 1];
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i];
    const s = 1 - t;
    const b0 = s * s * s;
    const b1 = 3 * s * s * t;
    const b2 = 3 * s * t * t;
    const b3 = t * t * t;
    const a1 = mul(t1, b1);
    const a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(add(mul(first, b0), mul(first, b1)), add(mul(last, b2), mul(last, b3))));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = det === 0 ? 0 : (c11 * x0 - c01 * x1) / det;
  let alphaR = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const segLen = Math.hypot(last.x - first.x, last.y - first.y);
  const eps = 1e-6 * segLen;
  if (alphaL < eps || alphaR < eps) {
    alphaL = alphaR = segLen / 3;
  }
  return [first, add(first, mul(t1, alphaL)), add(last, mul(t2, alphaR)), last];
}

function maxError(pts: Vec[], c: Cubic, u: number[]): { err: number; index: number } {
  let err = 0;
  let index = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = bezierPoint(c, u[i]);
    const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
    if (d > err) {
      err = d;
      index = i;
    }
  }
  return { err, index };
}

function reparameterize(pts: Vec[], u: number[], c: Cubic): number[] {
  return u.map((t, i) => {
    const p = pts[i];
    const q = bezierPoint(c, t);
    const q1 = bezierDerivative(c, t);
    const q2 = bezierSecond(c, t);
    const num = (q.x - p.x) * q1.x + (q.y - p.y) * q1.y;
    const den = q1.x * q1.x + q1.y * q1.y + (q.x - p.x) * q2.x + (q.y - p.y) * q2.y;
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - num / den));
  });
}

function fitCubic(pts: Vec[], t1: Vec, t2: Vec, error: number, out: Cubic[]): void {
  if (pts.length === 2) {
    const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / 3;
    out.push([pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let bez = generateBezier(pts, u, t1, t2);
  let { err, index } = maxError(pts, bez, u);
  if (err < error) {
    out.push(bez);
    return;
  }
  if (err < error * 4) {
    for (let i = 0; i < 20; i++) {
      const u2 = reparameterize(pts, u, bez);
      const b2 = generateBezier(pts, u2, t1, t2);
      const m = maxError(pts, b2, u2);
      if (m.err < error) {
        out.push(b2);
        return;
      }
      u = u2;
      bez = b2;
      err = m.err;
      index = m.index;
    }
  }
  if (index <= 0 || index >= pts.length - 1) index = Math.floor(pts.length / 2);
  const centre = norm(sub(pts[index - 1], pts[index + 1]));
  fitCubic(pts.slice(0, index + 1), t1, centre, error, out);
  fitCubic(pts.slice(index), mul(centre, -1), t2, error, out);
}

/** Least-squares cubic Bézier fit (Schneider); `error` is the max deviation in px. */
export function fitCurve(pts: Vec[], error: number): Cubic[] {
  const out: Cubic[] = [];
  if (pts.length < 2) return out;
  const t1 = norm(sub(pts[1], pts[0]));
  const t2 = norm(sub(pts[pts.length - 2], pts[pts.length - 1]));
  fitCubic(pts, t1, t2, error * error, out);
  return out;
}

/** Cubics (sharing end points) → anchors of an open subpath. */
function cubicsToAnchors(cubics: Cubic[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i];
    if (i === 0) anchors.push({ point: { ...c[0] }, handleIn: null, handleOut: sub(c[1], c[0]), kind: 'corner' });
    else {
      const last = anchors[anchors.length - 1];
      last.handleOut = sub(c[1], c[0]);
    }
    anchors.push({ point: { ...c[3] }, handleIn: sub(c[2], c[3]), handleOut: null, kind: 'corner' });
  }
  for (const a of anchors) {
    if (a.handleIn && a.handleOut) {
      const li = Math.hypot(a.handleIn.x, a.handleIn.y);
      const lo = Math.hypot(a.handleOut.x, a.handleOut.y);
      if (li > 1e-9 && lo > 1e-9) {
        const cross = (a.handleIn.x * a.handleOut.y - a.handleIn.y * a.handleOut.x) / (li * lo);
        const d = (a.handleIn.x * a.handleOut.x + a.handleIn.y * a.handleOut.y) / (li * lo);
        a.kind = Math.abs(cross) < 1e-3 && d < 0 ? 'smooth' : 'corner';
      }
    }
    if (a.handleIn && Math.hypot(a.handleIn.x, a.handleIn.y) < 1e-6) a.handleIn = null;
    if (a.handleOut && Math.hypot(a.handleOut.x, a.handleOut.y) < 1e-6) a.handleOut = null;
  }
  return anchors;
}

/**
 * Polyline (pixel centres) → subpath: corners are found on the simplified
 * polyline, every piece between corners is smoothed (pixel staircases) and
 * fitted with cubics. Closed polylines become closed subpaths.
 */
export function polylineToSubPath(raw: Vec[], closed: boolean, tolerance: number): SubPath | null {
  const dense = closed ? raw.concat([raw[0]]) : raw;
  let simple = simplifyPolyline(dense, tolerance);
  if (simple.length < 2) return null;
  // corners: sharp turns between the simplified segments
  const cornerIdx = new Set<number>();
  const simpleIdx: number[] = [];
  let k = 0;
  for (const p of simple) {
    while (k < dense.length && (dense[k].x !== p.x || dense[k].y !== p.y)) k++;
    if (k >= dense.length) break;
    simpleIdx.push(k);
  }
  for (let i = 1; i < simple.length - 1; i++) {
    const a = sub(simple[i], simple[i - 1]);
    const b = sub(simple[i + 1], simple[i]);
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la < 1e-9 || lb < 1e-9) continue;
    const cos = dot(a, b) / (la * lb);
    if (cos < Math.cos((70 * Math.PI) / 180) && la >= 2 && lb >= 2 && simpleIdx[i] !== undefined) cornerIdx.add(simpleIdx[i]);
  }
  const cubics: Cubic[] = [];
  if (closed && cornerIdx.size === 0) {
    // one smooth loop: smooth around the seam, fit as an open curve that returns to its start
    const sm = smoothPolyline(raw, true);
    cubics.push(...fitCurve(sm.concat([sm[0]]), tolerance));
  } else {
    const breaks = [0, ...Array.from(cornerIdx).sort((x, y) => x - y), dense.length - 1];
    for (let i = 0; i < breaks.length - 1; i++) {
      const piece = dense.slice(breaks[i], breaks[i + 1] + 1);
      if (piece.length < 2) continue;
      cubics.push(...fitCurve(smoothPolyline(piece, false), tolerance));
    }
  }
  if (!cubics.length) return null;
  const anchors = cubicsToAnchors(cubics);
  if (closed && anchors.length > 2) {
    const last = anchors.pop()!;
    const a = anchors[0];
    a.handleIn = last.handleIn;
    const hi = a.handleIn;
    const ho = a.handleOut;
    if (hi && ho) {
      const li = Math.hypot(hi.x, hi.y);
      const lo = Math.hypot(ho.x, ho.y);
      const cross = (hi.x * ho.y - hi.y * ho.x) / (li * lo || 1);
      a.kind = Math.abs(cross) < 1e-3 ? 'smooth' : 'corner';
    }
    return { anchors, closed: true };
  }
  return { anchors, closed: false };
}

// ---------------------------------------------------------------------------
// Strokes of one mask
// ---------------------------------------------------------------------------

function polylineLength(pts: Vec[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

export interface StrokeSplit {
  strokes: TracedStroke[];
  /** pixels that belong to strokes (left out of the fills) */
  thin: Uint8Array;
  /** pixels of the thick regions (fills) */
  thick: Uint8Array;
}

/**
 * Split a layer's pixels into stroked centerlines and thick fill regions.
 * A skeleton branch becomes a stroke when its median thickness is at most
 * `maxWeight` and it is elongated; the other branches rebuild the thick
 * regions as the union of their maximal discs.
 */
export function traceStrokes(fg: Uint8Array, w: number, h: number, opts: StrokeTraceOptions): StrokeSplit {
  const n = w * h;
  const bg = new Uint8Array(n);
  for (let i = 0; i < n; i++) bg[i] = fg[i] ? 0 : 1;
  const distBg = chamferDistance(bg, w, h);
  const skel = thinZhangSuen(majority3x3(fg, w, h), w, h);
  const polys = cleanSkeletonBranches(skeletonPolylines(skel, w, h), skel, w, h, distBg, (width) => Math.max(3, width * 1.5));
  const toPts = (pixels: number[]): Vec[] => pixels.map((i) => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 }));
  const strokes: TracedStroke[] = [];
  const thickSeed = new Uint8Array(n);
  const strokeSeed = new Uint8Array(n);
  const offset = new Float32Array(n);
  const maxWeight = Math.max(1, opts.maxWeight);
  const seedThick = (pixels: number[]) => {
    for (const i of pixels) {
      thickSeed[i] = 1;
      offset[i] = -distBg[i];
    }
  };
  for (const poly of polys) {
    const pts = toPts(poly.pixels);
    const length = polylineLength(pts) + (poly.closed ? Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) : 0);
    const widths = poly.pixels.map((_, k) => measureWidth(fg, w, h, poly.pixels, k, maxWeight + 2)).sort((a, b) => a - b);
    const width = widths[Math.floor(widths.length / 2)];
    // one pixel of slack: staircase edges of diagonal lines measure up to a pixel wider
    const thin = width <= maxWeight + 1;
    const elongated = length >= Math.max(2, width * 1.5);
    const structural = poly.startJunction && poly.endJunction;
    let isStroke = thin && (elongated || structural);
    if (isStroke && !poly.closed && !structural && length < opts.minLength) isStroke = false;
    if (isStroke && poly.closed && length < Math.max(opts.minLength, 6)) isStroke = false;
    if (!isStroke) {
      seedThick(poly.pixels);
      continue;
    }
    const sp = polylineToSubPath(pts, poly.closed, Math.max(0.3, opts.tolerance));
    if (!sp || sp.anchors.length < 2) {
      seedThick(poly.pixels);
      continue;
    }
    for (const i of poly.pixels) {
      strokeSeed[i] = 1;
      offset[i] = -distBg[i];
    }
    strokes.push({ subpath: sp, width: Math.round(width * 4) / 4, length });
  }
  const thin = new Uint8Array(n);
  const thick = new Uint8Array(n);
  if (!strokes.length) {
    // nothing became a stroke: the whole layer stays a fill
    for (let i = 0; i < n; i++) thick[i] = fg[i] ? 1 : 0;
    return { strokes, thin, thick };
  }
  // a pixel is part of a stroke when it lies inside the discs of a stroke branch
  // and no fill branch claims it more strongly (fills keep their corners this way)
  const dStroke = chamferDistance(strokeSeed, w, h, offset);
  let anyThick = false;
  for (let i = 0; i < n; i++) if (thickSeed[i]) anyThick = true;
  const dThick = anyThick ? chamferDistance(thickSeed, w, h, offset) : null;
  for (let i = 0; i < n; i++) {
    if (!fg[i]) continue;
    const a = dStroke[i];
    const isThin = a <= 1 && (!dThick || a < dThick[i] + 0.5);
    if (isThin) thin[i] = 1;
    else thick[i] = 1;
  }
  return { strokes, thin, thick };
}
