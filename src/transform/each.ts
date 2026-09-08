/**
 * Transform Each: transforms every selected object around its own reference
 * point (scale, move, rotate, reflect, optionally randomized).
 */
import type { Document, ID, Matrix } from '@/model/types';
import { multiply, scale, translate } from '@/geometry/matrix';
import { worldBounds } from '@/model/document';
import { getState } from '@/store/store';
import { refPointOf } from './refPoint';
import { aboutPoint, rotationAbout } from './matrices';
import { applyTransform, previewDocument, transformTargets, type MatrixSource } from './apply';
import { getTransformState, type EachParams } from './store';

export const DEFAULT_EACH: EachParams = { scaleX: 100, scaleY: 100, moveX: 0, moveY: 0, angle: 0, reflectX: false, reflectY: false, random: false, ref: 'c' };

/** Small deterministic PRNG (mulberry32) so preview and apply agree. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Matrix source applying `params` to each object around its own reference point. */
export function eachMatrixSource(params: EachParams, seed = 1): MatrixSource {
  const rnd = makeRandom(seed);
  const cache = new Map<ID, Matrix | null>();
  return (id: ID, doc: Document) => {
    if (cache.has(id)) return cache.get(id)!;
    const b = worldBounds(doc, id);
    if (!b) {
      cache.set(id, null);
      return null;
    }
    let sx = params.scaleX / 100;
    let sy = params.scaleY / 100;
    let mx = params.moveX;
    let my = params.moveY;
    let ang = params.angle;
    if (params.random) {
      sx = 1 + (sx - 1) * rnd();
      sy = 1 + (sy - 1) * rnd();
      mx *= rnd();
      my *= rnd();
      ang *= rnd();
    }
    if (!Number.isFinite(sx) || Math.abs(sx) < 1e-4) sx = 1e-4;
    if (!Number.isFinite(sy) || Math.abs(sy) < 1e-4) sy = 1e-4;
    const p = refPointOf(b, params.ref);
    let lin = scale(sx, sy);
    if (params.reflectX) lin = multiply(scale(-1, 1), lin);
    if (params.reflectY) lin = multiply(scale(1, -1), lin);
    let m = aboutPoint(lin, p);
    if (ang) m = multiply(rotationAbout(ang, p), m);
    m = multiply(translate(mx, my), m);
    cache.set(id, m);
    return m;
  };
}

export function previewTransformEach(base: Document, ids: ID[], params: EachParams, seed: number): Document {
  return previewDocument(base, ids, eachMatrixSource(params, seed));
}

export function applyTransformEach(params: EachParams, opts: { label?: string; copy?: boolean; ids?: ID[]; seed?: number } = {}): ID[] {
  const s = getState();
  const ids = opts.ids ?? transformTargets(s);
  if (!ids.length) return [];
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
  const out = applyTransform(eachMatrixSource(params, seed), { label: opts.label ?? 'Transform Each', copy: opts.copy, ids });
  getTransformState().setLastTransform({ label: 'Transform Each', copy: !!opts.copy, pivot: { kind: 'ref', ref: params.ref }, linear: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, translate: { x: 0, y: 0 }, each: { ...params } });
  return out;
}
