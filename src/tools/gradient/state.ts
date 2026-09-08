/** Ephemeral UI state of the gradient tool (stop colour popover). */
import { create } from 'zustand';
import type { Vec } from '@/model/types';

export interface GradientToolUi {
  popover: { index: number; screen: Vec } | null;
  /** hovered annotator element for highlighting */
  hover: string | null;
  setPopover: (p: { index: number; screen: Vec } | null) => void;
  setHover: (h: string | null) => void;
}

export const useGradientToolStore = create<GradientToolUi>((set) => ({
  popover: null,
  hover: null,
  setPopover: (popover) => set({ popover }),
  setHover: (hover) => set((s) => (s.hover === hover ? s : { hover })),
}));
