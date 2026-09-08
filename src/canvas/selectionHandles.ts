import type { Rect, Vec } from '@/model/types';
import type { EditorState } from '@/store/store';
import { selectionBounds } from '@/model/document';

export type HandleKind = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface Handle {
  kind: HandleKind;
  /** screen position */
  x: number;
  y: number;
  /** anchor (opposite point) in world coordinates */
  opposite: Vec;
  cursor: string;
}

export interface SelectionFrame {
  /** world bounds */
  bounds: Rect;
  /** screen rect */
  screen: Rect;
  handles: Handle[];
  center: Vec;
}

export const HANDLE_KINDS: HandleKind[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const CURSORS: Record<HandleKind, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export function handlePoint(b: Rect, kind: HandleKind): Vec {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  switch (kind) {
    case 'nw':
      return { x: b.x, y: b.y };
    case 'n':
      return { x: cx, y: b.y };
    case 'ne':
      return { x: b.x + b.width, y: b.y };
    case 'e':
      return { x: b.x + b.width, y: cy };
    case 'se':
      return { x: b.x + b.width, y: b.y + b.height };
    case 's':
      return { x: cx, y: b.y + b.height };
    case 'sw':
      return { x: b.x, y: b.y + b.height };
    case 'w':
      return { x: b.x, y: cy };
  }
}

export function oppositeHandle(kind: HandleKind): HandleKind {
  const map: Record<HandleKind, HandleKind> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
  return map[kind];
}

export function getSelectionFrame(state: EditorState, ids = state.selection): SelectionFrame | null {
  if (!ids.length) return null;
  const b = selectionBounds(state.doc, ids);
  if (!b) return null;
  const z = state.zoom;
  const p = state.pan;
  const screen: Rect = { x: b.x * z + p.x, y: b.y * z + p.y, width: b.width * z, height: b.height * z };
  const handles: Handle[] = HANDLE_KINDS.map((kind) => {
    const wp = handlePoint(b, kind);
    return { kind, x: wp.x * z + p.x, y: wp.y * z + p.y, opposite: handlePoint(b, oppositeHandle(kind)), cursor: CURSORS[kind] };
  });
  return { bounds: b, screen, handles, center: { x: b.x + b.width / 2, y: b.y + b.height / 2 } };
}

export interface HandleHit {
  kind: HandleKind;
  /** true = rotate zone just outside a corner */
  rotate: boolean;
}

/** Hit test the selection frame handles in screen space. */
export function hitHandle(frame: SelectionFrame | null, screen: Vec, handleSize = 7): HandleHit | null {
  if (!frame) return null;
  const half = handleSize / 2 + 2;
  // small selections: side handles overlap — prefer corners
  for (const h of frame.handles) {
    if (h.kind.length === 2 && Math.abs(screen.x - h.x) <= half && Math.abs(screen.y - h.y) <= half) return { kind: h.kind, rotate: false };
  }
  for (const h of frame.handles) {
    if (h.kind.length === 1 && Math.abs(screen.x - h.x) <= half && Math.abs(screen.y - h.y) <= half) return { kind: h.kind, rotate: false };
  }
  // rotate zones: within 14px outside the corners
  for (const h of frame.handles) {
    if (h.kind.length !== 2) continue;
    const dx = screen.x - h.x;
    const dy = screen.y - h.y;
    const d = Math.hypot(dx, dy);
    if (d > half && d <= half + 14) {
      const outsideX = h.kind.includes('w') ? dx < 0 : dx > 0;
      const outsideY = h.kind.includes('n') ? dy < 0 : dy > 0;
      if (outsideX || outsideY) return { kind: h.kind, rotate: true };
    }
  }
  return null;
}

export function rotateCursor(kind: HandleKind): string {
  // an SVG cursor with a curved arrow is defined in CSS as .cursor-rotate-*; fall back to 'grab'
  return `var(--cursor-rotate-${kind}, grab)`;
}
