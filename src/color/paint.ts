/**
 * Paint helpers shared by the colour UI: active colour of a paint (solid or the
 * edited gradient stop), updating that colour, equality and labels.
 */
import type { Paint, SolidPaint, GradientPaint, HexColor } from '@/model/types';

export function isGradient(p: Paint | null | undefined): p is GradientPaint {
  return !!p && (p.type === 'linear' || p.type === 'radial');
}

export function clampStopIndex(p: GradientPaint, i: number): number {
  if (!p.stops.length) return 0;
  return Math.max(0, Math.min(p.stops.length - 1, Math.floor(Number.isFinite(i) ? i : 0)));
}

/** The colour edited by the colour UI: a solid paint, or the active gradient stop. */
export function activeSolid(paint: Paint, stopIndex = 0): SolidPaint {
  if (paint.type === 'solid') return paint;
  if (isGradient(paint)) {
    const s = paint.stops[clampStopIndex(paint, stopIndex)];
    return { type: 'solid', color: s?.color ?? '#000000', opacity: s?.opacity ?? 1 };
  }
  return { type: 'solid', color: '#000000', opacity: 1 };
}

/**
 * Returns a new paint with the active colour replaced. `none` and pattern
 * paints become solid; gradients keep their geometry and update the stop.
 */
export function withActiveColor(paint: Paint, stopIndex: number, patch: { color?: HexColor; opacity?: number }): Paint {
  const cur = activeSolid(paint, stopIndex);
  const color = patch.color ?? cur.color;
  const opacity = patch.opacity ?? cur.opacity;
  if (isGradient(paint)) {
    const idx = clampStopIndex(paint, stopIndex);
    return { ...paint, stops: paint.stops.map((s, i) => (i === idx ? { ...s, color, opacity } : s)) };
  }
  return { type: 'solid', color, opacity };
}

export function paintEquals(a: Paint | null | undefined, b: Paint | null | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Equality tolerant to floating point noise (numbers rounded to 1e-9). */
export function paintNearlyEqual(a: Paint | null | undefined, b: Paint | null | undefined): boolean {
  if (!a || !b) return a === b;
  const norm = (p: Paint) => JSON.stringify(p, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v));
  return norm(a) === norm(b);
}

export function clonePaintDeep<T extends Paint>(p: T): T {
  return JSON.parse(JSON.stringify(p)) as T;
}

export function paintLabel(p: Paint): string {
  switch (p.type) {
    case 'none':
      return 'None';
    case 'solid':
      return p.color.toUpperCase() + (p.opacity < 1 ? ` ${Math.round(p.opacity * 100)}%` : '');
    case 'linear':
      return 'Linear gradient';
    case 'radial':
      return 'Radial gradient';
    case 'pattern':
      return 'Pattern';
  }
}

export function paintTypeLabel(p: Paint): string {
  switch (p.type) {
    case 'none':
      return 'None';
    case 'solid':
      return 'Color';
    case 'linear':
      return 'Linear';
    case 'radial':
      return 'Radial';
    case 'pattern':
      return 'Pattern';
  }
}
