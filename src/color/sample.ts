/**
 * Eyedropper logic: sample the appearance of a node and apply it to the
 * selection / defaults, or push the current appearance onto a node. Images are
 * sampled per pixel through an offscreen canvas.
 */
import type { Document, ID, Paint, StrokeStyle, TextStyle, ImageNode, Vec, HexColor } from '@/model/types';
import { getState } from '@/store/store';
import { worldMatrix, localBounds } from '@/model/document';
import { applyToPoint, invert } from '@/geometry/matrix';
import { clonePaint, cloneStroke } from '@/model/nodes';
import { setFillPaint, setStrokePaint, setStrokeProps, setTextStyle, setNodeProps, currentAppearance, type CurrentAppearance } from '@/commands/appearance';
import { rgbToHex } from '@/util/color';
import { gradientColorAt } from './gradient';
import { isGradient } from './paint';

export type EyedropperOptions = {
  fill: boolean;
  stroke: boolean;
  strokeOptions: boolean;
  textStyle: boolean;
  opacity: boolean;
}

export const DEFAULT_EYEDROPPER_OPTIONS: EyedropperOptions = { fill: true, stroke: true, strokeOptions: true, textStyle: true, opacity: false };

export interface Sample {
  fill?: Paint;
  stroke?: StrokeStyle;
  textStyle?: TextStyle;
  opacity?: number;
}

/** Appearance of a leaf node (paths/text have paints; images only opacity). */
export function sampleNode(doc: Document, id: ID): Sample | null {
  const n = doc.nodes[id];
  if (!n) return null;
  if (n.type === 'path' || n.type === 'text') {
    const s: Sample = { fill: clonePaint(n.fill), stroke: cloneStroke(n.stroke), opacity: n.opacity };
    if (n.type === 'text') s.textStyle = { ...n.style };
    return s;
  }
  if (n.type === 'image') return { opacity: n.opacity };
  return null;
}

function strokePropsOf(s: StrokeStyle): Partial<Omit<StrokeStyle, 'paint'>> {
  const { paint, ...rest } = s;
  void paint;
  return { ...rest, dash: [...rest.dash], widthProfile: rest.widthProfile ? rest.widthProfile.map((p) => ({ ...p })) : undefined };
}

/** Apply a sample to the selection (or the defaults) as one history step. */
export function applySample(sample: Sample, opts: EyedropperOptions, label = 'Eyedropper'): void {
  const s = getState();
  if (opts.fill && sample.fill) setFillPaint(sample.fill, false);
  if (opts.stroke && sample.stroke) setStrokePaint(sample.stroke.paint, false);
  if (opts.strokeOptions && sample.stroke) setStrokeProps(strokePropsOf(sample.stroke), false);
  if (opts.textStyle && sample.textStyle) setTextStyle(sample.textStyle, false);
  if (opts.opacity && sample.opacity !== undefined && s.selection.length) setNodeProps({ opacity: sample.opacity }, false);
  s.commit(label);
}

/** Push the current appearance (selection or defaults) onto one node (Alt-click). */
export function applyAppearanceToNode(id: ID, opts: EyedropperOptions, app: CurrentAppearance = currentAppearance(), label = 'Eyedropper'): void {
  const s = getState();
  s.updateDoc((d) => {
    const n = d.nodes[id];
    if (!n) return;
    if (n.type === 'path' || n.type === 'text') {
      if (opts.fill) n.fill = clonePaint(app.fill);
      if (opts.stroke) n.stroke = { ...n.stroke, paint: clonePaint(app.stroke.paint) };
      if (opts.strokeOptions) n.stroke = { ...n.stroke, ...strokePropsOf(app.stroke) };
      if (opts.textStyle && n.type === 'text') {
        n.style = { ...app.textStyle };
        for (const r of n.runs) delete r.style;
      }
    }
    if (opts.opacity && app.opacity !== null) n.opacity = app.opacity;
  }, label);
}

/**
 * Colour of a path/text node at a world point: solid fill, or the gradient
 * colour at that point; falls back to the stroke when the fill is none.
 */
export function sampleColorAt(doc: Document, id: ID, world: Vec, preferStroke = false): { color: HexColor; opacity: number } | null {
  const n = doc.nodes[id];
  if (!n || (n.type !== 'path' && n.type !== 'text')) return null;
  const paints = preferStroke ? [n.stroke.paint, n.fill] : [n.fill, n.stroke.paint];
  for (const p of paints) {
    if (p.type === 'solid') return { color: p.color, opacity: p.opacity };
    if (isGradient(p)) {
      const b = localBounds(doc, id);
      if (!b) continue;
      const local = applyToPoint(invert(worldMatrix(doc, id)), world);
      const u = (local.x - b.x) / Math.max(b.width, 1e-6);
      const v = (local.y - b.y) / Math.max(b.height, 1e-6);
      return gradientColorAt(p, u, v);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image pixels
// ---------------------------------------------------------------------------

const imageCache = new Map<string, HTMLImageElement>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached && cached.complete && cached.naturalWidth) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = cached ?? new Image();
    if (!cached) {
      img.crossOrigin = 'anonymous';
      imageCache.set(src, img);
      img.src = src;
    }
    if (img.complete && img.naturalWidth) {
      resolve(img);
      return;
    }
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', () => reject(new Error('Image failed to load')), { once: true });
  });
}

/** Read the pixel colour of an image node at a world point (null when outside/unreadable). */
export async function sampleImagePixel(doc: Document, id: ID, world: Vec): Promise<{ color: HexColor; opacity: number } | null> {
  const n = doc.nodes[id] as ImageNode | undefined;
  if (!n || n.type !== 'image') return null;
  const local = applyToPoint(invert(worldMatrix(doc, id)), world);
  if (local.x < 0 || local.y < 0 || local.x > n.width || local.y > n.height) return null;
  const img = await loadImage(n.src);
  const nw = img.naturalWidth || n.naturalWidth;
  const nh = img.naturalHeight || n.naturalHeight;
  if (!nw || !nh) return null;
  const crop = n.crop ?? { x: 0, y: 0, width: nw, height: nh };
  const px = Math.floor(crop.x + (local.x / n.width) * crop.width);
  const py = Math.floor(crop.y + (local.y / n.height) * crop.height);
  if (px < 0 || py < 0 || px >= nw || py >= nh) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, px, py, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { color: rgbToHex({ r: d[0], g: d[1], b: d[2] }), opacity: d[3] / 255 };
  } catch {
    return null;
  }
}
