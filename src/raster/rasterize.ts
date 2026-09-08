/**
 * Rasterize: render selected objects to a bitmap and replace them with an
 * image node. Crop helpers for image nodes.
 */
import type { Document, ID, ImageNode, Rect } from '@/model/types';
import { getState } from '@/store/store';
import { makeImage } from '@/model/nodes';
import { addNode, removeNode, worldBounds, topmostOf, sortByPaintOrder, indexInParent, worldMatrix, applyWorldMatrix } from '@/model/document';
import { translate, invert, applyToPoint } from '@/geometry/matrix';
import { rectUnion } from '@/geometry/vec';
import { renderToDataUrl } from '@/io/raster';

export interface RasterizeOptions {
  /** pixels per inch (72 screen, 150 medium, 300 high) */
  ppi: number;
  background: 'white' | 'transparent';
  /** keep the vector originals (the image is added on top) */
  keepOriginal: boolean;
  /** extra transparent margin around the objects (px) */
  margin: number;
}

export const DEFAULT_RASTERIZE: RasterizeOptions = { ppi: 150, background: 'transparent', keepOriginal: false, margin: 0 };

export async function rasterizeSelection(opts: RasterizeOptions): Promise<ID | null> {
  const s = getState();
  const roots = sortByPaintOrder(s.doc, topmostOf(s.doc, s.selection)).filter((id) => s.doc.nodes[id]?.type !== 'layer');
  if (!roots.length) return null;
  let bounds: Rect | null = null;
  for (const id of roots) bounds = rectUnion(bounds, worldBounds(s.doc, id));
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const scale = Math.max(0.05, opts.ppi / 96);
  const r = await renderToDataUrl(s.doc, {
    scope: 'selection',
    ids: roots,
    scale,
    format: 'png',
    backgroundColor: opts.background === 'white' ? '#ffffff' : null,
    margin: opts.margin,
    maxSize: 8192,
  });
  const st = getState();
  const top = roots[roots.length - 1];
  const parent = st.doc.nodes[top]?.parent ?? null;
  const index = indexInParent(st.doc, top);
  const m = opts.margin;
  const node = makeImage(r.dataUrl, r.width, r.height, {
    name: 'Rasterized',
    width: bounds.width + m * 2,
    height: bounds.height + m * 2,
    transform: translate(bounds.x - m, bounds.y - m),
  });
  st.updateDoc((d) => {
    addNode(d, node, parent, index + 1);
    if (!opts.keepOriginal) for (const id of roots) removeNode(d, id);
  }, 'Rasterize');
  getState().setSelection([node.id]);
  return node.id;
}

/** Crop an image node to a world rectangle (intersection with the image). */
export function cropImageToRect(draft: Document, imageId: ID, world: Rect): boolean {
  const n = draft.nodes[imageId] as ImageNode | undefined;
  if (!n || n.type !== 'image') return false;
  const inv = invert(worldMatrix(draft, imageId));
  const a = applyToPoint(inv, { x: world.x, y: world.y });
  const b = applyToPoint(inv, { x: world.x + world.width, y: world.y + world.height });
  // local display rect → natural pixels
  const crop = n.crop ?? { x: 0, y: 0, width: n.naturalWidth, height: n.naturalHeight };
  const kx = crop.width / n.width;
  const ky = crop.height / n.height;
  const lx1 = Math.max(0, Math.min(a.x, b.x));
  const ly1 = Math.max(0, Math.min(a.y, b.y));
  const lx2 = Math.min(n.width, Math.max(a.x, b.x));
  const ly2 = Math.min(n.height, Math.max(a.y, b.y));
  if (lx2 - lx1 < 1 || ly2 - ly1 < 1) return false;
  const next: Rect = { x: crop.x + lx1 * kx, y: crop.y + ly1 * ky, width: (lx2 - lx1) * kx, height: (ly2 - ly1) * ky };
  n.crop = next;
  n.width = lx2 - lx1;
  n.height = ly2 - ly1;
  // keep the cropped part where it was
  applyWorldMatrix(draft, imageId, translate(0, 0), false);
  n.transform = { ...n.transform, e: n.transform.e + n.transform.a * lx1 + n.transform.c * ly1, f: n.transform.f + n.transform.b * lx1 + n.transform.d * ly1 };
  return true;
}

export function setImageCrop(draft: Document, imageId: ID, crop: Rect | null): void {
  const n = draft.nodes[imageId] as ImageNode | undefined;
  if (!n || n.type !== 'image') return;
  const old = n.crop ?? { x: 0, y: 0, width: n.naturalWidth, height: n.naturalHeight };
  const next = crop
    ? {
        x: Math.max(0, Math.min(n.naturalWidth - 1, crop.x)),
        y: Math.max(0, Math.min(n.naturalHeight - 1, crop.y)),
        width: Math.max(1, Math.min(n.naturalWidth - Math.max(0, crop.x), crop.width)),
        height: Math.max(1, Math.min(n.naturalHeight - Math.max(0, crop.y), crop.height)),
      }
    : { x: 0, y: 0, width: n.naturalWidth, height: n.naturalHeight };
  // keep the pixel scale: displayed size follows the crop size
  const kx = n.width / old.width;
  const ky = n.height / old.height;
  n.width = next.width * kx;
  n.height = next.height * ky;
  n.crop = crop ? next : undefined;
}
