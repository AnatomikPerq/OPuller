/**
 * Project library: every document the user works on is kept in the browser
 * (IndexedDB) with a thumbnail, like Illustrator's cloud documents on the Home
 * screen. Metadata lives in one store, the project JSON in another.
 */
import type { Document } from '@/model/types';
import { kvStore } from '@/io/idb';
import { serializeProject, parseProject, isBlankDocument } from '@/io/project';
import { renderToDataUrl } from '@/io/raster';

export interface ProjectMeta {
  id: string;
  name: string;
  /** file name when the document came from / went to disk */
  fileName: string | null;
  created: number;
  updated: number;
  /** data URL (jpeg) or null */
  thumbnail: string | null;
  width: number;
  height: number;
  artboards: number;
  objects: number;
  /** JSON size in bytes */
  bytes: number;
}

// one database per store: the kv helper creates its object store on first open only
const meta = kvStore('opuller-projects-meta', 'meta');
const docs = kvStore('opuller-projects-docs', 'docs');
const listeners = new Set<() => void>();
let cache: ProjectMeta[] | null = null;
let loading: Promise<ProjectMeta[]> | null = null;

export function onProjectsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(): void {
  listeners.forEach((l) => l());
}

export async function listProjects(): Promise<ProjectMeta[]> {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      const keys = await meta.keys();
      const out: ProjectMeta[] = [];
      for (const k of keys) {
        const m = await meta.get<ProjectMeta>(k);
        if (m && typeof m.id === 'string') out.push(m);
      }
      out.sort((a, b) => b.updated - a.updated);
      cache = out;
      return out;
    })();
  }
  return loading;
}

/** Synchronous snapshot (empty until listProjects resolved once). */
export function projectsSnapshot(): ProjectMeta[] {
  return cache ?? [];
}

export function getProjectMeta(id: string): ProjectMeta | undefined {
  return cache?.find((p) => p.id === id);
}

function countObjects(doc: Document): number {
  let n = 0;
  for (const node of Object.values(doc.nodes)) if (node.type !== 'layer') n++;
  return n;
}

/** Small JPEG preview of the first artboard. */
export async function makeThumbnail(doc: Document): Promise<string | null> {
  try {
    const ab = doc.artboards[0];
    if (!ab) return null;
    const r = await renderToDataUrl(doc, { scope: 'artboard', artboardId: ab.id, format: 'jpeg', quality: 0.82, width: 360, backgroundColor: ab.transparent ? '#ffffff' : ab.background, maxSize: 512 });
    return r.dataUrl;
  } catch {
    return null;
  }
}

export interface SaveOptions {
  fileName?: string | null;
  /** regenerate the thumbnail (default true) */
  thumbnail?: boolean;
  name?: string;
}

/** Save (upsert) a document in the library. Returns the metadata. */
export async function saveProject(doc: Document, opts: SaveOptions = {}): Promise<ProjectMeta | null> {
  const list = await listProjects();
  const existing = list.find((p) => p.id === doc.id);
  const json = await serializeProject(doc);
  const ab = doc.artboards[0];
  const thumb = opts.thumbnail === false ? (existing?.thumbnail ?? null) : await makeThumbnail(doc);
  const m: ProjectMeta = {
    id: doc.id,
    name: opts.name ?? existing?.name ?? doc.name,
    fileName: opts.fileName !== undefined ? opts.fileName : (existing?.fileName ?? null),
    created: existing?.created ?? Date.now(),
    updated: Date.now(),
    thumbnail: thumb,
    width: ab?.width ?? 0,
    height: ab?.height ?? 0,
    artboards: doc.artboards.length,
    objects: countObjects(doc),
    bytes: json.length,
  };
  const okDoc = await docs.set(doc.id, json);
  if (!okDoc) return null;
  await meta.set(doc.id, m);
  const next = list.filter((p) => p.id !== doc.id);
  next.unshift(m);
  cache = next;
  notify();
  return m;
}

export async function loadProject(id: string): Promise<Document | null> {
  const json = await docs.get<string>(id);
  if (!json) return null;
  try {
    return parseProject(json);
  } catch {
    return null;
  }
}

export async function projectJson(id: string): Promise<string | null> {
  return docs.get<string>(id);
}

export async function deleteProject(id: string): Promise<void> {
  await docs.delete(id);
  await meta.delete(id);
  if (cache) cache = cache.filter((p) => p.id !== id);
  notify();
}

export async function renameProject(id: string, name: string): Promise<void> {
  const list = await listProjects();
  const m = list.find((p) => p.id === id);
  if (!m) return;
  const next = { ...m, name: name.trim() || m.name, updated: Date.now() };
  await meta.set(id, next);
  // keep the document's own name in sync
  const doc = await loadProject(id);
  if (doc) {
    doc.name = next.name;
    await docs.set(id, await serializeProject(doc));
  }
  cache = list.map((p) => (p.id === id ? next : p)).sort((a, b) => b.updated - a.updated);
  notify();
}

export async function duplicateProject(id: string): Promise<ProjectMeta | null> {
  const doc = await loadProject(id);
  const m = getProjectMeta(id);
  if (!doc) return null;
  // fresh id and name
  doc.id = Math.random().toString(36).slice(2, 12);
  doc.name = `${m?.name ?? doc.name} copy`;
  return saveProject(doc, { fileName: null, name: doc.name });
}

export async function touchProject(id: string): Promise<void> {
  const m = getProjectMeta(id);
  if (!m) return;
  const next = { ...m, updated: Date.now() };
  await meta.set(id, next);
  cache = (cache ?? []).map((p) => (p.id === id ? next : p)).sort((a, b) => b.updated - a.updated);
  notify();
}

export function shouldPersist(doc: Document): boolean {
  return !isBlankDocument(doc);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(t: number): string {
  const d = Date.now() - t;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(t).toLocaleDateString();
}
