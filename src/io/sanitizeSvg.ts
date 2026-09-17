/**
 * Sanitiser for SVG markup that is injected into the live DOM as-is (pattern cells
 * stored in .opuller files are rendered with dangerouslySetInnerHTML). A crafted
 * project file must not be able to run script, register event handlers or make the
 * editor fetch external resources; everything the pattern renderer itself produces
 * (geometry, paint servers, filters, text, data-URL images) passes through unchanged.
 *
 * Pure DOM code (DOMParser / XMLSerializer) so vitest can cover it — no React, no paper.js.
 */

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'image', 'style',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
]);

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Local references (`#id`) and inline data are the only references a cell may hold. */
function safeReference(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (v.startsWith('#')) return true;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml)[;,]/i.test(v)) return true;
  if (/^data:(font\/[a-z0-9.+-]+|application\/(x-)?font-[a-z0-9.+-]+|application\/vnd\.ms-fontobject)[;,]/i.test(v)) return true;
  if (v.startsWith('blob:')) return true;
  return false;
}

/** `url(...)` inside presentation attributes / CSS must point at a local id or inline data. */
function safeUrlFunctions(value: string): boolean {
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) if (!safeReference(m[2])) return false;
  return !/@import/i.test(value) && !/expression\s*\(/i.test(value);
}

function isReferenceAttribute(name: string, ns: string | null): boolean {
  return name === 'href' || name === 'xlink:href' || (ns === XLINK_NS && name.endsWith('href'));
}

function sanitizeElement(el: Element): void {
  // attributes: no event handlers, only local references and data URLs
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (isReferenceAttribute(name, attr.namespaceURI) || lower === 'src') {
      if (!safeReference(attr.value)) el.removeAttributeNode(attr);
      continue;
    }
    if (attr.value.includes('(') && !safeUrlFunctions(attr.value)) el.removeAttributeNode(attr);
  }
  if (el.localName === 'style' && !safeUrlFunctions(el.textContent ?? '')) {
    el.remove();
    return;
  }
  for (const child of Array.from(el.children)) {
    if (child.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(child.localName)) child.remove();
    else sanitizeElement(child);
  }
}

/**
 * Returns the sanitised markup of the children of an SVG fragment (the cell of a pattern),
 * or '' when the markup does not parse.
 */
export function sanitizeSvgMarkup(markup: string): string {
  if (!markup) return '';
  if (typeof DOMParser === 'undefined') return markup; // non-DOM environment: nothing renders it there
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">${markup}</svg>`, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return '';
  sanitizeElement(root);
  // serialise the wrapper and strip it, so the children keep no redundant xmlns declarations
  const xml = new XMLSerializer().serializeToString(root);
  const open = xml.indexOf('>');
  const close = xml.lastIndexOf('</svg>');
  return open < 0 || close < open ? '' : xml.slice(open + 1, close);
}

/**
 * Image sources the document may carry: inline data, in-session blobs and plain
 * http(s) links (linked pictures in imported SVGs). Anything else — javascript:,
 * file:, vbscript:, unknown schemes — is dropped.
 */
export function safeImageSrc(src: string): string {
  const v = src.trim();
  if (v === '') return '';
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(v)) return v;
  if (/^blob:/i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return '';
}
