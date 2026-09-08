/** SVG cursors for the gradient and eyedropper tools (data URLs, hotspot = tip). */

function svgCursor(svg: string, hx: number, hy: number, fallback: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}

const CROSS = '<path d="M11 2v6M11 14v6M2 11h6M14 11h6" stroke="#fff" stroke-width="3"/><path d="M11 2v6M11 14v6M2 11h6M14 11h6" stroke="#000" stroke-width="1.2"/>';

export const GRADIENT_CURSOR = svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">${CROSS}<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect x="17" y="17" width="11" height="8" fill="url(#g)" stroke="#000" stroke-width="1"/></svg>`,
  11,
  11,
  'crosshair',
);

export const GRADIENT_MOVE_CURSOR = 'move';

const PIPETTE = (extra: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M4 24l1-5 11-11 4 4-11 11z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/><path d="M17 7l3-3a2 2 0 013 3l-3 3" fill="#000"/><path d="M15 9l4 4" stroke="#000" stroke-width="2"/>${extra}</svg>`;

export const EYEDROPPER_CURSOR = svgCursor(PIPETTE(''), 4, 24, 'crosshair');
/** Alt: apply the current appearance (filled square) */
export const EYEDROPPER_APPLY_CURSOR = svgCursor(PIPETTE('<rect x="18" y="18" width="8" height="8" fill="#000" stroke="#fff" stroke-width="1"/>'), 4, 24, 'crosshair');
/** Shift: sample a single colour (small colour chip) */
export const EYEDROPPER_COLOR_CURSOR = svgCursor(PIPETTE('<rect x="18" y="18" width="8" height="8" fill="#e5484d" stroke="#fff" stroke-width="1"/><rect x="21" y="21" width="2" height="2" fill="#fff"/>'), 4, 24, 'crosshair');
