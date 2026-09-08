/**
 * SVG data-URL cursors for the freehand tools (white glyphs with a dark outline
 * so they read on any canvas colour). Hotspots sit at the drawing tip.
 */

function cursorUrl(svg: string, hx: number, hy: number, fallback = 'crosshair'): string {
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">';
const OUTLINE = 'fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"';

/** pencil body drawn from the tip at (3,23) towards the top-right */
const PENCIL_BODY = `<path d="M3 23l1-4.5L17.5 5l3.5 3.5L7.5 22z" ${OUTLINE}/><path d="M15.5 7l3.5 3.5M4 18.5l3.5 3.5" stroke="#000" stroke-width="1" fill="none"/>`;

export const PENCIL_CURSOR = cursorUrl(`${HEAD}${PENCIL_BODY}</svg>`, 3, 23);
export const PENCIL_EDIT_CURSOR = cursorUrl(`${HEAD}${PENCIL_BODY}<path d="M18 19h6M21 16v6" stroke="#000" stroke-width="2.4"/><path d="M18 19h6M21 16v6" stroke="#fff" stroke-width="1.2"/></svg>`, 3, 23);
export const PENCIL_CLOSE_CURSOR = cursorUrl(`${HEAD}${PENCIL_BODY}<circle cx="21" cy="20" r="3.2" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>`, 3, 23);

export const BRUSH_CURSOR = cursorUrl(
  `${HEAD}<path d="M3 23c0-3 1-5.5 3.5-6.5 1.5-0.6 2.6 0.2 3 1.2 0.6 1.7-0.4 3.7-2 4.6C6 23.2 4.5 23.3 3 23z" ${OUTLINE}/><path d="M9 16.5L21.5 4l1.5 1.5L10.5 18z" ${OUTLINE}/></svg>`,
  3,
  23,
);

export const BLOB_CURSOR = cursorUrl(
  `${HEAD}<path d="M9.5 16.5L21.5 4.5l1.5 1.5-12 12z" ${OUTLINE}/><path d="M3 23c-0.5-3.5 1-6.5 4-7 2.5-0.4 4.5 1.5 4 4-0.4 2.5-2.5 4-5 3.5C4.8 23.3 3.8 23.2 3 23z" ${OUTLINE}/></svg>`,
  3,
  23,
);

export const SMOOTH_CURSOR = cursorUrl(`${HEAD}${PENCIL_BODY}<path d="M15 21c1.5-2 3-2 4.5 0s3 2 4.5 0" stroke="#000" stroke-width="2.4" fill="none"/><path d="M15 21c1.5-2 3-2 4.5 0s3 2 4.5 0" stroke="#fff" stroke-width="1.2" fill="none"/></svg>`, 3, 23);

export const PATH_ERASER_CURSOR = cursorUrl(
  `${HEAD}<path d="M3 23l1-4.5L14 8l3.5 3.5L7.5 22z" ${OUTLINE}/><path d="M14 8l4-4 3.5 3.5-4 4z" fill="#f2a5b8" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/><path d="M4 18.5l3.5 3.5" stroke="#000" stroke-width="1" fill="none"/></svg>`,
  3,
  23,
);

const circleCache = new Map<number, string>();

/**
 * Circular cursor of the given screen diameter (eraser / blob brush). Browsers
 * ignore cursors larger than 128px, so beyond that a crosshair is used and the
 * tool draws the circle in the overlay instead.
 */
export function circleCursor(diameterPx: number): string {
  const d = Math.max(4, Math.round(diameterPx));
  if (d > 120) return 'crosshair';
  const cached = circleCache.get(d);
  if (cached) return cached;
  const size = d + 6;
  const c = size / 2;
  const r = d / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#000" stroke-width="2.5" stroke-opacity="0.55"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#fff" stroke-width="1"/><path d="M${c - 3} ${c}h6M${c} ${c - 3}v6" stroke="#000" stroke-width="2" stroke-opacity="0.6"/><path d="M${c - 3} ${c}h6M${c} ${c - 3}v6" stroke="#fff" stroke-width="0.8"/></svg>`;
  const url = cursorUrl(svg, c, c);
  circleCache.set(d, url);
  return url;
}

/** Whether the circle cursor falls back to a crosshair (tool should draw the circle itself). */
export function circleCursorIsFallback(diameterPx: number): boolean {
  return Math.round(diameterPx) > 120;
}
