/**
 * Print module UI state (bleed guides visibility) persisted in localStorage.
 */
import { create } from 'zustand';

const KEY = 'opuller.print.v1';

interface PrintState {
  showBleed: boolean;
  setShowBleed: (v: boolean) => void;
}

function load(): Partial<PrintState> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export const usePrintStore = create<PrintState>()((set, get) => ({
  showBleed: load().showBleed ?? true,
  setShowBleed: (v) => {
    set({ showBleed: v });
    try {
      localStorage.setItem(KEY, JSON.stringify({ showBleed: get().showBleed }));
    } catch {
      /* ignore */
    }
  },
}));
