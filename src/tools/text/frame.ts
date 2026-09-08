/**
 * Area text frame handles (screen-space hit testing while editing).
 */
import type { EditorState } from '@/store/store';
import type { TextNode, Vec } from '@/model/types';
import { applyToPoint } from '@/geometry/matrix';
import { nodeScreenMatrix } from '@/canvas/SelectionOverlay';

export type FrameHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const FRAME_HANDLES: FrameHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function frameHandleLocal(box: { width: number; height: number }, kind: FrameHandle): Vec {
  const w = box.width;
  const h = box.height;
  switch (kind) {
    case 'nw':
      return { x: 0, y: 0 };
    case 'n':
      return { x: w / 2, y: 0 };
    case 'ne':
      return { x: w, y: 0 };
    case 'e':
      return { x: w, y: h / 2 };
    case 'se':
      return { x: w, y: h };
    case 's':
      return { x: w / 2, y: h };
    case 'sw':
      return { x: 0, y: h };
    case 'w':
      return { x: 0, y: h / 2 };
  }
}

export function frameCursor(kind: FrameHandle): string {
  switch (kind) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    default:
      return 'ew-resize';
  }
}

/** Handle under a screen point (area text only). */
export function hitFrameHandle(state: EditorState, node: TextNode, screen: Vec): FrameHandle | null {
  if (node.kind !== 'area' || !node.box) return null;
  const m = nodeScreenMatrix(state, node.id);
  const r = state.prefs.handleSize / 2 + 2;
  let best: FrameHandle | null = null;
  let bestD = r;
  for (const kind of FRAME_HANDLES) {
    const p = applyToPoint(m, frameHandleLocal(node.box, kind));
    const d = Math.max(Math.abs(p.x - screen.x), Math.abs(p.y - screen.y));
    if (d <= bestD) {
      bestD = d;
      best = kind;
    }
  }
  return best;
}
