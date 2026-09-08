/**
 * Artboard operations (pure functions on a Document draft) and size presets.
 */
import type { Document, Artboard, ID, Rect } from '@/model/types';
import { makeArtboard } from '@/model/nodes';
import { worldBounds, getChildren, cloneSubtree, addSubtree, applyParentMatrix, removeNode } from '@/model/document';
import { translate } from '@/geometry/matrix';
import { rectUnion, rectIntersects, rectCenter, rectContainsPoint } from '@/geometry/vec';

export interface ArtboardPreset {
  group: string;
  name: string;
  width: number;
  height: number;
}

/** Sizes in CSS px (96 dpi). */
export const ARTBOARD_PRESETS: ArtboardPreset[] = [
  { group: 'Print', name: 'A3', width: 1123, height: 1587 },
  { group: 'Print', name: 'A4', width: 794, height: 1123 },
  { group: 'Print', name: 'A5', width: 559, height: 794 },
  { group: 'Print', name: 'A6', width: 397, height: 559 },
  { group: 'Print', name: 'US Letter', width: 816, height: 1056 },
  { group: 'Print', name: 'US Legal', width: 816, height: 1344 },
  { group: 'Print', name: 'Tabloid', width: 1056, height: 1632 },
  { group: 'Print', name: 'Business card (3.5 × 2 in)', width: 336, height: 192 },
  { group: 'Print', name: 'Postcard (6 × 4 in)', width: 576, height: 384 },
  { group: 'Web', name: 'Full HD 1920 × 1080', width: 1920, height: 1080 },
  { group: 'Web', name: 'Desktop 1440 × 900', width: 1440, height: 900 },
  { group: 'Web', name: 'Laptop 1366 × 768', width: 1366, height: 768 },
  { group: 'Web', name: 'HD 1280 × 720', width: 1280, height: 720 },
  { group: 'Web', name: '4K UHD 3840 × 2160', width: 3840, height: 2160 },
  { group: 'Mobile', name: 'iPhone 15 / 14 (393 × 852)', width: 393, height: 852 },
  { group: 'Mobile', name: 'iPhone SE (375 × 667)', width: 375, height: 667 },
  { group: 'Mobile', name: 'Android (360 × 800)', width: 360, height: 800 },
  { group: 'Mobile', name: 'iPad (820 × 1180)', width: 820, height: 1180 },
  { group: 'Mobile', name: 'iPad Pro 12.9 (1024 × 1366)', width: 1024, height: 1366 },
  { group: 'Social', name: 'Instagram post (1080 × 1080)', width: 1080, height: 1080 },
  { group: 'Social', name: 'Instagram portrait (1080 × 1350)', width: 1080, height: 1350 },
  { group: 'Social', name: 'Story / Reel (1080 × 1920)', width: 1080, height: 1920 },
  { group: 'Social', name: 'X / Twitter post (1600 × 900)', width: 1600, height: 900 },
  { group: 'Social', name: 'X / Twitter header (1500 × 500)', width: 1500, height: 500 },
  { group: 'Social', name: 'Facebook cover (820 × 312)', width: 820, height: 312 },
  { group: 'Social', name: 'YouTube thumbnail (1280 × 720)', width: 1280, height: 720 },
  { group: 'Social', name: 'LinkedIn banner (1584 × 396)', width: 1584, height: 396 },
  { group: 'Icons', name: 'Icon 1024 × 1024', width: 1024, height: 1024 },
  { group: 'Icons', name: 'Icon 512 × 512', width: 512, height: 512 },
  { group: 'Icons', name: 'Icon 256 × 256', width: 256, height: 256 },
  { group: 'Icons', name: 'Icon 128 × 128', width: 128, height: 128 },
  { group: 'Icons', name: 'Favicon 64 × 64', width: 64, height: 64 },
  { group: 'Icons', name: 'Favicon 32 × 32', width: 32, height: 32 },
];

export const ARTBOARD_GAP = 100;

export function getArtboard(doc: Document, id: ID | null | undefined): Artboard | undefined {
  return id ? doc.artboards.find((a) => a.id === id) : undefined;
}

export function artboardRect(a: Artboard): Rect {
  return { x: a.x, y: a.y, width: a.width, height: a.height };
}

export function uniqueArtboardName(doc: Document, base: string, ignoreId?: ID): string {
  const names = new Set(doc.artboards.filter((a) => a.id !== ignoreId).map((a) => a.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function nextArtboardName(doc: Document): string {
  let i = doc.artboards.length + 1;
  const names = new Set(doc.artboards.map((a) => a.name));
  while (names.has(`Artboard ${i}`)) i++;
  return `Artboard ${i}`;
}

/** A free spot to the right of the right-most artboard (top aligned with it). */
export function nextFreePosition(doc: Document, width: number, height: number): { x: number; y: number } {
  if (!doc.artboards.length) return { x: 0, y: 0 };
  let rightMost = doc.artboards[0];
  for (const a of doc.artboards) if (a.x + a.width > rightMost.x + rightMost.width) rightMost = a;
  const x = rightMost.x + rightMost.width + ARTBOARD_GAP;
  const y = rightMost.y;
  void width;
  void height;
  return { x, y };
}

/** Add an artboard; when no position is given it is placed next to the others. */
export function addArtboard(doc: Document, spec: Partial<Artboard> = {}): Artboard {
  const width = Math.max(1, spec.width ?? (doc.artboards[0]?.width ?? 1920));
  const height = Math.max(1, spec.height ?? (doc.artboards[0]?.height ?? 1080));
  const pos = spec.x !== undefined && spec.y !== undefined ? { x: spec.x, y: spec.y } : nextFreePosition(doc, width, height);
  const ab = makeArtboard(
    {
      ...spec,
      name: spec.name ? uniqueArtboardName(doc, spec.name) : nextArtboardName(doc),
      width,
      height,
      x: pos.x,
      y: pos.y,
      background: spec.background ?? doc.artboards[0]?.background ?? '#ffffff',
      transparent: spec.transparent ?? doc.artboards[0]?.transparent ?? false,
    },
    doc.artboards.length,
  );
  doc.artboards.push(ab);
  return ab;
}

/** Top-level objects (children of layers) whose bounds centre lies inside the artboard. */
export function artworkOnArtboard(doc: Document, ab: Artboard, mode: 'center' | 'intersect' = 'center'): ID[] {
  const r = artboardRect(ab);
  const out: ID[] = [];
  for (const layerId of doc.layers) {
    for (const id of getChildren(doc, layerId)) {
      const b = worldBounds(doc, id);
      if (!b) continue;
      if (mode === 'center' ? rectContainsPoint(r, rectCenter(b)) : rectIntersects(r, b)) out.push(id);
    }
  }
  return out;
}

/** Duplicate an artboard (and optionally the artwork on it) to the right of all artboards. */
export function duplicateArtboard(doc: Document, id: ID, withArtwork = true): Artboard | null {
  const src = getArtboard(doc, id);
  if (!src) return null;
  const pos = nextFreePosition(doc, src.width, src.height);
  const copy = addArtboard(doc, { ...src, id: undefined, name: uniqueArtboardName(doc, `${src.name} copy`), x: pos.x, y: pos.y });
  if (withArtwork) {
    const dx = copy.x - src.x;
    const dy = copy.y - src.y;
    for (const nid of artworkOnArtboard(doc, src)) {
      const n = doc.nodes[nid];
      if (!n) continue;
      const { root, nodes } = cloneSubtree(doc, nid);
      const parentId = n.parent;
      const siblings = getChildren(doc, parentId);
      addSubtree(doc, root, nodes, parentId, siblings.indexOf(nid) + 1);
      applyParentMatrix(doc, root.id, translate(dx, dy));
    }
  }
  return copy;
}

/** Delete an artboard (never the last one). Optionally deletes the artwork on it. */
export function deleteArtboard(doc: Document, id: ID, deleteArtwork = false): boolean {
  if (doc.artboards.length <= 1) return false;
  const ab = getArtboard(doc, id);
  if (!ab) return false;
  if (deleteArtwork) for (const nid of artworkOnArtboard(doc, ab)) removeNode(doc, nid);
  doc.artboards = doc.artboards.filter((a) => a.id !== id);
  return true;
}

export function moveArtboard(doc: Document, id: ID, dx: number, dy: number, moveArtwork: boolean, artworkIds?: ID[]): void {
  const ab = getArtboard(doc, id);
  if (!ab) return;
  const ids = moveArtwork ? (artworkIds ?? artworkOnArtboard(doc, ab)) : [];
  ab.x += dx;
  ab.y += dy;
  for (const nid of ids) if (doc.nodes[nid]) applyParentMatrix(doc, nid, translate(dx, dy));
}

/** Bounds of the artwork on an artboard (or of the given ids). */
export function artworkBounds(doc: Document, ids: ID[]): Rect | null {
  let r: Rect | null = null;
  for (const id of ids) r = rectUnion(r, worldBounds(doc, id));
  return r;
}

/** Resize the artboard to the artwork bounds (all art on it, or the given ids). */
export function fitArtboardToArtwork(doc: Document, id: ID, ids?: ID[], padding = 0): boolean {
  const ab = getArtboard(doc, id);
  if (!ab) return false;
  const targets = ids ?? artworkOnArtboard(doc, ab, 'intersect');
  const b = artworkBounds(doc, targets);
  if (!b || b.width <= 0 || b.height <= 0) return false;
  ab.x = Math.round((b.x - padding) * 100) / 100;
  ab.y = Math.round((b.y - padding) * 100) / 100;
  ab.width = Math.max(1, Math.round((b.width + padding * 2) * 100) / 100);
  ab.height = Math.max(1, Math.round((b.height + padding * 2) * 100) / 100);
  return true;
}

export interface RearrangeOptions {
  columns: number;
  spacing: number;
  /** 'row' = left-to-right then down, 'column' = top-to-bottom then right */
  layout: 'row' | 'column';
  moveArtwork: boolean;
}

/** Lay the artboards out in a grid starting at the first artboard's position. */
export function rearrangeArtboards(doc: Document, opts: RearrangeOptions): void {
  const list = doc.artboards;
  if (!list.length) return;
  const cols = Math.max(1, Math.min(list.length, Math.round(opts.columns)));
  const rows = Math.ceil(list.length / cols);
  const origin = { x: list[0].x, y: list[0].y };
  // column widths / row heights
  const cellW: number[] = [];
  const cellH: number[] = [];
  list.forEach((a, i) => {
    const c = opts.layout === 'row' ? i % cols : Math.floor(i / rows);
    const r = opts.layout === 'row' ? Math.floor(i / cols) : i % rows;
    cellW[c] = Math.max(cellW[c] ?? 0, a.width);
    cellH[r] = Math.max(cellH[r] ?? 0, a.height);
  });
  const colX: number[] = [];
  let x = origin.x;
  for (let c = 0; c < cellW.length; c++) {
    colX[c] = x;
    x += cellW[c] + opts.spacing;
  }
  const rowY: number[] = [];
  let y = origin.y;
  for (let r = 0; r < cellH.length; r++) {
    rowY[r] = y;
    y += cellH[r] + opts.spacing;
  }
  // gather artwork per artboard before moving anything
  const art = list.map((a) => (opts.moveArtwork ? artworkOnArtboard(doc, a) : []));
  list.forEach((a, i) => {
    const c = opts.layout === 'row' ? i % cols : Math.floor(i / rows);
    const r = opts.layout === 'row' ? Math.floor(i / cols) : i % rows;
    const nx = colX[c];
    const ny = rowY[r];
    moveArtboard(doc, a.id, nx - a.x, ny - a.y, opts.moveArtwork, art[i]);
  });
}

export function reorderArtboard(doc: Document, id: ID, newIndex: number): void {
  const i = doc.artboards.findIndex((a) => a.id === id);
  if (i < 0) return;
  const [ab] = doc.artboards.splice(i, 1);
  const idx = Math.max(0, Math.min(doc.artboards.length, newIndex));
  doc.artboards.splice(idx, 0, ab);
}

/** Convert selected objects into artboards (their world bounds); the objects are removed. */
export function convertToArtboards(doc: Document, ids: ID[]): Artboard[] {
  const out: Artboard[] = [];
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n || n.type === 'layer') continue;
    const b = worldBounds(doc, id);
    if (!b || b.width < 1 || b.height < 1) continue;
    let bg: string | undefined;
    if (n.type === 'path' && n.fill.type === 'solid') bg = n.fill.color;
    const ab = addArtboard(doc, { x: b.x, y: b.y, width: b.width, height: b.height, name: n.name && n.name !== 'Rectangle' ? n.name : undefined, background: bg });
    out.push(ab);
    removeNode(doc, id);
  }
  return out;
}

export function presetFor(width: number, height: number): ArtboardPreset | undefined {
  return ARTBOARD_PRESETS.find((p) => (p.width === width && p.height === height) || (p.width === height && p.height === width));
}
