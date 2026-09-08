import { create } from 'zustand';

export type HomeSection = 'home' | 'projects' | 'recent' | 'samples' | 'learn' | 'ai';

export interface HomeState {
  open: boolean;
  section: HomeSection;
  query: string;
  view: 'grid' | 'list';
  sort: 'updated' | 'name' | 'created';
  setOpen: (v: boolean, section?: HomeSection) => void;
  setSection: (s: HomeSection) => void;
  setQuery: (q: string) => void;
  setView: (v: 'grid' | 'list') => void;
  setSort: (s: 'updated' | 'name' | 'created') => void;
}

const PERSIST = 'opuller.home.v1';

function persisted(): Partial<Pick<HomeState, 'view' | 'sort'>> {
  try {
    const raw = localStorage.getItem(PERSIST);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export const useHomeStore = create<HomeState>((set, get) => ({
  open: false,
  section: 'home',
  query: '',
  view: persisted().view ?? 'grid',
  sort: persisted().sort ?? 'updated',
  setOpen: (open, section) => set({ open, section: section ?? get().section, query: open ? get().query : '' }),
  setSection: (section) => set({ section }),
  setQuery: (query) => set({ query }),
  setView: (view) => {
    set({ view });
    persist(get());
  },
  setSort: (sort) => {
    set({ sort });
    persist(get());
  },
}));

function persist(s: HomeState): void {
  try {
    localStorage.setItem(PERSIST, JSON.stringify({ view: s.view, sort: s.sort }));
  } catch {
    /* ignore */
  }
}
