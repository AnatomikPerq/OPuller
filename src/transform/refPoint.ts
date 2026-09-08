/**
 * Reference points: the 9-point grid used by the Transform panel and dialogs
 * (Illustrator's "reference point locator").
 */
import type { Rect, Vec } from '@/model/types';

export type RefPoint = 'nw' | 'n' | 'ne' | 'w' | 'c' | 'e' | 'sw' | 's' | 'se';

export const REF_GRID: RefPoint[][] = [
  ['nw', 'n', 'ne'],
  ['w', 'c', 'e'],
  ['sw', 's', 'se'],
];

export const REF_LABELS: Record<RefPoint, string> = {
  nw: 'Top left',
  n: 'Top center',
  ne: 'Top right',
  w: 'Middle left',
  c: 'Center',
  e: 'Middle right',
  sw: 'Bottom left',
  s: 'Bottom center',
  se: 'Bottom right',
};

/** World position of a reference point on a rectangle. */
export function refPointOf(r: Rect, ref: RefPoint): Vec {
  const fx = ref.includes('w') ? 0 : ref.includes('e') ? 1 : 0.5;
  const fy = ref.includes('n') ? 0 : ref.includes('s') ? 1 : 0.5;
  return { x: r.x + r.width * fx, y: r.y + r.height * fy };
}

/** Fractions (0..1) of a reference point inside its rectangle. */
export function refFractions(ref: RefPoint): Vec {
  return { x: ref.includes('w') ? 0 : ref.includes('e') ? 1 : 0.5, y: ref.includes('n') ? 0 : ref.includes('s') ? 1 : 0.5 };
}
