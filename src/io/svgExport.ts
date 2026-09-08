/**
 * SVG export. Renders the document (or a part of it) with the same React
 * renderer the canvas uses (`StaticDocument`) and wraps it in a standalone
 * `<svg>` root with a viewBox covering the exported region.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Document, ID, Node, TextNode } from '@/model/types';
import { printerMarksSvg, anyMarks } from '@/print/marks';
import { StaticDocument } from '@/canvas/Renderer';
import { parentWorldMatrix, ancestors } from '@/model/document';
import { toSvgTransform, isIdentity } from '@/geometry/matrix';
import { makeGroup } from '@/model/nodes';
import { textToOutlinePaths } from '@/text/outline';
import { SVG_NS, XLINK_NS, exportRegions, type SvgExportOptions, type SvgExportResult, type ExportRegion } from './regions';

export { safeFileName, documentBounds, exportRegions, resolveBleed, SVG_NS, XLINK_NS } from './regions';
export type { ExportScope, SvgExportOptions, SvgExportResult, ExportRegion } from './regions';
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function withHiddenVisible(doc: Document): Document {
  const nodes: Record<ID, Node> = {};
  let changed = false;
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (n.visible) nodes[id] = n;
    else {
      nodes[id] = { ...n, visible: true };
      changed = true;
    }
  }
  return changed ? { ...doc, nodes } : doc;
}

function fmt(v: number, precision: number): string {
  const s = (+v.toFixed(precision)).toString();
  return s === '-0' ? '0' : s;
}

/** Render one region to an SVG string. */
export function renderRegion(doc: Document, region: ExportRegion, opts: SvgExportOptions = {}): SvgExportResult {
  const precision = opts.precision ?? 3;
  const prefix = opts.prefix ?? '';
  const d = opts.includeHidden ? withHiddenVisible(doc) : doc;
  const { rect } = region;
  const bgColor = opts.backgroundColor !== undefined ? opts.backgroundColor : (opts.background ?? true) ? region.background : null;
  const roots = region.ids
    ? region.ids.map((id) => {
        const pw = parentWorldMatrix(d, id);
        const inner = React.createElement(StaticDocument, { doc: d, ids: [id], prefix, exportMode: true });
        // ancestors' opacity is applied so a selection export looks like the canvas
        const opacity = ancestors(d, id).reduce((o, a) => o * (d.nodes[a]?.opacity ?? 1), 1);
        return React.createElement('g', { key: id, transform: isIdentity(pw) ? undefined : toSvgTransform(pw), opacity: opacity !== 1 ? opacity : undefined }, inner);
      })
    : [React.createElement(StaticDocument, { key: 'doc', doc: d, prefix, exportMode: true })];
  const children: React.ReactNode[] = [];
  if (opts.css) children.push(React.createElement('style', { key: 'style', dangerouslySetInnerHTML: { __html: opts.css } }));
  const bgRect = region.bleedBox ?? rect;
  if (bgColor) children.push(React.createElement('rect', { key: 'bg', x: bgRect.x, y: bgRect.y, width: bgRect.width, height: bgRect.height, fill: bgColor }));
  if (region.bleedBox && region.marks && anyMarks(region.marks)) {
    // artwork must not run into the marks area: clip to the bleed box
    const clipId = `${prefix}bleed-clip`;
    children.push(
      React.createElement('defs', { key: 'bleeddefs' }, React.createElement('clipPath', { id: clipId }, React.createElement('rect', { x: region.bleedBox.x, y: region.bleedBox.y, width: region.bleedBox.width, height: region.bleedBox.height }))),
      React.createElement('g', { key: 'art', clipPath: `url(#${clipId})` }, ...roots),
      React.createElement('g', { key: 'marks', dangerouslySetInnerHTML: { __html: printerMarksSvg(region.trim!, region.bleed!, region.marks) } }),
    );
  } else children.push(...roots);
  const rootProps: Record<string, unknown> = {
    xmlns: SVG_NS,
    xmlnsXlink: XLINK_NS,
    viewBox: `${fmt(rect.x, precision)} ${fmt(rect.y, precision)} ${fmt(rect.width, precision)} ${fmt(rect.height, precision)}`,
  };
  if (!opts.responsive) {
    rootProps.width = fmt(rect.width, precision);
    rootProps.height = fmt(rect.height, precision);
  }
  let svg = renderToStaticMarkup(React.createElement('svg', rootProps, ...children));
  svg = roundNumbers(svg, precision);
  if (opts.pretty) svg = prettyPrintSvg(svg);
  if (opts.xmlDeclaration) svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg;
  return { svg, x: rect.x, y: rect.y, width: rect.width, height: rect.height, name: region.name, artboardId: region.artboardId };
}

/** Export for a scope; returns one result per region ('artboards' yields several). */
export function exportSvgAll(doc: Document, opts: SvgExportOptions = {}): SvgExportResult[] {
  return exportRegions(doc, opts).map((r, i) => renderRegion(doc, r, { ...opts, prefix: opts.prefix ?? (i ? `a${i}-` : '') }));
}

/** Export the first region for a scope (the active artboard, the selection, ...). */
export function exportSvg(doc: Document, opts: SvgExportOptions = {}): SvgExportResult {
  const list = exportSvgAll(doc, opts);
  if (!list.length) throw new Error(opts.scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
  return list[0];
}

// ---------------------------------------------------------------------------
// Text → outlines (for the "convert text to outlines" option)
// ---------------------------------------------------------------------------

/** Whether outlining text is available at all (opentype.js fonts). */
export const canOutlineText = typeof textToOutlinePaths === 'function';

/** Returns a copy of the document where text nodes are replaced by groups of glyph paths. */
export async function withTextOutlines(doc: Document, ids?: ID[]): Promise<{ doc: Document; failed: string[] }> {
  const failed: string[] = [];
  const texts = Object.values(doc.nodes).filter((n): n is TextNode => n.type === 'text' && n.text.trim().length > 0);
  if (!texts.length) return { doc, failed };
  const only = ids ? new Set(ids.flatMap((id) => [id, ...ancestorsAndDescendants(doc, id)])) : null;
  const nodes: Record<ID, Node> = { ...doc.nodes };
  for (const t of texts) {
    if (only && !only.has(t.id)) continue;
    try {
      const paths = await textToOutlinePaths(doc, t);
      if (!paths.length) continue;
      const group = makeGroup([], { id: t.id, name: t.name, transform: t.transform, opacity: t.opacity, blendMode: t.blendMode, effects: t.effects, visible: t.visible, locked: t.locked });
      group.parent = t.parent;
      for (const p of paths) {
        p.parent = group.id;
        nodes[p.id] = p;
        group.children.push(p.id);
      }
      nodes[t.id] = group;
      // hide the path a text-on-path was attached to? it stays as in the editor (already invisible paint)
    } catch (e: any) {
      failed.push(`${t.name}: ${e?.message ?? e}`);
    }
  }
  return { doc: { ...doc, nodes }, failed };
}

function ancestorsAndDescendants(doc: Document, id: ID): ID[] {
  const out: ID[] = [];
  const visit = (nid: ID) => {
    const n = doc.nodes[nid];
    if (!n) return;
    out.push(nid);
    if (n.type === 'group' || n.type === 'layer') for (const c of n.children) visit(c);
  };
  visit(id);
  return out;
}

// ---------------------------------------------------------------------------
// Post-processing: number precision & pretty printing
// ---------------------------------------------------------------------------

const NUMERIC_ATTRS = new Set([
  'd', 'transform', 'gradientTransform', 'patternTransform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'width', 'height', 'points',
  'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'font-size', 'letter-spacing', 'dx', 'dy', 'stdDeviation', 'offset', 'refX', 'refY', 'markerWidth', 'markerHeight',
  'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'flood-opacity',
]);

/** Round numbers inside geometric attributes (ids, hrefs and data URLs are untouched). */
export function roundNumbers(svg: string, precision: number): string {
  if (precision >= 10) return svg;
  const numRe = /-?(?:\d+\.\d*|\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi;
  return svg.replace(/ ([A-Za-z:-]+)="([^"]*)"/g, (all, name: string, value: string) => {
    if (!NUMERIC_ATTRS.has(name)) return all;
    if (value.includes('%') && name !== 'd') return all;
    const rounded = value.replace(numRe, (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return n;
      return fmt(v, precision);
    });
    return ` ${name}="${rounded}"`;
  });
}

const PRESERVE_TAGS = new Set(['text', 'tspan', 'textPath', 'style', 'script', 'title', 'desc']);

/** Indent the markup (text content of <text>/<style> elements is left untouched). */
export function prettyPrintSvg(svg: string, indent = '  '): string {
  const tokens = svg.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
  const out: string[] = [];
  let depth = 0;
  let preserve = 0;
  let pendingText = '';
  for (const tok of tokens) {
    if (tok[0] !== '<') {
      if (preserve) out.push(tok);
      else pendingText += tok;
      continue;
    }
    const isClose = tok.startsWith('</');
    const selfClose = tok.endsWith('/>') || tok.startsWith('<?') || tok.startsWith('<!');
    const name = tok.match(/^<\/?([A-Za-z][\w:-]*)/)?.[1] ?? '';
    if (preserve) {
      out.push(tok);
      if (isClose && PRESERVE_TAGS.has(name)) preserve--;
      else if (!isClose && !selfClose && PRESERVE_TAGS.has(name)) preserve++;
      continue;
    }
    if (pendingText.trim()) out.push(pendingText.trim());
    pendingText = '';
    if (isClose) depth = Math.max(0, depth - 1);
    if (out.length) out.push('\n' + indent.repeat(depth));
    out.push(tok);
    if (!isClose && !selfClose) {
      depth++;
      if (PRESERVE_TAGS.has(name)) preserve = 1;
    }
  }
  return out.join('');
}
