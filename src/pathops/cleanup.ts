/**
 * Sliver cleanup for boolean results: paper.js leaves hair-thin subpaths where outlines
 * touch; they are dropped from Pathfinder results unless asked otherwise. Pure (no paper.js).
 */
import type { SubPath } from '@/model/types';
import { subpathArea } from '@/geometry/path';

/** Area (px²) below which a subpath of a boolean result is a sliver that gets dropped. */
export const SLIVER_AREA = 0.25;

/** Remove degenerate subpaths (tiny area, fewer than 2 anchors) from boolean results; keeps at least one subpath per result. */
export function cleanupResults<T extends { subpaths: SubPath[] }>(results: T[], minArea = SLIVER_AREA): T[] {
  return results
    .map((r) => {
      const kept = r.subpaths.filter((sp) => sp.anchors.length >= 2 && (!sp.closed || Math.abs(subpathArea(sp)) >= minArea));
      return kept.length ? { ...r, subpaths: kept } : r;
    })
    .filter((r) => r.subpaths.length > 0);
}

