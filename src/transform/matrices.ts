/**
 * Matrix builders in Illustrator's angle convention: angles are in degrees and
 * positive angles are counter-clockwise on screen (the document's y axis grows
 * downwards, so this is the opposite sign of `geometry/matrix.rotate`).
 */
import type { Matrix, Vec } from '@/model/types';
import { identity, multiply, rotate, reflect, scale, skew, translate } from '@/geometry/matrix';

/** `lin` (a matrix about the origin) applied about point `p`. */
export function aboutPoint(lin: Matrix, p: Vec): Matrix {
  return multiply(translate(p.x, p.y), multiply(lin, translate(-p.x, -p.y)));
}

/** The linear part (a, b, c, d) of a matrix, translation dropped. */
export function linearPart(m: Matrix): Matrix {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0 };
}

/** Rotation by `angleCcw` degrees (counter-clockwise positive) about `p`. */
export function rotationAbout(angleCcw: number, p: Vec): Matrix {
  return rotate(-angleCcw, p.x, p.y);
}

export function scaleAbout(sx: number, sy: number, p: Vec): Matrix {
  return scale(sx, sy, p.x, p.y);
}

/** Reflection across the line through `p` at `axisAngleCcw` degrees (0 = horizontal axis, 90 = vertical axis). */
export function reflectAbout(axisAngleCcw: number, p: Vec): Matrix {
  return reflect(-axisAngleCcw, p.x, p.y);
}

/**
 * Shear by `shearAngleCcw` degrees along an axis at `axisAngleCcw` degrees
 * (0 = horizontal axis: the top of the object moves to the right for positive
 * angles, like italics; 90 = vertical axis).
 */
export function shearAbout(shearAngleCcw: number, axisAngleCcw: number, p: Vec): Matrix {
  const k = skew(-shearAngleCcw, 0);
  const r = rotate(-axisAngleCcw);
  const ri = rotate(axisAngleCcw);
  return aboutPoint(multiply(r, multiply(k, ri)), p);
}

export function translation(dx: number, dy: number): Matrix {
  return translate(dx, dy);
}

/** Normalize an angle to (-180, 180]. */
export function normalizeAngle(deg: number): number {
  let a = ((deg + 180) % 360) - 180;
  if (a <= -180) a += 360;
  if (Math.abs(a) < 1e-9) a = 0;
  return a;
}

/** Snap an angle to multiples of `step` degrees. */
export function snapAngle(deg: number, step: number): number {
  if (!step || step <= 0) return deg;
  return Math.round(deg / step) * step;
}

/** Convert a screen-space direction (y down) to a counter-clockwise angle in degrees. */
export function screenAngleDeg(from: Vec, to: Vec): number {
  return normalizeAngle((-Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

/** Uniform scale factor of a matrix (sqrt of |det|). */
export function uniformFactor(m: Matrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/** Whether a matrix is (close to) a pure translation. */
export function isTranslationOnly(m: Matrix, eps = 1e-9): boolean {
  return Math.abs(m.a - 1) < eps && Math.abs(m.d - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps;
}

export { identity };
