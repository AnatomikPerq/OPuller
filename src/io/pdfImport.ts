/**
 * PDF / PDF-compatible AI import through pdf.js: the page operator list is
 * converted into paths (fills, strokes, clip groups) and images; text comes
 * from the text content (positions + fonts) as editable text nodes. Pages can
 * also be placed as a rasterised image.
 */
import type { Node, ID, Paint, StrokeStyle, SubPath, Anchor, Matrix, Vec, HexColor } from '@/model/types';
import { makePath, makeGroup, makeImage, makeText } from '@/model/nodes';
import { noStroke, defaultStroke } from '@/model/defaults';
import { multiply, identity, translate, scale as scaleM, applyToPoint, decompose } from '@/geometry/matrix';
import { transformSubPaths } from '@/geometry/path';
import { parseCssColor, rgbToHex } from '@/util/color';
import type { ImportedItem } from './svgImport';

export interface PdfImportOptions {
  /** 1-based page number */
  page?: number;
  /** 'objects' converts to editable objects; 'image' places a rasterised page */
  mode?: 'objects' | 'image';
  /** raster scale for image mode (pixels per point) */
  scale?: number;
  /** keep text as text nodes (default true); false rasterises nothing but skips text */
  text?: boolean;
  name?: string;
}

export interface PdfImportResult {
  items: ImportedItem[];
  pages: number;
  page: number;
  /** page size in px (CSS px = pt × 96/72) */
  width: number;
  height: number;
  warnings: string[];
}

const PT = 96 / 72;

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  if (!lib) {
    lib = (async () => {
      const mod = await import('pdfjs-dist');
      try {
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default as string;
        mod.GlobalWorkerOptions.workerSrc = worker;
      } catch {
        /* the fake worker is used when the worker file cannot be resolved */
      }
      return mod;
    })();
  }
  return lib;
}

/** Whether the bytes start with (or embed) a PDF header. Returns the offset or -1. */
export function pdfOffset(bytes: Uint8Array, limit = 4096): number {
  const n = Math.min(bytes.length - 4, limit);
  for (let i = 0; i <= n; i++) if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return i;
  return -1;
}

export async function pdfPageCount(data: ArrayBuffer): Promise<number> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
  const n = doc.numPages;
  await doc.cleanup();
  return n;
}

// ---------------------------------------------------------------------------
// Graphics state
// ---------------------------------------------------------------------------

interface GState {
  ctm: Matrix;
  fill: HexColor;
  fillAlpha: number;
  stroke: HexColor;
  strokeAlpha: number;
  lineWidth: number;
  cap: StrokeStyle['cap'];
  join: StrokeStyle['join'];
  dash: number[];
  /** open clip group at this level (children go into it) */
  clip: ID | null;
}

function cssHex(v: unknown): HexColor | null {
  if (typeof v !== 'string') return null;
  const c = parseCssColor(v);
  return c ? c.hex : null;
}

/** Decode a DrawOPS stream (pdf.js ≥ 4) into subpaths in user space. */
function decodeDrawOps(data: ArrayLike<number> | null | undefined): SubPath[] {
  const out: SubPath[] = [];
  if (!data) return out;
  let cur: Anchor[] = [];
  let closed = false;
  const flush = () => {
    if (cur.length) out.push({ anchors: cur, closed });
    cur = [];
    closed = false;
  };
  let i = 0;
  const n = data.length;
  let last: Vec = { x: 0, y: 0 };
  while (i < n) {
    const op = data[i++];
    switch (op) {
      case 0: {
        flush();
        last = { x: data[i++], y: data[i++] };
        cur.push({ point: { ...last }, handleIn: null, handleOut: null, kind: 'corner' });
        break;
      }
      case 1: {
        last = { x: data[i++], y: data[i++] };
        cur.push({ point: { ...last }, handleIn: null, handleOut: null, kind: 'corner' });
        break;
      }
      case 2: {
        const c1 = { x: data[i++], y: data[i++] };
        const c2 = { x: data[i++], y: data[i++] };
        const p = { x: data[i++], y: data[i++] };
        const prev = cur[cur.length - 1];
        if (prev) prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
        cur.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: 'smooth' });
        last = p;
        break;
      }
      case 3: {
        const c = { x: data[i++], y: data[i++] };
        const p = { x: data[i++], y: data[i++] };
        const prev = cur[cur.length - 1];
        if (prev) {
          const p0 = prev.point;
          const c1 = { x: p0.x + (2 / 3) * (c.x - p0.x), y: p0.y + (2 / 3) * (c.y - p0.y) };
          const c2 = { x: p.x + (2 / 3) * (c.x - p.x), y: p.y + (2 / 3) * (c.y - p.y) };
          prev.handleOut = { x: c1.x - p0.x, y: c1.y - p0.y };
          cur.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: 'smooth' });
        }
        last = p;
        break;
      }
      case 4:
        closed = true;
        flush();
        break;
      default:
        i = n;
    }
  }
  flush();
  return out;
}

/** Legacy path encoding (moveTo/lineTo/... separate ops) collected into subpaths. */
class PathBuilder {
  sps: SubPath[] = [];
  cur: Anchor[] = [];
  closed = false;
  move(p: Vec) {
    this.flush();
    this.cur.push({ point: p, handleIn: null, handleOut: null, kind: 'corner' });
  }
  line(p: Vec) {
    this.cur.push({ point: p, handleIn: null, handleOut: null, kind: 'corner' });
  }
  curve(c1: Vec, c2: Vec, p: Vec) {
    const prev = this.cur[this.cur.length - 1];
    if (prev) prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
    this.cur.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: 'smooth' });
  }
  rect(x: number, y: number, w: number, h: number) {
    this.flush();
    this.cur = [
      { point: { x, y }, handleIn: null, handleOut: null, kind: 'corner' },
      { point: { x: x + w, y }, handleIn: null, handleOut: null, kind: 'corner' },
      { point: { x: x + w, y: y + h }, handleIn: null, handleOut: null, kind: 'corner' },
      { point: { x, y: y + h }, handleIn: null, handleOut: null, kind: 'corner' },
    ];
    this.closed = true;
    this.flush();
  }
  close() {
    this.closed = true;
    this.flush();
  }
  flush() {
    if (this.cur.length) this.sps.push({ anchors: this.cur, closed: this.closed });
    this.cur = [];
    this.closed = false;
  }
  take(): SubPath[] {
    this.flush();
    const out = this.sps;
    this.sps = [];
    return out;
  }
}

async function imageDataUrl(imgData: any): Promise<{ url: string; width: number; height: number } | null> {
  if (!imgData) return null;
  const width = imgData.width;
  const height = imgData.height;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (imgData.bitmap) {
    ctx.drawImage(imgData.bitmap, 0, 0);
  } else if (imgData.data) {
    const img = ctx.createImageData(width, height);
    const src: Uint8ClampedArray = imgData.data;
    const kind = imgData.kind;
    if (kind === 3 || src.length === width * height * 4) img.data.set(src);
    else if (kind === 2 || src.length === width * height * 3) {
      for (let i = 0, j = 0; i < width * height; i++, j += 3) {
        img.data[i * 4] = src[j];
        img.data[i * 4 + 1] = src[j + 1];
        img.data[i * 4 + 2] = src[j + 2];
        img.data[i * 4 + 3] = 255;
      }
    } else if (kind === 1) {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const i = (y * width + x) * 4;
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
    } else return null;
    ctx.putImageData(img, 0, 0);
  } else return null;
  return { url: canvas.toDataURL('image/png'), width, height };
}

const FONT_MAP: Array<[RegExp, string]> = [
  [/times|georgia|garamond|serif/i, 'Lora'],
  [/courier|mono|consolas|menlo/i, 'Source Code Pro'],
  [/impact|bebas/i, 'Bebas Neue'],
  [/montserrat/i, 'Montserrat'],
  [/roboto/i, 'Roboto'],
  [/open ?sans/i, 'Open Sans'],
  [/poppins/i, 'Poppins'],
  [/oswald/i, 'Oswald'],
  [/playfair/i, 'Playfair Display'],
  [/raleway/i, 'Raleway'],
  [/nunito/i, 'Nunito'],
  [/merriweather/i, 'Merriweather'],
  [/pacifico/i, 'Pacifico'],
];

function mapFont(name: string | undefined, family: string | undefined): { fontFamily: string; fontWeight: number; fontStyle: 'normal' | 'italic' } {
  const n = `${name ?? ''} ${family ?? ''}`;
  let fontFamily = 'Inter';
  for (const [re, fam] of FONT_MAP) if (re.test(n)) {
    fontFamily = fam;
    break;
  }
  const fontWeight = /bold|black|heavy|semibold|demibold/i.test(n) ? 700 : /light|thin/i.test(n) ? 300 : 400;
  const fontStyle: 'normal' | 'italic' = /italic|oblique/i.test(n) ? 'italic' : 'normal';
  return { fontFamily, fontWeight, fontStyle };
}

/**
 * Import one page. Coordinates: the PDF user space is flipped (y up) and
 * scaled to CSS px; the page's top-left corner becomes (0, 0).
 */
export async function importPdf(data: ArrayBuffer, opts: PdfImportOptions = {}): Promise<PdfImportResult> {
  const pdfjs = await loadPdfJs();
  const warnings: string[] = [];
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
  try {
    const pageNo = Math.max(1, Math.min(doc.numPages, opts.page ?? 1));
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width * PT;
    const height = viewport.height * PT;
    const items: ImportedItem[] = [];
    const name = opts.name ?? 'PDF';
    if ((opts.mode ?? 'objects') === 'image') {
      const scale = opts.scale ?? 2;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport: vp } as never).promise;
      const img = makeImage(canvas.toDataURL('image/png'), canvas.width, canvas.height, { name: `${name} p${pageNo}`, width, height });
      items.push({ root: img, nodes: [img] });
      return { items, pages: doc.numPages, page: pageNo, width, height, warnings };
    }
    // base transform: PDF user space (pt, y up) → px, y down, origin top-left
    const [vx0, vy0, vx1, vy1] = viewport.viewBox as [number, number, number, number];
    void vx1;
    const base: Matrix = { a: PT, b: 0, c: 0, d: -PT, e: -vx0 * PT, f: vy1 * PT };
    void vy0;
    const root = makeGroup([], { name: `${name} p${pageNo}` });
    const nodes: Node[] = [root];
    const opList = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const stack: GState[] = [];
    let gs: GState = { ctm: base, fill: '#000000', fillAlpha: 1, stroke: '#000000', strokeAlpha: 1, lineWidth: 1, cap: 'butt', join: 'miter', dash: [], clip: null };
    const parents: ID[] = [root.id];
    const builder = new PathBuilder();
    let pendingClip: 'nonzero' | 'evenodd' | null = null;
    const parentId = () => parents[parents.length - 1];
    const addChild = (n: Node) => {
      const p = nodes.find((x) => x.id === parentId());
      n.parent = p?.id ?? root.id;
      if (p && (p.type === 'group' || p.type === 'layer')) p.children.push(n.id);
      nodes.push(n);
    };
    const emit = (sps: SubPath[], mode: 'fill' | 'stroke' | 'fillStroke', rule: 'nonzero' | 'evenodd') => {
      if (!sps.length) return;
      const world = transformSubPaths(sps, gs.ctm);
      const sw = gs.lineWidth * (Math.hypot(gs.ctm.a, gs.ctm.b) || 1);
      const fill: Paint = mode === 'stroke' ? { type: 'none' } : { type: 'solid', color: gs.fill, opacity: gs.fillAlpha };
      const stroke: StrokeStyle = mode === 'fill' ? noStroke() : defaultStroke({ paint: { type: 'solid', color: gs.stroke, opacity: gs.strokeAlpha }, width: Math.max(0.1, sw), cap: gs.cap, join: gs.join, dash: gs.dash.map((d) => d * (Math.hypot(gs.ctm.a, gs.ctm.b) || 1)) });
      const p = makePath(world, { fill, stroke, fillRule: rule, name: mode === 'stroke' ? 'Stroke' : 'Path' });
      addChild(p);
    };
    const applyClip = (sps: SubPath[], rule: 'nonzero' | 'evenodd') => {
      if (!sps.length) return;
      const world = transformSubPaths(sps, gs.ctm);
      const g = makeGroup([], { name: 'Clip group' });
      addChild(g);
      const clip = makePath(world, { fill: { type: 'none' }, stroke: noStroke(), fillRule: rule, name: 'Clipping path' });
      clip.parent = g.id;
      g.children.push(clip.id);
      g.clipId = clip.id;
      nodes.push(clip);
      parents.push(g.id);
      gs.clip = g.id;
    };
    const paintOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.stroke, OPS.closeStroke, OPS.endPath]);
    const paint = (op: number, sps: SubPath[]) => {
      if (pendingClip) {
        applyClip(sps, pendingClip);
        pendingClip = null;
        if (op === OPS.endPath) return;
      }
      switch (op) {
        case OPS.fill:
        case OPS.closeFillStroke:
          emit(sps, op === OPS.fill ? 'fill' : 'fillStroke', 'nonzero');
          break;
        case OPS.eoFill:
          emit(sps, 'fill', 'evenodd');
          break;
        case OPS.fillStroke:
          emit(sps, 'fillStroke', 'nonzero');
          break;
        case OPS.eoFillStroke:
        case OPS.closeEOFillStroke:
          emit(sps, 'fillStroke', 'evenodd');
          break;
        case OPS.stroke:
        case OPS.closeStroke:
          emit(sps, 'stroke', 'nonzero');
          break;
        default:
          break;
      }
    };
    const fn = opList.fnArray;
    const args = opList.argsArray;
    let imageCount = 0;
    for (let i = 0; i < fn.length; i++) {
      const op = fn[i];
      const a = args[i] as any[];
      switch (op) {
        case OPS.save:
          stack.push({ ...gs, dash: [...gs.dash] });
          break;
        case OPS.restore: {
          const prev = stack.pop();
          if (prev) {
            // close clip groups opened since the matching save
            while (parents.length > 1 && gs.clip && gs.clip !== prev.clip) {
              parents.pop();
              gs = { ...gs, clip: parents.length > 1 ? gs.clip : null };
              if (parents.length === 1) break;
            }
            gs = prev;
          }
          break;
        }
        case OPS.transform:
          gs.ctm = multiply(gs.ctm, { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] });
          break;
        case OPS.setLineWidth:
          gs.lineWidth = Number(a[0]) || 1;
          break;
        case OPS.setLineCap:
          gs.cap = a[0] === 1 ? 'round' : a[0] === 2 ? 'square' : 'butt';
          break;
        case OPS.setLineJoin:
          gs.join = a[0] === 1 ? 'round' : a[0] === 2 ? 'bevel' : 'miter';
          break;
        case OPS.setDash:
          gs.dash = Array.isArray(a[0]) ? a[0].map(Number).filter((d: number) => Number.isFinite(d) && d >= 0) : [];
          break;
        case OPS.setFillRGBColor:
        case OPS.setFillGray:
        case OPS.setFillCMYKColor:
        case OPS.setFillColor:
        case OPS.setFillColorN: {
          const c = cssHex(a[0]) ?? (typeof a[0] === 'number' && a.length >= 3 ? rgbToHex({ r: a[0] * 255, g: a[1] * 255, b: a[2] * 255 }) : null);
          if (c) gs.fill = c;
          break;
        }
        case OPS.setStrokeRGBColor:
        case OPS.setStrokeGray:
        case OPS.setStrokeCMYKColor:
        case OPS.setStrokeColor:
        case OPS.setStrokeColorN: {
          const c = cssHex(a[0]) ?? (typeof a[0] === 'number' && a.length >= 3 ? rgbToHex({ r: a[0] * 255, g: a[1] * 255, b: a[2] * 255 }) : null);
          if (c) gs.stroke = c;
          break;
        }
        case OPS.setGState: {
          for (const [k, v] of a[0] as Array<[string, unknown]>) {
            if (k === 'ca' && typeof v === 'number') gs.fillAlpha = v;
            if (k === 'CA' && typeof v === 'number') gs.strokeAlpha = v;
            if (k === 'LW' && typeof v === 'number') gs.lineWidth = v;
          }
          break;
        }
        case OPS.constructPath: {
          // pdf.js ≥ 4: [paintOp, [drawOpsData], minMax] (the data sits inside a one-element array)
          const paintOp = a[0] as number;
          const raw = Array.isArray(a[1]) && a[1].length && typeof a[1][0] !== 'number' ? a[1][0] : a[1];
          const sps = decodeDrawOps(raw as ArrayLike<number>);
          if (paintOps.has(paintOp)) paint(paintOp, sps);
          else if (paintOp === OPS.clip || paintOp === OPS.eoClip) applyClip(sps, paintOp === OPS.eoClip ? 'evenodd' : 'nonzero');
          break;
        }
        case OPS.moveTo:
          builder.move({ x: a[0], y: a[1] });
          break;
        case OPS.lineTo:
          builder.line({ x: a[0], y: a[1] });
          break;
        case OPS.curveTo:
          builder.curve({ x: a[0], y: a[1] }, { x: a[2], y: a[3] }, { x: a[4], y: a[5] });
          break;
        case OPS.rectangle:
          builder.rect(a[0], a[1], a[2], a[3]);
          break;
        case OPS.closePath:
          builder.close();
          break;
        case OPS.clip:
          pendingClip = 'nonzero';
          break;
        case OPS.eoClip:
          pendingClip = 'evenodd';
          break;
        case OPS.fill:
        case OPS.eoFill:
        case OPS.fillStroke:
        case OPS.eoFillStroke:
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke:
        case OPS.stroke:
        case OPS.closeStroke:
        case OPS.endPath:
          paint(op, builder.take());
          break;
        case OPS.paintFormXObjectBegin: {
          stack.push({ ...gs, dash: [...gs.dash] });
          const m = a[0] as number[] | null;
          if (m) gs.ctm = multiply(gs.ctm, { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
          const bbox = a[1] as number[] | null;
          if (bbox) applyClip([{ anchors: [{ x: bbox[0], y: bbox[1] }, { x: bbox[2], y: bbox[1] }, { x: bbox[2], y: bbox[3] }, { x: bbox[0], y: bbox[3] }].map((p) => ({ point: p, handleIn: null, handleOut: null, kind: 'corner' as const })), closed: true }], 'nonzero');
          break;
        }
        case OPS.paintFormXObjectEnd: {
          const prev = stack.pop();
          if (prev) {
            while (parents.length > 1 && gs.clip !== prev.clip) {
              parents.pop();
              gs.clip = parents.length > 1 ? gs.clip : null;
              if (parents.length === 1) break;
            }
            gs = prev;
          }
          break;
        }
        case OPS.paintImageXObject:
        case OPS.paintInlineImageXObject:
        case OPS.paintImageMaskXObject: {
          try {
            let imgData: any = null;
            if (op === OPS.paintImageXObject) {
              const objId = a[0] as string;
              imgData = await new Promise((resolve) => {
                try {
                  if (page.objs.has(objId)) resolve(page.objs.get(objId));
                  else page.objs.get(objId, (d: unknown) => resolve(d));
                } catch {
                  resolve(null);
                }
              });
            } else imgData = a[0];
            const decoded = await imageDataUrl(imgData);
            if (!decoded) break;
            // the image fills the unit square of the current CTM (y flipped)
            const m = multiply(gs.ctm, { a: 1 / decoded.width, b: 0, c: 0, d: -1 / decoded.height, e: 0, f: 1 });
            const node = makeImage(decoded.url, decoded.width, decoded.height, { name: `Image ${++imageCount}` });
            node.transform = m;
            addChild(node);
          } catch (err) {
            warnings.push(`Image skipped: ${(err as Error)?.message ?? err}`);
          }
          break;
        }
        default:
          break;
      }
    }
    // text
    if (opts.text !== false) {
      try {
        const tc = await page.getTextContent();
        let count = 0;
        for (const it of tc.items as any[]) {
          if (!it.str || !it.str.trim() || !it.transform) continue;
          const [ta, tb, tcx, td, te, tf] = it.transform as number[];
          const m = multiply(base, { a: ta, b: tb, c: tcx, d: td, e: te, f: tf });
          const dec = decompose(m);
          const size = Math.abs(dec.scaleY) || Math.abs(dec.scaleX) || 12;
          const style = tc.styles?.[it.fontName];
          const font = mapFont(it.fontName, style?.fontFamily);
          const t = makeText(it.str, { name: it.str.slice(0, 24), style: { fontSize: size, ...font }, fill: { type: 'solid', color: '#000000', opacity: 1 } });
          // text nodes draw from the baseline at y=0: place the origin at the glyph baseline
          const origin = applyToPoint(m, { x: 0, y: 0 });
          t.transform = multiply(translate(origin.x, origin.y), multiply({ a: Math.cos((dec.rotation * Math.PI) / 180), b: Math.sin((dec.rotation * Math.PI) / 180), c: -Math.sin((dec.rotation * Math.PI) / 180), d: Math.cos((dec.rotation * Math.PI) / 180), e: 0, f: 0 }, identity()));
          addChild(t);
          count++;
        }
        if (count) warnings.push(`${count} text object${count === 1 ? '' : 's'} imported with substituted fonts`);
      } catch (err) {
        warnings.push(`Text skipped: ${(err as Error)?.message ?? err}`);
      }
    }
    if (root.children.length) items.push({ root, nodes });
    return { items, pages: doc.numPages, page: pageNo, width, height, warnings };
  } finally {
    await doc.cleanup();
  }
}

export { scaleM };
