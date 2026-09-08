/**
 * Pointer sampling shared by the freehand tools (pencil, brush, blob brush,
 * smooth, path eraser, eraser).
 *
 * A `StrokeSampler` collects world-space samples with pressure, drops samples
 * that are too close to the previous one and supports "straight segment" mode
 * (Alt in the pencil, Shift in the eraser): while active, the pending end point
 * follows the pointer and is committed as a single sample when the mode ends.
 *
 * Everything in this file is pure (no paper.js) so it can be unit tested.
 */
import type { Vec } from '@/model/types';

export interface Sample {
  x: number;
  y: number;
  /** 0..1 (mouse: 1) */
  pressure: number;
}

/** A run of samples: freehand (fitted to a curve) or straight (a single line). */
export interface StrokeRun {
  points: Sample[];
  straight: boolean;
}

export class StrokeSampler {
  /** committed samples */
  readonly samples: Sample[] = [];
  /** indices into `samples` where straight segments start/end (consecutive pairs) */
  readonly straightPairs: Array<[number, number]> = [];
  private pending: Sample | null = null;
  private straightFrom = -1;

  constructor(
    /** minimum distance between samples (world units) */
    public minDist: number,
  ) {}

  get length(): number {
    return this.samples.length;
  }

  get inStraight(): boolean {
    return this.straightFrom >= 0;
  }

  /** Anchor sample of the current straight segment (null when not in straight mode). */
  straightStart(): Sample | null {
    return this.straightFrom >= 0 ? this.samples[this.straightFrom] : null;
  }

  first(): Sample | null {
    return this.samples[0] ?? null;
  }

  last(): Sample | null {
    return this.pending ?? this.samples[this.samples.length - 1] ?? null;
  }

  /** Add a freehand sample. Returns true when it was accepted. */
  add(p: Vec, pressure = 1): boolean {
    if (this.straightFrom >= 0) {
      this.pending = { x: p.x, y: p.y, pressure };
      return true;
    }
    const last = this.samples[this.samples.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < this.minDist) {
      // keep the most recent pressure for the last sample
      last.pressure = pressure;
      return false;
    }
    this.samples.push({ x: p.x, y: p.y, pressure });
    return true;
  }

  /** Begin a straight segment from the last committed sample. */
  beginStraight(p: Vec, pressure = 1): void {
    if (this.straightFrom >= 0) return;
    if (!this.samples.length) this.samples.push({ x: p.x, y: p.y, pressure });
    this.straightFrom = this.samples.length - 1;
    this.pending = { x: p.x, y: p.y, pressure };
  }

  /** End the straight segment, committing the pending end point. */
  endStraight(): void {
    if (this.straightFrom < 0) return;
    const from = this.straightFrom;
    this.straightFrom = -1;
    const pend = this.pending;
    this.pending = null;
    if (!pend) return;
    const last = this.samples[this.samples.length - 1];
    if (Math.hypot(last.x - pend.x, last.y - pend.y) < this.minDist * 0.5) return;
    this.samples.push(pend);
    this.straightPairs.push([from, this.samples.length - 1]);
  }

  /** Committed samples plus the pending straight end point (for previews). */
  points(): Sample[] {
    return this.pending ? this.samples.concat([this.pending]) : this.samples;
  }

  /** Split the samples into freehand / straight runs sharing their end points. */
  runs(): StrokeRun[] {
    const pts = this.points();
    const pairs = this.straightPairs.slice();
    if (this.pending && this.straightFrom >= 0) pairs.push([this.straightFrom, pts.length - 1]);
    if (!pairs.length) return pts.length ? [{ points: pts, straight: false }] : [];
    const out: StrokeRun[] = [];
    let cursor = 0;
    for (const [a, b] of pairs) {
      if (a > cursor) out.push({ points: pts.slice(cursor, a + 1), straight: false });
      out.push({ points: [pts[a], pts[b]], straight: true });
      cursor = b;
    }
    if (cursor < pts.length - 1) out.push({ points: pts.slice(cursor), straight: false });
    return out;
  }
}

export function polylineLength(pts: Vec[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

/** Resample a polyline at (roughly) even spacing, interpolating pressure. */
export function resampleByDistance(samples: Sample[], spacing: number): Sample[] {
  if (samples.length < 2 || spacing <= 0) return samples.slice();
  const out: Sample[] = [{ ...samples[0] }];
  let carry = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    let d = spacing - carry;
    while (d <= segLen) {
      const t = d / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t });
      d += spacing;
    }
    carry = segLen - (d - spacing);
  }
  const last = samples[samples.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(tail.x - last.x, tail.y - last.y) > spacing * 0.25) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

/** Moving-average smoothing (end points stay fixed). */
export function smoothSamples(samples: Sample[], passes: number): Sample[] {
  let cur = samples.map((s) => ({ ...s }));
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) break;
    const next = cur.map((s) => ({ ...s }));
    for (let i = 1; i < cur.length - 1; i++) {
      next[i].x = (cur[i - 1].x + 2 * cur[i].x + cur[i + 1].x) / 4;
      next[i].y = (cur[i - 1].y + 2 * cur[i].y + cur[i + 1].y) / 4;
    }
    cur = next;
  }
  return cur;
}

/** Whether the stroke ends near its start (closing gesture). */
export function endsNearStart(samples: Vec[], distance: number, minLength = distance * 2): boolean {
  if (samples.length < 3) return false;
  const a = samples[0];
  const b = samples[samples.length - 1];
  if (Math.hypot(a.x - b.x, a.y - b.y) > distance) return false;
  return polylineLength(samples) > minLength;
}

/** SVG path data for a polyline. */
export function polylineSvg(points: Vec[], closed = false): string {
  if (!points.length) return '';
  let d = `M${r(points[0].x)} ${r(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `L${r(points[i].x)} ${r(points[i].y)}`;
  if (closed) d += 'Z';
  return d;
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Constrain a segment end to 45° increments around `from`. */
export function constrainTo45(from: Vec, to: Vec): Vec {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return { ...to };
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(a) * l, y: from.y + Math.sin(a) * l };
}

/**
 * Width along a stroke for the paintbrush: base width scaled by pressure (when
 * enabled) and tapered at both ends. `t` is 0..1 along the stroke.
 */
export function brushWidthAt(
  t: number,
  pressure: number,
  opts: { width: number; usePressure: boolean; taperStart: number; taperEnd: number; minWidth?: number },
): number {
  let w = opts.width;
  if (opts.usePressure) {
    const p = Math.max(0, Math.min(1, pressure));
    // ease pressure so light touches still leave a visible mark
    w *= 0.15 + 0.85 * p;
  }
  const ts = Math.max(0, Math.min(1, opts.taperStart / 100));
  const te = Math.max(0, Math.min(1, opts.taperEnd / 100));
  let taper = 1;
  if (ts > 0 && t < ts) taper = Math.min(taper, ease(t / ts));
  if (te > 0 && t > 1 - te) taper = Math.min(taper, ease((1 - t) / te));
  return Math.max(opts.minWidth ?? 0, w * taper);
}

function ease(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** Pressure along a sample polyline by normalised arc length (0..1). */
export function pressureLookup(samples: Sample[]): (t01: number) => number {
  if (samples.length < 2) return () => samples[0]?.pressure ?? 1;
  const cum: number[] = [0];
  for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  const total = cum[cum.length - 1] || 1;
  return (t01: number) => {
    const target = Math.max(0, Math.min(1, t01)) * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const f = span > 0 ? (target - cum[lo]) / span : 0;
    return samples[lo].pressure + (samples[hi].pressure - samples[lo].pressure) * f;
  };
}

/**
 * Closed outline polygon around a polyline with per-point half widths and
 * round caps. Pure: used for previews (screen space) and final outlines.
 */
export function outlineRing(pts: Vec[], halfWidths: number[], capSteps = 10): Vec[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) {
    const r = halfWidths[0] ?? 0;
    const out: Vec[] = [];
    for (let i = 0; i < 24; i++) out.push({ x: pts[0].x + Math.cos((i / 24) * Math.PI * 2) * r, y: pts[0].y + Math.sin((i / 24) * Math.PI * 2) * r });
    return out;
  }
  const left: Vec[] = [];
  const right: Vec[] = [];
  const tangents: Vec[] = [];
  let prevT: Vec = { x: 1, y: 0 };
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const l = Math.hypot(tx, ty);
    if (l < 1e-9) {
      tx = prevT.x;
      ty = prevT.y;
    } else {
      tx /= l;
      ty /= l;
    }
    prevT = { x: tx, y: ty };
    tangents.push(prevT);
    const w = halfWidths[i] ?? halfWidths[halfWidths.length - 1] ?? 0;
    left.push({ x: pts[i].x - ty * w, y: pts[i].y + tx * w });
    right.push({ x: pts[i].x + ty * w, y: pts[i].y - tx * w });
  }
  const ring: Vec[] = [];
  const r0 = halfWidths[0] ?? 0;
  const t0 = Math.atan2(tangents[0].y, tangents[0].x);
  ring.push(right[0]);
  if (r0 > 0.05) {
    for (let s = 1; s < capSteps; s++) {
      const a = t0 - Math.PI / 2 - (s * Math.PI) / capSteps;
      ring.push({ x: pts[0].x + Math.cos(a) * r0, y: pts[0].y + Math.sin(a) * r0 });
    }
  }
  for (let i = 0; i < n; i++) ring.push(left[i]);
  const rn = halfWidths[n - 1] ?? halfWidths[halfWidths.length - 1] ?? 0;
  const tn = Math.atan2(tangents[n - 1].y, tangents[n - 1].x);
  if (rn > 0.05) {
    for (let s = 1; s < capSteps; s++) {
      const a = tn + Math.PI / 2 - (s * Math.PI) / capSteps;
      ring.push({ x: pts[n - 1].x + Math.cos(a) * rn, y: pts[n - 1].y + Math.sin(a) * rn });
    }
  }
  for (let i = n - 1; i >= 1; i--) ring.push(right[i]);
  return ring;
}
