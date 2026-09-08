/**
 * Geometry of a path after its geometry effects (round corners, and any
 * effect registered by feature modules such as warp / free distort). Kept
 * separate from the renderer so pure modules (brushes, expand) can use it.
 */
import type { PathNode, SubPath, Effect, Rect } from '@/model/types';
import { roundCorners } from '@/geometry/shapes';

export type GeometryEffectFn = (sps: SubPath[], effect: Effect, node: PathNode) => SubPath[];

const geometryEffects = new Map<string, GeometryEffectFn>();

/** Feature modules register geometry effects (applied in list order). */
export function registerGeometryEffect(type: string, fn: GeometryEffectFn): void {
  geometryEffects.set(type, fn);
}

export function isGeometryEffect(type: string): boolean {
  return type === 'roundCorners' || geometryEffects.has(type);
}

/** Path geometry after geometry effects (round corners, warp, ...). */
export function effectiveSubPaths(n: PathNode): SubPath[] {
  let sps = n.subpaths;
  for (const e of n.effects) {
    if (!e.enabled) continue;
    if (e.type === 'roundCorners') {
      if (e.radius > 0) sps = sps.map((sp) => roundCorners(sp, e.radius));
      continue;
    }
    const fn = geometryEffects.get(e.type);
    if (fn) sps = fn(sps, e, n);
  }
  return sps;
}

export type { Rect };
