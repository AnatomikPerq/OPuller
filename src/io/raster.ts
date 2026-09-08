/**
 * Raster export (PNG / JPEG / WebP): the SVG export is loaded into an <img>
 * through a blob URL and drawn onto a canvas. Fonts are embedded as data-URL
 * @font-face rules inside the SVG because an SVG rendered through <img> cannot
 * load external resources.
 */
import type { Document, ID } from '@/model/types';
import { exportRegions, renderRegion, type SvgExportOptions, type ExportRegion, type SvgExportResult } from './svgExport';
import { fontFaceCss, fontsReady } from './fontEmbed';

export type RasterFormat = 'png' | 'jpeg' | 'webp';

export interface RasterOptions extends SvgExportOptions {
  format?: RasterFormat;
  /** pixel scale (1 = 96 dpi); ignored when width/height is given */
  scale?: number;
  /** explicit pixel width (height follows the aspect unless given) */
  width?: number;
  height?: number;
  /** 0..1 for JPEG / WebP */
  quality?: number;
  /** canvas background: null = transparent (JPEG always gets white) */
  backgroundColor?: string | null;
  /** embed @font-face rules for the used fonts (default true) */
  embedFonts?: boolean;
  /** maximum canvas dimension (default 8192) */
  maxSize?: number;
}

export interface RasterResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  name: string;
  artboardId?: ID;
  /** the SVG the raster was produced from */
  svg: SvgExportResult;
}

export const MIME: Record<RasterFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const EXT: Record<RasterFormat, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };

const fontCssCache = new WeakMap<Document, Promise<string>>();

async function cssFor(doc: Document, ids?: ID[]): Promise<string> {
  if (ids) return (await fontFaceCss(doc, ids)).css;
  let p = fontCssCache.get(doc);
  if (!p) {
    p = fontFaceCss(doc).then((r) => r.css);
    fontCssCache.set(doc, p);
  }
  return p;
}

/** Load an SVG string as an image (blob URL). */
export function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The SVG could not be rasterised.'));
    };
    img.src = url;
  });
}

/** Pixel size for an export region given the options. */
export function pixelSize(region: { width: number; height: number }, opts: RasterOptions): { width: number; height: number; scale: number } {
  const max = opts.maxSize ?? 8192;
  let scale = opts.scale ?? 1;
  if (opts.width && opts.height) {
    return { width: clampInt(opts.width, max), height: clampInt(opts.height, max), scale: opts.width / region.width };
  }
  if (opts.width) scale = opts.width / region.width;
  else if (opts.height) scale = opts.height / region.height;
  let w = Math.round(region.width * scale);
  let h = Math.round(region.height * scale);
  if (w > max || h > max) {
    const f = Math.min(max / w, max / h);
    w = Math.round(w * f);
    h = Math.round(h * f);
    scale *= f;
  }
  return { width: Math.max(1, w), height: Math.max(1, h), scale };
}

function clampInt(v: number, max: number): number {
  return Math.max(1, Math.min(max, Math.round(v)));
}

/** Rasterise one region. */
export async function rasterizeRegion(doc: Document, region: ExportRegion, opts: RasterOptions = {}): Promise<RasterResult> {
  const format = opts.format ?? 'png';
  await fontsReady();
  const css = opts.embedFonts === false ? '' : await cssFor(doc, region.ids);
  const svg = renderRegion(doc, region, { ...opts, css: [opts.css, css].filter(Boolean).join('\n'), pretty: false, responsive: false, backgroundColor: null });
  const { width, height } = pixelSize(region.rect, opts);
  const img = await loadSvgImage(svg.svg);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is not available.');
  let bg = opts.backgroundColor !== undefined ? opts.backgroundColor : region.background;
  if (format === 'jpeg' && !bg) bg = '#ffffff';
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, width, height, name: region.name, artboardId: region.artboardId, svg };
}

/** Rasterise every region of the scope (several for 'artboards'). */
export async function rasterizeAll(doc: Document, opts: RasterOptions = {}): Promise<RasterResult[]> {
  const regions = exportRegions(doc, opts);
  const out: RasterResult[] = [];
  for (const r of regions) out.push(await rasterizeRegion(doc, r, opts));
  return out;
}

/** Rasterise the first region of the scope to a canvas. */
export async function renderToCanvas(doc: Document, opts: RasterOptions = {}): Promise<RasterResult> {
  const regions = exportRegions(doc, opts);
  if (!regions.length) throw new Error(opts.scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
  return rasterizeRegion(doc, regions[0], opts);
}

export function canvasToBlob(canvas: HTMLCanvasElement, format: RasterFormat, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`Could not encode ${format.toUpperCase()}.`));
      },
      MIME[format],
      format === 'png' ? undefined : (quality ?? 0.92),
    );
  });
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, format: RasterFormat, quality?: number): string {
  return canvas.toDataURL(MIME[format], format === 'png' ? undefined : (quality ?? 0.92));
}

/** Rasterise and encode the first region. */
export async function renderToBlob(doc: Document, opts: RasterOptions = {}): Promise<{ blob: Blob; result: RasterResult }> {
  const result = await renderToCanvas(doc, opts);
  const blob = await canvasToBlob(result.canvas, opts.format ?? 'png', opts.quality);
  return { blob, result };
}

/** Rasterise and encode the first region as a data URL (handy for tests/previews). */
export async function renderToDataUrl(doc: Document, opts: RasterOptions = {}): Promise<{ dataUrl: string; width: number; height: number }> {
  const result = await renderToCanvas(doc, opts);
  return { dataUrl: canvasToDataUrl(result.canvas, opts.format ?? 'png', opts.quality), width: result.width, height: result.height };
}

/** DPI presets → scale (96 dpi == 1x). */
export function dpiToScale(dpi: number): number {
  return dpi / 96;
}
