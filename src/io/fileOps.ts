/**
 * Document-level file operations shared by the File menu, dialogs, drag & drop
 * and the clipboard: new / open / save / revert / place.
 */
import type { Document, ID, Node, Vec, Rect, Artboard } from '@/model/types';
import { getState, setState } from '@/store/store';
import { createDocument, makeImage, makeGroup, makeText, type NewDocumentOptions } from '@/model/nodes';
import { addNode, addSubtree, bakeTransform, worldBounds, parentWorldMatrix, cloneSubtree } from '@/model/document';
import { multiply, translate, scale, invert, identity } from '@/geometry/matrix';
import { rectUnion } from '@/geometry/vec';
import { saveFile, readAsText, readAsDataUrl, loadImage, baseName, extensionOf, hasFSAccess, type OpenedFile } from '@/util/files';
import { insertionParent } from '@/tools/shapes/tool';
import { serializeProject, parseProject, isProjectJson, PROJECT_EXTENSION, PROJECT_MIME } from './project';
import { importSvg, itemsToLayers, looksLikeSvg, type ImportedItem } from './svgImport';
import { safeFileName } from './svgExport';
import { addRecent } from './recent';
import { clearAutosave } from './autosave';

export const OPEN_ACCEPT = '.opuller,.json,.svg,image/*';
export const PLACE_ACCEPT = '.svg,image/*';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']);

export function isImageFile(file: File): boolean {
  return (file.type && file.type.startsWith('image/') && file.type !== 'image/svg+xml') || IMAGE_EXTENSIONS.has(extensionOf(file.name));
}

export function isSvgFile(file: File): boolean {
  return file.type === 'image/svg+xml' || extensionOf(file.name) === 'svg';
}

export function isProjectFile(file: File): boolean {
  const ext = extensionOf(file.name);
  return ext === 'opuller' || ext === 'json';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function activeArtboard(doc = getState().doc, id = getState().activeArtboardId): Artboard | undefined {
  return doc.artboards.find((a) => a.id === id) ?? doc.artboards[0];
}

/** Centre of the visible viewport in world coordinates. */
export function viewCenter(): Vec {
  const s = getState();
  return { x: (s.viewportSize.width / 2 - s.pan.x) / s.zoom, y: (s.viewportSize.height / 2 - s.pan.y) / s.zoom };
}

function fitView(doc: Document): void {
  const ab = doc.artboards[0];
  if (ab) getState().zoomToRect(ab, 40);
}

/** Install a document as the current one (resets history) and remember it. */
export function loadDocument(doc: Document, opts: { fileName?: string | null; handle?: FileSystemFileHandle | null; remember?: boolean; dirty?: boolean } = {}): void {
  const s = getState();
  s.setDocument(doc, { fileName: opts.fileName ?? null, handle: opts.handle ?? null });
  if (opts.dirty) setState({ dirty: true });
  fitView(doc);
  s.setStatus(`Opened ${opts.fileName ?? doc.name}`);
  if (opts.remember !== false) void addRecent(doc, opts.fileName ?? null);
}

export function newDocument(opts: NewDocumentOptions = {}): Document {
  const doc = createDocument(opts);
  getState().setDocument(doc);
  fitView(doc);
  void clearAutosave();
  return doc;
}

// ---------------------------------------------------------------------------
// Conversions to documents
// ---------------------------------------------------------------------------

/** Build a document from SVG markup: the artboard matches the SVG size, top-level groups become layers. */
export function documentFromSvg(svgText: string, name: string): { doc: Document; warnings: string[] } {
  const res = importSvg(svgText, { name });
  const width = Math.max(1, Math.round(res.width * 1000) / 1000);
  const height = Math.max(1, Math.round(res.height * 1000) / 1000);
  const doc = createDocument({ name, width, height });
  const layers = itemsToLayers(res.items);
  doc.nodes = {};
  doc.layers = [];
  for (const item of layers) {
    for (const n of item.nodes) doc.nodes[n.id] = n;
    item.root.parent = null;
    doc.layers.push(item.root.id);
  }
  return { doc, warnings: res.warnings };
}

export async function documentFromImage(blob: Blob, name: string): Promise<Document> {
  const dataUrl = await readAsDataUrl(blob);
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || 100;
  const h = img.naturalHeight || 100;
  const doc = createDocument({ name, width: w, height: h });
  const node = makeImage(dataUrl, w, h, { name });
  addNode(doc, node, doc.layers[0]);
  return doc;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function openDocumentFromFile(file: File, handle: FileSystemFileHandle | null = null): Promise<void> {
  const s = getState();
  const name = baseName(file.name);
  if (isProjectFile(file)) {
    const text = await readAsText(file);
    const doc = parseProject(text);
    doc.name = doc.name || name;
    loadDocument(doc, { fileName: file.name, handle });
    return;
  }
  if (isSvgFile(file)) {
    const text = await readAsText(file);
    const { doc, warnings } = documentFromSvg(text, name);
    loadDocument(doc, { fileName: null, handle: null, dirty: true });
    if (warnings.length) s.toast(`Imported with notes: ${warnings[0]}`, 'info');
    return;
  }
  if (isImageFile(file)) {
    const doc = await documentFromImage(file, name);
    loadDocument(doc, { fileName: null, handle: null, dirty: true });
    return;
  }
  // unknown extension: sniff the content
  const text = await readAsText(file);
  if (isProjectJson(text)) {
    const doc = parseProject(text);
    loadDocument(doc, { fileName: file.name, handle });
    return;
  }
  if (looksLikeSvg(text)) {
    const { doc } = documentFromSvg(text, name);
    loadDocument(doc, { fileName: null, dirty: true });
    return;
  }
  throw new Error(`Cannot open "${file.name}": unsupported file type.`);
}

/** Open the first file as a document and place the rest. */
export async function openFiles(files: OpenedFile[]): Promise<void> {
  if (!files.length) return;
  await openDocumentFromFile(files[0].file, files[0].handle);
  if (files.length > 1) await placeFiles(files.slice(1).map((f) => f.file));
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function projectFileName(): string {
  const s = getState();
  if (s.fileName && extensionOf(s.fileName) === 'opuller') return s.fileName;
  return safeFileName(s.doc.name) + PROJECT_EXTENSION;
}

/**
 * Save the document. Uses the existing file handle when available (silent save),
 * otherwise shows a save dialog (or downloads when the File System Access API
 * is missing). Returns true when the document was written.
 */
export async function saveDocument(saveAs = false): Promise<boolean> {
  const s = getState();
  const json = await serializeProject(s.doc);
  const blob = new Blob([json], { type: PROJECT_MIME });
  const suggestedName = projectFileName();
  const existing = saveAs ? null : s.fileHandle;
  s.setStatus('Saving…');
  const handle = await saveFile(blob, { suggestedName, mime: PROJECT_MIME, extension: PROJECT_EXTENSION, description: 'OPuller document' }, existing);
  if (handle) {
    setState({ fileHandle: handle, fileName: handle.name });
  } else if (hasFSAccess) {
    // picker cancelled
    s.setStatus('');
    return false;
  } else {
    setState({ fileName: suggestedName, fileHandle: null });
  }
  const st = getState();
  st.markSaved();
  st.setStatus(`Saved ${st.fileName ?? suggestedName}`);
  st.toast(`Saved ${st.fileName ?? suggestedName}`, 'success');
  void addRecent(st.doc, st.fileName);
  void clearAutosave();
  return true;
}

/** Reload the document from its file handle (or the stored recent copy). */
export async function revertDocument(): Promise<boolean> {
  const s = getState();
  if (s.fileHandle) {
    const file = await s.fileHandle.getFile();
    const text = await readAsText(file);
    const doc = parseProject(text);
    loadDocument(doc, { fileName: s.fileName, handle: s.fileHandle, remember: false });
    return true;
  }
  const { loadRecent } = await import('./recent');
  const doc = await loadRecent(s.doc.id);
  if (!doc) return false;
  loadDocument(doc, { fileName: s.fileName, remember: false });
  return true;
}

export function canRevert(): boolean {
  const s = getState();
  return s.dirty && (!!s.fileHandle || !!s.fileName);
}

// ---------------------------------------------------------------------------
// Unsaved changes
// ---------------------------------------------------------------------------

export type DiscardChoice = 'save' | 'discard' | 'cancel';

/**
 * When the document has unsaved changes, ask the user (Save / Don't Save /
 * Cancel). Resolves true when the caller may proceed.
 */
export function confirmDiscard(action = 'continue'): Promise<boolean> {
  const s = getState();
  if (!s.dirty) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    s.openDialog('io.unsavedChanges', {
      action,
      name: s.fileName ?? s.doc.name,
      onChoice: async (choice: DiscardChoice) => {
        if (choice === 'cancel') return resolve(false);
        if (choice === 'discard') return resolve(true);
        try {
          resolve(await saveDocument(false));
        } catch (e: any) {
          getState().toast(String(e?.message ?? e), 'error');
          resolve(false);
        }
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Place (import into the current document)
// ---------------------------------------------------------------------------

export interface PlaceOptions {
  /** world position of the centre (defaults to the active artboard centre) */
  at?: Vec;
  /** scale down to fit inside the artboard when larger (default true) */
  fit?: boolean;
  /** group name when several items are placed */
  name?: string;
  label?: string;
  /** select the placed nodes (default true) */
  select?: boolean;
}

function boundsOfItems(doc: Document, items: ImportedItem[]): Rect | null {
  const tmp: Document = { ...doc, nodes: { ...doc.nodes } };
  for (const it of items) for (const n of it.nodes) tmp.nodes[n.id] = n;
  let r: Rect | null = null;
  for (const it of items) r = rectUnion(r, worldBounds(tmp, it.root.id));
  return r;
}

/**
 * Insert imported items into the document centred at `at` (or the artboard
 * centre), scaled to fit inside the artboard when they are larger. One history
 * step. Returns the ids of the inserted roots.
 */
export function placeItems(items: ImportedItem[], opts: PlaceOptions = {}): ID[] {
  const s = getState();
  if (!items.length) return [];
  const parent = insertionParent();
  if (!parent) return [];
  const ab = activeArtboard();
  const bounds = boundsOfItems(s.doc, items);
  const center = opts.at ?? (ab ? { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 } : viewCenter());
  let m = identity();
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    let k = 1;
    if ((opts.fit ?? true) && ab) k = Math.min(1, ab.width / bounds.width, ab.height / bounds.height);
    const bc = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    m = multiply(translate(center.x - bc.x * k, center.y - bc.y * k), scale(k, k));
  } else if (bounds) {
    m = translate(center.x - bounds.x, center.y - bounds.y);
  }
  const ids: ID[] = [];
  s.updateDoc((d) => {
    const inv = invert(multiply(parentWorldMatrix(d, parent), d.nodes[parent].transform));
    let group: Node | null = null;
    if (items.length > 1) {
      group = makeGroup([], { name: opts.name ?? 'Placed' });
      group.transform = multiply(inv, m);
      addNode(d, group, parent);
    }
    for (const it of items) {
      // fresh ids in case the same items are placed twice
      const tmp: Document = { ...d, nodes: { ...d.nodes } };
      for (const n of it.nodes) tmp.nodes[n.id] = n;
      const { root, nodes } = cloneSubtree(tmp, it.root.id);
      root.transform = group ? root.transform : multiply(inv, multiply(m, root.transform));
      addSubtree(d, root, nodes, group ? group.id : parent);
      if (root.type === 'path') bakeTransform(d, root.id);
      ids.push(root.id);
    }
    if (group) {
      ids.length = 0;
      ids.push(group.id);
    }
  }, opts.label ?? 'Place');
  if (opts.select !== false) getState().setSelection(ids);
  return ids;
}

/** Place SVG markup into the current document. */
export function placeSvgText(svgText: string, opts: PlaceOptions = {}): ID[] {
  const res = importSvg(svgText, { name: opts.name });
  if (!res.items.length) throw new Error('The SVG contains nothing to place.');
  const ids = placeItems(res.items, { ...opts, name: opts.name ?? 'SVG' });
  if (res.warnings.length) getState().toast(res.warnings[0], 'info');
  return ids;
}

/** Place a raster image (blob / file) into the current document. */
export async function placeImageBlob(blob: Blob, opts: PlaceOptions = {}): Promise<ID[]> {
  const dataUrl = await readAsDataUrl(blob);
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || 100;
  const h = img.naturalHeight || 100;
  const node = makeImage(dataUrl, w, h, { name: opts.name ?? 'Image' });
  node.parent = null;
  return placeItems([{ root: node, nodes: [node] }], { ...opts, label: opts.label ?? 'Place Image' });
}

/** Place plain text as a point text object. */
export function placeText(text: string, opts: PlaceOptions = {}): ID[] {
  const s = getState();
  const node = makeText(text.replace(/\r\n?/g, '\n'), { style: s.appearance.textStyle, fill: s.appearance.fill.type === 'none' ? { type: 'solid', color: '#000000', opacity: 1 } : s.appearance.fill });
  node.parent = null;
  return placeItems([{ root: node, nodes: [node] }], { ...opts, fit: false, label: opts.label ?? 'Paste Text' });
}

/** Place files (images / SVG / project files as SVG-less imports) into the current document. */
export async function placeFiles(files: File[], opts: PlaceOptions = {}): Promise<ID[]> {
  const s = getState();
  const ids: ID[] = [];
  let offset = 0;
  for (const file of files) {
    const at = opts.at ? { x: opts.at.x + offset, y: opts.at.y + offset } : undefined;
    try {
      if (isSvgFile(file)) {
        const text = await readAsText(file);
        ids.push(...placeSvgText(text, { ...opts, at, name: baseName(file.name) }));
      } else if (isImageFile(file)) {
        ids.push(...(await placeImageBlob(file, { ...opts, at, name: baseName(file.name) })));
      } else if (isProjectFile(file)) {
        const text = await readAsText(file);
        const doc = parseProject(text);
        const items: ImportedItem[] = doc.layers.map((lid) => {
          const layer = doc.nodes[lid];
          const g = makeGroup([], { name: layer.name, visible: layer.visible, locked: layer.locked });
          const nodes: Node[] = [g];
          if (layer.type === 'layer') {
            for (const cid of layer.children) {
              const child = doc.nodes[cid];
              child.parent = g.id;
              g.children.push(cid);
              const collect = (n: Node) => {
                nodes.push(n);
                if (n.type === 'group') for (const c of n.children) collect(doc.nodes[c]);
              };
              collect(child);
            }
          }
          return { root: g, nodes };
        });
        ids.push(...placeItems(items, { ...opts, at, name: baseName(file.name), fit: false }));
      } else {
        s.toast(`Unsupported file: ${file.name}`, 'error');
      }
    } catch (e: any) {
      s.toast(`Could not place ${file.name}: ${e?.message ?? e}`, 'error');
    }
    offset += 20;
  }
  if (ids.length) {
    getState().setSelection(ids);
    getState().setStatus(`Placed ${ids.length} item${ids.length > 1 ? 's' : ''}`);
  }
  return ids;
}
