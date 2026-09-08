/**
 * Recent documents: a small list (name + timestamp) in localStorage plus the
 * full project JSON in IndexedDB so that entries can be reopened without a file
 * handle (browsers do not persist File System Access handles across sessions
 * without extra permission prompts).
 */
import type { Document } from '@/model/types';
import { kvStore } from './idb';
import { serializeProject, parseProject } from './project';

export interface RecentEntry {
  /** stable id (document id) */
  id: string;
  name: string;
  /** file name shown in the menu, when known */
  fileName: string | null;
  /** last opened/saved time (ms) */
  time: number;
}

export const MAX_RECENT = 10;
const LS_KEY = 'opuller.recent.v1';
const store = kvStore('opuller-recent', 'documents');
const listeners = new Set<() => void>();

let cache: RecentEntry[] | null = null;

function load(): RecentEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const list = raw ? (JSON.parse(raw) as RecentEntry[]) : [];
    cache = Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(list: RecentEntry[]): void {
  cache = list.slice(0, MAX_RECENT);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function recentEntries(): RecentEntry[] {
  return load();
}

export function onRecentChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Remember a document (after open / save). Stores the JSON in IndexedDB. */
export async function addRecent(doc: Document, fileName: string | null): Promise<void> {
  const name = fileName ?? doc.name;
  const entry: RecentEntry = { id: doc.id, name, fileName, time: Date.now() };
  const list = load().filter((e) => e.id !== doc.id && !(fileName && e.fileName === fileName));
  list.unshift(entry);
  save(list);
  try {
    const json = await serializeProject(doc);
    await store.set(doc.id, json);
  } catch {
    /* ignore: the entry stays but cannot be reopened */
  }
  // prune stored documents that fell off the list
  const keep = new Set(load().map((e) => e.id));
  for (const key of await store.keys()) if (!keep.has(key)) void store.delete(key);
}

export async function loadRecent(id: string): Promise<Document | null> {
  const json = await store.get<string>(id);
  if (!json) return null;
  try {
    return parseProject(json);
  } catch {
    return null;
  }
}

export async function removeRecent(id: string): Promise<void> {
  save(load().filter((e) => e.id !== id));
  await store.delete(id);
}

export async function clearRecent(): Promise<void> {
  save([]);
  await store.clear();
}

export function touchRecent(id: string): void {
  const list = load();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return;
  const [e] = list.splice(i, 1);
  list.unshift({ ...e, time: Date.now() });
  save(list);
}
