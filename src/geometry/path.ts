import type { Anchor, SubPath, Vec, Rect, Matrix, FillRule } from '@/model/types';
import {
  type Cubic,
  cubicBounds,
  cubicSplit,
  cubicNearest,
  cubicFlatten,
  cubicLength,
  cubicPoint,
  cubicDerivative,
  quadToCubic,
  arcToCubics,
  isLine,
} from './bezier';
import { applyToPoint, applyToVector } from './matrix';
import { add, sub, rectUnion, rectFromPointList, dist, len, normalize, mul } from './vec';

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

export function anchor(point: Vec, handleIn: Vec | null = null, handleOut: Vec | null = null, kind?: 'corner' | 'smooth'): Anchor {
  return {
    point: { x: point.x, y: point.y },
    handleIn: handleIn ? { x: handleIn.x, y: handleIn.y } : null,
    handleOut: handleOut ? { x: handleOut.x, y: handleOut.y } : null,
    kind: kind ?? (handleIn && handleOut ? 'smooth' : 'corner'),
  };
}

export function cloneAnchor(a: Anchor): Anchor {
  return anchor(a.point, a.handleIn, a.handleOut, a.kind);
}

export function cloneSubPath(sp: SubPath): SubPath {
  return { anchors: sp.anchors.map(cloneAnchor), closed: sp.closed };
}

export function cloneSubPaths(sps: SubPath[]): SubPath[] {
  return sps.map(cloneSubPath);
}

export function absHandleIn(a: Anchor): Vec {
  return a.handleIn ? add(a.point, a.handleIn) : a.point;
}

export function absHandleOut(a: Anchor): Vec {
  return a.handleOut ? add(a.point, a.handleOut) : a.point;
}

export function hasHandle(h: Vec | null | undefined): h is Vec {
  return !!h && (Math.abs(h.x) > 1e-9 || Math.abs(h.y) > 1e-9);
}

// ---------------------------------------------------------------------------
// Segments / cubics
// ---------------------------------------------------------------------------

/** Number of segments (curves) in a subpath. */
export function segmentCount(sp: SubPath): number {
  const n = sp.anchors.length;
  if (n < 2) return 0;
  return sp.closed ? n : n - 1;
}

/** The cubic for segment i (from anchor i to anchor i+1, wrapping for closed). */
export function segmentCubic(sp: SubPath, i: number): Cubic {
  const a = sp.anchors[i];
  const b = sp.anchors[(i + 1) % sp.anchors.length];
  return { p0: a.point, p1: absHandleOut(a), p2: absHandleIn(b), p3: b.point };
}

export function subpathToCubics(sp: SubPath): Cubic[] {
  const out: Cubic[] = [];
  const n = segmentCount(sp);
  for (let i = 0; i < n; i++) out.push(segmentCubic(sp, i));
  return out;
}

// ---------------------------------------------------------------------------
// SVG path data
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

export function subpathToSvgD(sp: SubPath): string {
  const n = sp.anchors.length;
  if (n === 0) return '';
  const parts: string[] = [];
  const first = sp.anchors[0];
  parts.push(`M${fmt(first.point.x)} ${fmt(first.point.y)}`);
  const segs = segmentCount(sp);
  for (let i = 0; i < segs; i++) {
    const a = sp.anchors[i];
    const b = sp.anchors[(i + 1) % n];
    if (!hasHandle(a.handleOut) && !hasHandle(b.handleIn)) {
      parts.push(`L${fmt(b.point.x)} ${fmt(b.point.y)}`);
    } else {
      const h1 = absHandleOut(a);
      const h2 = absHandleIn(b);
      parts.push(
        `C${fmt(h1.x)} ${fmt(h1.y)} ${fmt(h2.x)} ${fmt(h2.y)} ${fmt(b.point.x)} ${fmt(b.point.y)}`,
      );
    }
  }
  if (sp.closed) parts.push('Z');
  return parts.join('');
}

export function pathToSvgD(subpaths: SubPath[]): string {
  return subpaths.map(subpathToSvgD).join('');
}

/**
 * Parse SVG path data into subpaths. Supports all commands (M L H V C S Q T A Z,
 * absolute & relative); arcs and quadratics are converted to cubics.
 */
export function parseSvgPathData(d: string): SubPath[] {
  const tokens = tokenize(d);
  const subpaths: SubPath[] = [];
  let current: SubPath | null = null;
  let cx = 0,
    cy = 0; // current point
  let sx = 0,
    sy = 0; // subpath start
  let lastCtrl: Vec | null = null; // last control point for S/T
  let lastCmd = '';
  let i = 0;

  const startSub = (x: number, y: number) => {
    current = { anchors: [anchor({ x, y })], closed: false };
    subpaths.push(current);
    sx = x;
    sy = y;
    cx = x;
    cy = y;
  };
  const ensureSub = () => {
    if (!current) startSub(cx, cy);
    return current!;
  };
  const addCubic = (c1: Vec, c2: Vec, p: Vec) => {
    const sp = ensureSub();
    const last = sp.anchors[sp.anchors.length - 1];
    last.handleOut = sub(c1, last.point);
    sp.anchors.push(anchor(p, sub(c2, p), null, 'corner'));
    fixKind(last);
    cx = p.x;
    cy = p.y;
  };
  const addLine = (p: Vec) => {
    const sp = ensureSub();
    sp.anchors.push(anchor(p));
    cx = p.x;
    cy = p.y;
  };
  const closeSub = () => {
    if (current) {
      const sp: SubPath = current;
      // if the last anchor coincides with the first, merge them
      if (sp.anchors.length > 1) {
        const first = sp.anchors[0];
        const last = sp.anchors[sp.anchors.length - 1];
        if (dist(first.point, last.point) < 1e-6) {
          first.handleIn = last.handleIn;
          sp.anchors.pop();
          fixKind(first);
        }
      }
      sp.closed = true;
    }
    cx = sx;
    cy = sy;
    current = null;
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    let cmd: string;
    if (typeof tok === 'string') {
      cmd = tok;
      i++;
    } else {
      // implicit repeat of the previous command (M becomes L)
      cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
      if (!cmd) break;
    }
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z' && cmd !== 'Z';
    const num = () => {
      const t = tokens[i++];
      return typeof t === 'number' ? t : 0;
    };
    const has = (n: number) => {
      for (let k = 0; k < n; k++) if (typeof tokens[i + k] !== 'number') return false;
      return true;
    };
    switch (cmd.toUpperCase()) {
      case 'M': {
        if (!has(2)) { i = tokens.length; break; }
        let x = num(),
          y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        current = null;
        startSub(x, y);
        lastCtrl = null;
        break;
      }
      case 'L': {
        if (!has(2)) { i = tokens.length; break; }
        let x = num(),
          y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        addLine({ x, y });
        lastCtrl = null;
        break;
      }
      case 'H': {
        if (!has(1)) { i = tokens.length; break; }
        let x = num();
        if (rel) x += cx;
        addLine({ x, y: cy });
        lastCtrl = null;
        break;
      }
      case 'V': {
        if (!has(1)) { i = tokens.length; break; }
        let y = num();
        if (rel) y += cy;
        addLine({ x: cx, y });
        lastCtrl = null;
        break;
      }
      case 'C': {
        if (!has(6)) { i = tokens.length; break; }
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) {
          x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy;
        }
        addCubic({ x: x1, y: y1 }, { x: x2, y: y2 }, { x, y });
        lastCtrl = { x: x2, y: y2 };
        break;
      }
      case 'S': {
        if (!has(4)) { i = tokens.length; break; }
        let x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) {
          x2 += cx; y2 += cy; x += cx; y += cy;
        }
        const c1 = lastCtrl && /[CScs]/.test(lastCmd) ? { x: 2 * cx - lastCtrl.x, y: 2 * cy - lastCtrl.y } : { x: cx, y: cy };
        addCubic(c1, { x: x2, y: y2 }, { x, y });
        lastCtrl = { x: x2, y: y2 };
        break;
      }
      case 'Q': {
        if (!has(4)) { i = tokens.length; break; }
        let x1 = num(), y1 = num(), x = num(), y = num();
        if (rel) {
          x1 += cx; y1 += cy; x += cx; y += cy;
        }
        const c = quadToCubic({ x: cx, y: cy }, { x: x1, y: y1 }, { x, y });
        addCubic(c.p1, c.p2, c.p3);
        lastCtrl = { x: x1, y: y1 };
        break;
      }
      case 'T': {
        if (!has(2)) { i = tokens.length; break; }
        let x = num(), y = num();
        if (rel) {
          x += cx; y += cy;
        }
        const ctrl: Vec = lastCtrl && /[QTqt]/.test(lastCmd) ? { x: 2 * cx - lastCtrl.x, y: 2 * cy - lastCtrl.y } : { x: cx, y: cy };
        const c = quadToCubic({ x: cx, y: cy }, ctrl, { x, y });
        addCubic(c.p1, c.p2, c.p3);
        lastCtrl = ctrl;
        break;
      }
      case 'A': {
        if (!has(7)) { i = tokens.length; break; }
        const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0;
        let x = num(), y = num();
        if (rel) {
          x += cx; y += cy;
        }
        const cubics = arcToCubics({ x: cx, y: cy }, rx, ry, rot, large, sweep, { x, y });
        if (cubics.length === 0) addLine({ x, y });
        for (const c of cubics) addCubic(c.p1, c.p2, c.p3);
        lastCtrl = null;
        break;
      }
      case 'Z': {
        closeSub();
        lastCtrl = null;
        break;
      }
      default:
        i = tokens.length;
    }
    lastCmd = cmd;
  }
  return subpaths.filter((sp) => sp.anchors.length > 0);
}

function tokenize(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]));
  }
  // Arc flags may be written without separators ("a1 1 0 00 5 5"): the regex above
  // handles that because "00" tokenizes as a single number 0 followed by... not quite.
  // We post-process arc commands to split glued flags.
  return splitArcFlags(out);
}

function splitArcFlags(tokens: Array<string | number>): Array<string | number> {
  const out: Array<string | number> = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'A' || t === 'a') {
      out.push(t);
      i++;
      // read groups of 7 params; flags may be glued
      while (i < tokens.length && typeof tokens[i] === 'number') {
        const rx = tokens[i++] as number;
        const ry = tokens[i++] as number;
        const rot = tokens[i++] as number;
        const rest: number[] = [];
        // flags
        while (rest.length < 2 && i < tokens.length && typeof tokens[i] === 'number') {
          const s = String(tokens[i]);
          if (s.length > 1 && /^[01]+$/.test(s)) {
            // glued flags like "01" or "00" or "10"
            for (const ch of s) if (rest.length < 2) rest.push(Number(ch));
            i++;
          } else if (s.length > 1 && /^[01][01]\d/.test(s)) {
            rest.push(Number(s[0]), Number(s[1]));
            tokens[i] = Number(s.slice(2));
          } else if (/^[01]$/.test(s)) {
            rest.push(Number(s));
            i++;
          } else if (rest.length === 1 && s.startsWith('0') === false && /^[01]/.test(s)) {
            // "1" followed by digits like "15" -> flag 1 and number 5 — ambiguous; treat as-is
            rest.push(Number(s[0]));
            tokens[i] = Number(s.slice(1));
          } else break;
        }
        while (rest.length < 2) rest.push(0);
        const x = i < tokens.length && typeof tokens[i] === 'number' ? (tokens[i++] as number) : 0;
        const y = i < tokens.length && typeof tokens[i] === 'number' ? (tokens[i++] as number) : 0;
        out.push(rx, ry, rot, rest[0], rest[1], x, y);
      }
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

function fixKind(a: Anchor) {
  if (hasHandle(a.handleIn) && hasHandle(a.handleOut)) {
    const hi = normalize(a.handleIn!);
    const ho = normalize(a.handleOut!);
    const cross = hi.x * ho.y - hi.y * ho.x;
    const dotv = hi.x * ho.x + hi.y * ho.y;
    a.kind = Math.abs(cross) < 1e-3 && dotv < 0 ? 'smooth' : 'corner';
  } else {
    a.kind = 'corner';
  }
}

export { fixKind as inferAnchorKind };

// ---------------------------------------------------------------------------
// Bounds / transforms
// ---------------------------------------------------------------------------

export function subpathBounds(sp: SubPath): Rect | null {
  if (sp.anchors.length === 0) return null;
  if (sp.anchors.length === 1) return { x: sp.anchors[0].point.x, y: sp.anchors[0].point.y, width: 0, height: 0 };
  let r: Rect | null = null;
  for (const c of subpathToCubics(sp)) r = rectUnion(r, cubicBounds(c));
  if (!r) return rectFromPointList(sp.anchors.map((a) => a.point));
  return r;
}

export function pathBounds(subpaths: SubPath[]): Rect | null {
  let r: Rect | null = null;
  for (const sp of subpaths) r = rectUnion(r, subpathBounds(sp));
  return r;
}

/** Bounds including all handles (useful for marquee/overlay). */
export function pathControlBounds(subpaths: SubPath[]): Rect | null {
  const pts: Vec[] = [];
  for (const sp of subpaths)
    for (const a of sp.anchors) {
      pts.push(a.point);
      if (a.handleIn) pts.push(absHandleIn(a));
      if (a.handleOut) pts.push(absHandleOut(a));
    }
  return rectFromPointList(pts);
}

export function transformAnchor(a: Anchor, m: Matrix): Anchor {
  return {
    point: applyToPoint(m, a.point),
    handleIn: a.handleIn ? applyToVector(m, a.handleIn) : null,
    handleOut: a.handleOut ? applyToVector(m, a.handleOut) : null,
    kind: a.kind,
  };
}

export function transformSubPath(sp: SubPath, m: Matrix): SubPath {
  return { anchors: sp.anchors.map((a) => transformAnchor(a, m)), closed: sp.closed };
}

export function transformSubPaths(sps: SubPath[], m: Matrix): SubPath[] {
  return sps.map((sp) => transformSubPath(sp, m));
}

export function reverseSubPath(sp: SubPath): SubPath {
  return {
    closed: sp.closed,
    anchors: sp.anchors
      .slice()
      .reverse()
      .map((a) => anchor(a.point, a.handleOut, a.handleIn, a.kind)),
  };
}

export function pathLength(subpaths: SubPath[]): number {
  let l = 0;
  for (const sp of subpaths) for (const c of subpathToCubics(sp)) l += cubicLength(c);
  return l;
}

export function subpathLength(sp: SubPath): number {
  let l = 0;
  for (const c of subpathToCubics(sp)) l += cubicLength(c);
  return l;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface PathLocation {
  subpath: number;
  /** segment index (from anchor `segment` to `segment+1`) */
  segment: number;
  t: number;
  point: Vec;
  distance: number;
}

export function nearestPointOnPath(subpaths: SubPath[], p: Vec): PathLocation | null {
  let best: PathLocation | null = null;
  subpaths.forEach((sp, si) => {
    const n = segmentCount(sp);
    for (let i = 0; i < n; i++) {
      const r = cubicNearest(segmentCubic(sp, i), p);
      if (!best || r.distance < best.distance) best = { subpath: si, segment: i, t: r.t, point: r.point, distance: r.distance };
    }
    if (n === 0 && sp.anchors.length === 1) {
      const d = dist(sp.anchors[0].point, p);
      if (!best || d < best.distance) best = { subpath: si, segment: 0, t: 0, point: sp.anchors[0].point, distance: d };
    }
  });
  return best;
}

export function pointAt(sp: SubPath, segment: number, t: number): Vec {
  return cubicPoint(segmentCubic(sp, segment), t);
}

export function tangentAt(sp: SubPath, segment: number, t: number): Vec {
  return normalize(cubicDerivative(segmentCubic(sp, segment), t));
}

/** Location along a subpath by normalized offset (0..1 of total length). */
export function locationAtOffset(sp: SubPath, offset: number): { segment: number; t: number; point: Vec; tangent: Vec } {
  const cubics = subpathToCubics(sp);
  if (!cubics.length) {
    const p = sp.anchors[0]?.point ?? { x: 0, y: 0 };
    return { segment: 0, t: 0, point: p, tangent: { x: 1, y: 0 } };
  }
  const lengths = cubics.map((c) => cubicLength(c));
  const total = lengths.reduce((a, b) => a + b, 0);
  let target = Math.max(0, Math.min(1, offset)) * total;
  for (let i = 0; i < cubics.length; i++) {
    if (target <= lengths[i] || i === cubics.length - 1) {
      // find t by bisection on length
      const c = cubics[i];
      let lo = 0,
        hi = 1;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        const [left] = cubicSplit(c, mid);
        if (cubicLength(left) < target) lo = mid;
        else hi = mid;
      }
      const t = (lo + hi) / 2;
      return { segment: i, t, point: cubicPoint(c, t), tangent: normalize(cubicDerivative(c, t)) };
    }
    target -= lengths[i];
  }
  const last = cubics[cubics.length - 1];
  return { segment: cubics.length - 1, t: 1, point: last.p3, tangent: normalize(cubicDerivative(last, 1)) };
}

/** Flatten a subpath into a polyline (closed subpaths do not repeat the first point). */
export function flattenSubPath(sp: SubPath, tolerance = 0.25): Vec[] {
  if (sp.anchors.length === 0) return [];
  const out: Vec[] = [sp.anchors[0].point];
  const n = segmentCount(sp);
  for (let i = 0; i < n; i++) {
    const c = segmentCubic(sp, i);
    if (isLine(c)) out.push(c.p3);
    else cubicFlatten(c, tolerance, out);
  }
  if (sp.closed && out.length > 1) out.pop();
  return out;
}

/** Point-in-fill test using flattened polygons and the given fill rule. */
export function pointInPath(subpaths: SubPath[], p: Vec, fillRule: FillRule = 'nonzero'): boolean {
  let winding = 0;
  let crossings = 0;
  for (const sp of subpaths) {
    if (sp.anchors.length < 3 && !(sp.anchors.length === 2 && sp.closed)) {
      // open paths are treated as closed for hit-testing purposes if they have >= 3 points
      if (sp.anchors.length < 3) continue;
    }
    const poly = flattenSubPath({ ...sp, closed: true });
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      if (a.y <= p.y) {
        if (b.y > p.y && isLeft(a, b, p) > 0) {
          winding++;
          crossings++;
        }
      } else if (b.y <= p.y && isLeft(a, b, p) < 0) {
        winding--;
        crossings++;
      }
    }
  }
  return fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
}

function isLeft(a: Vec, b: Vec, p: Vec): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

/** Minimum distance from p to the path outline (stroke hit testing). */
export function distanceToPath(subpaths: SubPath[], p: Vec): number {
  const loc = nearestPointOnPath(subpaths, p);
  return loc ? loc.distance : Infinity;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Insert an anchor on segment `segment` at parameter t. Returns index of the new anchor. */
export function insertAnchorAt(sp: SubPath, segment: number, t: number): number {
  const n = sp.anchors.length;
  const a = sp.anchors[segment];
  const bIndex = (segment + 1) % n;
  const b = sp.anchors[bIndex];
  const c = segmentCubic(sp, segment);
  const [l, r] = cubicSplit(c, t);
  const straight = isLine(c);
  const mid = l.p3;
  const na: Anchor = straight
    ? anchor(mid)
    : anchor(mid, sub(l.p2, mid), sub(r.p1, mid), 'smooth');
  if (!straight) {
    a.handleOut = sub(l.p1, a.point);
    b.handleIn = sub(r.p2, b.point);
  }
  sp.anchors.splice(segment + 1, 0, na);
  return segment + 1;
}

/** Remove an anchor, attempting to keep the shape by adjusting neighbouring handles. */
export function removeAnchor(sp: SubPath, index: number): void {
  if (sp.anchors.length <= 1) {
    sp.anchors.splice(index, 1);
    return;
  }
  const n = sp.anchors.length;
  const prev = sp.anchors[(index - 1 + n) % n];
  const next = sp.anchors[(index + 1) % n];
  const cur = sp.anchors[index];
  const isEdge = !sp.closed && (index === 0 || index === n - 1);
  if (!isEdge && (hasHandle(cur.handleIn) || hasHandle(cur.handleOut) || hasHandle(prev.handleOut) || hasHandle(next.handleIn))) {
    // approximate merged curve: scale neighbour handles
    const c1 = { p0: prev.point, p1: absHandleOut(prev), p2: absHandleIn(cur), p3: cur.point };
    const c2 = { p0: cur.point, p1: absHandleOut(cur), p2: absHandleIn(next), p3: next.point };
    const l1 = cubicLength(c1);
    const l2 = cubicLength(c2);
    const total = l1 + l2 || 1;
    const ho = sub(c1.p1, prev.point);
    const hi = sub(c2.p2, next.point);
    const k = total / Math.max(l1, 1e-6);
    const k2 = total / Math.max(l2, 1e-6);
    prev.handleOut = hasHandle(ho) ? mul(ho, Math.min(k, 3)) : mul(sub(cur.point, prev.point), 0.33);
    next.handleIn = hasHandle(hi) ? mul(hi, Math.min(k2, 3)) : mul(sub(cur.point, next.point), 0.33);
  }
  sp.anchors.splice(index, 1);
}

/** Split an open/closed subpath at an anchor index into (possibly) two subpaths. */
export function splitAtAnchor(sp: SubPath, index: number): SubPath[] {
  const n = sp.anchors.length;
  if (n < 2) return [cloneSubPath(sp)];
  if (sp.closed) {
    // open at anchor: rotate so that anchor `index` is first and duplicate it at the end
    const anchors: Anchor[] = [];
    for (let k = 0; k < n; k++) anchors.push(cloneAnchor(sp.anchors[(index + k) % n]));
    const first = anchors[0];
    const last = cloneAnchor(first);
    last.handleOut = null;
    first.handleIn = null;
    anchors.push(last);
    return [{ anchors, closed: false }];
  }
  if (index <= 0 || index >= n - 1) return [cloneSubPath(sp)];
  const a = sp.anchors.slice(0, index + 1).map(cloneAnchor);
  const b = sp.anchors.slice(index).map(cloneAnchor);
  a[a.length - 1].handleOut = null;
  b[0].handleIn = null;
  return [
    { anchors: a, closed: false },
    { anchors: b, closed: false },
  ];
}

/** Split a subpath at a location on a segment (inserting an anchor first). */
export function splitAtLocation(sp: SubPath, segment: number, t: number): SubPath[] {
  const copy = cloneSubPath(sp);
  if (t < 1e-4) return splitAtAnchor(copy, segment);
  if (t > 1 - 1e-4) return splitAtAnchor(copy, (segment + 1) % copy.anchors.length);
  const idx = insertAnchorAt(copy, segment, t);
  return splitAtAnchor(copy, idx);
}

/** Join two open subpaths end-to-start (b appended to a). */
export function joinSubPaths(a: SubPath, b: SubPath): SubPath {
  const anchors = a.anchors.map(cloneAnchor);
  const bAnchors = b.anchors.map(cloneAnchor);
  if (anchors.length && bAnchors.length && dist(anchors[anchors.length - 1].point, bAnchors[0].point) < 1e-6) {
    const last = anchors[anchors.length - 1];
    last.handleOut = bAnchors[0].handleOut;
    bAnchors.shift();
  }
  return { anchors: anchors.concat(bAnchors), closed: false };
}

/** Convert an anchor to a smooth anchor with symmetric handles tangent to the curve. */
export function makeSmooth(sp: SubPath, index: number, length?: number): void {
  const n = sp.anchors.length;
  const a = sp.anchors[index];
  const prev = sp.anchors[(index - 1 + n) % n];
  const next = sp.anchors[(index + 1) % n];
  const hasPrev = sp.closed || index > 0;
  const hasNext = sp.closed || index < n - 1;
  let dir: Vec;
  if (hasPrev && hasNext) dir = normalize(sub(next.point, prev.point));
  else if (hasNext) dir = normalize(sub(next.point, a.point));
  else if (hasPrev) dir = normalize(sub(a.point, prev.point));
  else dir = { x: 1, y: 0 };
  const l = length ?? Math.max(1, (hasPrev ? dist(a.point, prev.point) : 0) + (hasNext ? dist(a.point, next.point) : 0)) / 6;
  a.handleIn = mul(dir, -l);
  a.handleOut = mul(dir, l);
  a.kind = 'smooth';
}

export function makeCorner(sp: SubPath, index: number): void {
  const a = sp.anchors[index];
  a.handleIn = null;
  a.handleOut = null;
  a.kind = 'corner';
}

/** Total anchor count. */
export function anchorCount(subpaths: SubPath[]): number {
  return subpaths.reduce((n, sp) => n + sp.anchors.length, 0);
}

export function isDegenerate(subpaths: SubPath[]): boolean {
  return anchorCount(subpaths) < 2;
}

/** Smooth every anchor (Catmull-Rom-like tangents). */
export function smoothSubPath(sp: SubPath, factor = 1 / 3): SubPath {
  const out = cloneSubPath(sp);
  const n = out.anchors.length;
  for (let i = 0; i < n; i++) {
    const a = out.anchors[i];
    const hasPrev = out.closed || i > 0;
    const hasNext = out.closed || i < n - 1;
    if (!hasPrev || !hasNext) continue;
    const prev = out.anchors[(i - 1 + n) % n];
    const next = out.anchors[(i + 1) % n];
    const dir = normalize(sub(next.point, prev.point));
    a.handleIn = mul(dir, -dist(a.point, prev.point) * factor);
    a.handleOut = mul(dir, dist(a.point, next.point) * factor);
    a.kind = 'smooth';
  }
  return out;
}

/** Straight-line polyline path from points. */
export function polylineSubPath(points: Vec[], closed = false): SubPath {
  return { anchors: points.map((p) => anchor(p)), closed };
}

export function subpathCentroid(sp: SubPath): Vec {
  const pts = flattenSubPath(sp);
  if (!pts.length) return { x: 0, y: 0 };
  let sx = 0,
    sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

/** Signed area of a subpath (positive = clockwise in screen coordinates). */
export function subpathArea(sp: SubPath): number {
  const pts = flattenSubPath(sp);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function handleLength(h: Vec | null): number {
  return h ? len(h) : 0;
}
