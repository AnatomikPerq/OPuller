/**
 * Illustrator-style SVG cursors (data URIs) for the anchor editing tools:
 * pen nib with a small badge (close / add / delete / continue / corner /
 * curvature) and the direct-selection arrow with anchor / handle / segment
 * badges. Every cursor has a CSS fallback for browsers without SVG cursors.
 */

const cache = new Map<string, string>();

function svgCursor(key: string, body: string, hx: number, hy: number, fallback: string, size = 24): string {
  const cached = cache.get(key);
  if (cached) return cached;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
  const url = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
  cache.set(key, url);
  return url;
}

const OUTLINE = 'stroke="#000" stroke-width="1.2" stroke-linejoin="round"';
const WHITE = 'fill="#fff"';

/** Pen nib pointing to the top-left; the hotspot is the tip at (2, 2). */
const PEN_NIB = `<path d="M2 2 L11.5 5.5 L15 12 L12 15 L5.5 11.5 Z" ${WHITE} ${OUTLINE}/><circle cx="9.5" cy="9.5" r="1.4" fill="#000"/><path d="M12.2 12.2 L16.5 16.5" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>`;

/** Direct selection arrow (white with black outline); hotspot (3, 2). */
const ARROW = `<path d="M3 2 L3 17 L7 13.5 L9.8 19.5 L12.4 18.3 L9.7 12.5 L15 12.5 Z" ${WHITE} ${OUTLINE}/>`;

type PenBadge = 'none' | 'close' | 'add' | 'delete' | 'continue' | 'corner' | 'curvature' | 'join' | 'start';

function penBadge(kind: PenBadge): string {
  switch (kind) {
    case 'close':
      return `<circle cx="19" cy="19" r="3.2" ${WHITE} ${OUTLINE}/>`;
    case 'add':
      return `<path d="M15.5 19 H22.5 M19 15.5 V22.5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M15.5 19 H22.5 M19 15.5 V22.5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
    case 'delete':
      return `<path d="M15.5 19 H22.5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M15.5 19 H22.5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
    case 'continue':
      return `<path d="M15.5 22 L22 15.5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M15.5 22 L22 15.5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
    case 'join':
      return `<rect x="15.5" y="15.5" width="7" height="7" ${WHITE} ${OUTLINE}/><path d="M17 19 H21" stroke="#000" stroke-width="1.2"/>`;
    case 'corner':
      return `<path d="M15.5 22 L19 16 L22.5 22" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 22 L19 16 L22.5 22" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'curvature':
      return `<path d="M15 20 C16.5 15.5 19.5 23 22.5 17.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M15 20 C16.5 15.5 19.5 23 22.5 17.5" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
    case 'start':
      return `<path d="M16 16 L22 22 M22 16 L16 22" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M16 16 L22 22 M22 16 L16 22" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
    default:
      return '';
  }
}

export function penCursor(badge: PenBadge = 'none'): string {
  return svgCursor(`pen-${badge}`, PEN_NIB + penBadge(badge), 2, 2, 'crosshair');
}

/** Anchor Point (convert) tool cursor: a caret nib. */
export function anchorPointCursor(over: 'none' | 'anchor' | 'handle' | 'segment' = 'none'): string {
  const nib = `<path d="M3 20 L12 3 L21 20" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/><path d="M3 20 L12 3 L21 20" fill="none" stroke="#000" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
  let badge = '';
  if (over === 'anchor') badge = `<rect x="16.5" y="16.5" width="5.5" height="5.5" ${WHITE} ${OUTLINE}/>`;
  else if (over === 'handle') badge = `<circle cx="19.5" cy="19.5" r="2.8" ${WHITE} ${OUTLINE}/>`;
  else if (over === 'segment') badge = `<path d="M15 22 C17 17 20 21 23 16" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M15 22 C17 17 20 21 23 16" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>`;
  return svgCursor(`anchorpoint-${over}`, nib + badge, 12, 3, 'crosshair');
}

export function directCursor(over: 'none' | 'anchor' | 'handle' | 'segment' | 'object' | 'move' = 'none'): string {
  if (over === 'none') return 'default';
  let badge = '';
  if (over === 'anchor') badge = `<rect x="16.5" y="3.5" width="5.5" height="5.5" ${WHITE} ${OUTLINE}/>`;
  else if (over === 'handle') badge = `<circle cx="19.2" cy="6.2" r="2.8" ${WHITE} ${OUTLINE}/>`;
  else if (over === 'segment') badge = `<path d="M15 10 C17 5 20 9 23 4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M15 10 C17 5 20 9 23 4" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>`;
  else if (over === 'object') badge = `<rect x="16" y="3" width="6" height="6" fill="#000" stroke="#fff" stroke-width="1.2"/>`;
  else if (over === 'move') badge = `<path d="M19 3 L19 10 M15.5 6.5 L22.5 6.5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M19 3 L19 10 M15.5 6.5 L22.5 6.5" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>`;
  return svgCursor(`direct-${over}`, ARROW + badge, 3, 2, 'default');
}

export function lassoCursor(mode: 'none' | 'add' | 'subtract' = 'none'): string {
  const loop = `<path d="M4 9 C4 5.5 8 3 12 3 C16.5 3 20 5.5 20 9 C20 12.5 16 15 12 15 C10.5 15 9 14.7 8 14.2 L6 20" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M4 9 C4 5.5 8 3 12 3 C16.5 3 20 5.5 20 9 C20 12.5 16 15 12 15 C10.5 15 9 14.7 8 14.2 L6 20" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
  let badge = '';
  if (mode === 'add') badge = `<path d="M16 20 H23 M19.5 16.5 V23.5" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M16 20 H23 M19.5 16.5 V23.5" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>`;
  else if (mode === 'subtract') badge = `<path d="M16 20 H23" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M16 20 H23" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>`;
  return svgCursor(`lasso-${mode}`, loop + badge, 6, 20, 'crosshair');
}
