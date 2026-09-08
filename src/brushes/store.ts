/**
 * Brushes UI state: the brush selected in the panel (applied by the Paintbrush
 * tool to new strokes) and the panel view.
 */
import { create } from 'zustand';
import type { ID } from '@/model/types';

interface BrushState {
  activeId: ID | null;
  view: 'grid' | 'list';
  setActive: (id: ID | null) => void;
  setView: (v: 'grid' | 'list') => void;
}

export const useBrushStore = create<BrushState>()((set) => ({
  activeId: null,
  view: 'list',
  setActive: (activeId) => set({ activeId }),
  setView: (view) => set({ view }),
}));
