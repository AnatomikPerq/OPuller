/**
 * Printer's marks (trim marks, registration marks, colour bars, page
 * information) and bleed geometry for export. Marks are generated as SVG
 * markup in the export coordinate space (world px).
 */
import type { Bleed, Rect } from '@/model/types';

export interface PrinterMarks {
  trimMarks: boolean;
  registrationMarks: boolean;
  colorBars: boolean;
  pageInfo: boolean;
  /** stroke weight of marks in px (0.25 pt = 1/3 px by default) */
  weight?: number;
  /** offset of trim marks from the bleed box in px */
  offset?: number;
  /** text of the page information line (document name, artboard, date) */
  info?: string;
}

export const DEFAULT_MARKS: PrinterMarks = { trimMarks: true, registrationMarks: true, colorBars: true, pageInfo: true };

export const NO_MARKS: PrinterMarks = { trimMarks: false, registrationMarks: false, colorBars: false, pageInfo: false };

export function anyMarks(m: PrinterMarks | undefined | null): boolean {
  return !!m && (m.trimMarks || m.registrationMarks || m.colorBars || m.pageInfo);
}

export function bleedIsZero(b: Bleed | undefined | null): boolean {
  return !b || (b.top <= 0 && b.right <= 0 && b.bottom <= 0 && b.left <= 0);
}

export function expandByBleed(r: Rect, b: Bleed): Rect {
  return { x: r.x - b.left, y: r.y - b.top, width: r.width + b.left + b.right, height: r.height + b.top + b.bottom };
}

/** Margin needed around the bleed box for the marks (px). */
export function marksMargin(m: PrinterMarks, bleed: Bleed): number {
  if (!anyMarks(m)) return 0;
  const offset = m.offset ?? 6;
  // trim marks: 20 px long beyond the offset; registration & bars need ~28 px
  let margin = Math.max(offset + 22, 0);
  if (m.registrationMarks || m.colorBars) margin = Math.max(margin, 34);
  if (m.pageInfo) margin = Math.max(margin, 34);
  void bleed;
  return margin;
}

const REG = '#000000';

/**
 * SVG markup of the marks for a trim box (the artboard) with a bleed box
 * around it. Everything is drawn outside the bleed box.
 */
export function printerMarksSvg(trim: Rect, bleed: Bleed, m: PrinterMarks): string {
  if (!anyMarks(m)) return '';
  const w = m.weight ?? 1 / 3;
  const off = m.offset ?? 6;
  const box = expandByBleed(trim, bleed);
  const parts: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => parts.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${REG}" stroke-width="${f(w)}" />`);
  if (m.trimMarks) {
    const len = 20;
    const corners: Array<[number, number, number, number]> = [
      [trim.x, trim.y, -1, -1],
      [trim.x + trim.width, trim.y, 1, -1],
      [trim.x, trim.y + trim.height, -1, 1],
      [trim.x + trim.width, trim.y + trim.height, 1, 1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      // horizontal mark: at the trim y, starting beyond the bleed box + offset
      const hx0 = sx < 0 ? box.x - off : box.x + box.width + off;
      line(hx0, cy, hx0 + sx * len, cy);
      const vy0 = sy < 0 ? box.y - off : box.y + box.height + off;
      line(cx, vy0, cx, vy0 + sy * len);
    }
  }
  if (m.registrationMarks) {
    const r = 6;
    const cx = trim.x + trim.width / 2;
    const cy = trim.y + trim.height / 2;
    const d = off + 14;
    const spots: Array<[number, number]> = [
      [cx, box.y - d],
      [cx, box.y + box.height + d],
      [box.x - d, cy],
      [box.x + box.width + d, cy],
    ];
    for (const [x, y] of spots) {
      parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="none" stroke="${REG}" stroke-width="${f(w)}" />`);
      parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r / 3)}" fill="${REG}" />`);
      line(x - r * 1.6, y, x + r * 1.6, y);
      line(x, y - r * 1.6, x, y + r * 1.6);
    }
  }
  if (m.colorBars) {
    // process colour bar (top left) and gray ramp (top right)
    const size = 14;
    const y = box.y - off - size - 4;
    const inks = ['#00aeef', '#ec008c', '#fff200', '#000000', '#ff0000', '#00ff00', '#0000ff'];
    let x = trim.x + 8;
    for (const c of inks) {
      parts.push(`<rect x="${f(x)}" y="${f(y)}" width="${size}" height="${size}" fill="${c}" stroke="${REG}" stroke-width="${f(w)}" />`);
      x += size;
    }
    const steps = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    let gx = trim.x + trim.width - 8 - size * steps.length;
    for (const k of steps) {
      const v = Math.round(255 * (1 - k));
      const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
      parts.push(`<rect x="${f(gx)}" y="${f(y)}" width="${size}" height="${size}" fill="${hex}" stroke="${REG}" stroke-width="${f(w)}" />`);
      gx += size;
    }
  }
  if (m.pageInfo) {
    const y = box.y + box.height + off + 22;
    const text = escapeXml(m.info ?? '');
    parts.push(`<text x="${f(trim.x)}" y="${f(y)}" font-family="Helvetica, Arial, sans-serif" font-size="8" fill="${REG}">${text}</text>`);
  }
  return `<g id="printer-marks" fill="none">${parts.join('')}</g>`;
}

function f(v: number): string {
  return (+v.toFixed(3)).toString();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function pageInfoText(docName: string, artboardName: string | undefined, date = new Date()): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return [docName, artboardName, d, 'OPuller'].filter(Boolean).join('  ·  ');
}
