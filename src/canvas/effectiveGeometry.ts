/**
 * Geometry of a path after its geometry effects (round corners, and any
 * effect registered by feature modules such as warp / free distort). Kept
 * separate from the renderer so pure modules (brushes, expand) can use it.
 */
import type { PathNode, SubPath, Effect, Rect } from '@/model/types';
import { roundCornersEffect } from '@/geometry/roundCornersEffect';
import { roundCorners } from '@/geometry/shapes';
import { applyLiveCornersAll } from '@/geometry/corners';
import { pathBounds } from '@/geometry/path';

/** Geometry effects map subpaths within a frame (the bounds of the object the effect is applied to). */
export type GeometryEffectFn = (sps: SubPath[], effect: Effect, frame: Rect) => SubPath[];

const geometryEffects = new Map<string, GeometryEffectFn>();

/** Feature modules register geometry effects (applied in list order). */
export function registerGeometryEffect(type: string, fn: GeometryEffectFn): void {
  geometryEffects.set(type, fn);
}

export function isGeometryEffect(type: string): boolean {
  return type === 'roundCorners' || geometryEffects.has(type);
}

/**
 * Apply a list of effects' geometry parts to subpaths measured in `frame` (frame = null → own
 * bounds). Round Corners is Illustrator's effect (bare corners cut at the radius) when it comes
 * first; after another geometry effect (a warp has just turned the corners into anchors with
 * handles) it rounds tangent breaks like the corner widget instead, so `[warp, roundCorners]`
 * still rounds the tip — Illustrator's own result there is an artefact of its effect chain.
 */
export function applyGeometryEffects(sps: SubPath[], effects: Effect[], frame: Rect | null = null): SubPath[] {
  let cur = sps;
  let reshaped = false;
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.type === 'roundCorners') {
      if (e.radius > 0) cur = cur.map((sp) => (reshaped ? roundCorners(sp, e.radius) : roundCornersEffect(sp, e.radius)));
      continue;
    }
    const fn = geometryEffects.get(e.type);
    if (fn) {
      cur = fn(cur, e, frame ?? pathBounds(cur) ?? { x: 0, y: 0, width: 1, height: 1 });
      reshaped = true;
    }
  }
  return cur;
}

/**
 * Path geometry after its live corners (`anchor.cornerRadius`, applied first — they are part
 * of the object like Illustrator's corner widgets) and its own geometry effects (round
 * corners, warp, ...), in list order.
 */
export function effectiveSubPaths(n: PathNode): SubPath[] {
  return applyGeometryEffects(applyLiveCornersAll(n.subpaths), n.effects, null);
}

/** Path geometry with live corners baked and no effects (what destructive operations work on). */
export function baseSubPaths(n: PathNode): SubPath[] {
  return applyLiveCornersAll(n.subpaths);
}

/** Whether any enabled effect in the list changes geometry (registered geometry effects). */
export function hasGeometryEffects(effects: Effect[]): boolean {
  return effects.some((e) => e.enabled && e.type !== 'roundCorners' && geometryEffects.has(e.type));
}

export type { Rect };
