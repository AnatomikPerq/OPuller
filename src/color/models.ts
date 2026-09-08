/**
 * Colour models for the Color panel: channel definitions per mode, conversions
 * to/from hex and CSS gradient tracks that preview the effect of each slider.
 */
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, rgbToHsl, hslToRgb, normalizeHex, type RGB } from '@/util/color';

export type ColorMode = 'hsb' | 'rgb' | 'hsl' | 'hex' | 'gray' | 'cmyk';

export const COLOR_MODES: Array<{ id: ColorMode; label: string }> = [
  { id: 'hsb', label: 'HSB' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
  { id: 'hex', label: 'Hex' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'cmyk', label: 'CMYK' },
];

export interface ChannelDef {
  key: string;
  label: string;
  min: number;
  max: number;
  unit: '' | '%' | 'deg';
}

export const CHANNELS: Record<ColorMode, ChannelDef[]> = {
  hsb: [
    { key: 'h', label: 'H', min: 0, max: 360, unit: 'deg' },
    { key: 's', label: 'S', min: 0, max: 100, unit: '%' },
    { key: 'b', label: 'B', min: 0, max: 100, unit: '%' },
  ],
  rgb: [
    { key: 'r', label: 'R', min: 0, max: 255, unit: '' },
    { key: 'g', label: 'G', min: 0, max: 255, unit: '' },
    { key: 'b', label: 'B', min: 0, max: 255, unit: '' },
  ],
  hsl: [
    { key: 'h', label: 'H', min: 0, max: 360, unit: 'deg' },
    { key: 's', label: 'S', min: 0, max: 100, unit: '%' },
    { key: 'l', label: 'L', min: 0, max: 100, unit: '%' },
  ],
  hex: [],
  gray: [{ key: 'k', label: 'K', min: 0, max: 100, unit: '%' }],
  cmyk: [
    { key: 'c', label: 'C', min: 0, max: 100, unit: '%' },
    { key: 'm', label: 'M', min: 0, max: 100, unit: '%' },
    { key: 'y', label: 'Y', min: 0, max: 100, unit: '%' },
    { key: 'k', label: 'K', min: 0, max: 100, unit: '%' },
  ],
};

export interface CMYK {
  c: number;
  m: number;
  y: number;
  k: number;
}

/** Naive (device) CMYK approximation, 0..100 each. */
export function rgbToCmyk(c: RGB): CMYK {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-9) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: ((1 - r - k) / (1 - k)) * 100,
    m: ((1 - g - k) / (1 - k)) * 100,
    y: ((1 - b - k) / (1 - k)) * 100,
    k: k * 100,
  };
}

export function cmykToRgb(v: CMYK): RGB {
  const k = clamp01(v.k / 100);
  return {
    r: 255 * (1 - clamp01(v.c / 100)) * (1 - k),
    g: 255 * (1 - clamp01(v.m / 100)) * (1 - k),
    b: 255 * (1 - clamp01(v.y / 100)) * (1 - k),
  };
}

/** Grayscale as ink coverage K% (0 = white, 100 = black), luminance weighted. */
export function rgbToGray(c: RGB): number {
  const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return (1 - lum) * 100;
}

export function grayToRgb(k: number): RGB {
  const v = 255 * (1 - clamp01(k / 100));
  return { r: v, g: v, b: v };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function hexToChannels(mode: ColorMode, hex: string): number[] {
  const rgb = hexToRgb(hex);
  switch (mode) {
    case 'hsb': {
      const c = rgbToHsb(rgb);
      return [c.h, c.s, c.b];
    }
    case 'rgb':
      return [rgb.r, rgb.g, rgb.b];
    case 'hsl': {
      const c = rgbToHsl(rgb);
      return [c.h, c.s, c.l];
    }
    case 'gray':
      return [rgbToGray(rgb)];
    case 'cmyk': {
      const c = rgbToCmyk(rgb);
      return [c.c, c.m, c.y, c.k];
    }
    case 'hex':
      return [];
  }
}

export function channelsToHex(mode: ColorMode, v: number[]): string {
  switch (mode) {
    case 'hsb':
      return rgbToHex(hsbToRgb({ h: v[0] ?? 0, s: v[1] ?? 0, b: v[2] ?? 0 }));
    case 'rgb':
      return rgbToHex({ r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0 });
    case 'hsl':
      return rgbToHex(hslToRgb({ h: v[0] ?? 0, s: v[1] ?? 0, l: v[2] ?? 0 }));
    case 'gray':
      return rgbToHex(grayToRgb(v[0] ?? 0));
    case 'cmyk':
      return rgbToHex(cmykToRgb({ c: v[0] ?? 0, m: v[1] ?? 0, y: v[2] ?? 0, k: v[3] ?? 0 }));
    case 'hex':
      return '#000000';
  }
}

/** Clamp channel values to their ranges. */
export function clampChannels(mode: ColorMode, v: number[]): number[] {
  return CHANNELS[mode].map((ch, i) => Math.max(ch.min, Math.min(ch.max, Number.isFinite(v[i]) ? v[i] : ch.min)));
}

/**
 * CSS background for a slider track: samples the channel across its range while
 * keeping the other channels at their current values, so the track shows the
 * colour the slider would produce (Illustrator style).
 */
export function channelTrackCss(mode: ColorMode, index: number, values: number[], steps = 12): string {
  const chans = CHANNELS[mode];
  const ch = chans[index];
  if (!ch) return 'transparent';
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const v = values.slice();
    v[index] = ch.min + (ch.max - ch.min) * t;
    parts.push(`${channelsToHex(mode, v)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/**
 * Colour under a point of the spectrum bar (x = hue 0..1, y = 0 white → 0.5 pure hue → 1 black).
 */
export function spectrumColorAt(x: number, y: number): string {
  const h = clamp01(x) * 360;
  const yy = clamp01(y);
  const s = yy < 0.5 ? yy * 2 * 100 : 100;
  const b = yy < 0.5 ? 100 : (1 - (yy - 0.5) * 2) * 100;
  return rgbToHex(hsbToRgb({ h, s, b }));
}

export const SPECTRUM_CSS = 'linear-gradient(to bottom, #fff 0%, rgba(255,255,255,0) 50%, rgba(0,0,0,0) 50%, #000 100%), linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';

export function invertHex(hex: string): string {
  const c = hexToRgb(hex);
  return rgbToHex({ r: 255 - c.r, g: 255 - c.g, b: 255 - c.b });
}

export function complementHex(hex: string): string {
  const c = rgbToHsb(hexToRgb(hex));
  return rgbToHex(hsbToRgb({ ...c, h: (c.h + 180) % 360 }));
}

export { normalizeHex };
