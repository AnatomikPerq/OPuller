/**
 * Swatch helpers: naming, usage queries, replacing paints across the document,
 * JSON import/export.
 */
import type { Document, ID, Paint, Swatch, GradientStop, ColorMode } from '@/model/types';
import { plainPaint, colorNameFor } from './globals';
import { newId } from '@/model/nodes';
import { selectableNodes, descendants } from '@/model/document';
import { normalizeHex, isValidHex } from '@/util/color';
import { paintEquals, clonePaintDeep } from './paint';

export function makeSwatch(name: string, paint: Paint): Swatch {
  return { id: newId(), name, paint: clonePaintDeep(paint) };
}

export function uniqueSwatchName(swatches: Swatch[], base: string): string {
  const names = new Set(swatches.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
  return base;
}

export function defaultSwatchName(paint: Paint, mode: ColorMode = 'rgb'): string {
  switch (paint.type) {
    case 'solid':
      return mode === 'cmyk' ? colorNameFor(paint.color, 'cmyk') : paint.color.toUpperCase();
    case 'linear':
      return 'Linear Gradient';
    case 'radial':
      return 'Radial Gradient';
    case 'pattern':
      return 'Pattern';
    case 'freeform':
      return 'Freeform Gradient';
    case 'mesh':
      return 'Gradient Mesh';
    case 'none':
      return 'None';
  }
}

/** Swatch whose paint equals the given paint (links to global swatches count as matches). */
export function findSwatchByPaint(swatches: Swatch[], paint: Paint): Swatch | undefined {
  if (paint.type === 'solid' && paint.swatchId) {
    const linked = swatches.find((s) => s.id === paint.swatchId);
    if (linked) return linked;
  }
  const plain = plainPaint(paint);
  return swatches.find((s) => paintEquals(s.paint, plain));
}

/** Leaf objects (path/text) whose fill or stroke uses the paint. */
export function nodesUsingPaint(doc: Document, paint: Paint): ID[] {
  const out: ID[] = [];
  const plain = plainPaint(paint);
  for (const top of selectableNodes(doc, true)) {
    for (const id of descendants(doc, top, true)) {
      const n = doc.nodes[id];
      if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
      if (paintEquals(plainPaint(n.fill), plain) || paintEquals(plainPaint(n.stroke.paint), plain)) out.push(id);
    }
  }
  return Array.from(new Set(out));
}

/** Replace every fill/stroke equal to `from` with `to` (mutates a draft). Returns count. */
export function replacePaintInDoc(doc: Document, from: Paint, to: Paint): number {
  let count = 0;
  const f = plainPaint(from);
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'path' && n.type !== 'text') continue;
    if (paintEquals(plainPaint(n.fill), f)) {
      n.fill = clonePaintDeep(to);
      count++;
    }
    if (paintEquals(plainPaint(n.stroke.paint), f)) {
      n.stroke = { ...n.stroke, paint: clonePaintDeep(to) };
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export const SWATCH_JSON_FORMAT = 'opuller-swatches';

export function exportSwatchesJson(swatches: Swatch[]): string {
  return JSON.stringify({ format: SWATCH_JSON_FORMAT, version: 1, swatches: swatches.map((s) => ({ name: s.name, paint: s.paint, kind: s.kind, cmyk: s.cmyk })) }, null, 2);
}

function validStop(s: unknown): s is GradientStop {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return typeof o.offset === 'number' && typeof o.color === 'string' && isValidHex(o.color);
}

/** Validate a paint-like object; returns a normalized paint or null. */
export function sanitizePaint(p: unknown): Paint | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, any>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const spread = (v: unknown): 'pad' | 'reflect' | 'repeat' => (v === 'reflect' || v === 'repeat' ? v : 'pad');
  switch (o.type) {
    case 'none':
      return { type: 'none' };
    case 'solid':
      if (typeof o.color !== 'string' || !isValidHex(o.color)) return null;
      return { type: 'solid', color: normalizeHex(o.color), opacity: Math.max(0, Math.min(1, num(o.opacity, 1))) };
    case 'linear':
    case 'radial': {
      if (!Array.isArray(o.stops) || o.stops.length < 2 || !o.stops.every(validStop)) return null;
      const stops: GradientStop[] = o.stops.map((s: GradientStop) => ({ offset: Math.max(0, Math.min(1, s.offset)), color: normalizeHex(s.color), opacity: Math.max(0, Math.min(1, num((s as any).opacity, 1))) }));
      if (o.type === 'linear') return { type: 'linear', x1: num(o.x1, 0), y1: num(o.y1, 0.5), x2: num(o.x2, 1), y2: num(o.y2, 0.5), stops, spread: spread(o.spread) };
      const r: Paint = { type: 'radial', cx: num(o.cx, 0.5), cy: num(o.cy, 0.5), r: num(o.r, 0.5), stops, spread: spread(o.spread) };
      if (typeof o.fx === 'number') (r as any).fx = o.fx;
      if (typeof o.fy === 'number') (r as any).fy = o.fy;
      return r;
    }
    case 'pattern':
      if (typeof o.patternId !== 'string') return null;
      return { type: 'pattern', patternId: o.patternId, scale: num(o.scale, 1), angle: num(o.angle, 0) };
    case 'freeform':
      if (!Array.isArray(o.points) || !o.points.length) return null;
      return { type: 'freeform', mode: o.mode === 'lines' ? 'lines' : 'points', points: o.points.map((pt: any) => ({ x: num(pt?.x, 0.5), y: num(pt?.y, 0.5), color: typeof pt?.color === 'string' && isValidHex(pt.color) ? normalizeHex(pt.color) : '#000000', opacity: Math.max(0, Math.min(1, num(pt?.opacity, 1))), spread: Math.max(0.02, num(pt?.spread, 0.5)) })), lines: Array.isArray(o.lines) ? o.lines : undefined };
    case 'mesh':
      if (!Array.isArray(o.nodes) || typeof o.rows !== 'number' || typeof o.cols !== 'number' || o.nodes.length !== (o.rows + 1) * (o.cols + 1)) return null;
      return { type: 'mesh', rows: o.rows, cols: o.cols, nodes: o.nodes.map((n: any) => ({ x: num(n?.x, 0), y: num(n?.y, 0), color: typeof n?.color === 'string' && isValidHex(n.color) ? normalizeHex(n.color) : '#000000', opacity: Math.max(0, Math.min(1, num(n?.opacity, 1))), up: n?.up ?? null, down: n?.down ?? null, left: n?.left ?? null, right: n?.right ?? null })) };
    default:
      return null;
  }
}

/**
 * Parse swatches from JSON. Accepts the OPuller format, a bare array of
 * `{ name, paint }`, `{ name, color }` entries or an array of hex strings.
 */
export function parseSwatchesJson(text: string): Swatch[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON');
  }
  const list: unknown[] = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as any).swatches) ? (data as any).swatches : [];
  const out: Swatch[] = [];
  list.forEach((item, i) => {
    if (typeof item === 'string') {
      if (isValidHex(item)) out.push(makeSwatch(item.toUpperCase(), { type: 'solid', color: normalizeHex(item), opacity: 1 }));
      return;
    }
    if (!item || typeof item !== 'object') return;
    const o = item as Record<string, any>;
    let paint: Paint | null = null;
    if (o.paint) paint = sanitizePaint(o.paint);
    else if (typeof o.color === 'string' && isValidHex(o.color)) paint = { type: 'solid', color: normalizeHex(o.color), opacity: 1 };
    else if (typeof o.hex === 'string' && isValidHex(o.hex)) paint = { type: 'solid', color: normalizeHex(o.hex), opacity: 1 };
    if (!paint) return;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : defaultSwatchName(paint) || `Swatch ${i + 1}`;
    const sw = makeSwatch(name, paint);
    if (o.kind === 'global' || o.kind === 'spot') sw.kind = o.kind;
    if (o.cmyk && typeof o.cmyk === 'object' && ['c', 'm', 'y', 'k'].every((k) => typeof o.cmyk[k] === 'number')) sw.cmyk = { c: o.cmyk.c, m: o.cmyk.m, y: o.cmyk.y, k: o.cmyk.k };
    out.push(sw);
  });
  if (!out.length) throw new Error('No swatches found in the file');
  return out;
}

/** Move an item inside an array (pure). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  const idx = Math.max(0, Math.min(out.length, to));
  out.splice(idx, 0, item);
  return out;
}
