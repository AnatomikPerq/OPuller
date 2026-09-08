/**
 * Variable-width strokes (Width tool). Given a path and a width profile,
 * produce a filled outline (list of closed subpaths).
 *
 * The default implementation samples the path, offsets sample points along the
 * normal by the interpolated half-width on each side and fits a smooth outline.
 */
import type { SubPath, WidthPoint, Vec } from '@/model/types';
import { subpathToCubics, locationAtOffset, subpathLength } from './path';
import { cubicPoint, cubicDerivative, cubicLength } from './bezier';
import { fitPoints } from './paperBridge';

export function widthAt(profile: WidthPoint[], t: number, baseWidth: number): { left: number; right: number } {
  if (!profile.length) return { left: baseWidth / 2, right: baseWidth / 2 };
  const sorted = [...profile].sort((a, b) => a.offset - b.offset);
  const w = (p: WidthPoint) => ({ left: (p.left ?? p.width / 2), right: (p.right ?? p.width / 2) });
  if (t <= sorted[0].offset) return w(sorted[0]);
  if (t >= sorted[sorted.length - 1].offset) return w(sorted[sorted.length - 1]);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a.offset && t <= b.offset) {
      const f = b.offset === a.offset ? 0 : (t - a.offset) / (b.offset - a.offset);
      // smoothstep for pleasant transitions
      const s = f * f * (3 - 2 * f);
      const wa = w(a);
      const wb = w(b);
      return { left: wa.left + (wb.left - wa.left) * s, right: wa.right + (wb.right - wa.right) * s };
    }
  }
  return w(sorted[0]);
}

/** Outline of a single subpath with a variable width profile. */
export function variableWidthOutline(sp: SubPath, profile: WidthPoint[], baseWidth: number, samplesPerSegment = 24): SubPath[] {
  const cubics = subpathToCubics(sp);
  if (!cubics.length) return [];
  const lengths = cubics.map((c) => cubicLength(c));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const left: Vec[] = [];
  const right: Vec[] = [];
  let acc = 0;
  cubics.forEach((c, i) => {
    const n = Math.max(4, Math.round(samplesPerSegment * (lengths[i] / total) * cubics.length));
    for (let k = 0; k <= n; k++) {
      if (i > 0 && k === 0) continue;
      const t = k / n;
      const p = cubicPoint(c, t);
      const d = cubicDerivative(c, t);
      const l = Math.hypot(d.x, d.y) || 1;
      const nx = -d.y / l;
      const ny = d.x / l;
      const off = (acc + lengths[i] * t) / total;
      const w = widthAt(profile, off, baseWidth);
      left.push({ x: p.x + nx * w.left, y: p.y + ny * w.left });
      right.push({ x: p.x - nx * w.right, y: p.y - ny * w.right });
    }
    acc += lengths[i];
  });
  const ring = left.concat(right.reverse());
  const fitted = fitPoints(ring, 0.5, true);
  return fitted ? [fitted] : [];
}

export function variableWidthOutlines(subpaths: SubPath[], profile: WidthPoint[], baseWidth: number): SubPath[] {
  const out: SubPath[] = [];
  for (const sp of subpaths) out.push(...variableWidthOutline(sp, profile, baseWidth));
  return out;
}

export { locationAtOffset, subpathLength };
