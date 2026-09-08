/**
 * SVG import: converts SVG markup into OPuller nodes.
 *
 * Supported: svg root (viewBox / width / height with units), nested svg, g, a,
 * path, rect, circle, ellipse, line, polyline, polygon, text/tspan, image, use,
 * symbol, defs with linear/radial gradients (objectBoundingBox and
 * userSpaceOnUse, gradientTransform, href inheritance), clipPath (→ clip
 * groups), presentation attributes, inline style, <style> sheets with simple
 * selectors, transforms, named / rgb() / hsl() colours.
 * Ignored gracefully: filters, markers, masks, patterns, foreignObject.
 */
import type { Document, Node, ID, Paint, StrokeStyle, SubPath, Matrix, Rect, TextStyle, GradientStop, BlendMode, GroupNode, TextRun, PathNode } from '@/model/types';
import { makePath, makeShape, makeGroup, makeText, makeImage, makeLayer } from '@/model/nodes';
import { parseSvgPathData, transformSubPaths, pathBounds, polylineSubPath } from '@/geometry/path';
import { parseSvgTransform, multiply, translate, scale, identity, isIdentity, applyToPoint, scaleFactor, applyToRect } from '@/geometry/matrix';
import { parseCssColor } from '@/util/color';
import { defaultStroke } from '@/model/defaults';
import { bakeTransform, localBounds } from '@/model/document';
import { LAYER_COLORS } from '@/model/defaults';

export interface SvgImportOptions {
  /** name used for the top-level group / document */
  name?: string;
}

export interface ImportedItem {
  root: Node;
  /** all nodes of the subtree (root included) */
  nodes: Node[];
}

export interface SvgImportResult {
  /** top-level items in paint order (bottom first); roots have parent = null */
  items: ImportedItem[];
  /** every node created */
  nodes: Node[];
  /** intrinsic size in px */
  width: number;
  height: number;
  viewBox: Rect | null;
  warnings: string[];
}

export class SvgImportError extends Error {}

// ---------------------------------------------------------------------------
// Units & numbers
// ---------------------------------------------------------------------------

const UNIT_PX: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 25.4 / 4 };

/** Parse an SVG/CSS length to px. `ref` resolves percentages; `em` uses fontSize. */
export function parseSvgLength(v: string | null | undefined, ref = 0, fontSize = 16): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|q|em|rem|ex|%)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? 'px';
  if (unit === '%') return (n / 100) * ref;
  if (unit === 'em') return n * fontSize;
  if (unit === 'rem') return n * 16;
  if (unit === 'ex') return n * fontSize * 0.5;
  return n * (UNIT_PX[unit] ?? 1);
}

function numAttr(el: Element, name: string, def = 0, ref = 0, fontSize = 16): number {
  const v = parseSvgLength(el.getAttribute(name), ref, fontSize);
  return v === null ? def : v;
}

function parseNumberList(s: string | null): number[] {
  if (!s) return [];
  return s
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

type Style = Record<string, string>;

const INHERITED = new Set([
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing', 'text-decoration', 'visibility', 'clip-rule', 'font',
]);
const PROPS = new Set([...INHERITED, 'opacity', 'display', 'clip-path', 'mix-blend-mode', 'stop-color', 'stop-opacity', 'mask', 'filter', 'marker-start', 'marker-end', 'marker-mid']);

const ROOT_STYLE: Style = {
  fill: '#000000',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  color: '#000000',
  'font-family': 'sans-serif',
  'font-size': '16',
  'font-weight': '400',
  'font-style': 'normal',
  'text-anchor': 'start',
  visibility: 'visible',
};

interface StyleRule {
  selector: CompoundSelector[];
  specificity: number;
  decls: Style;
  order: number;
}

interface CompoundSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
  /** combinator to the previous compound (' ' descendant, '>' child) */
  combinator: ' ' | '>' | null;
}

function parseDeclarations(text: string): Style {
  const out: Style = {};
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    if (!name || !value) continue;
    value = value.replace(/\s*!important\s*$/i, '');
    if (name === 'font') {
      Object.assign(out, parseFontShorthand(value));
      continue;
    }
    if (PROPS.has(name)) out[name] = value;
  }
  return out;
}

function parseFontShorthand(value: string): Style {
  // [style] [weight] size[/line-height] family
  const out: Style = {};
  const m = value.match(/^(.*?)(\d[\d.]*(?:px|pt|em|%|mm|cm|in)?)(?:\/[^\s]+)?\s+(.+)$/);
  if (!m) return out;
  const pre = m[1].trim().split(/\s+/).filter(Boolean);
  for (const p of pre) {
    if (p === 'italic' || p === 'oblique') out['font-style'] = 'italic';
    else if (p === 'bold' || /^\d{3}$/.test(p)) out['font-weight'] = p;
  }
  out['font-size'] = m[2];
  out['font-family'] = m[3];
  return out;
}

function parseCompound(s: string, combinator: ' ' | '>' | null): CompoundSelector | null {
  const m = s.match(/^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/);
  if (!m) return null;
  const sel: CompoundSelector = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, id: null, classes: [], combinator };
  const rest = m[2] ?? '';
  const re = /([.#])([\w-]+)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(rest))) {
    if (t[1] === '#') sel.id = t[2];
    else sel.classes.push(t[2]);
  }
  return sel;
}

function parseSelector(s: string): CompoundSelector[] | null {
  const tokens = s.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const out: CompoundSelector[] = [];
  let comb: ' ' | '>' | null = null;
  for (const tok of tokens) {
    if (tok === '>') {
      comb = '>';
      continue;
    }
    const c = parseCompound(tok, out.length ? (comb ?? ' ') : null);
    if (!c) return null; // unsupported selector (pseudo classes, attributes, ...)
    out.push(c);
    comb = null;
  }
  return out.length ? out : null;
}

function parseStyleSheet(css: string, rules: StyleRule[]): void {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const selectors = m[1].trim();
    if (!selectors || selectors.startsWith('@')) continue;
    const decls = parseDeclarations(m[2]);
    if (!Object.keys(decls).length) continue;
    for (const sel of selectors.split(',')) {
      const parsed = parseSelector(sel);
      if (!parsed) continue;
      const spec = parsed.reduce((acc, c) => acc + (c.id ? 100 : 0) + c.classes.length * 10 + (c.tag ? 1 : 0), 0);
      rules.push({ selector: parsed, specificity: spec, decls, order: rules.length });
    }
  }
}

function matchesCompound(el: Element, c: CompoundSelector): boolean {
  if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    for (const k of c.classes) if (!cls.includes(k)) return false;
  }
  return true;
}

function matchesSelector(el: Element, sel: CompoundSelector[]): boolean {
  let i = sel.length - 1;
  if (!matchesCompound(el, sel[i])) return false;
  let cur: Element | null = el;
  i--;
  while (i >= 0) {
    const comb = sel[i + 1].combinator;
    if (comb === '>') {
      cur = cur?.parentElement ?? null;
      if (!cur || !matchesCompound(cur, sel[i])) return false;
      i--;
    } else {
      cur = cur?.parentElement ?? null;
      while (cur && !matchesCompound(cur, sel[i])) cur = cur.parentElement;
      if (!cur) return false;
      i--;
    }
  }
  return true;
}

function computeStyle(el: Element, parent: Style, rules: StyleRule[]): Style {
  const out: Style = {};
  for (const k of Object.keys(parent)) if (INHERITED.has(k)) out[k] = parent[k];
  // presentation attributes (lowest priority)
  for (const p of PROPS) {
    const v = el.getAttribute(p);
    if (v !== null && v.trim()) out[p] = v.trim();
  }
  // style sheet rules by specificity, then order
  const matching = rules.filter((r) => matchesSelector(el, r.selector)).sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const r of matching) Object.assign(out, r.decls);
  // inline style
  const inline = el.getAttribute('style');
  if (inline) Object.assign(out, parseDeclarations(inline));
  // "inherit" keyword
  for (const k of Object.keys(out)) if (out[k] === 'inherit') out[k] = parent[k] ?? '';
  return out;
}

// ---------------------------------------------------------------------------
// Import context
// ---------------------------------------------------------------------------

interface Ctx {
  doc: Document;
  byId: Map<string, Element>;
  rules: StyleRule[];
  nodes: Node[];
  warnings: Set<string>;
  useDepth: number;
  viewport: { width: number; height: number };
}

function register(ctx: Ctx, n: Node): Node {
  ctx.doc.nodes[n.id] = n;
  ctx.nodes.push(n);
  return n;
}

function unregister(ctx: Ctx, n: Node): void {
  delete ctx.doc.nodes[n.id];
  const i = ctx.nodes.indexOf(n);
  if (i >= 0) ctx.nodes.splice(i, 1);
}

function warn(ctx: Ctx, msg: string): void {
  ctx.warnings.add(msg);
}

function hrefOf(el: Element): string | null {
  return el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? el.getAttribute('xlink:href');
}

function refId(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(/^url\(\s*["']?#([^"')]+)["']?\s*\)/) ?? value.trim().match(/^#(.+)$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

interface GradientDef {
  kind: 'linear' | 'radial';
  units: 'objectBoundingBox' | 'userSpaceOnUse';
  transform: Matrix;
  spread: 'pad' | 'reflect' | 'repeat';
  stops: GradientStop[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  r: number;
  fx: number | null;
  fy: number | null;
}

function gradientChain(el: Element, ctx: Ctx): Element[] {
  const chain: Element[] = [];
  let cur: Element | null = el;
  const seen = new Set<Element>();
  while (cur && !seen.has(cur) && chain.length < 16) {
    seen.add(cur);
    chain.push(cur);
    const id = refId(hrefOf(cur));
    cur = id ? (ctx.byId.get(id) ?? null) : null;
    if (cur && !/Gradient$/.test(cur.localName)) cur = null;
  }
  return chain;
}

function stopsOf(el: Element, ctx: Ctx, parentStyle: Style): GradientStop[] {
  const out: GradientStop[] = [];
  for (const s of Array.from(el.children)) {
    if (s.localName !== 'stop') continue;
    const st = computeStyle(s, parentStyle, ctx.rules);
    const offRaw = (s.getAttribute('offset') ?? '0').trim();
    let offset = offRaw.endsWith('%') ? parseFloat(offRaw) / 100 : parseFloat(offRaw);
    if (!Number.isFinite(offset)) offset = 0;
    offset = Math.max(0, Math.min(1, offset));
    const colorRaw = st['stop-color'] ?? '#000000';
    const parsed = colorRaw === 'currentColor' ? parseCssColor(st.color ?? '#000000') : parseCssColor(colorRaw);
    const so = parseFloat(st['stop-opacity'] ?? '1');
    const opacity = Math.max(0, Math.min(1, (Number.isFinite(so) ? so : 1) * (parsed?.alpha ?? 1)));
    out.push({ offset: out.length && offset < out[out.length - 1].offset ? out[out.length - 1].offset : offset, color: parsed?.hex ?? '#000000', opacity });
  }
  return out;
}

function resolveGradient(el: Element, ctx: Ctx, style: Style): GradientDef | null {
  const chain = gradientChain(el, ctx);
  const attr = (name: string): string | null => {
    for (const e of chain) {
      const v = e.getAttribute(name);
      if (v !== null) return v;
    }
    return null;
  };
  const kind: 'linear' | 'radial' = el.localName === 'radialGradient' ? 'radial' : 'linear';
  const units = attr('gradientUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox';
  const transform = parseSvgTransform(attr('gradientTransform'));
  const spreadRaw = attr('spreadMethod');
  const spread = spreadRaw === 'reflect' || spreadRaw === 'repeat' ? spreadRaw : 'pad';
  let stops: GradientStop[] = [];
  for (const e of chain) {
    stops = stopsOf(e, ctx, style);
    if (stops.length) break;
  }
  if (!stops.length) return null;
  if (stops.length === 1) stops.push({ ...stops[0], offset: 1 });
  const coord = (name: string, def: string, ref: number): number => {
    const raw = attr(name) ?? def;
    const s = raw.trim();
    if (units === 'objectBoundingBox') {
      if (s.endsWith('%')) return parseFloat(s) / 100;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    }
    return parseSvgLength(s, ref) ?? 0;
  };
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const diag = Math.hypot(vw, vh) / Math.SQRT2;
  const def: GradientDef = {
    kind,
    units,
    transform,
    spread,
    stops,
    x1: coord('x1', '0%', vw),
    y1: coord('y1', '0%', vh),
    x2: coord('x2', '100%', vw),
    y2: coord('y2', '0%', vh),
    cx: coord('cx', '50%', vw),
    cy: coord('cy', '50%', vh),
    r: coord('r', '50%', diag),
    fx: attr('fx') !== null ? coord('fx', '50%', vw) : null,
    fy: attr('fy') !== null ? coord('fy', '50%', vh) : null,
  };
  return def;
}

function gradientToPaint(def: GradientDef, bbox: Rect | null): Paint {
  const b = bbox && bbox.width > 0 && bbox.height > 0 ? bbox : { x: 0, y: 0, width: 1, height: 1 };
  const toBox = (p: { x: number; y: number }) => (def.units === 'userSpaceOnUse' ? { x: (p.x - b.x) / b.width, y: (p.y - b.y) / b.height } : p);
  const stops = def.stops.map((s) => ({ ...s }));
  if (def.kind === 'linear') {
    const p1 = toBox(applyToPoint(def.transform, { x: def.x1, y: def.y1 }));
    const p2 = toBox(applyToPoint(def.transform, { x: def.x2, y: def.y2 }));
    return { type: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stops, spread: def.spread };
  }
  const c = toBox(applyToPoint(def.transform, { x: def.cx, y: def.cy }));
  const f = def.fx !== null || def.fy !== null ? toBox(applyToPoint(def.transform, { x: def.fx ?? def.cx, y: def.fy ?? def.cy })) : null;
  const s = scaleFactor(def.transform);
  let r = def.r * s;
  if (def.units === 'userSpaceOnUse') r = r / Math.max(b.width, b.height);
  const paint: Paint = { type: 'radial', cx: c.x, cy: c.y, r: Math.max(1e-4, r), stops, spread: def.spread };
  if (f) {
    paint.fx = f.x;
    paint.fy = f.y;
  }
  return paint;
}

function paintFrom(value: string | undefined, opacityRaw: string | undefined, style: Style, ctx: Ctx, bbox: Rect | null, def: Paint): Paint {
  const v = (value ?? '').trim();
  const op = parseFloat(opacityRaw ?? '1');
  const opacity = Math.max(0, Math.min(1, Number.isFinite(op) ? op : 1));
  if (!v) return def;
  if (v === 'none' || v === 'transparent') return { type: 'none' };
  if (v.startsWith('url(')) {
    const id = refId(v);
    const target = id ? ctx.byId.get(id) : undefined;
    if (target && /Gradient$/.test(target.localName)) {
      const g = resolveGradient(target, ctx, style);
      if (g) {
        const p = gradientToPaint(g, bbox);
        if (opacity !== 1 && (p.type === 'linear' || p.type === 'radial')) p.stops = p.stops.map((s) => ({ ...s, opacity: s.opacity * opacity }));
        return p;
      }
    }
    // fallback colour after the url(), e.g. "url(#p) red"
    const rest = v.replace(/^url\([^)]*\)\s*/, '').trim();
    if (rest && rest !== 'none') {
      const c = parseCssColor(rest);
      if (c) return { type: 'solid', color: c.hex, opacity: opacity * c.alpha };
    }
    if (target) warn(ctx, `Unsupported paint server <${target.localName}> replaced by a solid colour.`);
    return { type: 'solid', color: '#808080', opacity };
  }
  const colorValue = v === 'currentcolor' || v === 'currentColor' ? (style.color ?? '#000000') : v;
  const c = parseCssColor(colorValue);
  if (!c) return def;
  return { type: 'solid', color: c.hex, opacity: opacity * c.alpha };
}

function strokeFrom(style: Style, ctx: Ctx, bbox: Rect | null, fontSize: number, strokeScale = 1): StrokeStyle {
  const paint = paintFrom(style.stroke, style['stroke-opacity'], style, ctx, bbox, { type: 'none' });
  const width = (parseSvgLength(style['stroke-width'], Math.hypot(ctx.viewport.width, ctx.viewport.height) / Math.SQRT2, fontSize) ?? 1) * strokeScale;
  const capRaw = style['stroke-linecap'];
  const joinRaw = style['stroke-linejoin'];
  const dashRaw = (style['stroke-dasharray'] ?? '').trim();
  let dash: number[] = [];
  if (dashRaw && dashRaw !== 'none') {
    dash = dashRaw
      .split(/[\s,]+/)
      .map((d) => parseSvgLength(d, 0, fontSize))
      .filter((d): d is number => d !== null && d >= 0)
      .map((d) => d * strokeScale);
    if (dash.length % 2 === 1) dash = dash.concat(dash);
    if (dash.every((d) => d === 0)) dash = [];
  }
  const ml = parseFloat(style['stroke-miterlimit'] ?? '4');
  return defaultStroke({
    paint,
    width: Math.max(0, width),
    cap: capRaw === 'round' || capRaw === 'square' ? capRaw : 'butt',
    join: joinRaw === 'round' || joinRaw === 'bevel' ? joinRaw : 'miter',
    miterLimit: Number.isFinite(ml) ? Math.max(1, ml) : 4,
    dash,
    dashOffset: (parseSvgLength(style['stroke-dashoffset'], 0, fontSize) ?? 0) * strokeScale,
  });
}

const BLEND_MODES = new Set<string>(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

function applyCommon(node: Node, el: Element, style: Style): void {
  const id = el.getAttribute('id');
  if (id) node.name = id.replace(/_x([0-9A-Fa-f]{2})_/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/_/g, ' ').trim() || node.name;
  const op = parseFloat(style.opacity ?? '1');
  if (Number.isFinite(op)) node.opacity = Math.max(0, Math.min(1, op));
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') node.visible = false;
  const blend = style['mix-blend-mode'];
  if (blend && BLEND_MODES.has(blend)) node.blendMode = blend as BlendMode;
}

function fontSizeOf(style: Style): number {
  const raw = (style['font-size'] ?? '16').trim().toLowerCase();
  const keywords: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
  if (keywords[raw]) return keywords[raw];
  return parseSvgLength(raw, 16, 16) ?? 16;
}

// ---------------------------------------------------------------------------
// Transforms & baking
// ---------------------------------------------------------------------------

/** Pre-multiply a node's transform by `m` (parent-space transform); paths get baked. */
function premultiply(ctx: Ctx, node: Node, m: Matrix): void {
  if (isIdentity(m)) return;
  node.transform = multiply(m, node.transform);
  if (node.type === 'path') bakePath(ctx, node);
}

/** Bake a path node's transform (keeping live shapes when lossless) and scale its stroke accordingly. */
function bakePath(ctx: Ctx, node: PathNode): void {
  const m = node.transform;
  if (isIdentity(m)) return;
  const s = scaleFactor(m);
  bakeTransform(ctx.doc, node.id);
  const remaining = scaleFactor(node.transform);
  const applied = s / (remaining || 1);
  if (Math.abs(applied - 1) > 1e-9 && Number.isFinite(applied)) {
    node.stroke = { ...node.stroke, width: node.stroke.width * applied, dash: node.stroke.dash.map((d) => d * applied), dashOffset: node.stroke.dashOffset * applied };
  }
}

// ---------------------------------------------------------------------------
// Element conversion
// ---------------------------------------------------------------------------

const SKIP = new Set(['title', 'desc', 'metadata', 'style', 'script', 'defs', 'symbol', 'clipPath', 'mask', 'marker', 'pattern', 'filter', 'linearGradient', 'radialGradient', 'font', 'font-face', 'cursor', 'view', 'stop', 'glyph', 'missing-glyph', 'hkern', 'vkern', 'color-profile', 'animate', 'animateTransform', 'animateMotion', 'set', 'mpath', 'feGaussianBlur']);

function convertChildren(parent: Element, ctx: Ctx, style: Style, into: GroupNode | null): Node[] {
  const roots: Node[] = [];
  for (const child of Array.from(parent.children)) {
    const nodes = convertElement(child, ctx, style);
    for (const n of nodes) {
      if (into) {
        n.parent = into.id;
        into.children.push(n.id);
      } else n.parent = null;
      roots.push(n);
    }
  }
  return roots;
}

function convertElement(el: Element, ctx: Ctx, parentStyle: Style): Node[] {
  const tag = el.localName;
  if (SKIP.has(tag)) return [];
  const style = computeStyle(el, parentStyle, ctx.rules);
  const clipId = refId(style['clip-path']);
  const clipEl = clipId ? ctx.byId.get(clipId) : undefined;
  const hasClip = !!clipEl && clipEl.localName === 'clipPath';
  const T = parseSvgTransform(el.getAttribute('transform'));
  if (style.mask) warn(ctx, 'Masks are not supported and were ignored.');
  if (style.filter && style.filter !== 'none') warn(ctx, 'SVG filters are not supported and were ignored.');
  if (style['marker-start'] || style['marker-end'] || style['marker-mid']) warn(ctx, 'Markers are not supported and were ignored.');

  let produced: Node[];
  switch (tag) {
    case 'g':
    case 'a':
    case 'switch':
      produced = [convertGroup(el, ctx, style, tag === 'switch')];
      break;
    case 'svg':
      produced = [convertNestedSvg(el, ctx, style)];
      break;
    case 'path':
      produced = arr(convertPath(el, ctx, style));
      break;
    case 'rect':
      produced = arr(convertRect(el, ctx, style));
      break;
    case 'circle':
    case 'ellipse':
      produced = arr(convertEllipse(el, ctx, style));
      break;
    case 'line':
      produced = arr(convertLine(el, ctx, style));
      break;
    case 'polyline':
    case 'polygon':
      produced = arr(convertPoly(el, ctx, style, tag === 'polygon'));
      break;
    case 'text':
      produced = arr(convertText(el, ctx, style));
      break;
    case 'image':
      produced = arr(convertImage(el, ctx, style));
      break;
    case 'use':
      produced = arr(convertUse(el, ctx, style));
      break;
    case 'foreignObject':
      warn(ctx, '<foreignObject> is not supported and was ignored.');
      produced = [];
      break;
    default:
      produced = [];
  }
  if (!produced.length) return [];
  for (const n of produced) applyCommon(n, el, style);
  if (hasClip && clipEl) {
    const plainGroup = produced.length === 1 && produced[0].type === 'group' && (tag === 'g' || tag === 'a' || tag === 'switch') ? (produced[0] as GroupNode) : null;
    const wrapped = wrapClip(produced, clipEl, ctx, style, T, plainGroup);
    if (wrapped) {
      if (wrapped !== produced[0]) {
        wrapped.name = produced[0].name;
        wrapped.opacity = produced.length === 1 ? produced[0].opacity : 1;
        if (produced.length === 1) {
          produced[0].opacity = 1;
          wrapped.visible = produced[0].visible;
          produced[0].visible = true;
          wrapped.blendMode = produced[0].blendMode;
          produced[0].blendMode = 'normal';
        }
      }
      return [wrapped];
    }
  }
  for (const n of produced) premultiply(ctx, n, T);
  return produced;
}

function arr(n: Node | null): Node[] {
  return n ? [n] : [];
}

function convertGroup(el: Element, ctx: Ctx, style: Style, firstOnly = false): GroupNode {
  const g = register(ctx, makeGroup([], { name: 'Group' })) as GroupNode;
  if (firstOnly) {
    for (const child of Array.from(el.children)) {
      const nodes = convertElement(child, ctx, style);
      if (nodes.length) {
        for (const n of nodes) {
          n.parent = g.id;
          g.children.push(n.id);
        }
        break;
      }
    }
  } else convertChildren(el, ctx, style, g);
  return g;
}

/** Root/nested <svg>: viewBox → scale, x/y → translate. Returns the matrix mapping viewBox space to the parent. */
function viewportMatrix(el: Element, ctx: Ctx, defaults?: { width: number; height: number }): { m: Matrix; width: number; height: number; viewBox: Rect | null } {
  const vbRaw = parseNumberList(el.getAttribute('viewBox'));
  const viewBox: Rect | null = vbRaw.length === 4 && vbRaw[2] > 0 && vbRaw[3] > 0 ? { x: vbRaw[0], y: vbRaw[1], width: vbRaw[2], height: vbRaw[3] } : null;
  const wAttr = el.getAttribute('width');
  const hAttr = el.getAttribute('height');
  const pw = defaults?.width ?? ctx.viewport.width;
  const ph = defaults?.height ?? ctx.viewport.height;
  let width = parseSvgLength(wAttr, pw);
  let height = parseSvgLength(hAttr, ph);
  if (wAttr && wAttr.trim().endsWith('%') && viewBox) width = viewBox.width;
  if (hAttr && hAttr.trim().endsWith('%') && viewBox) height = viewBox.height;
  if (width === null || width <= 0) width = viewBox ? (height && viewBox.height ? (height * viewBox.width) / viewBox.height : viewBox.width) : (defaults?.width ?? 300);
  if (height === null || height <= 0) height = viewBox ? (viewBox.width ? (width * viewBox.height) / viewBox.width : viewBox.height) : (defaults?.height ?? 150);
  let m = identity();
  if (viewBox) {
    const par = (el.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').trim().split(/\s+/);
    const align = par[0] ?? 'xMidYMid';
    const meetOrSlice = par[1] ?? 'meet';
    let sx = width / viewBox.width;
    let sy = height / viewBox.height;
    let tx = 0;
    let ty = 0;
    if (align !== 'none') {
      const s = meetOrSlice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
      sx = s;
      sy = s;
      const ex = width - viewBox.width * s;
      const ey = height - viewBox.height * s;
      tx = /xMid/i.test(align) ? ex / 2 : /xMax/i.test(align) ? ex : 0;
      ty = /YMid/.test(align) ? ey / 2 : /YMax/.test(align) ? ey : 0;
    }
    m = multiply(multiply(translate(tx, ty), scale(sx, sy)), translate(-viewBox.x, -viewBox.y));
  }
  return { m, width, height, viewBox };
}

function convertNestedSvg(el: Element, ctx: Ctx, style: Style): GroupNode {
  const g = register(ctx, makeGroup([], { name: 'SVG' })) as GroupNode;
  const x = numAttr(el, 'x', 0, ctx.viewport.width);
  const y = numAttr(el, 'y', 0, ctx.viewport.height);
  const vp = viewportMatrix(el, ctx);
  const saved = ctx.viewport;
  if (vp.viewBox) ctx.viewport = { width: vp.viewBox.width, height: vp.viewBox.height };
  else ctx.viewport = { width: vp.width, height: vp.height };
  convertChildren(el, ctx, style, g);
  ctx.viewport = saved;
  g.transform = multiply(translate(x, y), vp.m);
  return g;
}

function rawBoundsOf(node: Node): Rect | null {
  if (node.type === 'path') return pathBounds(node.subpaths);
  return null;
}

function finishShape(node: PathNode, el: Element, ctx: Ctx, style: Style, rawBounds: Rect | null): PathNode {
  const fs = fontSizeOf(style);
  node.fill = paintFrom(style.fill, style['fill-opacity'], style, ctx, rawBounds, { type: 'solid', color: '#000000', opacity: 1 });
  node.stroke = strokeFrom(style, ctx, rawBounds, fs);
  node.fillRule = style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
  void el;
  return register(ctx, node) as PathNode;
}

function convertPath(el: Element, ctx: Ctx, style: Style): Node | null {
  const d = el.getAttribute('d');
  if (!d || !d.trim()) return null;
  let subpaths: SubPath[];
  try {
    subpaths = parseSvgPathData(d);
  } catch {
    warn(ctx, 'A path with invalid data was skipped.');
    return null;
  }
  if (!subpaths.length || !subpaths.some((sp) => sp.anchors.length)) return null;
  const node = makePath(subpaths, { name: 'Path' });
  return finishShape(node, el, ctx, style, pathBounds(subpaths));
}

function convertRect(el: Element, ctx: Ctx, style: Style): Node | null {
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const x = numAttr(el, 'x', 0, vw);
  const y = numAttr(el, 'y', 0, vh);
  const w = numAttr(el, 'width', 0, vw);
  const h = numAttr(el, 'height', 0, vh);
  if (w <= 0 || h <= 0) return null;
  let rx = parseSvgLength(el.getAttribute('rx'), vw);
  let ry = parseSvgLength(el.getAttribute('ry'), vh);
  if (rx === null && ry === null) {
    rx = 0;
    ry = 0;
  } else if (rx === null) rx = ry!;
  else if (ry === null) ry = rx;
  rx = Math.max(0, Math.min(rx!, w / 2));
  ry = Math.max(0, Math.min(ry!, h / 2));
  const r = Math.min(rx, ry);
  const node = makeShape({ kind: 'rect', width: w, height: h, radii: [r, r, r, r] }, { name: 'Rectangle', transform: translate(x, y) });
  if (Math.abs(rx - ry) > 1e-6) {
    // elliptical corners are not a live shape parameter: bake the geometry
    node.subpaths = [ellipticalRect(w, h, rx, ry)];
    node.shape = undefined;
  }
  return finishShape(node, el, ctx, style, { x, y, width: w, height: h });
}

function ellipticalRect(w: number, h: number, rx: number, ry: number): SubPath {
  const k = 0.5522847498;
  const pts = [
    { p: { x: rx, y: 0 }, hi: null, ho: null },
    { p: { x: w - rx, y: 0 }, hi: null, ho: { x: rx * k, y: 0 } },
    { p: { x: w, y: ry }, hi: { x: 0, y: -ry * k }, ho: null },
    { p: { x: w, y: h - ry }, hi: null, ho: { x: 0, y: ry * k } },
    { p: { x: w - rx, y: h }, hi: { x: rx * k, y: 0 }, ho: null },
    { p: { x: rx, y: h }, hi: null, ho: { x: -rx * k, y: 0 } },
    { p: { x: 0, y: h - ry }, hi: { x: 0, y: ry * k }, ho: null },
    { p: { x: 0, y: ry }, hi: null, ho: { x: 0, y: -ry * k } },
  ];
  // the last corner closes back to the first point
  const anchors = pts.map((a) => ({ point: a.p, handleIn: a.hi, handleOut: a.ho, kind: 'corner' as const }));
  anchors[0].handleIn = { x: -rx * k, y: 0 };
  return { anchors, closed: true };
}

function convertEllipse(el: Element, ctx: Ctx, style: Style): Node | null {
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const cx = numAttr(el, 'cx', 0, vw);
  const cy = numAttr(el, 'cy', 0, vh);
  let rx: number;
  let ry: number;
  if (el.localName === 'circle') {
    rx = ry = numAttr(el, 'r', 0, Math.hypot(vw, vh) / Math.SQRT2);
  } else {
    rx = numAttr(el, 'rx', 0, vw);
    ry = numAttr(el, 'ry', 0, vh);
    if (el.getAttribute('rx') === 'auto' || !el.hasAttribute('rx')) rx = ry;
    if (el.getAttribute('ry') === 'auto' || !el.hasAttribute('ry')) ry = rx;
  }
  if (rx <= 0 || ry <= 0) return null;
  const node = makeShape({ kind: 'ellipse', rx, ry }, { name: el.localName === 'circle' ? 'Circle' : 'Ellipse', transform: translate(cx, cy) });
  return finishShape(node, el, ctx, style, { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 });
}

function convertLine(el: Element, ctx: Ctx, style: Style): Node | null {
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const x1 = numAttr(el, 'x1', 0, vw);
  const y1 = numAttr(el, 'y1', 0, vh);
  const x2 = numAttr(el, 'x2', 0, vw);
  const y2 = numAttr(el, 'y2', 0, vh);
  const node = makeShape({ kind: 'line', x1: 0, y1: 0, x2: x2 - x1, y2: y2 - y1 }, { name: 'Line', transform: translate(x1, y1) });
  const out = finishShape(node, el, ctx, style, { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
  out.fill = { type: 'none' };
  return out;
}

function convertPoly(el: Element, ctx: Ctx, style: Style, closed: boolean): Node | null {
  const nums = parseNumberList(el.getAttribute('points'));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  if (pts.length < 2) return null;
  const sp = polylineSubPath(pts, closed);
  const node = makePath([sp], { name: closed ? 'Polygon' : 'Polyline' });
  return finishShape(node, el, ctx, style, pathBounds([sp]));
}

function convertImage(el: Element, ctx: Ctx, style: Style): Node | null {
  const href = hrefOf(el);
  if (!href) return null;
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const x = numAttr(el, 'x', 0, vw);
  const y = numAttr(el, 'y', 0, vh);
  let w = numAttr(el, 'width', 0, vw);
  let h = numAttr(el, 'height', 0, vh);
  if (w <= 0 && h <= 0) {
    w = 100;
    h = 100;
  } else if (w <= 0) w = h;
  else if (h <= 0) h = w;
  const node = makeImage(href.trim(), Math.round(w), Math.round(h), { width: w, height: h, name: 'Image', transform: translate(x, y) });
  void style;
  return register(ctx, node);
}

function convertUse(el: Element, ctx: Ctx, style: Style): Node | null {
  const id = refId(hrefOf(el));
  const target = id ? ctx.byId.get(id) : undefined;
  if (!target) {
    if (id) warn(ctx, `<use> references a missing element "#${id}".`);
    return null;
  }
  if (ctx.useDepth > 12) {
    warn(ctx, 'Recursive <use> references were ignored.');
    return null;
  }
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const x = numAttr(el, 'x', 0, vw);
  const y = numAttr(el, 'y', 0, vh);
  ctx.useDepth++;
  let inner: Node[] = [];
  let m = translate(x, y);
  try {
    if (target.localName === 'symbol' || target.localName === 'svg') {
      const wAttr = el.getAttribute('width') ?? target.getAttribute('width');
      const hAttr = el.getAttribute('height') ?? target.getAttribute('height');
      const clone = target.cloneNode(true) as Element;
      if (wAttr) clone.setAttribute('width', wAttr);
      if (hAttr) clone.setAttribute('height', hAttr);
      if (!clone.getAttribute('viewBox') && !wAttr && !hAttr) {
        // no sizing: symbol content is used as-is
      }
      const vp = viewportMatrix(clone, ctx, { width: vw, height: vh });
      const g = register(ctx, makeGroup([], { name: 'Symbol' })) as GroupNode;
      const saved = ctx.viewport;
      if (vp.viewBox) ctx.viewport = { width: vp.viewBox.width, height: vp.viewBox.height };
      convertChildren(clone, ctx, style, g);
      ctx.viewport = saved;
      g.transform = vp.m;
      if (target.localName === 'svg') m = multiply(m, translate(numAttr(clone, 'x', 0, vw), numAttr(clone, 'y', 0, vh)));
      inner = [g];
    } else {
      inner = convertElement(target, ctx, style);
    }
  } finally {
    ctx.useDepth--;
  }
  if (!inner.length) return null;
  const g = register(ctx, makeGroup([], { name: 'Use' })) as GroupNode;
  for (const n of inner) {
    n.parent = g.id;
    g.children.push(n.id);
  }
  g.transform = m;
  return g;
}

/**
 * Make converted nodes clipped: the clip content lives in the inner space of
 * the element's transform T. A plain group receives the clip directly (`into`),
 * other content is wrapped into a new group carrying T.
 */
function wrapClip(content: Node[], clipEl: Element, ctx: Ctx, style: Style, T: Matrix, into: GroupNode | null): GroupNode | null {
  const clipStyle: Style = { ...ROOT_STYLE, color: style.color ?? '#000000' };
  const clipNodes = convertChildren(clipEl, ctx, clipStyle, null);
  if (!clipNodes.length) return null;
  let clipNode: Node;
  if (clipNodes.length === 1) clipNode = clipNodes[0];
  else {
    const cg = register(ctx, makeGroup([], { name: 'Clip' })) as GroupNode;
    for (const n of clipNodes) {
      n.parent = cg.id;
      cg.children.push(n.id);
    }
    clipNode = cg;
  }
  clipNode.name = 'Clipping Path';
  clipNode.visible = true;
  let cm = parseSvgTransform(clipEl.getAttribute('transform'));
  if (clipEl.getAttribute('clipPathUnits') === 'objectBoundingBox') {
    let bb: Rect | null = null;
    for (const n of content) {
      let b: Rect | null = null;
      try {
        b = localBounds(ctx.doc, n.id);
      } catch {
        b = rawBoundsOf(n);
      }
      if (b) b = applyToRect(n.transform, b);
      if (b) bb = bb ? union(bb, b) : b;
    }
    if (bb) cm = multiply(multiply(translate(bb.x, bb.y), scale(bb.width || 1, bb.height || 1)), cm);
  }
  premultiply(ctx, clipNode, cm);
  if (into) {
    into.transform = multiply(T, into.transform);
    clipNode.parent = into.id;
    into.children.unshift(clipNode.id);
    into.clipId = clipNode.id;
    return into;
  }
  const g = register(ctx, makeGroup([], { name: content[0]?.name ?? 'Clip Group', transform: T })) as GroupNode;
  clipNode.parent = g.id;
  g.children.push(clipNode.id);
  for (const n of content) {
    n.parent = g.id;
    g.children.push(n.id);
  }
  g.clipId = clipNode.id;
  return g;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

interface Chunk {
  text: string;
  style: Style;
  x: number | null;
  y: number | null;
  dx: number;
  dy: number;
}

const GENERIC_FAMILIES: Record<string, string> = { 'sans-serif': 'Inter', serif: 'Lora', monospace: 'Source Code Pro', cursive: 'Pacifico', fantasy: 'Bebas Neue', 'system-ui': 'Inter', 'ui-sans-serif': 'Inter', 'ui-serif': 'Lora', 'ui-monospace': 'Source Code Pro' };

function familyOf(style: Style): string {
  const raw = (style['font-family'] ?? 'sans-serif').split(',')[0].trim().replace(/^["']|["']$/g, '');
  return GENERIC_FAMILIES[raw.toLowerCase()] ?? raw ?? 'Inter';
}

function weightOf(style: Style, parentWeight = 400): number {
  const raw = (style['font-weight'] ?? '400').trim().toLowerCase();
  if (raw === 'bold') return 700;
  if (raw === 'normal') return 400;
  if (raw === 'bolder') return Math.min(900, parentWeight + 300);
  if (raw === 'lighter') return Math.max(100, parentWeight - 300);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(100, Math.min(900, Math.round(n / 100) * 100)) : 400;
}

function textStyleOf(style: Style): TextStyle {
  const fs = fontSizeOf(style);
  const anchor = style['text-anchor'];
  const dec = (style['text-decoration'] ?? '').toLowerCase();
  const ls = style['letter-spacing'];
  return {
    fontFamily: familyOf(style),
    fontSize: fs,
    fontWeight: weightOf(style),
    fontStyle: /italic|oblique/i.test(style['font-style'] ?? '') ? 'italic' : 'normal',
    lineHeight: 1.2,
    letterSpacing: ls && ls !== 'normal' ? (parseSvgLength(ls, 0, fs) ?? 0) : 0,
    textAlign: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
    textDecoration: dec.includes('line-through') ? 'line-through' : dec.includes('underline') ? 'underline' : 'none',
    textTransform: 'none',
    baselineShift: 0,
    paragraphSpacing: 0,
  };
}

function collectChunks(el: Element, ctx: Ctx, style: Style, out: Chunk[], preserve: boolean, first: { x: number | null; y: number | null; dx: number; dy: number }): void {
  let pending = first;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 /* TEXT */) {
      const raw = child.textContent ?? '';
      const text = preserve ? raw.replace(/[\r\n\t]+/g, ' ') : raw.replace(/\s+/g, ' ');
      if (!text) continue;
      out.push({ text, style, x: pending.x, y: pending.y, dx: pending.dx, dy: pending.dy });
      pending = { x: null, y: null, dx: 0, dy: 0 };
    } else if (child.nodeType === 1) {
      const c = child as Element;
      if (c.localName !== 'tspan' && c.localName !== 'a' && c.localName !== 'textPath') continue;
      const cs = computeStyle(c, style, ctx.rules);
      const fs = fontSizeOf(cs);
      const xs = parseNumberList(c.getAttribute('x'));
      const ys = parseNumberList(c.getAttribute('y'));
      const cx = xs.length ? xs[0] : pending.x;
      const cy = ys.length ? ys[0] : pending.y;
      const dxs = c.getAttribute('dx');
      const dys = c.getAttribute('dy');
      const cdx = pending.dx + (dxs ? (parseSvgLength(dxs.split(/[\s,]+/)[0], 0, fs) ?? 0) : 0);
      const cdy = pending.dy + (dys ? (parseSvgLength(dys.split(/[\s,]+/)[0], 0, fs) ?? 0) : 0);
      const pres = c.getAttribute('xml:space') === 'preserve' || (c.getAttribute('xml:space') !== 'default' && preserve);
      collectChunks(c, ctx, cs, out, pres, { x: cx, y: cy, dx: cdx, dy: cdy });
      pending = { x: null, y: null, dx: 0, dy: 0 };
    }
  }
}

function convertText(el: Element, ctx: Ctx, style: Style): Node | null {
  const fs = fontSizeOf(style);
  const xs = parseNumberList(el.getAttribute('x'));
  const ys = parseNumberList(el.getAttribute('y'));
  const preserve = el.getAttribute('xml:space') === 'preserve';
  const chunks: Chunk[] = [];
  const dx = el.getAttribute('dx') ? (parseSvgLength(el.getAttribute('dx')!.split(/[\s,]+/)[0], 0, fs) ?? 0) : 0;
  const dy = el.getAttribute('dy') ? (parseSvgLength(el.getAttribute('dy')!.split(/[\s,]+/)[0], 0, fs) ?? 0) : 0;
  collectChunks(el, ctx, style, chunks, preserve, { x: xs.length ? xs[0] : 0, y: ys.length ? ys[0] : 0, dx, dy });
  if (!chunks.length) return null;
  // group chunks into lines: a chunk with an absolute y (different from the current line) starts a new line
  interface Line {
    x: number;
    y: number;
    chunks: Chunk[];
  }
  const lines: Line[] = [];
  let curX = 0;
  let curY = 0;
  let accDy = 0;
  for (const c of chunks) {
    const absY = c.y !== null ? c.y + c.dy : null;
    const startsLine = !lines.length || (c.y !== null && Math.abs(absY! - (curY + accDy)) > 0.01) || (c.dy !== 0 && lines.length > 0 && c.x !== null);
    if (startsLine) {
      curX = c.x !== null ? c.x + c.dx : curX;
      curY = c.y !== null ? c.y : curY + (lines.length ? c.dy : 0);
      if (c.y === null && lines.length) accDy = 0;
      else accDy = c.y !== null ? c.dy : 0;
      lines.push({ x: curX, y: curY + accDy, chunks: [c] });
    } else lines[lines.length - 1].chunks.push(c);
  }
  const base = textStyleOf(style);
  const lineTexts: string[] = [];
  const runs: TextRun[] = [];
  lines.forEach((line, li) => {
    let text = line.chunks.map((c) => c.text).join('');
    if (!preserve) text = text.replace(/^\s+|\s+$/g, '');
    // build runs (per chunk style overrides)
    let consumed = 0;
    for (const c of line.chunks) {
      let t = c.text;
      if (!preserve) {
        if (consumed === 0) t = t.replace(/^\s+/, '');
        if (c === line.chunks[line.chunks.length - 1]) t = t.replace(/\s+$/, '');
      }
      if (!t) continue;
      consumed += t.length;
      const st = textStyleOf(c.style);
      const override: Partial<TextStyle> = {};
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textDecoration'] as const) if (st[k] !== base[k]) (override as any)[k] = st[k];
      runs.push(Object.keys(override).length ? { text: t, style: override } : { text: t });
    }
    if (consumed !== text.length) {
      // whitespace normalisation mismatch: fall back to a plain run for this line
      runs.splice(runs.length - line.chunks.length, line.chunks.length);
      runs.push({ text });
    }
    if (li < lines.length - 1) runs.push({ text: '\n' });
    lineTexts.push(text);
  });
  const fullText = lineTexts.join('\n');
  if (!fullText.trim()) return null;
  if (lines.length > 1) {
    const dys = lines.slice(1).map((l, i) => l.y - lines[i].y).filter((d) => d > 0);
    if (dys.length) base.lineHeight = Math.max(0.5, Math.min(4, dys.reduce((a, b) => a + b, 0) / dys.length / base.fontSize));
  }
  const node = makeText(fullText, { style: base, transform: translate(lines[0].x, lines[0].y), name: fullText.split('\n')[0].slice(0, 24) });
  // merge adjacent runs with equal style
  const merged: TextRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && JSON.stringify(last.style ?? null) === JSON.stringify(r.style ?? null)) last.text += r.text;
    else merged.push({ ...r });
  }
  node.runs = merged.map((r) => r.text).join('') === fullText ? merged : [{ text: fullText }];
  const approxBounds: Rect = { x: 0, y: -base.fontSize, width: Math.max(1, fullText.length * base.fontSize * 0.6), height: base.fontSize * 1.2 * lines.length };
  node.fill = paintFrom(style.fill, style['fill-opacity'], style, ctx, approxBounds, { type: 'solid', color: '#000000', opacity: 1 });
  node.stroke = strokeFrom(style, ctx, approxBounds, fs);
  return register(ctx, node);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseSvgDocument(svgText: string): SVGSVGElement {
  const text = svgText.replace(/^﻿/, '');
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = parsed.getElementsByTagName('parsererror')[0];
  const root = parsed.documentElement;
  if (err || !root || root.localName !== 'svg') {
    // HTML documents with an inline <svg>
    const html = new DOMParser().parseFromString(text, 'text/html');
    const inline = html.querySelector('svg');
    if (inline) return inline as unknown as SVGSVGElement;
    throw new SvgImportError(err ? `Invalid SVG: ${(err.textContent ?? '').split('\n')[0].slice(0, 120)}` : 'Not an SVG document.');
  }
  return root as unknown as SVGSVGElement;
}

/** Quick check whether a text looks like SVG markup. */
export function looksLikeSvg(text: string): boolean {
  const t = text.trimStart().slice(0, 2000);
  return /<svg[\s>]/i.test(t);
}

export function importSvg(svgText: string, opts: SvgImportOptions = {}): SvgImportResult {
  const root = parseSvgDocument(svgText);
  const scratch: Document = { id: 'import', name: opts.name ?? 'Import', units: 'px', artboards: [], layers: [], nodes: {}, guides: [], swatches: [], patterns: [], grid: { size: 50, subdivisions: 5, color: '#888888', style: 'lines' }, colorMode: 'rgb', bleed: { top: 0, right: 0, bottom: 0, left: 0 }, meta: { created: '', modified: '', generator: 'OPuller', version: 1 } };
  const ctx: Ctx = { doc: scratch, byId: new Map(), rules: [], nodes: [], warnings: new Set(), useDepth: 0, viewport: { width: 300, height: 150 } };
  // index ids and style sheets (whole document, including defs)
  const all = root.getElementsByTagName('*');
  for (const e of Array.from(all)) {
    const id = e.getAttribute('id');
    if (id && !ctx.byId.has(id)) ctx.byId.set(id, e);
    if (e.localName === 'style') parseStyleSheet(e.textContent ?? '', ctx.rules);
  }
  const vp = viewportMatrix(root, ctx, { width: 300, height: 150 });
  ctx.viewport = vp.viewBox ? { width: vp.viewBox.width, height: vp.viewBox.height } : { width: vp.width, height: vp.height };
  const rootStyle = computeStyle(root, ROOT_STYLE, ctx.rules);
  for (const k of Object.keys(ROOT_STYLE)) if (rootStyle[k] === undefined) rootStyle[k] = ROOT_STYLE[k];
  const roots = convertChildren(root, ctx, rootStyle, null);
  for (const r of roots) {
    premultiply(ctx, r, vp.m);
    r.parent = null;
  }
  const items: ImportedItem[] = roots.map((r) => ({ root: r, nodes: subtreeNodes(ctx.doc, r) }));
  return { items, nodes: ctx.nodes, width: vp.width, height: vp.height, viewBox: vp.viewBox, warnings: Array.from(ctx.warnings) };
}

function subtreeNodes(doc: Document, root: Node): Node[] {
  const out: Node[] = [];
  const visit = (n: Node) => {
    out.push(n);
    if (n.type === 'group' || n.type === 'layer') for (const c of n.children) if (doc.nodes[c]) visit(doc.nodes[c]);
  };
  visit(root);
  return out;
}

/**
 * Turn import items into layers for a new document: top-level groups become
 * layers (Illustrator exports layers as top-level <g>), other nodes go into
 * one layer.
 */
export function itemsToLayers(items: ImportedItem[]): ImportedItem[] {
  const allGroups = items.length > 0 && items.every((it) => it.root.type === 'group' && !(it.root as GroupNode).clipId && isIdentity(it.root.transform) && it.root.opacity === 1 && it.root.blendMode === 'normal' && !it.root.effects.length);
  if (allGroups && items.length <= 24) {
    return items.map((it, i) => {
      const g = it.root as GroupNode;
      const layer = makeLayer({ id: g.id, name: g.name === 'Group' ? `Layer ${i + 1}` : g.name, children: g.children, visible: g.visible, locked: g.locked, color: LAYER_COLORS[i % LAYER_COLORS.length] }, i);
      const nodes = it.nodes.map((n) => (n === g ? layer : n));
      return { root: layer, nodes };
    });
  }
  const layer = makeLayer({ name: 'Layer 1' }, 0);
  const nodes: Node[] = [layer];
  for (const it of items) {
    it.root.parent = layer.id;
    layer.children.push(it.root.id);
    nodes.push(...it.nodes);
  }
  return [{ root: layer, nodes }];
}

