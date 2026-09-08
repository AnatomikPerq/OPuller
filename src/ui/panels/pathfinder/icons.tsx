/**
 * Glyphs for the "Pathfinders" row, drawn in the style of lucide's overlapping
 * squares (SquaresUnite & co. are used for the shape modes).
 */
import React from 'react';

const base = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** Two overlapping squares, all edges of the overlap drawn (faces). */
export function DivideIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="12" height="12" rx="1.5" />
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
      <path d="M9 15h6M15 9v6" />
    </svg>
  );
}

/** Back square loses the covered part. */
export function TrimIcon() {
  return (
    <svg {...base}>
      <path d="M15 3H4.5A1.5 1.5 0 0 0 3 4.5V15h6V9h6z" />
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
    </svg>
  );
}

/** Same-fill pieces united: one outline without inner edges. */
export function MergeIcon() {
  return (
    <svg {...base}>
      <path d="M4.5 3H13.5A1.5 1.5 0 0 1 15 4.5V9h4.5A1.5 1.5 0 0 1 21 10.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 19.5V15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3z" />
    </svg>
  );
}

/** Front square as the crop frame, only the covered part of the back square stays. */
export function CropIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="12" height="12" rx="1.5" strokeDasharray="2 2" opacity="0.6" />
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" opacity="0.75" />
    </svg>
  );
}

/** Edges cut at the intersections. */
export function OutlineIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="12" height="12" rx="1.5" strokeWidth="1.5" />
      <rect x="9" y="9" width="12" height="12" rx="1.5" strokeWidth="1.5" />
      <circle cx="15" cy="9" r="1.8" fill="var(--bg-panel)" />
      <circle cx="9" cy="15" r="1.8" fill="var(--bg-panel)" />
    </svg>
  );
}

/** Front square minus the back one. */
export function MinusBackIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="12" height="12" rx="1.5" strokeDasharray="2 2" opacity="0.6" />
      <path d="M15 9h4.5A1.5 1.5 0 0 1 21 10.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 19.5V15h6z" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}
