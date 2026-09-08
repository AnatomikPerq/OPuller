/**
 * Font registry: bundled @fontsource families, user-uploaded fonts (persisted in
 * IndexedDB) and system fonts. Also provides parsed opentype.js fonts for
 * "Create Outlines" — those are loaded from the WOFF files declared by the
 * @font-face rules the page already uses (so every bundled subset — latin,
 * cyrillic, greek… — is available on demand) or from the uploaded font data.
 */
import { useSyncExternalStore } from 'react';
import { produce } from 'immer';
import * as opentype from 'opentype.js';
import { getState, setState } from '@/store/store';
import { clearMeasureCache, invalidateLayouts } from './layout';

// --- bundled font CSS (400 / 500 / 700 + italic 400 where the family has it) ----
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/400-italic.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/roboto/400-italic.css';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/500.css';
import '@fontsource/open-sans/700.css';
import '@fontsource/open-sans/400-italic.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/400-italic.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/500.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/lora/400.css';
import '@fontsource/lora/500.css';
import '@fontsource/lora/700.css';
import '@fontsource/lora/400-italic.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/700.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import '@fontsource/source-code-pro/700.css';
import '@fontsource/source-code-pro/400-italic.css';
import '@fontsource/pacifico/400.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/raleway/400.css';
import '@fontsource/raleway/500.css';
import '@fontsource/raleway/700.css';
import '@fontsource/raleway/400-italic.css';
import '@fontsource/merriweather/400.css';
import '@fontsource/merriweather/500.css';
import '@fontsource/merriweather/700.css';
import '@fontsource/merriweather/400-italic.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/400-italic.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/500.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/400-italic.css';

export type FontStyleName = 'normal' | 'italic';
export type FontCategory = 'sans-serif' | 'serif' | 'display' | 'monospace' | 'handwriting' | 'system' | 'uploaded';
export type FontSource = 'bundled' | 'uploaded' | 'system';

export interface FontFaceDef {
  weight: number;
  style: FontStyleName;
  label: string;
}

export interface FontFamilyDef {
  family: string;
  category: FontCategory;
  source: FontSource;
  faces: FontFaceDef[];
  /** whether Create Outlines can use this family */
  outlines: boolean;
}

export const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

export function faceLabel(weight: number, style: FontStyleName): string {
  const w = WEIGHT_NAMES[weight] ?? String(weight);
  if (style === 'italic') return weight === 400 ? 'Italic' : `${w} Italic`;
  return w;
}

function faces(weights: number[], italics: number[]): FontFaceDef[] {
  const out: FontFaceDef[] = [];
  const all = Array.from(new Set([...weights, ...italics])).sort((a, b) => a - b);
  for (const w of all) {
    if (weights.includes(w)) out.push({ weight: w, style: 'normal', label: faceLabel(w, 'normal') });
    if (italics.includes(w)) out.push({ weight: w, style: 'italic', label: faceLabel(w, 'italic') });
  }
  return out;
}

const STD = [400, 500, 700];

const BUNDLED: FontFamilyDef[] = [
  { family: 'Inter', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Roboto', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Open Sans', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Montserrat', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Poppins', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Nunito', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Raleway', category: 'sans-serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Oswald', category: 'sans-serif', source: 'bundled', faces: faces(STD, []), outlines: true },
  { family: 'Playfair Display', category: 'serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Lora', category: 'serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Merriweather', category: 'serif', source: 'bundled', faces: faces(STD, [400]), outlines: true },
  { family: 'Bebas Neue', category: 'display', source: 'bundled', faces: faces([400], []), outlines: true },
  { family: 'Pacifico', category: 'handwriting', source: 'bundled', faces: faces([400], []), outlines: true },
  { family: 'Source Code Pro', category: 'monospace', source: 'bundled', faces: faces(STD, [400]), outlines: true },
];

const SYSTEM_FAMILIES: Array<[string, FontCategory]> = [
  ['Arial', 'system'],
  ['Helvetica', 'system'],
  ['Verdana', 'system'],
  ['Tahoma', 'system'],
  ['Trebuchet MS', 'system'],
  ['Segoe UI', 'system'],
  ['Times New Roman', 'system'],
  ['Georgia', 'system'],
  ['Garamond', 'system'],
  ['Palatino Linotype', 'system'],
  ['Courier New', 'system'],
  ['Lucida Console', 'system'],
  ['Impact', 'system'],
  ['Comic Sans MS', 'system'],
];

const SYSTEM_FACES = faces([300, 400, 500, 600, 700, 900], [400, 700]);

export function systemFamilyDef(family: string): FontFamilyDef {
  return { family, category: 'system', source: 'system', faces: SYSTEM_FACES, outlines: false };
}

// ---------------------------------------------------------------------------
// Uploaded fonts (IndexedDB)
// ---------------------------------------------------------------------------

export interface UploadedFont {
  id: string;
  family: string;
  weight: number;
  style: FontStyleName;
  fileName: string;
  /** whether opentype.js could parse it (woff2 cannot be parsed) */
  parsable: boolean;
  data: ArrayBuffer;
}

const uploaded: UploadedFont[] = [];
const uploadedFaces = new Map<string, FontFace>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  listeners.forEach((l) => l());
}

export function subscribeFonts(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function fontsVersion(): number {
  return version;
}

/** React hook: re-renders when the registry changes. Returns the version. */
export function useFontRegistry(): number {
  return useSyncExternalStore(subscribeFonts, fontsVersion, fontsVersion);
}

const DB_NAME = 'opuller-fonts';
const DB_STORE = 'fonts';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function dbPut(rec: UploadedFont): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function dbDelete(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function dbGetAll(): Promise<UploadedFont[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve((req.result as UploadedFont[]) ?? []);
    req.onerror = () => resolve([]);
  });
}

function detectFormat(name: string, buf: ArrayBuffer): 'woff2' | 'woff' | 'ttf' | 'otf' | 'unknown' {
  const u8 = new Uint8Array(buf.slice(0, 4));
  const sig = String.fromCharCode(...Array.from(u8));
  if (sig === 'wOF2') return 'woff2';
  if (sig === 'wOFF') return 'woff';
  if (sig === 'OTTO') return 'otf';
  if (sig === 'true' || sig === 'ttcf' || (u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0)) return 'ttf';
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'woff2' || ext === 'woff' || ext === 'ttf' || ext === 'otf') return ext;
  return 'unknown';
}

function metaFromFileName(name: string): { family: string; weight: number; style: FontStyleName } {
  const base = name.replace(/\.[^.]+$/, '');
  const style: FontStyleName = /italic|oblique/i.test(base) ? 'italic' : 'normal';
  let weight = 400;
  if (/thin|hairline/i.test(base)) weight = 100;
  else if (/extralight|ultralight/i.test(base)) weight = 200;
  else if (/light/i.test(base)) weight = 300;
  else if (/medium/i.test(base)) weight = 500;
  else if (/semibold|demibold/i.test(base)) weight = 600;
  else if (/extrabold|ultrabold/i.test(base)) weight = 800;
  else if (/black|heavy/i.test(base)) weight = 900;
  else if (/bold/i.test(base)) weight = 700;
  const family = base
    .replace(/[-_ ]?(thin|hairline|extralight|ultralight|light|regular|medium|semibold|demibold|extrabold|ultrabold|black|heavy|bold|italic|oblique)/gi, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return { family: family || base, weight, style };
}

function metaFromFont(font: opentype.Font, fileName: string): { family: string; weight: number; style: FontStyleName } {
  const fromName = metaFromFileName(fileName);
  let family = '';
  let sub = '';
  try {
    family = font.getEnglishName('preferredFamily') || font.getEnglishName('fontFamily') || '';
    sub = font.getEnglishName('preferredSubfamily') || font.getEnglishName('fontSubfamily') || '';
  } catch {
    /* ignore */
  }
  const os2 = (font.tables as any)?.os2;
  const post = (font.tables as any)?.post;
  let weight = Number(os2?.usWeightClass) || fromName.weight;
  if (weight < 100 || weight > 900) weight = 400;
  weight = Math.round(weight / 100) * 100;
  const italic = !!(os2 && os2.fsSelection & 1) || (post && post.italicAngle !== 0) || /italic|oblique/i.test(sub);
  return { family: family.trim() || fromName.family, weight, style: italic ? 'italic' : 'normal' };
}

function newId(): string {
  return 'f' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function installUploaded(rec: UploadedFont): Promise<boolean> {
  try {
    const face = new FontFace(rec.family, rec.data.slice(0), { weight: String(rec.weight), style: rec.style });
    await face.load();
    document.fonts.add(face);
    uploadedFaces.set(rec.id, face);
    return true;
  } catch (err) {
    console.warn('Font could not be installed', rec.fileName, err);
    return false;
  }
}

/** Upload a TTF/OTF/WOFF/WOFF2 file: registers it with the FontFace API, persists it and returns the record. */
export async function uploadFont(file: File): Promise<UploadedFont> {
  const data = await file.arrayBuffer();
  const format = detectFormat(file.name, data);
  if (format === 'unknown') throw new Error(`"${file.name}" is not a TTF, OTF, WOFF or WOFF2 font file.`);
  let parsed: opentype.Font | null = null;
  if (format !== 'woff2') {
    try {
      parsed = opentype.parse(data.slice(0));
    } catch (err) {
      console.warn('opentype.js could not parse', file.name, err);
    }
  }
  const meta = parsed ? metaFromFont(parsed, file.name) : metaFromFileName(file.name);
  const rec: UploadedFont = { id: newId(), family: meta.family, weight: meta.weight, style: meta.style, fileName: file.name, parsable: !!parsed, data };
  const ok = await installUploaded(rec);
  if (!ok) throw new Error(`The browser could not load "${file.name}".`);
  // replace an existing record for the same face
  const existing = uploaded.findIndex((u) => sameFamily(u.family, rec.family) && u.weight === rec.weight && u.style === rec.style);
  if (existing >= 0) {
    const old = uploaded[existing];
    const oldFace = uploadedFaces.get(old.id);
    if (oldFace) document.fonts.delete(oldFace);
    uploadedFaces.delete(old.id);
    uploaded.splice(existing, 1);
    await dbDelete(old.id);
  }
  uploaded.push(rec);
  if (parsed) parsedFonts.set('upload:' + rec.id, Promise.resolve(parsed));
  await dbPut(rec);
  notify();
  fontsChanged();
  return rec;
}

export async function removeUploadedFont(id: string): Promise<void> {
  const i = uploaded.findIndex((u) => u.id === id);
  if (i < 0) return;
  const face = uploadedFaces.get(id);
  if (face) document.fonts.delete(face);
  uploadedFaces.delete(id);
  uploaded.splice(i, 1);
  parsedFonts.delete('upload:' + id);
  await dbDelete(id);
  notify();
  fontsChanged();
}

export function uploadedFonts(): UploadedFont[] {
  return uploaded.slice();
}

let restored: Promise<void> | null = null;
/** Restore uploaded fonts from IndexedDB (once). */
export function restoreUploadedFonts(): Promise<void> {
  if (restored) return restored;
  restored = (async () => {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
    const recs = await dbGetAll();
    for (const rec of recs) {
      if (uploaded.some((u) => u.id === rec.id)) continue;
      const ok = await installUploaded(rec);
      if (ok) uploaded.push(rec);
    }
    if (recs.length) {
      notify();
      fontsChanged();
    }
  })();
  return restored;
}

// ---------------------------------------------------------------------------
// Registry queries
// ---------------------------------------------------------------------------

export function sameFamily(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function uploadedFamilies(): FontFamilyDef[] {
  const map = new Map<string, FontFamilyDef>();
  for (const u of uploaded) {
    const key = u.family.toLowerCase();
    let def = map.get(key);
    if (!def) {
      def = { family: u.family, category: 'uploaded', source: 'uploaded', faces: [], outlines: true };
      map.set(key, def);
    }
    if (!def.faces.some((f) => f.weight === u.weight && f.style === u.style)) def.faces.push({ weight: u.weight, style: u.style, label: faceLabel(u.weight, u.style) });
    if (!u.parsable) def.outlines = def.outlines && false;
  }
  for (const def of map.values()) def.faces.sort((a, b) => a.weight - b.weight || (a.style === 'normal' ? -1 : 1));
  return Array.from(map.values()).sort((a, b) => a.family.localeCompare(b.family));
}

/** All known families: bundled, uploaded, common system fonts, plus any extra names (e.g. used in the document). */
export function listFamilies(extra: string[] = []): FontFamilyDef[] {
  const out: FontFamilyDef[] = BUNDLED.map((d) => ({ ...d, faces: [...d.faces] }));
  // uploaded faces of a family that already exists (bundled) are merged into it
  for (const u of uploadedFamilies()) {
    const existing = out.find((d) => sameFamily(d.family, u.family));
    if (!existing) {
      out.push(u);
      continue;
    }
    for (const f of u.faces) if (!existing.faces.some((x) => x.weight === f.weight && x.style === f.style)) existing.faces.push(f);
    existing.faces.sort((a, b) => a.weight - b.weight || (a.style === 'normal' ? -1 : 1));
  }
  for (const [f] of SYSTEM_FAMILIES) if (!out.some((d) => sameFamily(d.family, f))) out.push(systemFamilyDef(f));
  for (const name of extra) {
    if (!name || out.some((d) => sameFamily(d.family, name))) continue;
    out.push(systemFamilyDef(name));
  }
  return out;
}

export function familyDef(family: string): FontFamilyDef {
  return listFamilies().find((d) => sameFamily(d.family, family)) ?? systemFamilyDef(family);
}

export function weightsFor(family: string): FontFaceDef[] {
  return familyDef(family).faces;
}

/** Nearest available face for a requested weight/style. */
export function nearestFace(family: string, weight: number, style: FontStyleName): FontFaceDef {
  const fs = weightsFor(family);
  if (!fs.length) return { weight, style, label: faceLabel(weight, style) };
  const same = fs.filter((f) => f.style === style);
  const pool = same.length ? same : fs;
  let best = pool[0];
  for (const f of pool) if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight) || (Math.abs(f.weight - weight) === Math.abs(best.weight - weight) && f.weight > best.weight)) best = f;
  return best;
}

export function isOutlineCapable(family: string): boolean {
  return familyDef(family).outlines;
}

// ---------------------------------------------------------------------------
// Loading (document.fonts)
// ---------------------------------------------------------------------------

const loadedKeys = new Set<string>();

/** Re-layout every text node after fonts changed (metrics differ once a web font is available). */
export function fontsChanged(): void {
  clearMeasureCache();
  invalidateLayouts();
  refreshTextNodes();
}

/**
 * Give every text node a fresh identity so the renderer and cached layouts
 * recompute with the now-available font metrics. Does not create an undo step
 * or mark the document dirty.
 */
export function refreshTextNodes(): void {
  const s = getState();
  let any = false;
  const next = produce(s.doc, (d) => {
    for (const n of Object.values(d.nodes)) {
      if (n.type === 'text') {
        n.style = { ...n.style };
        any = true;
      }
    }
  });
  if (!any || next === s.doc) return;
  if (s.doc === s.historyBase) setState({ doc: next, historyBase: next, docVersion: s.docVersion + 1 });
  else setState({ doc: next, docVersion: s.docVersion + 1 });
}

export function fontSpec(family: string, weight: number, style: FontStyleName, size = 16): string {
  const fam = /[\s,]/.test(family) ? `"${family}"` : family;
  return `${style} ${weight} ${size}px ${fam}`;
}

/** Ensure a face is loaded (web fonts); re-lays out text when it becomes available. */
export function ensureLoaded(family: string, weight: number, style: FontStyleName, text?: string): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const key = `${family.toLowerCase()}|${weight}|${style}|${text ? text.slice(0, 32) : ''}`;
  if (loadedKeys.has(key)) return Promise.resolve();
  const spec = fontSpec(family, weight, style);
  let already = false;
  try {
    already = document.fonts.check(spec, text);
  } catch {
    already = false;
  }
  if (already) {
    loadedKeys.add(key);
    return Promise.resolve();
  }
  return document.fonts
    .load(spec, text)
    .then((faces) => {
      loadedKeys.add(key);
      if (faces.length) fontsChanged();
    })
    .catch(() => undefined);
}

let initialized = false;
/** One-time setup: restore uploaded fonts and watch for late-loading web fonts. */
export function initFonts(): void {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  void restoreUploadedFonts();
  try {
    document.fonts.addEventListener('loadingdone', () => fontsChanged());
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// opentype.js fonts for outlines
// ---------------------------------------------------------------------------

interface CssFace {
  family: string;
  weight: number;
  style: FontStyleName;
  urls: Array<{ url: string; format: string }>;
  ranges: Array<[number, number]> | null;
}

export function parseUnicodeRange(value: string): Array<[number, number]> | null {
  const v = value.trim();
  if (!v) return null;
  const out: Array<[number, number]> = [];
  for (const part of v.split(',')) {
    const m = part.trim().match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/i);
    if (!m) continue;
    if (m[1].includes('?')) {
      const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
      const hi = parseInt(m[1].replace(/\?/g, 'F'), 16);
      out.push([lo, hi]);
    } else {
      const lo = parseInt(m[1], 16);
      const hi = m[2] ? parseInt(m[2], 16) : lo;
      out.push([lo, hi]);
    }
  }
  return out.length ? out : null;
}

export function inRanges(ranges: Array<[number, number]> | null, cp: number): boolean {
  if (!ranges) return true;
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function parseSrc(src: string): Array<{ url: string; format: string }> {
  const out: Array<{ url: string; format: string }> = [];
  const re = /url\((["']?)(.*?)\1\)(?:\s*format\((["']?)(.*?)\3\))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let format = (m[4] ?? '').toLowerCase();
    if (!format) {
      const ext = m[2].split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      format = ext;
    }
    out.push({ url: m[2], format });
  }
  return out;
}

let cssScanCount = -1;
let cssFaces: CssFace[] = [];

function scanCssFaces(): CssFace[] {
  if (typeof document === 'undefined') return [];
  const sheets = Array.from(document.styleSheets);
  let total = 0;
  const faces: CssFace[] = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    total += rules.length;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const family = st.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
      if (!family) continue;
      const weight = parseInt(st.getPropertyValue('font-weight'), 10) || 400;
      const style = /italic|oblique/i.test(st.getPropertyValue('font-style')) ? 'italic' : 'normal';
      const urls = parseSrc(st.getPropertyValue('src'));
      const ranges = parseUnicodeRange(st.getPropertyValue('unicode-range'));
      faces.push({ family, weight, style, urls, ranges });
    }
  }
  if (total !== cssScanCount) {
    cssScanCount = total;
    cssFaces = faces;
  }
  return cssFaces;
}

const parsedFonts = new Map<string, Promise<opentype.Font>>();

function parseFromUrl(url: string): Promise<opentype.Font> {
  let p = parsedFonts.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not fetch font file (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => opentype.parse(buf));
    p.catch(() => parsedFonts.delete(url));
    parsedFonts.set(url, p);
  }
  return p;
}

export interface OutlineSubset {
  font: opentype.Font;
  ranges: Array<[number, number]> | null;
}

export interface OutlineFont {
  family: string;
  weight: number;
  style: FontStyleName;
  subsets: OutlineSubset[];
  /** glyph for a character (null for characters without outlines, e.g. whitespace) */
  glyphFor(ch: string): { font: opentype.Font; glyph: opentype.Glyph } | null;
}

function makeOutlineFont(family: string, weight: number, style: FontStyleName, subsets: OutlineSubset[]): OutlineFont {
  return {
    family,
    weight,
    style,
    subsets,
    glyphFor(ch: string) {
      if (!ch || /\s/.test(ch)) return null;
      const cp = ch.codePointAt(0) ?? 0;
      const ordered = subsets.filter((s) => inRanges(s.ranges, cp)).concat(subsets.filter((s) => !inRanges(s.ranges, cp)));
      for (const s of ordered) {
        try {
          if (s.font.hasChar(ch)) return { font: s.font, glyph: s.font.charToGlyph(ch) };
        } catch {
          /* ignore */
        }
      }
      const first = subsets[0];
      if (!first) return null;
      try {
        return { font: first.font, glyph: first.font.charToGlyph(ch) };
      } catch {
        return null;
      }
    },
  };
}

function pickClosest<T extends { weight: number; style: FontStyleName }>(list: T[], weight: number, style: FontStyleName): T[] {
  if (!list.length) return [];
  const sameStyle = list.filter((f) => f.style === style);
  const pool = sameStyle.length ? sameStyle : list;
  let best = pool[0].weight;
  for (const f of pool) if (Math.abs(f.weight - weight) < Math.abs(best - weight) || (Math.abs(f.weight - weight) === Math.abs(best - weight) && f.weight > best)) best = f.weight;
  const st = pool[0].style;
  return pool.filter((f) => f.weight === best && f.style === st);
}

/**
 * Parsed opentype.js font(s) for a family/weight/style. `text` limits the subsets
 * fetched to those covering the characters. Returns null for fonts that are not
 * available as files (system fonts).
 */
export async function getOpentypeFont(family: string, weight: number, style: FontStyleName, text = ''): Promise<OutlineFont | null> {
  const cps = Array.from(new Set(Array.from(text).map((c) => c.codePointAt(0) ?? 0)));
  // uploaded fonts first
  const ups = uploaded.filter((u) => sameFamily(u.family, family) && u.parsable);
  if (ups.length) {
    const chosen = pickClosest(ups, weight, style);
    const subsets: OutlineSubset[] = [];
    for (const u of chosen) {
      const key = 'upload:' + u.id;
      let p = parsedFonts.get(key);
      if (!p) {
        p = Promise.resolve().then(() => opentype.parse(u.data.slice(0)));
        parsedFonts.set(key, p);
      }
      subsets.push({ font: await p, ranges: null });
    }
    return makeOutlineFont(family, chosen[0].weight, chosen[0].style, subsets);
  }
  const css = scanCssFaces().filter((f) => sameFamily(f.family, family));
  if (!css.length) return null;
  const chosen = pickClosest(css, weight, style);
  let needed = cps.length ? chosen.filter((f) => !f.ranges || cps.some((cp) => inRanges(f.ranges, cp))) : chosen;
  if (!needed.length) needed = chosen.slice(0, 1);
  const subsets: OutlineSubset[] = [];
  const errors: string[] = [];
  for (const f of needed) {
    const src = f.urls.find((u) => u.format === 'woff' || u.format === 'truetype' || u.format === 'opentype' || u.format === 'ttf' || u.format === 'otf');
    if (!src) {
      errors.push('only WOFF2 available');
      continue;
    }
    try {
      subsets.push({ font: await parseFromUrl(src.url), ranges: f.ranges });
    } catch (err: any) {
      errors.push(String(err?.message ?? err));
    }
  }
  if (!subsets.length) throw new Error(`Could not load font files for "${family}"${errors.length ? ` (${errors[0]})` : ''}.`);
  return makeOutlineFont(family, chosen[0].weight, chosen[0].style, subsets);
}
