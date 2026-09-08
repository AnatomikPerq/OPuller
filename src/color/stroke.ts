/**
 * Stroke panel logic: weight presets, dash pairs, width profile presets and a
 * per-property summary of the selection (with mixed detection).
 */
import type { StrokeStyle, WidthPoint, Arrowhead, LineCap, LineJoin, StrokeAlign, Node } from '@/model/types';
import type { EditorState } from '@/store/store';
import { appearanceTargets } from '@/commands/appearance';

export const WEIGHT_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 40];

export const MIXED = Symbol('mixed');
export type Mixed<T> = T | typeof MIXED;

export interface StrokeSummary {
  hasTargets: boolean;
  width: Mixed<number>;
  cap: Mixed<LineCap>;
  join: Mixed<LineJoin>;
  miterLimit: Mixed<number>;
  align: Mixed<StrokeAlign>;
  dash: Mixed<number[]>;
  dashOffset: Mixed<number>;
  markerStart: Mixed<Arrowhead>;
  markerEnd: Mixed<Arrowhead>;
  markerScale: Mixed<number>;
  widthProfile: Mixed<WidthPoint[] | undefined>;
  paintType: Mixed<string>;
}

function same<T>(values: T[], key: (v: T) => string = (v) => JSON.stringify(v ?? null)): Mixed<T> {
  if (!values.length) return MIXED;
  const k = key(values[0]);
  for (let i = 1; i < values.length; i++) if (key(values[i]) !== k) return MIXED;
  return values[0];
}

/** Summarise the strokes of the selection (or the defaults when nothing is selected). */
export function strokeSummary(state: EditorState): StrokeSummary {
  const targets = appearanceTargets(state.selection);
  const strokes: StrokeStyle[] = targets.length
    ? targets
        .map((id) => state.doc.nodes[id])
        .filter((n): n is Extract<Node, { stroke: StrokeStyle }> => !!n && (n.type === 'path' || n.type === 'text'))
        .map((n) => n.stroke)
    : [state.appearance.stroke];
  return {
    hasTargets: targets.length > 0,
    width: same(strokes.map((s) => s.width)),
    cap: same(strokes.map((s) => s.cap)),
    join: same(strokes.map((s) => s.join)),
    miterLimit: same(strokes.map((s) => s.miterLimit)),
    align: same(strokes.map((s) => s.align)),
    dash: same(strokes.map((s) => s.dash)),
    dashOffset: same(strokes.map((s) => s.dashOffset)),
    markerStart: same(strokes.map((s) => s.markerStart)),
    markerEnd: same(strokes.map((s) => s.markerEnd)),
    markerScale: same(strokes.map((s) => s.markerScale)),
    widthProfile: same(strokes.map((s) => s.widthProfile)),
    paintType: same(strokes.map((s) => s.paint.type)),
  };
}

// ---------------------------------------------------------------------------
// Dashes
// ---------------------------------------------------------------------------

export const DASH_SLOTS = 6;
export const DEFAULT_DASH = [12, 6];

/** Expand a dash array into 3 dash/gap pairs (6 numbers, 0 = empty). */
export function dashPairs(dash: number[]): number[] {
  const out: number[] = new Array(DASH_SLOTS).fill(0);
  dash.slice(0, DASH_SLOTS).forEach((v, i) => (out[i] = v));
  return out;
}

/** Build a dash array from the 6 slots; empty pairs are skipped. */
export function pairsToDash(pairs: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < DASH_SLOTS; i += 2) {
    const d = Math.max(0, pairs[i] ?? 0);
    const g = Math.max(0, pairs[i + 1] ?? 0);
    if (d <= 0 && g <= 0) continue;
    out.push(d, g);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arrowheads
// ---------------------------------------------------------------------------

export const ARROWHEADS: Array<{ id: Arrowhead; name: string }> = [
  { id: 'none', name: 'None' },
  { id: 'arrow', name: 'Arrow' },
  { id: 'triangle', name: 'Triangle' },
  { id: 'open-arrow', name: 'Open arrow' },
  { id: 'circle', name: 'Circle' },
  { id: 'square', name: 'Square' },
  { id: 'bar', name: 'Bar' },
  { id: 'diamond', name: 'Diamond' },
];

/** Marker shapes in a 10x10 box pointing right (same as the renderer). */
export const ARROWHEAD_SHAPES: Record<Exclude<Arrowhead, 'none'>, { d: string; fill: boolean }> = {
  arrow: { d: 'M0 0 L10 5 L0 10 L3 5 Z', fill: true },
  triangle: { d: 'M0 0 L10 5 L0 10 Z', fill: true },
  'open-arrow': { d: 'M1 1 L9 5 L1 9', fill: false },
  circle: { d: 'M5 1 A4 4 0 1 0 5 9 A4 4 0 1 0 5 1 Z', fill: true },
  square: { d: 'M1.5 1.5 H8.5 V8.5 H1.5 Z', fill: true },
  bar: { d: 'M4.5 0 H5.5 V10 H4.5 Z', fill: true },
  diamond: { d: 'M5 0 L10 5 L5 10 L0 5 Z', fill: true },
};

// ---------------------------------------------------------------------------
// Width profiles
// ---------------------------------------------------------------------------

export type ProfileId = 'uniform' | 'taperBoth' | 'taperStart' | 'taperEnd' | 'bulge' | 'wave' | 'thinThickThin';

export interface WidthProfileDef {
  id: ProfileId;
  name: string;
  /** [offset, width multiplier] pairs; empty = uniform stroke */
  points: Array<[number, number]>;
}

export const WIDTH_PROFILES: WidthProfileDef[] = [
  { id: 'uniform', name: 'Uniform', points: [] },
  { id: 'taperBoth', name: 'Taper both ends', points: [[0, 0], [0.5, 1], [1, 0]] },
  { id: 'taperStart', name: 'Taper start', points: [[0, 0], [1, 1]] },
  { id: 'taperEnd', name: 'Taper end', points: [[0, 1], [1, 0]] },
  { id: 'bulge', name: 'Bulge middle', points: [[0, 0.25], [0.5, 1], [1, 0.25]] },
  { id: 'wave', name: 'Wave', points: [[0, 0.2], [0.2, 1], [0.4, 0.2], [0.6, 1], [0.8, 0.2], [1, 1]] },
  { id: 'thinThickThin', name: 'Thin - thick - thin', points: [[0, 0.15], [0.25, 0.15], [0.5, 1], [0.75, 0.15], [1, 0.15]] },
];

/** Width points for a profile at the given base stroke width (undefined = uniform). */
export function profilePoints(id: ProfileId, width: number): WidthPoint[] | undefined {
  const def = WIDTH_PROFILES.find((p) => p.id === id);
  if (!def || !def.points.length) return undefined;
  const w = Math.max(0.01, width);
  return def.points.map(([offset, mul]) => ({ offset, width: Math.max(0, mul * w) }));
}

/** Detect which preset (if any) a width profile corresponds to. */
export function detectProfile(points: WidthPoint[] | undefined, width: number): ProfileId | null {
  if (!points || !points.length) return 'uniform';
  const w = Math.max(0.01, width);
  const norm = [...points].sort((a, b) => a.offset - b.offset).map((p) => [p.offset, p.width / w] as [number, number]);
  for (const def of WIDTH_PROFILES) {
    if (def.points.length !== norm.length) continue;
    let ok = true;
    for (let i = 0; i < norm.length; i++) {
      if (Math.abs(norm[i][0] - def.points[i][0]) > 1e-3 || Math.abs(norm[i][1] - def.points[i][1]) > 2e-2) {
        ok = false;
        break;
      }
    }
    if (ok) return def.id;
  }
  return null;
}

/** Mirror a profile along the path direction (swapping left/right widths). */
export function flipProfile(points: WidthPoint[]): WidthPoint[] {
  return [...points]
    .map((p) => {
      const out: WidthPoint = { offset: 1 - p.offset, width: p.width };
      if (p.right !== undefined) out.left = p.right;
      if (p.left !== undefined) out.right = p.left;
      return out;
    })
    .sort((a, b) => a.offset - b.offset);
}

/** Interpolated multiplier of a [offset, multiplier] profile at t (smoothstep like the renderer). */
export function profileMultiplierAt(points: Array<[number, number]>, t: number): number {
  if (!points.length) return 1;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (t <= sorted[0][0]) return sorted[0][1];
  if (t >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
      const s = f * f * (3 - 2 * f);
      return a[1] + (b[1] - a[1]) * s;
    }
  }
  return sorted[0][1];
}

/** Outline path (in a width x height box) previewing a profile. */
export function profilePreviewPath(points: Array<[number, number]>, width = 100, height = 24): string {
  if (!points.length) {
    const h = height * 0.35;
    return `M0 ${height / 2 - h / 2} H${width} V${height / 2 + h / 2} H0 Z`;
  }
  const steps = 40;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const half = profileMultiplierAt(points, t) * height * 0.45;
    top.push(`${(t * width).toFixed(2)} ${(height / 2 - half).toFixed(2)}`);
    bottom.push(`${(t * width).toFixed(2)} ${(height / 2 + half).toFixed(2)}`);
  }
  return `M${top.join(' L')} L${bottom.reverse().join(' L')} Z`;
}
