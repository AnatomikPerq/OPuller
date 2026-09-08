/**
 * Symbols UI state: the symbol selected in the panel (used by Place and the
 * Symbol Sprayer) and the current symbol-editing session.
 */
import { create } from 'zustand';
import type { ID, Node } from '@/model/types';

export interface EditingSession {
  instanceId: ID;
  symbolId: ID;
  /** node references of the instance subtree when editing started (change detection) */
  snapshot: Node[];
}

interface SymbolState {
  activeId: ID | null;
  editing: EditingSession | null;
  setActive: (id: ID | null) => void;
  setEditing: (e: EditingSession | null) => void;
}

export const useSymbolStore = create<SymbolState>()((set) => ({
  activeId: null,
  editing: null,
  setActive: (activeId) => set({ activeId }),
  setEditing: (editing) => set({ editing }),
}));
