/**
 * UI state of the perspective grid that is not part of the document (and not
 * undoable): visibility, the active plane and whether new shapes are drawn on
 * the active plane.
 */
import { create } from 'zustand';
import type { PerspectivePlane } from '@/model/types';

interface PerspectiveUiState {
  visible: boolean;
  activePlane: PerspectivePlane;
  /** shapes created by the drawing tools while the grid is shown are attached to the active plane */
  drawOnPlane: boolean;
  setVisible: (v: boolean) => void;
  setActivePlane: (p: PerspectivePlane) => void;
  setDrawOnPlane: (v: boolean) => void;
}

export const usePerspectiveStore = create<PerspectiveUiState>((set) => ({
  visible: false,
  activePlane: 'right',
  drawOnPlane: true,
  setVisible: (visible) => set({ visible }),
  setActivePlane: (activePlane) => set({ activePlane }),
  setDrawOnPlane: (drawOnPlane) => set({ drawOnPlane }),
}));
