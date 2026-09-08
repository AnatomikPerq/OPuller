/**
 * PDF export with jsPDF + svg2pdf.js: one page per exported region (artboard),
 * page size = region size in points, vector output. Regions that svg2pdf cannot
 * handle fall back to an embedded raster.
 */
import type { Document } from '@/model/types';
import { exportRegions, renderRegion, type SvgExportOptions, type ExportRegion } from './svgExport';
import { rasterizeRegion, canvasToDataUrl } from './raster';

export interface PdfOptions extends SvgExportOptions {
  /** force raster pages */
  raster?: boolean;
  /** raster scale used for fallbacks (default 2) */
  rasterScale?: number;
  /** try to outline text before export (fonts are otherwise substituted by the PDF viewer) */
  fontWarning?: (families: string[]) => void;
}

export interface PdfResult {
  blob: Blob;
  pages: number;
  /** pages that were embedded as raster because vector conversion failed */
  rasterPages: number[];
}

export const PX_TO_PT = 72 / 96;

let jspdfPromise: Promise<typeof import('jspdf')> | null = null;
async function loadJsPdf() {
  if (!jspdfPromise) {
    jspdfPromise = (async () => {
      const mod = await import('jspdf');
      await import('svg2pdf.js');
      return mod;
    })();
  }
  return jspdfPromise;
}

function parseSvg(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const err = parsed.querySelector('parsererror');
  if (err) throw new Error('Invalid SVG markup.');
  return parsed.documentElement as unknown as SVGSVGElement;
}

/** Export regions of the document as a multi-page PDF. */
export async function exportPdf(doc: Document, opts: PdfOptions = {}): Promise<PdfResult> {
  const regions = exportRegions(doc, opts);
  if (!regions.length) throw new Error(opts.scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
  const { jsPDF } = await loadJsPdf();
  const first = regions[0];
  const pdf = new jsPDF({ unit: 'pt', format: [first.rect.width * PX_TO_PT, first.rect.height * PX_TO_PT], orientation: first.rect.width >= first.rect.height ? 'landscape' : 'portrait', compress: true });
  pdf.setProperties({ title: doc.name, creator: 'OPuller' });
  const rasterPages: number[] = [];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const wPt = region.rect.width * PX_TO_PT;
    const hPt = region.rect.height * PX_TO_PT;
    if (i > 0) pdf.addPage([wPt, hPt], wPt >= hPt ? 'landscape' : 'portrait');
    let ok = false;
    if (!opts.raster) {
      try {
        await vectorPage(pdf, doc, region, opts, wPt, hPt);
        ok = true;
      } catch (e) {
        console.warn('svg2pdf failed, falling back to raster', e);
      }
    }
    if (!ok) {
      rasterPages.push(i + 1);
      const r = await rasterizeRegion(doc, region, { ...opts, format: 'png', scale: opts.rasterScale ?? 2 });
      pdf.addImage(canvasToDataUrl(r.canvas, 'png'), 'PNG', 0, 0, wPt, hPt, undefined, 'FAST');
    }
  }
  return { blob: pdf.output('blob'), pages: regions.length, rasterPages };
}

async function vectorPage(pdf: import('jspdf').jsPDF, doc: Document, region: ExportRegion, opts: PdfOptions, wPt: number, hPt: number): Promise<void> {
  const svg = renderRegion(doc, region, { ...opts, pretty: false, responsive: false, css: undefined, precision: 4 });
  const el = parseSvg(svg.svg);
  // svg2pdf measures text through the DOM: the element must be attached
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
  host.appendChild(document.importNode(el, true));
  document.body.appendChild(host);
  try {
    await pdf.svg(host.firstElementChild as Element, { x: 0, y: 0, width: wPt, height: hPt });
  } finally {
    host.remove();
  }
}
