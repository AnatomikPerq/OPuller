/**
 * 3D effects (pure): Extrude & Bevel, Revolve and Rotate. Paths are flattened,
 * lifted into 3D around the frame centre, rotated (X, Y, Z), lit with a simple
 * Lambert/plastic model and projected back with optional perspective. Faces
 * are returned far-to-near for painter's ordering.
 */
import type { SubPath, Rect, Vec, HexColor, Extrude3DEffect, Revolve3DEffect, Rotate3DEffect, Shading3D } from '@/model/types';
import { flattenSubPath, subpathArea } from '@/geometry/path';
import { hexToRgb, rgbToHex } from '@/util/color';
import { mapSubPaths, type PointMap } from '@/distort/map';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Face3D {
  /** projected polygons (one or more rings, evenodd for caps) */
  rings: Vec[][];
  color: HexColor;
  opacity: number;
  /** mean rotated depth (larger = closer to the viewer) */
  depth: number;
  kind: 'front' | 'back' | 'side' | 'bevel' | 'band';
}

export interface Projection {
  center: Vec;
  rot: (p: Vec3) => Vec3;
  project: (p: Vec3) => Vec;
}

const rad = (d: number) => (d * Math.PI) / 180;

function rotationMatrix(rx: number, ry: number, rz: number): number[] {
  const cx = Math.cos(rad(rx));
  const sx = Math.sin(rad(rx));
  const cy = Math.cos(rad(ry));
  const sy = Math.sin(rad(ry));
  const cz = Math.cos(rad(rz));
  const sz = Math.sin(rad(rz));
  // R = Rz * Ry * Rx (screen space: y down, z towards the viewer)
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const mul = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  };
  return mul(Rz, mul(Ry, Rx));
}

/** Projection for a frame and rotation/perspective settings. */
export function makeProjection(frame: Rect, rotX: number, rotY: number, rotZ: number, perspective: number): Projection {
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const R = rotationMatrix(rotX, -rotY, -rotZ);
  const size = Math.max(frame.width, frame.height, 1);
  const fov = Math.max(0, Math.min(160, perspective));
  const f = fov > 0.5 ? size / 2 / Math.tan(rad(fov) / 2) : 0;
  const rot = (p: Vec3): Vec3 => ({ x: R[0] * p.x + R[1] * p.y + R[2] * p.z, y: R[3] * p.x + R[4] * p.y + R[5] * p.z, z: R[6] * p.x + R[7] * p.y + R[8] * p.z });
  const project = (p: Vec3): Vec => {
    if (!f) return { x: center.x + p.x, y: center.y + p.y };
    const k = f / Math.max(f * 0.05, f - p.z);
    return { x: center.x + p.x * k, y: center.y + p.y * k };
  };
  return { center, rot, project };
}

function lightDir(angle: number, altitude: number): Vec3 {
  const a = rad(angle);
  const h = rad(Math.max(-89, Math.min(89, altitude)));
  return { x: Math.cos(h) * Math.cos(a), y: -Math.cos(h) * Math.sin(a), z: Math.sin(h) };
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Shaded colour of a face with the given (rotated, unit) normal. */
export function shade(fill: HexColor, normal: Vec3, shading: Shading3D, light: Vec3, ambient: number): HexColor {
  if (shading === 'none') return fill;
  const c = hexToRgb(fill);
  const amb = Math.max(0, Math.min(1, ambient / 100));
  const diffuse = Math.max(0, dot(normal, light));
  let k = amb + (1 - amb) * diffuse;
  let spec = 0;
  if (shading === 'plastic') {
    const h = normalize({ x: light.x, y: light.y, z: light.z + 1 });
    spec = Math.pow(Math.max(0, dot(normal, h)), 24) * 0.55;
  }
  k = Math.min(1, k);
  const r = c.r * k + (255 - c.r * k) * spec;
  const g = c.g * k + (255 - c.g * k) * spec;
  const b = c.b * k + (255 - c.b * k) * spec;
  return rgbToHex({ r, g, b });
}

function flattenRing(sp: SubPath, tol: number): Vec[] {
  const pts = flattenSubPath(sp, tol);
  // drop a duplicated closing point
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) pts.pop();
  }
  return pts;
}

/**
 * Inset a ring towards the material: `outerSign` is the sign of the outer
 * ring's area (left-hand normals point into positive-area rings), so both the
 * outer ring and its holes move into the solid part of the shape.
 */
function insetRing(ring: Vec[], amount: number, outerSign: number): Vec[] {
  const n = ring.length;
  if (n < 3 || amount === 0) return ring;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const a = ring[(i - 1 + n) % n];
    const b = ring[(i + 1) % n];
    const e1 = normalize({ x: p.x - a.x, y: p.y - a.y, z: 0 });
    const e2 = normalize({ x: b.x - p.x, y: b.y - p.y, z: 0 });
    // edge normals (left-hand for y-down screen space)
    const n1 = { x: -e1.y, y: e1.x };
    const n2 = { x: -e2.y, y: e2.x };
    let nx = n1.x + n2.x;
    let ny = n1.y + n2.y;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const cosHalf = Math.max(0.3, n1.x * nx + n1.y * ny);
    const d = (amount / cosHalf) * outerSign;
    out.push({ x: p.x + nx * d, y: p.y + ny * d });
  }
  return out;
}

interface Ring3 {
  pts: Vec[];
  /** +1 when the ring's outward side is to the right of the edge direction in screen space */
  outward: number;
}

/**
 * Extrude & Bevel. Returns faces (far → near). Holes (counter-wound rings)
 * get side walls too; caps are drawn as compound polygons.
 */
export function extrudeFaces(sps: SubPath[], frame: Rect, e: Extrude3DEffect, fill: HexColor, opacity = 1): Face3D[] {
  const tol = Math.max(0.15, Math.hypot(frame.width, frame.height) / 600);
  const proj = makeProjection(frame, e.rotX, e.rotY, e.rotZ, e.perspective);
  const light = normalize(lightDir(e.lightAngle, e.lightAltitude));
  const c = proj.center;
  const depth = Math.max(0, e.depth);
  const bh = e.bevel === 'none' ? 0 : Math.max(0, Math.min(depth, e.bevelHeight));
  const rings: Ring3[] = [];
  for (const sp of sps) {
    if (!sp.closed && sp.anchors.length < 3) continue;
    const pts = flattenRing(sp, tol);
    if (pts.length < 3) continue;
    const area = subpathArea({ anchors: pts.map((p) => ({ point: p, handleIn: null, handleOut: null, kind: 'corner' as const })), closed: true });
    rings.push({ pts, outward: area >= 0 ? 1 : -1 });
  }
  if (!rings.length) return [];
  // the largest ring decides which winding is "outer"
  const outerSign = rings.reduce((best, r) => (Math.abs(ringArea(r.pts)) > Math.abs(ringArea(best.pts)) ? r : best), rings[0]).outward;
  const faces: Face3D[] = [];
  const to3 = (p: Vec, z: number): Vec3 => proj.rot({ x: p.x - c.x, y: p.y - c.y, z });
  const emitQuad = (a: Vec, b: Vec, za: number, zb: number, kind: Face3D['kind'], sign: number) => {
    const A0 = to3(a, za);
    const B0 = to3(b, za);
    const B1 = to3(b, zb);
    const A1 = to3(a, zb);
    // normal of the wall: edge × depth direction, oriented outward
    let n = normalize(cross({ x: B0.x - A0.x, y: B0.y - A0.y, z: B0.z - A0.z }, { x: A1.x - A0.x, y: A1.y - A0.y, z: A1.z - A0.z }));
    if (sign < 0) n = { x: -n.x, y: -n.y, z: -n.z };
    if (n.z <= 0) return; // back-facing
    const d = (A0.z + B0.z + B1.z + A1.z) / 4;
    faces.push({ rings: [[proj.project(A0), proj.project(B0), proj.project(B1), proj.project(A1)]], color: shade(fill, n, e.shading, light, e.ambient), opacity, depth: d, kind });
  };
  const wallSign = (r: Ring3) => (r.outward === outerSign ? 1 : -1) * (outerSign > 0 ? -1 : 1);
  // bevel ring (front outline inset)
  const frontRings = rings.map((r) => (bh > 0 ? insetRing(r.pts, bh, outerSign) : r.pts));
  // side walls
  rings.forEach((r, ri) => {
    const pts = r.pts;
    const sign = wallSign(r);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (bh > 0) {
        const fa = frontRings[ri][i];
        const fb = frontRings[ri][(i + 1) % pts.length];
        // bevel: from the inset front (z=0) to the outline at z=-bh
        const A0 = to3(fa, 0);
        const B0 = to3(fb, 0);
        const B1 = to3(b, -bh);
        const A1 = to3(a, -bh);
        let n = normalize(cross({ x: B0.x - A0.x, y: B0.y - A0.y, z: B0.z - A0.z }, { x: A1.x - A0.x, y: A1.y - A0.y, z: A1.z - A0.z }));
        if (sign < 0) n = { x: -n.x, y: -n.y, z: -n.z };
        if (n.z > 0) faces.push({ rings: [[proj.project(A0), proj.project(B0), proj.project(B1), proj.project(A1)]], color: shade(fill, n, e.shading, light, e.ambient), opacity, depth: (A0.z + B0.z + B1.z + A1.z) / 4, kind: 'bevel' });
        if (depth > bh) emitQuad(a, b, -bh, -depth, 'side', sign);
      } else if (depth > 0) emitQuad(a, b, 0, -depth, 'side', sign);
    }
  });
  // caps
  const capNormalFront = proj.rot({ x: 0, y: 0, z: 1 });
  if (e.capped !== false) {
    if (capNormalFront.z > 0) {
      const ringsP = frontRings.map((pts) => pts.map((p) => proj.project(to3(p, 0))));
      faces.push({ rings: ringsP, color: shade(fill, capNormalFront, e.shading, light, e.ambient), opacity, depth: meanDepth(rings.map((r) => r.pts), to3, 0), kind: 'front' });
    }
    const backN = { x: -capNormalFront.x, y: -capNormalFront.y, z: -capNormalFront.z };
    if (backN.z > 0 && depth > 0) {
      const ringsP = rings.map((r) => r.pts.map((p) => proj.project(to3(p, -depth))));
      faces.push({ rings: ringsP, color: shade(fill, backN, e.shading, light, e.ambient), opacity, depth: meanDepth(rings.map((r) => r.pts), to3, -depth), kind: 'back' });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  return faces;
}

function ringArea(pts: Vec[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function meanDepth(rings: Vec[][], to3: (p: Vec, z: number) => Vec3, z: number): number {
  let s = 0;
  let n = 0;
  for (const r of rings) for (const p of r) {
    s += to3(p, z).z;
    n++;
  }
  return n ? s / n : 0;
}

/** Revolve a profile around a vertical axis at the left/right edge of the frame (+ offset). */
export function revolveFaces(sps: SubPath[], frame: Rect, e: Revolve3DEffect, fill: HexColor, opacity = 1): Face3D[] {
  const tol = Math.max(0.15, Math.hypot(frame.width, frame.height) / 400);
  const proj = makeProjection(frame, e.rotX, e.rotY, e.rotZ, e.perspective);
  const light = normalize(lightDir(e.lightAngle, e.lightAltitude));
  const c = proj.center;
  const axisX = e.axis === 'left' ? frame.x - e.offset : frame.x + frame.width + e.offset;
  const angle = Math.max(1, Math.min(360, e.angle));
  const steps = Math.max(3, Math.round((Math.max(6, e.steps) * angle) / 360));
  const faces: Face3D[] = [];
  const pos = (p: Vec, theta: number): Vec3 => {
    const r = p.x - axisX;
    return proj.rot({ x: axisX - c.x + r * Math.cos(theta), y: p.y - c.y, z: -r * Math.sin(theta) });
  };
  for (const sp of sps) {
    const pts = flattenSubPath(sp, tol);
    if (pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      for (let j = 0; j < steps; j++) {
        const t0 = (rad(angle) * j) / steps;
        const t1 = (rad(angle) * (j + 1)) / steps;
        const A0 = pos(a, t0);
        const A1 = pos(a, t1);
        const B1 = pos(b, t1);
        const B0 = pos(b, t0);
        let n = normalize(cross({ x: A1.x - A0.x, y: A1.y - A0.y, z: A1.z - A0.z }, { x: B0.x - A0.x, y: B0.y - A0.y, z: B0.z - A0.z }));
        // orient towards the viewer for shading of two-sided bands
        if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
        const d = (A0.z + A1.z + B1.z + B0.z) / 4;
        faces.push({ rings: [[proj.project(A0), proj.project(A1), proj.project(B1), proj.project(B0)]], color: shade(fill, n, e.shading, light, e.ambient), opacity, depth: d, kind: 'band' });
      }
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  return faces;
}

/** Point map of a 3D rotation of the flat artwork. */
export function rotate3dMap(e: Rotate3DEffect, frame: Rect): PointMap {
  const proj = makeProjection(frame, e.rotX, e.rotY, e.rotZ, e.perspective);
  return (p) => proj.project(proj.rot({ x: p.x - proj.center.x, y: p.y - proj.center.y, z: 0 }));
}

export function rotate3dSubPaths(sps: SubPath[], e: Rotate3DEffect, frame: Rect): SubPath[] {
  if (!e.rotX && !e.rotY && !e.rotZ) return sps;
  return mapSubPaths(sps, rotate3dMap(e, frame), frame, e.perspective > 0 ? 24 : 4);
}

/** Illustrator's position presets (X, Y, Z rotations). */
export const POSITION_PRESETS: Array<{ id: string; label: string; rot: [number, number, number] }> = [
  { id: 'offAxisFront', label: 'Off-Axis Front', rot: [-18, -26, 8] },
  { id: 'offAxisBack', label: 'Off-Axis Back', rot: [-18, 26, -8] },
  { id: 'offAxisLeft', label: 'Off-Axis Left', rot: [-18, 26, 8] },
  { id: 'offAxisRight', label: 'Off-Axis Right', rot: [-18, -26, -8] },
  { id: 'front', label: 'Front', rot: [0, 0, 0] },
  { id: 'back', label: 'Back', rot: [0, 180, 0] },
  { id: 'left', label: 'Left', rot: [0, 90, 0] },
  { id: 'right', label: 'Right', rot: [0, -90, 0] },
  { id: 'top', label: 'Top', rot: [90, 0, 0] },
  { id: 'bottom', label: 'Bottom', rot: [-90, 0, 0] },
  { id: 'isoLeft', label: 'Isometric Left', rot: [35, 30, -35] },
  { id: 'isoRight', label: 'Isometric Right', rot: [35, -30, 35] },
  { id: 'isoTop', label: 'Isometric Top', rot: [-35, -30, 35] },
  { id: 'isoBottom', label: 'Isometric Bottom', rot: [-35, 30, -35] },
];
