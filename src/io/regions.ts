/**
 * Export scopes and regions (pure, no renderer): resolves what to export
 * (artboard / all artboards / selection / document) into world rectangles,
 * including bleed and printer's marks around artboards.
 */
import type { Document, ID, Rect, Bleed } from '@/model/types';
import { worldBounds, topmostOf, sortByPaintOrder, selectionBounds } from '@/model/document';
import { rectUnion } from '@/geometry/vec';
import { marksMargin, expandByBleed, anyMarks, bleedIsZero, pageInfoText, type PrinterMarks } from '@/print/marks';

export type ExportScope = 'artboard' | 'artboards' | 'selection' | 'document';

export interface SvgExportOptions {
  scope?: ExportScope;
  /** artboard for scope 'artboard' (defaults to the first artboard) */
  artboardId?: ID | null;
  /** node ids for scope 'selection' */
  ids?: ID[];
  /** render nodes that are hidden in the editor */
  includeHidden?: boolean;
  /** paint the artboard background when the artboard is not transparent (default true) */
  background?: boolean;
  /** explicit background colour (overrides the artboard colour); null = none */
  backgroundColor?: string | null;
  pretty?: boolean;
  /** omit width/height on the root so the SVG scales to its container */
  responsive?: boolean;
  /** decimal places for coordinates (default 3) */
  precision?: number;
  /** margin around the selection / document bounds (px) */
  margin?: number;
  /** id prefix for defs (unique ids when several exports are combined) */
  prefix?: string;
  /** extra CSS (e.g. @font-face rules) embedded in a <style> element */
  css?: string;
  /** add an XML declaration */
  xmlDeclaration?: boolean;
  /** include bleed around artboards: true = the document bleed, or explicit values */
  bleed?: boolean | Bleed;
  /** printer's marks around artboards (drawn outside the bleed box) */
  marks?: PrinterMarks;
}

export interface SvgExportResult {
  svg: string;
  /** exported world region */
  x: number;
  y: number;
  width: number;
  height: number;
  /** suggested base file name (without extension) */
  name: string;
  artboardId?: ID;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';

// ---------------------------------------------------------------------------
// Region resolution
// ---------------------------------------------------------------------------

export interface ExportRegion {
  rect: Rect;
  /** roots to render (undefined = whole document) */
  ids?: ID[];
  name: string;
  artboardId?: ID;
  /** background colour from the artboard, when applicable */
  background: string | null;
  /** the artboard (trim box) when the region has bleed/marks around it */
  trim?: Rect;
  /** trim box + bleed */
  bleedBox?: Rect;
  bleed?: Bleed;
  marks?: PrinterMarks;
}

/** Resolve the bleed option against the document. */
export function resolveBleed(doc: Document, opt: SvgExportOptions['bleed']): Bleed | null {
  if (!opt) return null;
  const b = opt === true ? doc.bleed : opt;
  return bleedIsZero(b) ? null : { ...b };
}

function artboardRegion(doc: Document, a: Document['artboards'][number], name: string, opts: SvgExportOptions): ExportRegion {
  const trim = { x: a.x, y: a.y, width: a.width, height: a.height };
  const bleed = resolveBleed(doc, opts.bleed);
  const marks = opts.marks && anyMarks(opts.marks) ? { ...opts.marks, info: opts.marks.info ?? pageInfoText(doc.name, doc.artboards.length > 1 ? a.name : undefined) } : undefined;
  if (!bleed && !marks) return { rect: trim, name, artboardId: a.id, background: a.transparent ? null : a.background };
  const b: Bleed = bleed ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const bleedBox = expandByBleed(trim, b);
  const margin = marks ? marksMargin(marks, b) : 0;
  const rect = { x: bleedBox.x - margin, y: bleedBox.y - margin, width: bleedBox.width + margin * 2, height: bleedBox.height + margin * 2 };
  return { rect, name, artboardId: a.id, background: a.transparent ? null : a.background, trim, bleedBox, bleed: b, marks };
}

export function safeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return s || 'untitled';
}

/** Content bounds of the whole document (all layers, visible nodes). */
export function documentBounds(doc: Document): Rect | null {
  let r: Rect | null = null;
  for (const l of doc.layers) r = rectUnion(r, worldBounds(doc, l));
  return r;
}

/** Resolve the export regions for a scope (several for 'artboards'). */
export function exportRegions(doc: Document, opts: SvgExportOptions): ExportRegion[] {
  const scope = opts.scope ?? 'artboard';
  const margin = opts.margin ?? 0;
  const multi = doc.artboards.length > 1;
  const abName = (a: Document['artboards'][number]) => (multi ? `${safeFileName(doc.name)}-${safeFileName(a.name)}` : safeFileName(doc.name));
  switch (scope) {
    case 'artboards':
      return doc.artboards.map((a) => artboardRegion(doc, a, abName(a), opts));
    case 'artboard': {
      const a = doc.artboards.find((x) => x.id === opts.artboardId) ?? doc.artboards[0];
      if (!a) return [];
      return [artboardRegion(doc, a, abName(a), opts)];
    }
    case 'selection': {
      const ids = sortByPaintOrder(doc, topmostOf(doc, (opts.ids ?? []).filter((id) => !!doc.nodes[id])));
      const b = selectionBounds(doc, ids);
      if (!ids.length || !b) return [];
      return [{ rect: { x: b.x - margin, y: b.y - margin, width: Math.max(1, b.width + margin * 2), height: Math.max(1, b.height + margin * 2) }, ids, name: `${safeFileName(doc.name)}-selection`, background: null }];
    }
    case 'document': {
      let r: Rect | null = null;
      for (const a of doc.artboards) r = rectUnion(r, a);
      r = rectUnion(r, documentBounds(doc));
      if (!r) r = { x: 0, y: 0, width: 100, height: 100 };
      return [{ rect: { x: r.x - margin, y: r.y - margin, width: Math.max(1, r.width + margin * 2), height: Math.max(1, r.height + margin * 2) }, name: safeFileName(doc.name), background: null }];
    }
  }
}

