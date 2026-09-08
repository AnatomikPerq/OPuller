/**
 * Gradient mesh maths (pure): building a mesh from a colour, Coons patch
 * evaluation, inserting / removing mesh lines and locating a point.
 */
import type { MeshGradientPaint, MeshNode, Vec, HexColor, Paint } from '@/model/types';
import { hexToRgb, rgbToHex, mixHex } from '@/util/color';

export type MeshAppearance = 'flat' | 'toCenter' | 'toEdge';

export interface MeshOptions {
  rows: number;
  cols: number;
  appearance: MeshAppearance;
  /** highlight strength 0..100 (percent of white mixed in at the centre / edge) */
  highlight: number;
}

export const DEFAULT_MESH: MeshOptions = { rows: 4, cols: 4, appearance: 'flat', highlight: 100 };

export function nodeIndex(mesh: Pick<MeshGradientPaint, 'cols'>, r: number, c: number): number {
  return r * (mesh.cols + 1) + c;
}

export function meshNode(mesh: MeshGradientPaint, r: number, c: number): MeshNode {
  return mesh.nodes[nodeIndex(mesh, r, c)];
}

/** Default handles: a third of the way to the neighbouring nodes (smooth mesh). */
export function defaultHandles(mesh: MeshGradientPaint): MeshGradientPaint {
  const nodes = mesh.nodes.map((n) => ({ ...n }));
  const at = (r: number, c: number) => nodes[nodeIndex(mesh, r, c)];
  for (let r = 0; r <= mesh.rows; r++) {
    for (let c = 0; c <= mesh.cols; c++) {
      const n = at(r, c);
      n.up = r > 0 ? { x: (at(r - 1, c).x - n.x) / 3, y: (at(r - 1, c).y - n.y) / 3 } : null;
      n.down = r < mesh.rows ? { x: (at(r + 1, c).x - n.x) / 3, y: (at(r + 1, c).y - n.y) / 3 } : null;
      n.left = c > 0 ? { x: (at(r, c - 1).x - n.x) / 3, y: (at(r, c - 1).y - n.y) / 3 } : null;
      n.right = c < mesh.cols ? { x: (at(r, c + 1).x - n.x) / 3, y: (at(r, c + 1).y - n.y) / 3 } : null;
    }
  }
  return { ...mesh, nodes };
}

/** Base colour of a paint for the mesh (solid, first gradient stop, ...). */
export function baseColorOf(paint: Paint): { color: HexColor; opacity: number } {
  switch (paint.type) {
    case 'solid':
      return { color: paint.color, opacity: paint.opacity };
    case 'linear':
    case 'radial':
      return { color: paint.stops[0]?.color ?? '#808080', opacity: paint.stops[0]?.opacity ?? 1 };
    case 'freeform':
      return { color: paint.points[0]?.color ?? '#808080', opacity: 1 };
    case 'mesh':
      return { color: paint.nodes[0]?.color ?? '#808080', opacity: 1 };
    default:
      return { color: '#808080', opacity: 1 };
  }
}

/** Build a regular mesh over the bounding box (0..1) with an appearance. */
export function makeMesh(color: HexColor, opts: MeshOptions, opacity = 1): MeshGradientPaint {
  const rows = Math.max(1, Math.min(50, Math.round(opts.rows)));
  const cols = Math.max(1, Math.min(50, Math.round(opts.cols)));
  const nodes: MeshNode[] = [];
  const k = Math.max(0, Math.min(100, opts.highlight)) / 100;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = c / cols;
      const y = r / rows;
      let col = color;
      if (opts.appearance !== 'flat') {
        // distance from the centre, 0 at the centre, 1 at the corners
        const d = Math.min(1, Math.hypot((x - 0.5) * 2, (y - 0.5) * 2));
        const t = opts.appearance === 'toCenter' ? 1 - d : d;
        col = mixHex(color, '#ffffff', t * k);
      }
      nodes.push({ x, y, color: col, opacity });
    }
  }
  return defaultHandles({ type: 'mesh', rows, cols, nodes });
}

function cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function abs(n: MeshNode, h: Vec | null | undefined, fallback: Vec): Vec {
  return h ? { x: n.x + h.x, y: n.y + h.y } : fallback;
}

/** Point of a patch boundary curve: side 'top' (row r, c→c+1), 'bottom', 'left' (col c, r→r+1), 'right'. */
export function patchEdge(mesh: MeshGradientPaint, r: number, c: number, side: 'top' | 'bottom' | 'left' | 'right', t: number): Vec {
  const n00 = meshNode(mesh, r, c);
  const n01 = meshNode(mesh, r, c + 1);
  const n10 = meshNode(mesh, r + 1, c);
  const n11 = meshNode(mesh, r + 1, c + 1);
  switch (side) {
    case 'top':
      return cubic(n00, abs(n00, n00.right, lerp(n00, n01, 1 / 3)), abs(n01, n01.left, lerp(n00, n01, 2 / 3)), n01, t);
    case 'bottom':
      return cubic(n10, abs(n10, n10.right, lerp(n10, n11, 1 / 3)), abs(n11, n11.left, lerp(n10, n11, 2 / 3)), n11, t);
    case 'left':
      return cubic(n00, abs(n00, n00.down, lerp(n00, n10, 1 / 3)), abs(n10, n10.up, lerp(n00, n10, 2 / 3)), n10, t);
    case 'right':
      return cubic(n01, abs(n01, n01.down, lerp(n01, n11, 1 / 3)), abs(n11, n11.up, lerp(n01, n11, 2 / 3)), n11, t);
  }
}

function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Coons patch position at (u, v) inside patch (r, c). */
export function evalPatch(mesh: MeshGradientPaint, r: number, c: number, u: number, v: number): Vec {
  const top = patchEdge(mesh, r, c, 'top', u);
  const bottom = patchEdge(mesh, r, c, 'bottom', u);
  const left = patchEdge(mesh, r, c, 'left', v);
  const right = patchEdge(mesh, r, c, 'right', v);
  const n00 = meshNode(mesh, r, c);
  const n01 = meshNode(mesh, r, c + 1);
  const n10 = meshNode(mesh, r + 1, c);
  const n11 = meshNode(mesh, r + 1, c + 1);
  const bil = { x: (1 - u) * (1 - v) * n00.x + u * (1 - v) * n01.x + (1 - u) * v * n10.x + u * v * n11.x, y: (1 - u) * (1 - v) * n00.y + u * (1 - v) * n01.y + (1 - u) * v * n10.y + u * v * n11.y };
  return { x: (1 - v) * top.x + v * bottom.x + (1 - u) * left.x + u * right.x - bil.x, y: (1 - v) * top.y + v * bottom.y + (1 - u) * left.y + u * right.y - bil.y };
}

/** Bilinear colour at (u, v) inside patch (r, c) as [r, g, b, a] 0..255 / 0..1. */
export function patchColor(mesh: MeshGradientPaint, r: number, c: number, u: number, v: number): [number, number, number, number] {
  const n00 = meshNode(mesh, r, c);
  const n01 = meshNode(mesh, r, c + 1);
  const n10 = meshNode(mesh, r + 1, c);
  const n11 = meshNode(mesh, r + 1, c + 1);
  const c00 = hexToRgb(n00.color);
  const c01 = hexToRgb(n01.color);
  const c10 = hexToRgb(n10.color);
  const c11 = hexToRgb(n11.color);
  const w00 = (1 - u) * (1 - v);
  const w01 = u * (1 - v);
  const w10 = (1 - u) * v;
  const w11 = u * v;
  return [
    w00 * c00.r + w01 * c01.r + w10 * c10.r + w11 * c11.r,
    w00 * c00.g + w01 * c01.g + w10 * c10.g + w11 * c11.g,
    w00 * c00.b + w01 * c01.b + w10 * c10.b + w11 * c11.b,
    w00 * n00.opacity + w01 * n01.opacity + w10 * n10.opacity + w11 * n11.opacity,
  ];
}

export function patchColorHex(mesh: MeshGradientPaint, r: number, c: number, u: number, v: number): HexColor {
  const [rr, g, b] = patchColor(mesh, r, c, u, v);
  return rgbToHex({ r: rr, g, b });
}

/** Move a node (its handles move with it). */
export function moveNode(mesh: MeshGradientPaint, index: number, to: Vec): MeshGradientPaint {
  return { ...mesh, nodes: mesh.nodes.map((n, i) => (i === index ? { ...n, x: to.x, y: to.y } : n)) };
}

export function setHandle(mesh: MeshGradientPaint, index: number, which: 'up' | 'down' | 'left' | 'right', absolute: Vec): MeshGradientPaint {
  return { ...mesh, nodes: mesh.nodes.map((n, i) => (i === index ? { ...n, [which]: { x: absolute.x - n.x, y: absolute.y - n.y } } : n)) };
}

/** Insert a mesh row through parameter v (0..1) of the row band `r`. */
export function insertRow(mesh: MeshGradientPaint, r: number, v: number): MeshGradientPaint {
  const rows = mesh.rows + 1;
  const nodes: MeshNode[] = [];
  for (let rr = 0; rr <= mesh.rows; rr++) {
    for (let c = 0; c <= mesh.cols; c++) nodes.push({ ...meshNode(mesh, rr, c) });
    if (rr === r) {
      for (let c = 0; c <= mesh.cols; c++) {
        // sample the boundary curves between row r and r+1 at v for the position, colour bilinear
        const pos = c < mesh.cols ? patchEdge(mesh, r, c, 'left', v) : patchEdge(mesh, r, c - 1, 'right', v);
        const a = meshNode(mesh, r, c);
        const b = meshNode(mesh, r + 1, c);
        nodes.push({ x: pos.x, y: pos.y, color: mixHex(a.color, b.color, v), opacity: a.opacity + (b.opacity - a.opacity) * v });
      }
    }
  }
  return defaultHandlesKeep({ ...mesh, rows, nodes }, mesh);
}

/** Insert a mesh column through parameter u (0..1) of the column band `c`. */
export function insertCol(mesh: MeshGradientPaint, c: number, u: number): MeshGradientPaint {
  const cols = mesh.cols + 1;
  const nodes: MeshNode[] = [];
  for (let r = 0; r <= mesh.rows; r++) {
    for (let cc = 0; cc <= mesh.cols; cc++) {
      nodes.push({ ...meshNode(mesh, r, cc) });
      if (cc === c) {
        const pos = r < mesh.rows ? patchEdge(mesh, r, c, 'top', u) : patchEdge(mesh, r - 1, c, 'bottom', u);
        const a = meshNode(mesh, r, c);
        const b = meshNode(mesh, r, c + 1);
        nodes.push({ x: pos.x, y: pos.y, color: mixHex(a.color, b.color, u), opacity: a.opacity + (b.opacity - a.opacity) * u });
      }
    }
  }
  return defaultHandlesKeep({ ...mesh, cols, nodes }, mesh);
}

/** Recompute handles for nodes that have none (new ones) while keeping edited handles. */
function defaultHandlesKeep(mesh: MeshGradientPaint, _prev: MeshGradientPaint): MeshGradientPaint {
  const withDefaults = defaultHandles(mesh);
  const nodes = mesh.nodes.map((n, i) => {
    const d = withDefaults.nodes[i];
    return { ...n, up: n.up === undefined ? d.up : n.up ?? d.up, down: n.down === undefined ? d.down : n.down ?? d.down, left: n.left === undefined ? d.left : n.left ?? d.left, right: n.right === undefined ? d.right : n.right ?? d.right };
  });
  // boundary handles must be null
  for (let r = 0; r <= mesh.rows; r++) {
    for (let c = 0; c <= mesh.cols; c++) {
      const n = nodes[nodeIndex(mesh, r, c)];
      if (r === 0) n.up = null;
      if (r === mesh.rows) n.down = null;
      if (c === 0) n.left = null;
      if (c === mesh.cols) n.right = null;
    }
  }
  return { ...mesh, nodes };
}

export function removeRow(mesh: MeshGradientPaint, r: number): MeshGradientPaint {
  if (mesh.rows <= 1 || r <= 0 || r >= mesh.rows) return mesh;
  const nodes = mesh.nodes.filter((_, i) => Math.floor(i / (mesh.cols + 1)) !== r);
  return defaultHandlesKeep({ ...mesh, rows: mesh.rows - 1, nodes }, mesh);
}

export function removeCol(mesh: MeshGradientPaint, c: number): MeshGradientPaint {
  if (mesh.cols <= 1 || c <= 0 || c >= mesh.cols) return mesh;
  const nodes = mesh.nodes.filter((_, i) => i % (mesh.cols + 1) !== c);
  return defaultHandlesKeep({ ...mesh, cols: mesh.cols - 1, nodes }, mesh);
}

/** Locate the patch and parameters closest to a point (bbox units) by sampling. */
export function locate(mesh: MeshGradientPaint, p: Vec, samples = 12): { r: number; c: number; u: number; v: number; distance: number } {
  let best = { r: 0, c: 0, u: 0.5, v: 0.5, distance: Infinity };
  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      for (let i = 0; i <= samples; i++) {
        for (let j = 0; j <= samples; j++) {
          const u = i / samples;
          const v = j / samples;
          const q = evalPatch(mesh, r, c, u, v);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < best.distance) best = { r, c, u, v, distance: d };
        }
      }
    }
  }
  // refine with a few local steps
  let { u, v } = best;
  let step = 1 / samples / 2;
  for (let it = 0; it < 12; it++) {
    let improved = false;
    for (const [du, dv] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const uu = Math.max(0, Math.min(1, u + du));
      const vv = Math.max(0, Math.min(1, v + dv));
      const q = evalPatch(mesh, best.r, best.c, uu, vv);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best.distance) {
        best = { ...best, u: uu, v: vv, distance: d };
        u = uu;
        v = vv;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return best;
}

/** Index of the node nearest to a point, with its distance (bbox units). */
export function nearestNode(mesh: MeshGradientPaint, p: Vec): { index: number; distance: number } {
  let index = 0;
  let distance = Infinity;
  mesh.nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < distance) {
      distance = d;
      index = i;
    }
  });
  return { index, distance };
}

/** Row/column of a node index. */
export function nodeRC(mesh: Pick<MeshGradientPaint, 'cols'>, index: number): { r: number; c: number } {
  return { r: Math.floor(index / (mesh.cols + 1)), c: index % (mesh.cols + 1) };
}
