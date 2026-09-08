export interface RGB {
  r: number; // 0..255
  g: number;
  b: number;
}
export interface HSB {
  h: number; // 0..360
  s: number; // 0..100
  b: number; // 0..100
}
export interface HSL {
  h: number;
  s: number;
  l: number;
}

export function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function normalizeHex(hex: string): string {
  let h = hex.trim().replace(/^#/, '').toLowerCase();
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/.test(h)) return '#000000';
  return '#' + h;
}

export function isValidHex(hex: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex.trim());
}

export function hexToRgb(hex: string): RGB {
  const h = normalizeHex(hex).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function rgbToHex(c: RGB): string {
  const p = (v: number) => clamp255(v).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

export function rgbToHsb(c: RGB): HSB {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s: s * 100, b: max * 100 };
}

export function hsbToRgb(c: HSB): RGB {
  const h = ((c.h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, c.s)) / 100;
  const v = Math.max(0, Math.min(100, c.b)) / 100;
  const cc = v * s;
  const x = cc * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - cc;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [cc, x, 0];
  else if (h < 120) [r, g, b] = [x, cc, 0];
  else if (h < 180) [r, g, b] = [0, cc, x];
  else if (h < 240) [r, g, b] = [0, x, cc];
  else if (h < 300) [r, g, b] = [x, 0, cc];
  else [r, g, b] = [cc, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function rgbToHsl(c: RGB): HSL {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb(c: HSL): RGB {
  const h = ((c.h % 360) + 360) % 360;
  const s = c.s / 100;
  const l = c.l / 100;
  const cc = (1 - Math.abs(2 * l - 1)) * s;
  const x = cc * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - cc / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [cc, x, 0];
  else if (h < 120) [r, g, b] = [x, cc, 0];
  else if (h < 180) [r, g, b] = [0, cc, x];
  else if (h < 240) [r, g, b] = [0, x, cc];
  else if (h < 300) [r, g, b] = [x, 0, cc];
  else [r, g, b] = [cc, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function hexToHsb(hex: string): HSB {
  return rgbToHsb(hexToRgb(hex));
}

export function hsbToHex(c: HSB): string {
  return rgbToHex(hsbToRgb(c));
}

export function rgbaCss(hex: string, alpha = 1): string {
  const c = hexToRgb(hex);
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** Perceived luminance 0..1 */
export function luminance(hex: string): number {
  const c = hexToRgb(hex);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastText(hex: string): string {
  return luminance(hex) > 0.45 ? '#111111' : '#ffffff';
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t });
}

/** Parse CSS colour strings (hex, rgb(), rgba(), hsl(), named) to hex + alpha. */
export function parseCssColor(input: string): { hex: string; alpha: number } | null {
  const s = input.trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return s === 'transparent' ? { hex: '#000000', alpha: 0 } : null;
  if (isValidHex(s)) {
    const raw = s.replace('#', '');
    let alpha = 1;
    if (raw.length === 8) alpha = parseInt(raw.slice(6, 8), 16) / 255;
    if (raw.length === 4) alpha = parseInt(raw[3] + raw[3], 16) / 255;
    return { hex: normalizeHex(s), alpha };
  }
  let m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const conv = (v: string) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const r = conv(parts[0]);
    const g = conv(parts[1]);
    const b = conv(parts[2]);
    const a = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return { hex: rgbToHex({ r, g, b }), alpha: Number.isFinite(a) ? a : 1 };
  }
  m = s.match(/^hsla?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = parseFloat(parts[0]);
    const sat = parseFloat(parts[1]);
    const l = parseFloat(parts[2]);
    const a = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return { hex: rgbToHex(hslToRgb({ h, s: sat, l })), alpha: Number.isFinite(a) ? a : 1 };
  }
  const named = NAMED_COLORS[s];
  if (named) return { hex: named, alpha: 1 };
  // try the browser
  if (typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.style.color = s;
    if (el.style.color) {
      document.body.appendChild(el);
      const cs = getComputedStyle(el).color;
      document.body.removeChild(el);
      const r = parseCssColor(cs);
      if (r) return r;
    }
  }
  return null;
}

export const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  aqua: '#00ffff',
  teal: '#008080',
  navy: '#000080',
  fuchsia: '#ff00ff',
  purple: '#800080',
  orange: '#ffa500',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  gold: '#ffd700',
  indigo: '#4b0082',
  violet: '#ee82ee',
  tomato: '#ff6347',
  coral: '#ff7f50',
  salmon: '#fa8072',
  crimson: '#dc143c',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  beige: '#f5f5dc',
  ivory: '#fffff0',
  tan: '#d2b48c',
  turquoise: '#40e0d0',
  skyblue: '#87ceeb',
  steelblue: '#4682b4',
  royalblue: '#4169e1',
  dodgerblue: '#1e90ff',
  deepskyblue: '#00bfff',
  slategray: '#708090',
  darkgray: '#a9a9a9',
  lightgray: '#d3d3d3',
  dimgray: '#696969',
  darkred: '#8b0000',
  darkgreen: '#006400',
  darkblue: '#00008b',
  darkorange: '#ff8c00',
  orangered: '#ff4500',
  hotpink: '#ff69b4',
  deeppink: '#ff1493',
  chocolate: '#d2691e',
  firebrick: '#b22222',
  forestgreen: '#228b22',
  seagreen: '#2e8b57',
  springgreen: '#00ff7f',
  limegreen: '#32cd32',
  goldenrod: '#daa520',
  plum: '#dda0dd',
  orchid: '#da70d6',
  wheat: '#f5deb3',
  linen: '#faf0e6',
  snow: '#fffafa',
  mintcream: '#f5fffa',
  aliceblue: '#f0f8ff',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  rebeccapurple: '#663399',
};
