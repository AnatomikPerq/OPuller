import type { Matrix, Vec, Rect } from '@/model/types';

export const IDENTITY: Matrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as Matrix;

export function identity(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function isIdentity(m: Matrix, eps = 1e-12): boolean {
  return (
    Math.abs(m.a - 1) < eps &&
    Math.abs(m.b) < eps &&
    Math.abs(m.c) < eps &&
    Math.abs(m.d - 1) < eps &&
    Math.abs(m.e) < eps &&
    Math.abs(m.f) < eps
  );
}

export function matrixEquals(m: Matrix, n: Matrix, eps = 1e-9): boolean {
  return (
    Math.abs(m.a - n.a) < eps &&
    Math.abs(m.b - n.b) < eps &&
    Math.abs(m.c - n.c) < eps &&
    Math.abs(m.d - n.d) < eps &&
    Math.abs(m.e - n.e) < eps &&
    Math.abs(m.f - n.f) < eps
  );
}

export function translate(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scale(sx: number, sy = sx, cx = 0, cy = 0): Matrix {
  // translate(cx,cy) * scale * translate(-cx,-cy)
  return { a: sx, b: 0, c: 0, d: sy, e: cx - sx * cx, f: cy - sy * cy };
}

/** Rotation by `deg` degrees (clockwise on screen, since y grows downward). */
export function rotate(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: cx - cos * cx + sin * cy,
    f: cy - sin * cx - cos * cy,
  };
}

export function skew(degX: number, degY: number, cx = 0, cy = 0): Matrix {
  const tx = Math.tan((degX * Math.PI) / 180);
  const ty = Math.tan((degY * Math.PI) / 180);
  const m: Matrix = { a: 1, b: ty, c: tx, d: 1, e: 0, f: 0 };
  return multiply(translate(cx, cy), multiply(m, translate(-cx, -cy)));
}

/** Reflect across a line through (cx, cy) with the given angle in degrees. */
export function reflect(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(2 * r);
  const sin = Math.sin(2 * r);
  const m: Matrix = { a: cos, b: sin, c: sin, d: -cos, e: 0, f: 0 };
  return multiply(translate(cx, cy), multiply(m, translate(-cx, -cy)));
}

/** Returns m * n (apply n first, then m). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Compose left-to-right: compose(a, b, c) == a * b * c (c applied first). */
export function compose(...ms: Matrix[]): Matrix {
  let r = identity();
  for (const m of ms) r = multiply(r, m);
  return r;
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-14) {
    // singular — return identity-ish fallback (avoid NaNs downstream)
    return identity();
  }
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

export function determinant(m: Matrix): number {
  return m.a * m.d - m.b * m.c;
}

export function applyToPoint(m: Matrix, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Transform a direction vector (ignores translation). */
export function applyToVector(m: Matrix, v: Vec): Vec {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

export function applyToRect(m: Matrix, r: Rect): Rect {
  const pts = [
    applyToPoint(m, { x: r.x, y: r.y }),
    applyToPoint(m, { x: r.x + r.width, y: r.y }),
    applyToPoint(m, { x: r.x, y: r.y + r.height }),
    applyToPoint(m, { x: r.x + r.width, y: r.y + r.height }),
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function toSvgTransform(m: Matrix): string {
  return `matrix(${fmt(m.a)} ${fmt(m.b)} ${fmt(m.c)} ${fmt(m.d)} ${fmt(m.e)} ${fmt(m.f)})`;
}

export function toCssTransform(m: Matrix): string {
  return `matrix(${fmt(m.a)}, ${fmt(m.b)}, ${fmt(m.c)}, ${fmt(m.d)}, ${fmt(m.e)}, ${fmt(m.f)})`;
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(+n.toFixed(6));
}

export interface Decomposed {
  translateX: number;
  translateY: number;
  /** degrees */
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** degrees, x-skew after removing rotation */
  skewX: number;
}

/**
 * Decompose into translate * rotate * skewX * scale (QR-style decomposition).
 */
export function decompose(m: Matrix): Decomposed {
  const { a, b, c, d, e, f } = m;
  const det = a * d - b * c;
  let rotation = Math.atan2(b, a);
  let scaleX = Math.hypot(a, b);
  let scaleY = det / (scaleX || 1);
  const skew = Math.atan2(a * c + b * d, a * a + b * b);
  if (scaleX === 0) {
    rotation = 0;
    scaleY = Math.hypot(c, d);
  }
  return {
    translateX: e,
    translateY: f,
    rotation: (rotation * 180) / Math.PI,
    scaleX,
    scaleY,
    skewX: (skew * 180) / Math.PI,
  };
}

export function recompose(d: Decomposed): Matrix {
  return compose(
    translate(d.translateX, d.translateY),
    rotate(d.rotation),
    skew(d.skewX, 0),
    scale(d.scaleX, d.scaleY),
  );
}

/** Uniform-ish scale factor of a matrix (geometric mean of singular values). */
export function scaleFactor(m: Matrix): number {
  return Math.sqrt(Math.abs(determinant(m)));
}

/** Whether the matrix flips orientation. */
export function isMirrored(m: Matrix): boolean {
  return determinant(m) < 0;
}

export function matrixFromValues(a: number, b: number, c: number, d: number, e: number, f: number): Matrix {
  return { a, b, c, d, e, f };
}

/** Parse an SVG transform attribute (matrix/translate/scale/rotate/skewX/skewY list). */
export function parseSvgTransform(str: string | null | undefined): Matrix {
  let m = identity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(str))) {
    const name = match[1];
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(Number);
    let t: Matrix;
    switch (name) {
      case 'matrix':
        t = args.length >= 6 ? matrixFromValues(args[0], args[1], args[2], args[3], args[4], args[5]) : identity();
        break;
      case 'translate':
        t = translate(args[0] || 0, args[1] || 0);
        break;
      case 'scale':
        t = scale(args[0] ?? 1, args.length > 1 ? args[1] : (args[0] ?? 1));
        break;
      case 'rotate':
        t = rotate(args[0] || 0, args[1] || 0, args[2] || 0);
        break;
      case 'skewX':
        t = skew(args[0] || 0, 0);
        break;
      case 'skewY':
        t = skew(0, args[0] || 0);
        break;
      default:
        t = identity();
    }
    m = multiply(m, t);
  }
  return m;
}
