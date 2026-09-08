/**
 * Ephemeral canvas state that is not part of the document or undo history:
 * snap guide lines, marquee rectangles, temporary measurements, etc.
 */
import { create } from 'zustand';
import type { SnapResult } from './snap';
import type { Rect, Vec } from '@/model/types';

export interface OverlayState {
  snap: SnapResult | null;
  marquee: Rect | null;
  /** measurement label shown near the cursor (e.g. "W: 120 H: 80") */
  hud: { screen: Vec; text: string } | null;
  /** guide being dragged from a ruler or moved (world position) */
  dragGuide: { axis: 'x' | 'y'; position: number } | null;
  /** extra screen-space overlay elements registered by modules (e.g. text editor) */
  setSnap: (s: SnapResult | null) => void;
  setMarquee: (r: Rect | null) => void;
  setHud: (h: { screen: Vec; text: string } | null) => void;
  setDragGuide: (g: { axis: 'x' | 'y'; position: number } | null) => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  snap: null,
  marquee: null,
  hud: null,
  dragGuide: null,
  setSnap: (snap) => set({ snap }),
  setMarquee: (marquee) => set({ marquee }),
  setHud: (hud) => set({ hud }),
  setDragGuide: (dragGuide) => set({ dragGuide }),
}));
