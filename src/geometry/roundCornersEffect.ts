/**
 * Effect > Stylize > Round Corners, as Illustrator does it (measured through
 * scripts/illustrator/effect-fixtures.mjs, fixtures in tests/fixtures/effects/roundCorners.json).
 *
 * Only bare corners — anchors without handles, not the ends of an open path — are rounded. The
 * corner is cut at `radius` along each of its two sides and the cuts are joined by a cubic whose
 * handles point at the old corner with 0.55 × the cut length: a right angle becomes (almost) a
 * quarter circle, an acute one a shallower curve than a true fillet. A side is the straight
 * segment, or, when the segment is curved, the leg from the corner to the curve's far control
 * point — the cut lands on that leg and the curve keeps its far handle. A cut cannot be longer
 * than its side: half of it when the other end of a straight segment is a bare corner or an
 * open end too (both cuts then meet and merge into one anchor carrying both handles, even
 * with the open end), the whole side otherwise.
 *
 * Live corners (the corner widget, `geometry/corners.ts`) are a different feature with true
 * circular arcs; this file is the effect only.
 */
import type { SubPath, Anchor, Vec } from '@/model/types';
import { anchor as makeAnchor } from './path';

const HANDLE = 0.55;

interface Cut {
  /** where the cut lands */
  point: Vec;
  /** handle towards the corner */
  handle: Vec;
  /** the cut was shortened to the room its side leaves */
  clamped: boolean;
}

export function roundCornersEffect(sp: SubPath, radius: number): SubPath {
  const n = sp.anchors.length;
  const segs = sp.closed ? n : n - 1;
  if (radius <= 0 || n < 2 || segs < 1) return sp;
  const bare = (i: number) => !sp.anchors[i].handleIn && !sp.anchors[i].handleOut && (sp.closed || (i > 0 && i < n - 1));
  const openEnd = (i: number) => !sp.closed && (i === 0 || i === n - 1);
  if (!sp.anchors.some((_, i) => bare(i))) return sp;
  const abs = (a: Anchor, h: Vec | null): Vec => (h ? { x: a.point.x + h.x, y: a.point.y + h.y } : a.point);

  /**
   * The side of anchor `i` that lies on segment `s` (towards anchor `j`): its length and unit
   * direction, and whether the room is shared with the far end (straight segments only).
   */
  const side = (i: number, j: number, out: boolean) => {
    const a = sp.anchors[i];
    const b = sp.anchors[j];
    const nearHandle = out ? a.handleOut : a.handleIn;
    const farHandle = out ? b.handleIn : b.handleOut;
    // straight segment (no handle at either end): the room may be shared with the far end;
    // curved segment with a bare end at `i`: the leg to the far control point, never shared
    const straight = !nearHandle && !farHandle;
    const far = straight ? b.point : abs(b, farHandle);
    const d = { x: far.x - a.point.x, y: far.y - a.point.y };
    const L = Math.hypot(d.x, d.y);
    return { L, dir: L > 0 ? { x: d.x / L, y: d.y / L } : { x: 0, y: 0 }, shared: straight && (bare(j) || openEnd(j)) };
  };
  const cutOn = (i: number, j: number, out: boolean): Cut => {
    const s = side(i, j, out);
    const max = s.shared ? s.L / 2 : s.L;
    const d = Math.min(radius, max);
    const p = sp.anchors[i].point;
    return { point: { x: p.x + s.dir.x * d, y: p.y + s.dir.y * d }, handle: { x: -s.dir.x * d * HANDLE, y: -s.dir.y * d * HANDLE }, clamped: radius > max };
  };

  // per anchor: the cut on its incoming side and on its outgoing side (open ends get virtual cuts
  // that only matter when they merge with the neighbouring corner's cut)
  const cuts: Array<{ in: Cut | null; out: Cut | null }> = sp.anchors.map((_, i) => {
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const hasIn = sp.closed || i > 0;
    const hasOut = sp.closed || i < n - 1;
    if (bare(i)) return { in: hasIn ? cutOn(i, prev, false) : null, out: hasOut ? cutOn(i, next, true) : null };
    if (openEnd(i)) {
      const straightIn = hasIn && !sp.anchors[i].handleIn && !sp.anchors[prev].handleOut && bare(prev);
      const straightOut = hasOut && !sp.anchors[i].handleOut && !sp.anchors[next].handleIn && bare(next);
      return { in: straightIn ? cutOn(i, prev, false) : null, out: straightOut ? cutOn(i, next, true) : null };
    }
    return { in: null, out: null };
  });

  // a straight segment whose two cuts are both clamped: they meet in the middle and merge
  const merged = (s: number): boolean => {
    const i = s;
    const j = (s + 1) % n;
    const a = cuts[i].out;
    const b = cuts[j].in;
    return !!a && !!b && a.clamped && b.clamped && !sp.anchors[i].handleOut && !sp.anchors[j].handleIn;
  };

  const out: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    const a = sp.anchors[i];
    const prevSeg = (i - 1 + n) % n;
    const mergedIn = (sp.closed || i > 0) && merged(prevSeg);
    const mergedOut = (sp.closed || i < n - 1) && merged(i);
    if (bare(i)) {
      const cin = cuts[i].in;
      const cout = cuts[i].out;
      if (cin) {
        // the cut on the incoming side: a merged one takes the other corner's handle as its in-handle
        const hin = mergedIn ? cuts[prevSeg].out!.handle : null;
        out.push(makeAnchor(cin.point, hin, cin.handle, 'corner'));
      }
      if (cout && !mergedOut) out.push(makeAnchor(cout.point, cout.handle, null, 'corner'));
    } else {
      // open ends and anchors with handles stay; a merged virtual cut of an open end becomes the
      // out-handle of the neighbouring corner's cut (handled above) or an anchor after this end
      if (openEnd(i) && i === 0 && mergedOut) {
        out.push(makeAnchor(a.point, null, null, a.kind));
      } else if (openEnd(i) && i === n - 1 && mergedIn) {
        const c = cuts[prevSeg].out!;
        out.push(makeAnchor(c.point, c.handle, cuts[i].in!.handle, 'corner'));
        out.push(makeAnchor(a.point, null, null, a.kind));
      } else {
        out.push(a);
      }
    }
  }
  return { anchors: out, closed: sp.closed };
}
