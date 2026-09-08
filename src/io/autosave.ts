/**
 * Autosave: every 20 s, when the document is dirty and changed since the last
 * snapshot, the project JSON is written to IndexedDB ("opuller-autosave").
 * On startup a Recover dialog is offered when a snapshot exists (not when a
 * test runner drives the page).
 */
import { useStore, getState } from '@/store/store';
import { kvStore } from './idb';
import { serializeProject, parseProject, isBlankDocument } from './project';
import type { Document } from '@/model/types';

export const AUTOSAVE_INTERVAL = 20_000;
/** snapshots older than this are ignored (ms) */
export const AUTOSAVE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export interface AutosaveRecord {
  json: string;
  time: number;
  name: string;
  fileName: string | null;
  docId: string;
}

const store = kvStore('opuller-autosave', 'documents');
const KEY = 'latest';

let lastVersion = -1;
let timer: ReturnType<typeof setInterval> | null = null;
let saving = false;

export async function saveAutosaveNow(): Promise<boolean> {
  const s = getState();
  if (!s.dirty || saving) return false;
  if (s.docVersion === lastVersion) return false;
  saving = true;
  try {
    const json = await serializeProject(s.doc);
    const rec: AutosaveRecord = { json, time: Date.now(), name: s.doc.name, fileName: s.fileName, docId: s.doc.id };
    const ok = await store.set(KEY, rec);
    if (ok) lastVersion = s.docVersion;
    return ok;
  } catch {
    return false;
  } finally {
    saving = false;
  }
}

export async function clearAutosave(): Promise<void> {
  lastVersion = getState().docVersion;
  await store.delete(KEY);
}

export async function loadAutosave(): Promise<AutosaveRecord | null> {
  const rec = await store.get<AutosaveRecord>(KEY);
  if (!rec || typeof rec.json !== 'string') return null;
  return rec;
}

/** Start the periodic autosave (idempotent). Returns a stop function. */
export function startAutosave(interval = AUTOSAVE_INTERVAL): () => void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (getState().prefs.autosave === false) return;
    void saveAutosaveNow();
  }, interval);
  // a clean save invalidates the snapshot
  const unsub = useStore.subscribe(
    (s) => s.dirty,
    (dirty) => {
      if (!dirty) void clearAutosave();
    },
  );
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    unsub();
  };
}

export function isAutomated(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).webdriver;
}

/**
 * On startup: when an autosave snapshot exists that differs from a blank
 * document, open the Recover dialog. Skipped under WebDriver (Playwright).
 */
export async function checkRecovery(): Promise<void> {
  if (isAutomated()) return;
  const rec = await loadAutosave();
  if (!rec) return;
  if (Date.now() - rec.time > AUTOSAVE_MAX_AGE) {
    await clearAutosave();
    return;
  }
  let doc: Document;
  try {
    doc = parseProject(rec.json);
  } catch {
    await clearAutosave();
    return;
  }
  if (isBlankDocument(doc)) {
    await clearAutosave();
    return;
  }
  const s = getState();
  if (s.dialog) return; // do not fight another startup dialog
  s.openDialog('io.recover', { record: { time: rec.time, name: rec.name, fileName: rec.fileName }, doc });
}
