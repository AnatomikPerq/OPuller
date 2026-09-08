/**
 * EPS export (PostScript Level 3): paths with solid fills / strokes, dashes,
 * caps and joins, clipping groups, gradients as `shfill` shadings clipped to
 * the path, images as RGB `colorimage` data, text outlined beforehand (see
 * withTextOutlines). Colours are written as RGB (or CMYK in CMYK documents).
 */
import type { Document, ID, Node, PathNode, Paint, Rect, SubPath } from '@/model/types';
import { isContainer } from '@/model/types';
import { worldMatrix, worldBounds } from '@/model/document';
import { transformSubPaths, pathBounds, subpathToCubics } from '@/geometry/path';
import { effectiveSubPaths } from '@/canvas/effectiveGeometry';
import { hexToRgb } from '@/util/color';
import { rgbToCmyk } from '@/color/models';
import { exportRegions, type SvgExportOptions, type ExportRegion } from './regions';

export interface EpsOptions extends SvgExportOptions {
  /** write CMYK colours (setcmykcolor) instead of RGB */
  cmyk?: boolean;
  /** include a preview comment header only (no TIFF preview) */
  creator?: string;
}

const PT = 72 / 96;

function n(v: number): string {
  const s = (+v.toFixed(4)).toString();
  return s === '-0' ? '0' : s;
}

function colorOp(hex: string, cmyk: boolean): string {
  const c = hexToRgb(hex);
  if (cmyk) {
    const k = rgbToCmyk(c);
    return `${n(k.c / 100)} ${n(k.m / 100)} ${n(k.y / 100)} ${n(k.k / 100)} setcmykcolor`;
  }
  return `${n(c.r / 255)} ${n(c.g / 255)} ${n(c.b / 255)} setrgbcolor`;
}

/** Path data in PostScript operators for subpaths already in EPS space (pt, y up). */
function pathOps(sps: SubPath[]): string {
  const out: string[] = ['newpath'];
  for (const sp of sps) {
    if (!sp.anchors.length) continue;
    const cubics = subpathToCubics(sp);
    out.push(`${n(sp.anchors[0].point.x)} ${n(sp.anchors[0].point.y)} moveto`);
    for (const c of cubics) {
      const line = Math.abs(c.p1.x - c.p0.x) < 1e-9 && Math.abs(c.p1.y - c.p0.y) < 1e-9 && Math.abs(c.p2.x - c.p3.x) < 1e-9 && Math.abs(c.p2.y - c.p3.y) < 1e-9;
      out.push(line ? `${n(c.p3.x)} ${n(c.p3.y)} lineto` : `${n(c.p1.x)} ${n(c.p1.y)} ${n(c.p2.x)} ${n(c.p2.y)} ${n(c.p3.x)} ${n(c.p3.y)} curveto`);
    }
    if (sp.closed) out.push('closepath');
  }
  return out.join('\n');
}

function shading(paint: Paint, bounds: Rect, toEps: (p: { x: number; y: number }) => { x: number; y: number }, cmyk: boolean): string | null {
  if (paint.type !== 'linear' && paint.type !== 'radial') return null;
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
  if (stops.length < 2) return null;
  const space = cmyk ? '/DeviceCMYK' : '/DeviceRGB';
  const comp = (hex: string) => {
    const c = hexToRgb(hex);
    if (cmyk) {
      const k = rgbToCmyk(c);
      return [k.c / 100, k.m / 100, k.y / 100, k.k / 100];
    }
    return [c.r / 255, c.g / 255, c.b / 255];
  };
  // stitching function over the stops
  const fns = stops.slice(0, -1).map((s, i) => `<< /FunctionType 2 /Domain [0 1] /C0 [${comp(s.color).map(n).join(' ')}] /C1 [${comp(stops[i + 1].color).map(n).join(' ')}] /N 1 >>`);
  const bounds01 = stops.slice(1, -1).map((s) => n(s.offset));
  const encode = stops.slice(0, -1).map(() => '0 1').join(' ');
  const fn = fns.length === 1 ? fns[0] : `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${bounds01.join(' ')}] /Encode [${encode}] >>`;
  const t0 = stops[0].offset;
  const t1 = stops[stops.length - 1].offset;
  if (paint.type === 'linear') {
    const a = toEps({ x: bounds.x + paint.x1 * bounds.width, y: bounds.y + paint.y1 * bounds.height });
    const b = toEps({ x: bounds.x + paint.x2 * bounds.width, y: bounds.y + paint.y2 * bounds.height });
    return `<< /ShadingType 2 /ColorSpace ${space} /Coords [${n(a.x)} ${n(a.y)} ${n(b.x)} ${n(b.y)}] /Domain [${n(t0)} ${n(t1)}] /Extend [true true] /Function ${fn} >> shfill`;
  }
  const c = toEps({ x: bounds.x + paint.cx * bounds.width, y: bounds.y + paint.cy * bounds.height });
  const r = paint.r * Math.max(bounds.width, bounds.height) * PT;
  return `<< /ShadingType 3 /ColorSpace ${space} /Coords [${n(c.x)} ${n(c.y)} 0 ${n(c.x)} ${n(c.y)} ${n(r)}] /Domain [${n(t0)} ${n(t1)}] /Extend [true true] /Function ${fn} >> shfill`;
}

/** Export one region as EPS text. Text should be outlined first (withTextOutlines). */
export function exportEpsRegion(doc: Document, region: ExportRegion, opts: EpsOptions = {}): string {
  const rect = region.rect;
  const cmyk = opts.cmyk ?? doc.colorMode === 'cmyk';
  const wPt = rect.width * PT;
  const hPt = rect.height * PT;
  // world px → EPS points, y up, origin at the region's bottom-left
  const toEps = (p: { x: number; y: number }) => ({ x: (p.x - rect.x) * PT, y: (rect.y + rect.height - p.y) * PT });
  const epsMatrix = { a: PT, b: 0, c: 0, d: -PT, e: -rect.x * PT, f: (rect.y + rect.height) * PT };
  const lines: string[] = [];
  lines.push('%!PS-Adobe-3.0 EPSF-3.0');
  lines.push(`%%Creator: ${opts.creator ?? 'OPuller'}`);
  lines.push(`%%Title: ${region.name}`);
  lines.push(`%%BoundingBox: 0 0 ${Math.ceil(wPt)} ${Math.ceil(hPt)}`);
  lines.push(`%%HiResBoundingBox: 0 0 ${n(wPt)} ${n(hPt)}`);
  lines.push('%%LanguageLevel: 3');
  lines.push('%%Pages: 1');
  lines.push('%%EndComments');
  lines.push('%%BeginProlog');
  lines.push('/bd { bind def } bind def');
  lines.push('%%EndProlog');
  lines.push('%%Page: 1 1');
  lines.push('gsave');
  lines.push(`0 0 ${n(wPt)} ${n(hPt)} rectclip`);
  const bg = opts.backgroundColor !== undefined ? opts.backgroundColor : (opts.background ?? true) ? region.background : null;
  if (bg) lines.push(`gsave ${colorOp(bg, cmyk)} 0 0 ${n(wPt)} ${n(hPt)} rectfill grestore`);
  let imageCount = 0;
  const visit = (id: ID, inheritedOpacity: number) => {
    const node = doc.nodes[id];
    if (!node || !node.visible) return;
    if (isContainer(node)) {
      const g = node;
      const clipId = g.type === 'group' ? g.clipId : null;
      lines.push('gsave');
      if (clipId && doc.nodes[clipId]?.type === 'path') {
        const clip = doc.nodes[clipId] as PathNode;
        const sps = transformSubPaths(effectiveSubPaths(clip), multiply3(epsMatrix, worldMatrix(doc, clipId)));
        lines.push(pathOps(sps));
        lines.push(clip.fillRule === 'evenodd' ? 'eoclip newpath' : 'clip newpath');
      }
      for (const c of g.children) if (c !== clipId) visit(c, inheritedOpacity * node.opacity);
      lines.push('grestore');
      return;
    }
    if (node.type === 'path') {
      const wm = worldMatrix(doc, id);
      const sps = transformSubPaths(effectiveSubPaths(node), multiply3(epsMatrix, wm));
      if (!sps.length) return;
      const bounds = pathBounds(effectiveSubPaths(node)) ?? { x: 0, y: 0, width: 1, height: 1 };
      const worldB = worldBounds(doc, id) ?? bounds;
      lines.push(`% ${node.name.replace(/[\r\n]/g, ' ')}`);
      if (node.fill.type === 'solid') {
        lines.push(pathOps(sps));
        lines.push(`${colorOp(node.fill.color, cmyk)} ${node.fillRule === 'evenodd' ? 'eofill' : 'fill'}`);
      } else if (node.fill.type === 'linear' || node.fill.type === 'radial') {
        const sh = shading(node.fill, worldB, toEps, cmyk);
        if (sh) {
          lines.push('gsave');
          lines.push(pathOps(sps));
          lines.push(node.fillRule === 'evenodd' ? 'eoclip newpath' : 'clip newpath');
          lines.push(sh);
          lines.push('grestore');
        }
      } else if (node.fill.type === 'pattern' || node.fill.type === 'freeform' || node.fill.type === 'mesh') {
        // unsupported paints: a neutral fill keeps the shape visible
        lines.push(pathOps(sps));
        lines.push(`${colorOp('#bfbfbf', cmyk)} fill`);
      }
      const st = node.stroke;
      if (st.paint.type !== 'none' && st.width > 0) {
        const k = Math.hypot(wm.a, wm.b) * PT || PT;
        const color = st.paint.type === 'solid' ? st.paint.color : st.paint.type === 'linear' || st.paint.type === 'radial' ? st.paint.stops[0]?.color ?? '#000000' : '#000000';
        lines.push(pathOps(sps));
        lines.push(`${colorOp(color, cmyk)} ${n(st.width * k)} setlinewidth ${st.cap === 'round' ? 1 : st.cap === 'square' ? 2 : 0} setlinecap ${st.join === 'round' ? 1 : st.join === 'bevel' ? 2 : 0} setlinejoin ${n(st.miterLimit)} setmiterlimit`);
        lines.push(st.dash.length ? `[${st.dash.map((d) => n(d * k)).join(' ')}] ${n(st.dashOffset * k)} setdash` : '[] 0 setdash');
        lines.push('stroke');
      }
      return;
    }
    if (node.type === 'image') {
      const img = imageCache.get(node.src);
      if (!img) return;
      imageCount++;
      const wm = worldMatrix(doc, id);
      const m = multiply3(epsMatrix, wm);
      // image space: unit square scaled to the node size, flipped (PostScript images are bottom-up)
      lines.push('gsave');
      lines.push(`[${n(m.a * node.width)} ${n(m.b * node.width)} ${n(m.c * node.height)} ${n(m.d * node.height)} ${n(m.e)} ${n(m.f)}] concat`);
      lines.push(`/DeviceRGB setcolorspace`);
      lines.push(`<< /ImageType 1 /Width ${img.width} /Height ${img.height} /BitsPerComponent 8 /Decode [0 1 0 1 0 1] /ImageMatrix [${img.width} 0 0 ${-img.height} 0 ${img.height}] /DataSource currentfile /ASCIIHexDecode filter >> image`);
      lines.push(img.hex);
      lines.push('>');
      lines.push('grestore');
      return;
    }
    if (node.type === 'text') {
      // text is outlined before export (withTextOutlines); leftover text objects are skipped
      return;
    }
  };
  const roots = region.ids ?? doc.layers;
  for (const r of roots) visit(r, 1);
  lines.push('grestore');
  lines.push('showpage');
  lines.push('%%Trailer');
  lines.push('%%EOF');
  void imageCount;
  return lines.join('\n');
}

function multiply3(m: { a: number; b: number; c: number; d: number; e: number; f: number }, k: { a: number; b: number; c: number; d: number; e: number; f: number }) {
  return { a: m.a * k.a + m.c * k.b, b: m.b * k.a + m.d * k.b, c: m.a * k.c + m.c * k.d, d: m.b * k.c + m.d * k.d, e: m.a * k.e + m.c * k.f + m.e, f: m.b * k.e + m.d * k.f + m.f };
}

/** Decoded image pixels (hex RGB) cached per source for the exporter. */
const imageCache = new Map<string, { width: number; height: number; hex: string }>();

/** Prepare the raster images of the document as ASCII hex RGB (browser only, async). */
export async function prepareEpsImages(doc: Document, ids?: ID[], maxSize = 1024): Promise<number> {
  const nodes = Object.values(doc.nodes).filter((nd): nd is Extract<Node, { type: 'image' }> => nd.type === 'image' && (!ids || ids.includes(nd.id)));
  let count = 0;
  for (const nd of nodes) {
    if (imageCache.has(nd.src)) continue;
    try {
      const img = await loadImage(nd.src);
      const k = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k));
      const h = Math.max(1, Math.round(img.height * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const parts: string[] = [];
      let line = '';
      for (let i = 0; i < data.length; i += 4) {
        line += data[i].toString(16).padStart(2, '0') + data[i + 1].toString(16).padStart(2, '0') + data[i + 2].toString(16).padStart(2, '0');
        if (line.length >= 72) {
          parts.push(line);
          line = '';
        }
      }
      if (line) parts.push(line);
      imageCache.set(nd.src, { width: w, height: h, hex: parts.join('\n') });
      count++;
    } catch {
      /* skip */
    }
  }
  return count;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}

/** Export the first region of a scope as EPS (images must be prepared first). */
export function exportEps(doc: Document, opts: EpsOptions = {}): { eps: string; name: string; width: number; height: number } {
  const regions = exportRegions(doc, opts);
  if (!regions.length) throw new Error(opts.scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
  const r = regions[0];
  return { eps: exportEpsRegion(doc, r, opts), name: r.name, width: r.rect.width, height: r.rect.height };
}
