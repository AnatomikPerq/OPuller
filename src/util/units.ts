import type { Units } from '@/model/types';

/** px per unit */
export const UNIT_PX: Record<Units, number> = {
  px: 1,
  pt: 96 / 72,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

export const UNIT_LABELS: Record<Units, string> = { px: 'px', pt: 'pt', in: 'in', cm: 'cm', mm: 'mm' };

export function pxToUnit(px: number, u: Units): number {
  return px / UNIT_PX[u];
}

export function unitToPx(v: number, u: Units): number {
  return v * UNIT_PX[u];
}

export function formatLength(px: number, u: Units, decimals?: number): string {
  const v = pxToUnit(px, u);
  const d = decimals ?? (u === 'px' ? 2 : u === 'mm' ? 2 : 3);
  return trimZeros(v.toFixed(d)) + ' ' + UNIT_LABELS[u];
}

export function formatNumber(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '';
  return trimZeros(v.toFixed(decimals));
}

export function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Parse a numeric expression with optional unit suffix, e.g. "12", "1.5cm",
 * "10+5", "100/3", "50%" (percent handled by the caller through `percentBase`).
 * Returns the value in px (or in the given base unit when no unit is given).
 */
export function parseLength(input: string, defaultUnit: Units, percentBase?: number): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, '.');
  if (!s) return null;
  // unit suffix on the whole expression
  const m = s.match(/^(.*?)(px|pt|in|cm|mm|%)$/);
  let expr = s;
  let unit: Units | '%' = defaultUnit;
  if (m) {
    expr = m[1].trim();
    unit = m[2] as Units | '%';
  }
  const val = evalExpression(expr);
  if (val === null) return null;
  if (unit === '%') return percentBase !== undefined ? (val / 100) * percentBase : null;
  return unitToPx(val, unit);
}

/** Safe arithmetic evaluation: + - * / ( ) and unary minus. */
export function evalExpression(expr: string): number | null {
  const tokens = expr.match(/\d*\.\d+|\d+\.?\d*|[-+*/()]/g);
  if (!tokens || tokens.join('').replace(/\s+/g, '') !== expr.replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const parsePrimary = (): number | null => {
    const t = next();
    if (t === undefined) return null;
    if (t === '(') {
      const v = parseExpr();
      if (next() !== ')') return null;
      return v;
    }
    if (t === '-') {
      const v = parsePrimary();
      return v === null ? null : -v;
    }
    if (t === '+') return parsePrimary();
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  };
  const parseTerm = (): number | null => {
    let v = parsePrimary();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = parsePrimary();
      if (r === null) return null;
      v = op === '*' ? v * r : r === 0 ? NaN : v / r;
    }
    return v;
  };
  const parseExpr = (): number | null => {
    let v = parseTerm();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const result = parseExpr();
  if (i !== tokens.length) return null;
  return result !== null && Number.isFinite(result) ? result : null;
}

/** Nice tick step for rulers given px-per-screen-pixel scale. */
export function rulerStep(zoom: number, unit: Units): { major: number; minor: number } {
  // target ~ 80..160 screen px between major ticks
  const unitPx = UNIT_PX[unit];
  const candidates = unit === 'px' || unit === 'pt' ? [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000] : [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (const c of candidates) {
    const screen = c * unitPx * zoom;
    if (screen >= 70) return { major: c * unitPx, minor: (c * unitPx) / (c % 5 === 0 || c === 1 ? 5 : c % 2 === 0 ? 4 : 5) };
  }
  const last = candidates[candidates.length - 1] * unitPx;
  return { major: last, minor: last / 5 };
}
