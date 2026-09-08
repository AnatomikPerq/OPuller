/**
 * Pathfinder "Outline": split every path outline at its intersections with the
 * other paths into open edge segments. Uses paper.js locations directly.
 */
import type { SubPath } from '@/model/types';
import { ensurePaper, subpathToPaper, subpathsToPaper, paperPathToSubPath } from '@/geometry/paperBridge';
import { closeAll } from './geometry';

/** Split `sp` at every intersection with `others` (world space). Returns open pieces. */
export function splitAtIntersections(sp: SubPath, others: SubPath[][]): SubPath[] {
  const paper = ensurePaper();
  const path = subpathToPaper(sp);
  if (path.segments.length < 2) {
    path.remove();
    return [sp];
  }
  const offsets = new Set<number>();
  const length = path.length;
  for (const other of others) {
    if (!other.length) continue;
    const pb = subpathsToPaper(closeAll(other));
    try {
      for (const loc of path.getIntersections(pb)) {
        const off = loc.offset;
        if (off > 1e-6 && off < length - 1e-6) offsets.add(Math.round(off * 1000) / 1000);
      }
    } catch {
      /* ignore */
    }
    pb.remove();
  }
  if (!offsets.size) {
    path.remove();
    return [sp];
  }
  const sorted = Array.from(offsets).sort((a, b) => a - b);
  const pieces: paper.Path[] = [];
  let head = path;
  let list = sorted;
  if (head.closed) {
    const first = list[0];
    const loc = head.getLocationAt(first);
    if (loc) {
      const tail = head.splitAt(loc) as paper.Path | null;
      // splitting a closed path opens it at the location (returns the same path)
      if (tail && tail !== head) {
        pieces.push(tail);
      }
      head.closed = false;
    }
    list = list.slice(1).map((o) => o - first);
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const loc = head.getLocationAt(list[i]);
    if (!loc) continue;
    const tail = head.splitAt(loc) as paper.Path | null;
    if (tail && tail !== head) pieces.unshift(tail);
  }
  pieces.unshift(head);
  const out = pieces.filter((p) => p.segments.length >= 2).map((p) => ({ ...paperPathToSubPath(p), closed: false }));
  for (const p of pieces) p.remove();
  void paper;
  return out.length ? out : [sp];
}
