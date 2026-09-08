/**
 * Global and spot colours: paints linked to a swatch (`swatchId` + `tint`)
 * follow edits of the swatch. Tints mix the ink with white (Illustrator
 * semantics: 100 % = full colour, 0 % = white).
 */
import type { Document, Paint, Swatch, SolidPaint, GradientStop, HexColor, CMYK, ColorMode, Node, ID } from '@/model/types';
import { hexToRgb, rgbToHex, mixHex } from '@/util/color';
import { rgbToCmyk, cmykToRgb } from './models';

export const REGISTRATION_SWATCH_ID = 'sw-registration';

export function isGlobalSwatch(sw: Swatch | undefined | null): boolean {
  return !!sw && (sw.kind === 'global' || sw.kind === 'spot');
}

/** Base colour of a swatch (solid swatches only). */
export function swatchBaseColor(sw: Swatch): HexColor {
  if (sw.paint.type === 'solid') return sw.paint.color;
  if (sw.paint.type === 'linear' || sw.paint.type === 'radial') return sw.paint.stops[0]?.color ?? '#000000';
  return '#000000';
}

/** Colour of a tint (0..100) of a base colour: mixed towards white. */
export function tintColor(base: HexColor, tint: number): HexColor {
  const t = Math.max(0, Math.min(100, Number.isFinite(tint) ? tint : 100)) / 100;
  if (t >= 1) return base;
  return mixHex('#ffffff', base, t);
}

/** Solid paint that references a global/spot swatch at a tint. */
export function linkedPaint(sw: Swatch, tint = 100, opacity = 1): SolidPaint {
  return { type: 'solid', color: tintColor(swatchBaseColor(sw), tint), opacity, swatchId: sw.id, tint };
}

/** Whether a solid paint / stop is linked to the swatch. */
export function paintLinkedTo(p: Paint | GradientStop, swatchId: ID): boolean {
  return (p as { swatchId?: ID }).swatchId === swatchId;
}

/** Recompute the colour of every paint linked to the swatch (mutates a draft). Returns the count. */
export function propagateSwatch(doc: Document, sw: Swatch): number {
  const base = swatchBaseColor(sw);
  let count = 0;
  const fix = (p: Paint): Paint => {
    if (p.type === 'solid' && p.swatchId === sw.id) {
      const color = tintColor(base, p.tint ?? 100);
      if (color !== p.color) count++;
      return { ...p, color };
    }
    if ((p.type === 'linear' || p.type === 'radial') && p.stops.some((s) => s.swatchId === sw.id)) {
      const stops = p.stops.map((s) => (s.swatchId === sw.id ? { ...s, color: tintColor(base, s.tint ?? 100) } : s));
      count++;
      return { ...p, stops };
    }
    return p;
  };
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'path' && n.type !== 'text') continue;
    const f = fix(n.fill);
    if (f !== n.fill) n.fill = f;
    const sp = fix(n.stroke.paint);
    if (sp !== n.stroke.paint) n.stroke = { ...n.stroke, paint: sp };
  }
  return count;
}

/** Remove links to a swatch (paints keep their current colour). */
export function unlinkSwatch(doc: Document, swatchId: ID): void {
  const strip = (p: Paint): Paint => {
    if (p.type === 'solid' && p.swatchId === swatchId) {
      const { swatchId: _s, tint: _t, ...rest } = p;
      return rest;
    }
    if ((p.type === 'linear' || p.type === 'radial') && p.stops.some((s) => s.swatchId === swatchId)) {
      return { ...p, stops: p.stops.map((s) => (s.swatchId === swatchId ? { offset: s.offset, color: s.color, opacity: s.opacity } : s)) };
    }
    return p;
  };
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'path' && n.type !== 'text') continue;
    n.fill = strip(n.fill);
    n.stroke = { ...n.stroke, paint: strip(n.stroke.paint) };
  }
}

/** Nodes (path/text) with a fill or stroke linked to the swatch. */
export function nodesLinkedTo(doc: Document, swatchId: ID): ID[] {
  const out: ID[] = [];
  const uses = (p: Paint) => (p.type === 'solid' && p.swatchId === swatchId) || ((p.type === 'linear' || p.type === 'radial') && p.stops.some((s) => s.swatchId === swatchId));
  for (const n of Object.values(doc.nodes) as Node[]) {
    if ((n.type === 'path' || n.type === 'text') && (uses(n.fill) || uses(n.stroke.paint))) out.push(n.id);
  }
  return out;
}

/** Strip swatch links from a paint (for comparisons and plain copies). */
export function plainPaint(p: Paint): Paint {
  if (p.type === 'solid') return { type: 'solid', color: p.color, opacity: p.opacity };
  if (p.type === 'linear' || p.type === 'radial') return { ...p, stops: p.stops.map((s) => ({ offset: s.offset, color: s.color, opacity: s.opacity })) };
  return p;
}

// ---------------------------------------------------------------------------
// CMYK helpers
// ---------------------------------------------------------------------------

export function hexToCmyk(hex: HexColor): CMYK {
  const c = rgbToCmyk(hexToRgb(hex));
  return { c: Math.round(c.c), m: Math.round(c.m), y: Math.round(c.y), k: Math.round(c.k) };
}

export function cmykToHex(v: CMYK): HexColor {
  return rgbToHex(cmykToRgb(v));
}

/** "C=0 M=100 Y=100 K=0" style name (Illustrator convention). */
export function cmykName(v: CMYK): string {
  return `C=${Math.round(v.c)} M=${Math.round(v.m)} Y=${Math.round(v.y)} K=${Math.round(v.k)}`;
}

export function rgbName(hex: HexColor): string {
  const c = hexToRgb(hex);
  return `R=${Math.round(c.r)} G=${Math.round(c.g)} B=${Math.round(c.b)}`;
}

/** Default name for a colour in the document's colour mode. */
export function colorNameFor(hex: HexColor, mode: ColorMode): string {
  return mode === 'cmyk' ? cmykName(hexToCmyk(hex)) : rgbName(hex);
}

/** Human readable colour values for tooltips / lists. */
export function colorValuesLabel(sw: Swatch, mode: ColorMode): string {
  if (sw.paint.type !== 'solid') return sw.paint.type === 'pattern' ? 'Pattern' : 'Gradient';
  if (mode === 'cmyk' || sw.cmyk) return cmykName(sw.cmyk ?? hexToCmyk(sw.paint.color));
  return sw.paint.color.toUpperCase();
}

/**
 * Snap a colour to the CMYK gamut of the naive conversion. The device
 * conversion is lossless, so this only rounds ink values to whole percents —
 * useful to give "print" swatches clean numbers.
 */
export function roundToInks(hex: HexColor): HexColor {
  return cmykToHex(hexToCmyk(hex));
}
