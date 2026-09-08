/**
 * Home screen wiring: File > Home, Save to Library, automatic persistence of
 * the working document into the browser project library, start-up behaviour.
 */
import { useStore, getState } from '@/store/store';
import { registerCommands } from '@/commands/registry';
import { registerAppOverlay } from '@/ui/appSlots';
import { HomeScreen } from './HomeScreen';
import { useHomeStore, type HomeSection } from './store';
import * as projectsApi from './projects';
import { saveProject, shouldPersist, listProjects } from './projects';

const HOME_AT_START_KEY = 'opuller.homeAtStart';

export function openHome(section?: HomeSection): void {
  useHomeStore.getState().setOpen(true, section);
}

registerAppOverlay('home', HomeScreen);
// same module instance as the app (tests must not dynamic-import the file: Vite may serve another copy)
(window as any).__opuller = { ...((window as any).__opuller ?? {}), projects: projectsApi, home: useHomeStore };

registerCommands([
  {
    id: 'file.home',
    label: 'Home Screen',
    menu: 'File',
    shortcut: 'mod+shift+h',
    order: 0,
    run: () => useHomeStore.getState().setOpen(true, 'home'),
    allowInTextEdit: false,
  },
  {
    id: 'file.projects',
    label: 'Projects…',
    menu: 'File',
    order: 0.5,
    run: () => useHomeStore.getState().setOpen(true, 'projects'),
  },
  {
    id: 'file.saveToLibrary',
    label: 'Save to Library',
    menu: 'File',
    shortcut: 'mod+alt+s',
    order: 11.5,
    run: async () => {
      const s = getState();
      const m = await saveProject(s.doc, { fileName: s.fileName });
      getState().toast(m ? `"${m.name}" saved to the project library` : 'Could not save to the library (storage unavailable)', m ? 'success' : 'error');
    },
  },
  {
    id: 'home.showAtStart',
    label: 'Show Home Screen at Startup',
    menu: 'Help',
    order: 4,
    run: () => {
      const cur = localStorage.getItem(HOME_AT_START_KEY) !== 'off';
      localStorage.setItem(HOME_AT_START_KEY, cur ? 'off' : 'on');
      getState().toast(cur ? 'Home screen will not show at startup' : 'Home screen will show at startup', 'info');
    },
    checked: () => {
      try {
        return localStorage.getItem(HOME_AT_START_KEY) !== 'off';
      } catch {
        return true;
      }
    },
  },
]);

// ---------------------------------------------------------------------------
// Automatic persistence: every commit is written to the library (debounced);
// thumbnails are refreshed at most every 12 s to keep it cheap.
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let lastThumb = 0;
let lastSavedVersion = -1;

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const s = getState();
    if (!shouldPersist(s.doc) || s.docVersion === lastSavedVersion) return;
    if (s.doc !== s.historyBase) {
      schedule();
      return;
    }
    const withThumb = Date.now() - lastThumb > 12_000;
    lastSavedVersion = s.docVersion;
    const m = await saveProject(s.doc, { fileName: s.fileName, thumbnail: withThumb });
    if (m && withThumb) lastThumb = Date.now();
  }, 1500);
}

useStore.subscribe(
  (s) => s.historyBase,
  () => schedule(),
);
useStore.subscribe(
  (s) => s.doc.id,
  () => {
    lastThumb = 0;
    lastSavedVersion = -1;
  },
);

// ---------------------------------------------------------------------------
// Start-up: show the Home screen (not under test automation; the recovery
// dialog, when present, is handled by the IO module and stays on top).
// ---------------------------------------------------------------------------

try {
  const automated = typeof navigator !== 'undefined' && (navigator as any).webdriver;
  const wanted = localStorage.getItem(HOME_AT_START_KEY) !== 'off';
  if (wanted && !automated) {
    void listProjects();
    useHomeStore.getState().setOpen(true, 'home');
  }
} catch {
  /* ignore */
}
