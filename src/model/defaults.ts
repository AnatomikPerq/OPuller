import type { Paint, StrokeStyle, TextStyle, Effect, SolidPaint, HexColor, GridSettings, Swatch } from './types';

export const DEFAULT_FILL: SolidPaint = { type: 'solid', color: '#ffffff', opacity: 1 };
export const DEFAULT_STROKE_PAINT: SolidPaint = { type: 'solid', color: '#000000', opacity: 1 };

export function solid(color: HexColor, opacity = 1): SolidPaint {
  return { type: 'solid', color, opacity };
}

export const NO_PAINT: Paint = { type: 'none' };

export function defaultStroke(overrides: Partial<StrokeStyle> = {}): StrokeStyle {
  return {
    paint: { ...DEFAULT_STROKE_PAINT },
    width: 1,
    cap: 'butt',
    join: 'miter',
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
    align: 'center',
    markerStart: 'none',
    markerEnd: 'none',
    markerScale: 1,
    ...overrides,
  };
}

export function noStroke(): StrokeStyle {
  return defaultStroke({ paint: { type: 'none' } });
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'Inter',
    fontSize: 24,
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: 'left',
    textDecoration: 'none',
    textTransform: 'none',
    baselineShift: 0,
    paragraphSpacing: 0,
    ...overrides,
  };
}

export function defaultEffects(): Effect[] {
  return [];
}

export function defaultGrid(): GridSettings {
  return { size: 50, subdivisions: 5, color: '#8a8a8a', style: 'lines' };
}

export const DEFAULT_SWATCH_COLORS: Array<[string, string]> = [
  ['White', '#ffffff'],
  ['Black', '#000000'],
  ['Burgundy', '#7a1f3d'],
  ['Crimson', '#c8102e'],
  ['Red', '#ff3b30'],
  ['Orange', '#ff9500'],
  ['Amber', '#ffcc00'],
  ['Yellow', '#fff200'],
  ['Lime', '#a4e400'],
  ['Green', '#34c759'],
  ['Teal', '#00b8a9'],
  ['Cyan', '#32ade6'],
  ['Twitter Blue', '#1da1f2'],
  ['Blue', '#007aff'],
  ['Indigo', '#5856d6'],
  ['Purple', '#af52de'],
  ['Pink', '#ff2d55'],
  ['Brown', '#a2845e'],
  ['Gray 90', '#1c1c1e'],
  ['Gray 70', '#48484a'],
  ['Gray 50', '#8e8e93'],
  ['Gray 30', '#c7c7cc'],
  ['Gray 10', '#f2f2f7'],
];

export function defaultSwatches(): Swatch[] {
  const list: Swatch[] = DEFAULT_SWATCH_COLORS.map(([name, color], i) => ({
    id: `sw-${i}`,
    name,
    paint: solid(color),
  }));
  // registration colour: prints on every plate (used for marks); a spot swatch like Illustrator's
  list.splice(2, 0, { id: 'sw-registration', name: '[Registration]', paint: solid('#000000'), kind: 'spot', cmyk: { c: 100, m: 100, y: 100, k: 100 } });
  list.push({
    id: 'sw-grad-1',
    name: 'Burgundy fade',
    paint: {
      type: 'linear',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      spread: 'pad',
      stops: [
        { offset: 0, color: '#9b2a4f', opacity: 1 },
        { offset: 1, color: '#4a0f22', opacity: 1 },
      ],
    },
  });
  list.push({
    id: 'sw-grad-2',
    name: 'Sky',
    paint: {
      type: 'linear',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 1,
      spread: 'pad',
      stops: [
        { offset: 0, color: '#7fd0ff', opacity: 1 },
        { offset: 1, color: '#1da1f2', opacity: 1 },
      ],
    },
  });
  list.push({
    id: 'sw-grad-3',
    name: 'Radial glow',
    paint: {
      type: 'radial',
      cx: 0.5,
      cy: 0.5,
      r: 0.5,
      spread: 'pad',
      stops: [
        { offset: 0, color: '#ffffff', opacity: 1 },
        { offset: 1, color: '#ff9500', opacity: 1 },
      ],
    },
  });
  return list;
}

export const LAYER_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];
