/**
 * Illustrator native (AI 3–8 "PostScript" format) and Illustrator EPS import:
 * a small PostScript tokenizer plus an interpreter for the Adobe Illustrator
 * drawing operators (m l c v y h f F s S b B N n k K g G Xa XA x X Xx XX w j J
 * d M XR A u U *u *U q Q W Lb LB Ln Bb Bh Bg BB XI To TO Tp TP Tr Tf Tx TX Ta
 * Tl Tt) and the generic PostScript operators (moveto lineto curveto closepath
 * fill stroke setrgbcolor ...), enough for artwork exported by Illustrator,
 * CorelDRAW, OPuller and most simple EPS files. Gradient definitions
 * (%AI5_BeginGradient blocks) and embedded rasters (XI hex data) are read from
 * the text before interpretation because they live in comment lines.
 */
import type { Node, ID, SubPath, Anchor, Matrix, Vec, HexColor, Paint, StrokeStyle, GradientStop, Rect } from '@/model/types';
import { makePath, makeGroup, makeText, makeImage } from '@/model/nodes';
import { noStroke, defaultStroke } from '@/model/defaults';
import { multiply, translate, scale as scaleM, rotate, applyToPoint } from '@/geometry/matrix';
import { transformSubPaths, pathBounds } from '@/geometry/path';
import { rgbToHex } from '@/util/color';
import { cmykToRgb } from '@/color/models';
import type { ImportedItem } from './svgImport';

export interface AiImportResult {
  items: ImportedItem[];
  width: number;
  height: number;
  warnings: string[];
}

const PT = 96 / 72;

/** Whether the text looks like an Illustrator / PostScript file. */
export function looksLikeAiOrEps(text: string): boolean {
  const head = text.slice(0, 2000);
  return head.startsWith('%!PS-Adobe') || head.includes('%!PS-Adobe') || /%%Creator: ?Adobe Illustrator/i.test(head) || head.startsWith('%!AI');
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'str'; v: string } | { t: 'op'; v: string } | { t: 'arr'; v: Token[] } | { t: 'proc' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  const stack: Token[][] = [out];
  const push = (tok: Token) => stack[stack.length - 1].push(tok);
  while (i < n) {
    const ch = src[i];
    if (ch === '%') {
      // comments (but keep structured comments handled elsewhere)
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\0') {
      i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      let s = '';
      i++;
      while (i < n && depth > 0) {
        const c = src[i];
        if (c === '\\') {
          const nx = src[i + 1];
          if (nx === 'n') s += '\n';
          else if (nx === 'r') s += '\r';
          else if (nx === 't') s += '\t';
          else if (nx >= '0' && nx <= '7') {
            const oct = src.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? '';
            s += String.fromCharCode(parseInt(oct, 8));
            i += oct.length + 1;
            continue;
          } else s += nx;
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        s += c;
        i++;
      }
      i++;
      push({ t: 'str', v: s });
      continue;
    }
    if (ch === '<' && src[i + 1] !== '<') {
      // hex string
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end < 0 ? n : end).replace(/\s+/g, '');
      let s = '';
      for (let k = 0; k + 1 < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      push({ t: 'str', v: s });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') {
      push({ t: 'op', v: '<<' });
      i += 2;
      continue;
    }
    if (ch === '>' && src[i + 1] === '>') {
      push({ t: 'op', v: '>>' });
      i += 2;
      continue;
    }
    if (ch === '[') {
      const arr: Token[] = [];
      push({ t: 'arr', v: arr });
      stack.push(arr);
      i++;
      continue;
    }
    if (ch === ']') {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === '{') {
      // procedures are skipped entirely (definitions from prologs)
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        else if (src[i] === '(') {
          let d2 = 1;
          i++;
          while (i < n && d2 > 0) {
            if (src[i] === '\\') i++;
            else if (src[i] === '(') d2++;
            else if (src[i] === ')') d2--;
            i++;
          }
          continue;
        }
        i++;
      }
      push({ t: 'proc' });
      continue;
    }
    if (ch === '}') {
      i++;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/[\s()<>[\]{}/%]/.test(src[j])) j++;
      push({ t: 'name', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    // number or operator
    let j = i;
    while (j < n && !/[\s()<>[\]{}/%]/.test(src[j])) j++;
    const word = src.slice(i, j);
    i = j || i + 1;
    if (!word) {
      i++;
      continue;
    }
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(word)) push({ t: 'num', v: parseFloat(word) });
    else if (/^\d+#[0-9a-z]+$/i.test(word)) {
      const [radix, digits] = word.split('#');
      push({ t: 'num', v: parseInt(digits, parseInt(radix, 10)) });
    } else push({ t: 'op', v: word });
  }
  return out;
}

// ---------------------------------------------------------------------------
// String decoding: AI strings are platform bytes (Windows-1252 on Windows,
// Windows-1251 for Cyrillic documents written by OPuller / Russian Illustrator)
// ---------------------------------------------------------------------------

const CP1252_HIGH = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї';

export type AiTextEncoding = 'cp1252' | 'cp1251';

/** Decode the bytes of a PostScript string (one char per byte) into text. */
export function decodeAiString(bytes: string, encoding: AiTextEncoding = 'cp1252'): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.charCodeAt(i);
    if (b < 0x80) out += bytes[i];
    else if (encoding === 'cp1251') out += b < 0xc0 ? CP1251_HIGH[b - 0x80] : String.fromCharCode(0x0410 + (b - 0xc0));
    else out += b < 0xa0 ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comment-level data: gradients and rasters
// ---------------------------------------------------------------------------

interface AiGradientDef {
  type: 'linear' | 'radial';
  stops: GradientStop[];
}

function tintHex(hex: HexColor, fileTint: number): HexColor {
  // the file stores 1 − tint (0 = full ink)
  const t = Math.max(0, Math.min(1, 1 - fileTint));
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return rgbToHex({ r: 255 - (255 - r) * t, g: 255 - (255 - g) * t, b: 255 - (255 - b) * t });
}

/** Parse the %AI5_BeginGradient blocks of the setup section. */
function parseGradientDefs(text: string): Map<string, AiGradientDef> {
  const defs = new Map<string, AiGradientDef>();
  const re = /%AI5_BeginGradient:[^\n]*\n([\s\S]*?)%AI5_EndGradient/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const block = m[1];
    const bd = block.match(/\((.*?)\)\s+([01])\s+(\d+)\s+Bd/);
    if (!bd) continue;
    const name = bd[1].replace(/\\(.)/g, '$1');
    const type = bd[2] === '1' ? 'radial' : 'linear';
    const stops: GradientStop[] = [];
    const stopRe = /^([^%\n]*?)\s*%_Bs\s*$/gm;
    let s: RegExpExecArray | null;
    while ((s = stopRe.exec(block))) {
      const line = s[1].trim();
      const tokens = tokenize(line + ' ').filter((t) => t.t === 'num' || t.t === 'str');
      const nums = tokens.filter((t): t is { t: 'num'; v: number } => t.t === 'num').map((t) => t.v);
      if (nums.length < 3) continue;
      // … colorStyle midPoint rampPoint %_Bs
      const ramp = nums[nums.length - 1];
      const style = nums[nums.length - 3];
      let color: HexColor = '#000000';
      if (style === 0) {
        const g = Math.max(0, Math.min(1, nums[0]));
        color = rgbToHex({ r: g * 255, g: g * 255, b: g * 255 });
      } else if (style === 1) color = cmyk(nums[0], nums[1], nums[2], nums[3]);
      else if (style === 2 && nums.length >= 10) color = rgbToHex({ r: nums[4] * 255, g: nums[5] * 255, b: nums[6] * 255 });
      else if (style === 3) color = tintHex(cmyk(nums[0], nums[1], nums[2], nums[3]), nums[4]);
      else if (style === 4 && nums.length >= 11) color = tintHex(rgbToHex({ r: nums[4] * 255, g: nums[5] * 255, b: nums[6] * 255 }), nums[7]);
      else if (nums.length >= 7) color = cmyk(nums[0], nums[1], nums[2], nums[3]);
      stops.push({ offset: Math.max(0, Math.min(1, ramp / 100)), color, opacity: 1 });
    }
    stops.sort((a, b) => a.offset - b.offset);
    if (stops.length >= 2) defs.set(name, { type, stops });
  }
  return defs;
}

interface AiRaster {
  matrix: Matrix;
  width: number;
  height: number;
  bits: number;
  channels: number;
  /** data URL (BMP) or null when the data could not be decoded */
  src: string | null;
}

/** Encode top-down RGB bytes as a 24-bit BMP data URL (pure, no canvas). */
export function rgbToBmpDataUrl(width: number, height: number, rgb: Uint8Array): string {
  const rowBytes = (width * 3 + 3) & ~3;
  const size = 54 + rowBytes * height;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, rowBytes * height, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 3;
    const dst = 54 + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      buf[dst + x * 3] = rgb[srcRow + x * 3 + 2];
      buf[dst + x * 3 + 1] = rgb[srcRow + x * 3 + 1];
      buf[dst + x * 3 + 2] = rgb[srcRow + x * 3];
    }
  }
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return 'data:image/bmp;base64,' + btoa(bin);
}

/** Collect the XI rasters of the body in stream order (their hex data lives in comment lines). */
function parseRasters(body: string): AiRaster[] {
  const out: AiRaster[] = [];
  const re = /\[\s*([-\d.eE+ ]+)\]\s*([-\d.eE+ ]+?)\s+XI[ \t]*\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const mv = m[1].trim().split(/\s+/).map(Number);
    const args = m[2].trim().split(/\s+/).map(Number);
    if (mv.length !== 6 || args.length < 8) continue;
    const [, , , , width, height, bits, channels, , , binAscii] = args;
    const matrix: Matrix = { a: mv[0], b: mv[1], c: mv[2], d: mv[3], e: mv[4], f: mv[5] };
    let src: string | null = null;
    if ((binAscii ?? 0) === 0 && width > 0 && height > 0) {
      // hex rows prefixed by '%' until %AI5_EndRaster
      let i = re.lastIndex;
      const hex: string[] = [];
      while (i < body.length) {
        const eol = body.indexOf('\n', i);
        const line = body.slice(i, eol < 0 ? body.length : eol);
        i = eol < 0 ? body.length : eol + 1;
        if (line.startsWith('%AI5_EndRaster') || !line.startsWith('%')) break;
        hex.push(line.slice(1).trim());
      }
      re.lastIndex = i;
      const bytes = hexToBytes(hex.join(''));
      const rgb = toRgb(bytes, width, height, bits, channels);
      if (rgb) src = rgbToBmpDataUrl(width, height, rgb);
    }
    out.push({ matrix, width, height, bits, channels, src });
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function toRgb(bytes: Uint8Array, w: number, h: number, bits: number, channels: number): Uint8Array | null {
  const out = new Uint8Array(w * h * 3);
  if (bits === 8 && channels === 3) {
    if (bytes.length < w * h * 3) return null;
    out.set(bytes.subarray(0, w * h * 3));
    return out;
  }
  if (bits === 8 && channels === 4) {
    if (bytes.length < w * h * 4) return null;
    for (let i = 0; i < w * h; i++) {
      const c = bytes[i * 4] / 255;
      const m = bytes[i * 4 + 1] / 255;
      const y = bytes[i * 4 + 2] / 255;
      const k = bytes[i * 4 + 3] / 255;
      out[i * 3] = 255 * (1 - Math.min(1, c + k));
      out[i * 3 + 1] = 255 * (1 - Math.min(1, m + k));
      out[i * 3 + 2] = 255 * (1 - Math.min(1, y + k));
    }
    return out;
  }
  if (bits === 8 && channels === 1) {
    if (bytes.length < w * h) return null;
    for (let i = 0; i < w * h; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = bytes[i];
    return out;
  }
  if (bits === 1 && channels === 1) {
    const rowBytes = Math.ceil(w / 8);
    if (bytes.length < rowBytes * h) return null;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = (bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const i = (y * w + x) * 3;
        out[i] = out[i + 1] = out[i + 2] = v;
      }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

interface GState {
  ctm: Matrix;
  fill: HexColor;
  stroke: HexColor;
  fillOn: boolean;
  strokeOn: boolean;
  lineWidth: number;
  cap: StrokeStyle['cap'];
  join: StrokeStyle['join'];
  dash: number[];
  miter: number;
  fillRule: 'nonzero' | 'evenodd';
}

function cmyk(c: number, m: number, y: number, k: number): HexColor {
  return rgbToHex(cmykToRgb({ c: c * 100, m: m * 100, y: y * 100, k: k * 100 }));
}

function parseBoundingBox(text: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const hi = text.match(/%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
  const bb = hi ?? text.match(/%%BoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
  if (!bb) return null;
  const [x0, y0, x1, y1] = bb.slice(1, 5).map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return { x0, y0, x1, y1 };
}

/** The artboard of a native AI file: %AI5_ArtSize + the ruler origin derived from %AI3_TemplateBox (spec 2.2). */
function parseArtboard(text: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const size = text.match(/%AI5_ArtSize:\s*([-\d.]+)\s+([-\d.]+)/);
  if (!size) return null;
  const w = Number(size[1]);
  const h = Number(size[2]);
  if (!(w > 0) || !(h > 0)) return null;
  const tb = text.match(/%AI3_TemplateBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
  let cx = w / 2;
  let cy = h / 2;
  if (tb) {
    const v = tb.slice(1, 5).map(Number);
    if (v.every(Number.isFinite)) {
      cx = (v[0] + v[2]) / 2;
      cy = (v[1] + v[3]) / 2;
    }
  }
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

const FONT_MAP: Array<[RegExp, string]> = [
  [/times|georgia|garamond|serif/i, 'Lora'],
  [/courier|mono/i, 'Source Code Pro'],
  [/impact|bebas/i, 'Bebas Neue'],
  [/montserrat/i, 'Montserrat'],
  [/roboto/i, 'Roboto'],
  [/open ?sans/i, 'Open Sans'],
  [/oswald/i, 'Oswald'],
  [/playfair/i, 'Playfair Display'],
  [/inter\b/i, 'Inter'],
  [/poppins/i, 'Poppins'],
  [/raleway/i, 'Raleway'],
  [/nunito/i, 'Nunito'],
  [/lora/i, 'Lora'],
  [/merriweather/i, 'Merriweather'],
  [/pacifico/i, 'Pacifico'],
  [/source ?code/i, 'Source Code Pro'],
];

function mapFont(name: string): { fontFamily: string; fontWeight: number; fontStyle: 'normal' | 'italic' } {
  let fontFamily = 'Inter';
  for (const [re, fam] of FONT_MAP) if (re.test(name)) {
    fontFamily = fam;
    break;
  }
  const style = name.split('-')[1] ?? '';
  const weight = /black|heavy/i.test(style) ? 900 : /extrabold|ultrabold/i.test(style) ? 800 : /bold/i.test(style) ? 700 : /semibold|demibold/i.test(style) ? 600 : /medium/i.test(style) ? 500 : /extralight|ultralight/i.test(style) ? 200 : /light/i.test(style) ? 300 : /thin/i.test(style) ? 100 : /bold|black|heavy/i.test(name) ? 700 : 400;
  return { fontFamily, fontWeight: weight, fontStyle: /italic|oblique/i.test(name) ? 'italic' : 'normal' };
}

/** Parse Illustrator / EPS text into import items (world px, y down, origin at the artboard's / bounding box's top-left). */
export function importAi(text: string, opts: { name?: string } = {}): AiImportResult {
  const warnings: string[] = [];
  const bbox = parseArtboard(text) ?? parseBoundingBox(text) ?? { x0: 0, y0: 0, x1: 595, y1: 842 };
  const width = (bbox.x1 - bbox.x0) * PT;
  const height = (bbox.y1 - bbox.y0) * PT;
  // PostScript space → px, y down
  const base: Matrix = { a: PT, b: 0, c: 0, d: -PT, e: -bbox.x0 * PT, f: bbox.y1 * PT };
  // the drawing section: after the prolog/setup (or the whole file for bare AI)
  let body = text;
  const setupEnd = text.indexOf('%%EndSetup');
  if (setupEnd >= 0) body = text.slice(setupEnd + 10);
  else {
    const prologEnd = text.indexOf('%%EndProlog');
    if (prologEnd >= 0) body = text.slice(prologEnd + 11);
  }
  const trailer = body.indexOf('%%Trailer');
  if (trailer >= 0) body = body.slice(0, trailer);
  const gradientDefs = parseGradientDefs(setupEnd >= 0 ? text.slice(0, setupEnd) : text);
  const encoding: AiTextEncoding = /%AI_OPuller_TextEncoding:\s*cp1251/.test(text.slice(0, 4000)) ? 'cp1251' : 'cp1252';
  const rasters = parseRasters(body);
  let rasterIndex = 0;
  const tokens = tokenize(body);
  const root = makeGroup([], { name: opts.name ?? 'Artwork' });
  const nodes: Node[] = [root];
  const parents: ID[] = [root.id];
  const parentOf = (id: ID) => nodes.find((n) => n.id === id);
  let locked = false;
  const addChild = (n: Node) => {
    const p = parentOf(parents[parents.length - 1]);
    n.parent = p?.id ?? root.id;
    if (locked) n.locked = true;
    if (p && p.type === 'group') p.children.push(n.id);
    nodes.push(n);
  };
  let gs: GState = { ctm: base, fill: '#000000', stroke: '#000000', fillOn: true, strokeOn: true, lineWidth: 1, cap: 'butt', join: 'miter', dash: [], miter: 4, fillRule: 'nonzero' };
  const gstack: GState[] = [];
  /** group opened by the innermost q / gsave (it becomes the clip group when a mask follows) */
  const qGroups: ID[] = [];
  /** clip groups pushed inside a gsave level without their own q (popped at grestore) */
  const extraPush: number[] = [];
  let sawXR = false;
  const stack: Token[] = [];
  const num = (i: number) => {
    const t = stack[stack.length - 1 - i];
    return t && t.t === 'num' ? t.v : 0;
  };
  const pop = (n: number) => stack.splice(Math.max(0, stack.length - n), n);
  let anchors: Anchor[] = [];
  let sps: SubPath[] = [];
  let cur: Vec = { x: 0, y: 0 };
  let compound = 0;
  // holders: the closures below assign these, which TypeScript's narrowing cannot see
  const compoundState: { paint: { fill: boolean; stroke: boolean } | null } = { paint: null };
  let pendingClip = false;
  const last: { path: Node | null } = { path: null };
  // gradient instance state (Bb … BB)
  let gradientInstance: { name: string; origin: Vec; angle: number; length: number; hilite?: { angle: number; length: number } } | null = null;
  let inGradient = false;
  // text state
  let textType = 0;
  let textMatrix: Matrix | null = null;
  let textBox: Rect | null = null;
  let fontSize = 12;
  let fontName = 'Helvetica';
  let textAlign: 'left' | 'center' | 'right' | 'justify' = 'left';
  let textLeading = 0;
  let textTracking = 0;
  let textRender = 0;
  let textLines: string[] = [];
  const flushSub = (closed: boolean) => {
    if (closed && anchors.length > 2) {
      const first = anchors[0];
      const last = anchors[anchors.length - 1];
      if (Math.abs(first.point.x - last.point.x) < 1e-6 && Math.abs(first.point.y - last.point.y) < 1e-6) {
        first.handleIn = last.handleIn;
        if (last.kind === 'smooth' && first.handleOut) first.kind = 'smooth';
        anchors.pop();
      }
    }
    if (anchors.length) sps.push({ anchors, closed });
    anchors = [];
  };
  const strokeStyle = (): StrokeStyle => {
    const k = Math.hypot(gs.ctm.a, gs.ctm.b) || 1;
    return defaultStroke({ paint: { type: 'solid', color: gs.stroke, opacity: 1 }, width: Math.max(0.1, gs.lineWidth * k), cap: gs.cap, join: gs.join, miterLimit: gs.miter, dash: gs.dash.map((d) => d * k), dashOffset: 0 });
  };
  /** Gradient paint in bounding-box units of a world path for the pending Bb … Bg instance. */
  const gradientPaint = (world: SubPath[]): Paint | null => {
    if (!gradientInstance) return null;
    const def = gradientDefs.get(gradientInstance.name);
    if (!def) return null;
    const b = pathBounds(world);
    if (!b) return null;
    const bw = b.width || 1;
    const bh = b.height || 1;
    const g = gradientInstance;
    const o = applyToPoint(gs.ctm, g.origin);
    const k = Math.sqrt(Math.abs(gs.ctm.a * gs.ctm.d - gs.ctm.b * gs.ctm.c)) || 1;
    if (def.type === 'linear') {
      const rad = (g.angle * Math.PI) / 180;
      const e = applyToPoint(gs.ctm, { x: g.origin.x + Math.cos(rad) * g.length, y: g.origin.y + Math.sin(rad) * g.length });
      return { type: 'linear', x1: (o.x - b.x) / bw, y1: (o.y - b.y) / bh, x2: (e.x - b.x) / bw, y2: (e.y - b.y) / bh, stops: def.stops.map((s) => ({ ...s })), spread: 'pad' };
    }
    const r = (g.length * k) / Math.max(bw, bh);
    const paint: Paint = { type: 'radial', cx: (o.x - b.x) / bw, cy: (o.y - b.y) / bh, r: Math.max(1e-4, r), stops: def.stops.map((s) => ({ ...s })), spread: 'pad' };
    if (g.hilite && g.hilite.length > 0) {
      const rad = (g.hilite.angle * Math.PI) / 180;
      const f = applyToPoint(gs.ctm, { x: g.origin.x + Math.cos(rad) * g.hilite.length * g.length, y: g.origin.y + Math.sin(rad) * g.hilite.length * g.length });
      paint.fx = (f.x - b.x) / bw;
      paint.fy = (f.y - b.y) / bh;
    }
    return paint;
  };
  const emit = (fill: boolean, stroke: boolean) => {
    flushSub(false);
    if (!sps.length) return;
    if (pendingClip) {
      // clipping path: the group opened by q / gsave becomes the clip group, otherwise open one
      const world = transformSubPaths(sps, gs.ctm);
      const clip = makePath(world, { fill: { type: 'none' }, stroke: noStroke(), name: 'Clipping path', fillRule: gs.fillRule });
      const current = parentOf(parents[parents.length - 1]);
      const own = qGroups[qGroups.length - 1];
      if (current && current.type === 'group' && current.id === own && !current.clipId) {
        clip.parent = current.id;
        current.children.push(clip.id);
        current.clipId = clip.id;
        nodes.push(clip);
      } else {
        const g = makeGroup([], { name: 'Clip group' });
        addChild(g);
        clip.parent = g.id;
        g.children.push(clip.id);
        g.clipId = clip.id;
        nodes.push(clip);
        parents.push(g.id);
        if (extraPush.length) extraPush[extraPush.length - 1]++;
      }
      pendingClip = false;
      sps = [];
      return;
    }
    const world = transformSubPaths(sps, gs.ctm);
    const grad = fill ? gradientPaint(world) : null;
    const fp: Paint = fill ? grad ?? { type: 'solid', color: gs.fill, opacity: 1 } : { type: 'none' };
    const st: StrokeStyle = stroke ? strokeStyle() : noStroke();
    const p = makePath(world, { fill: fp, stroke: st, fillRule: world.length > 1 && !sawXR ? 'evenodd' : gs.fillRule, name: world.length > 1 ? 'Compound path' : fill ? 'Path' : 'Stroke' });
    addChild(p);
    last.path = p;
    sps = [];
  };
  const discard = () => {
    flushSub(false);
    if (pendingClip && sps.length) emit(false, false);
    sps = [];
    pendingClip = false;
  };
  const renderOp = (fill: boolean, stroke: boolean, closed: boolean) => {
    if (compound) {
      flushSub(closed);
      compoundState.paint = { fill: (compoundState.paint?.fill ?? false) || fill, stroke: (compoundState.paint?.stroke ?? false) || stroke };
      if (pendingClip) {
        // compound clipping mask: every element is a mask piece
        return;
      }
    } else {
      flushSub(closed);
      emit(fill, stroke);
    }
  };
  const beginGroup = (name = 'Group') => {
    const g = makeGroup([], { name });
    addChild(g);
    parents.push(g.id);
    return g;
  };
  const endGroup = () => {
    if (parents.length > 1) {
      const id = parents.pop()!;
      const g = parentOf(id);
      // drop empty groups
      if (g && g.type === 'group' && !g.children.length) {
        const idx = nodes.indexOf(g);
        if (idx >= 0) nodes.splice(idx, 1);
        const p = parentOf(g.parent ?? '');
        if (p && p.type === 'group') p.children = p.children.filter((c) => c !== id);
      }
    }
  };
  const showText = (s: string) => {
    if (!textMatrix) textMatrix = translate(cur.x, cur.y);
    textLines.push(decodeAiString(s, encoding).replace(/\r/g, '\n'));
  };
  const endText = () => {
    if (!textLines.length || !textMatrix || textRender === 3) {
      textLines = [];
      textMatrix = null;
      textBox = null;
      return;
    }
    const m = multiply(gs.ctm, textMatrix);
    const str = textLines.join('');
    const font = mapFont(fontName);
    const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    const size = fontSize * k;
    const fill: Paint = textRender === 1 ? { type: 'none' } : { type: 'solid', color: gs.fill, opacity: 1 };
    const t = makeText(str, {
      name: str.slice(0, 24),
      kind: textBox ? 'area' : 'point',
      box: textBox ? { width: textBox.width * k, height: textBox.height * k } : undefined,
      style: { fontSize: size, ...font, textAlign, lineHeight: textLeading && fontSize ? Math.max(0.5, textLeading / fontSize) : 1.2, letterSpacing: (textTracking / 1000) * size },
      fill,
      stroke: textRender === 1 || textRender === 2 ? strokeStyle() : undefined,
    });
    // PostScript text is y-up: flip so glyphs stand upright in our y-down space; keep only rotation + translation
    const flipped = multiply(m, { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 });
    const sx = Math.hypot(flipped.a, flipped.b) || 1;
    t.transform = { a: flipped.a / sx, b: flipped.b / sx, c: -flipped.b / sx, d: flipped.a / sx, e: flipped.e, f: flipped.f };
    addChild(t);
    textLines = [];
    textMatrix = null;
    textBox = null;
  };
  let layerDepth = 0;
  const layerGroups = new Set<ID>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t !== 'op') {
      stack.push(tok);
      if (stack.length > 64) stack.splice(0, stack.length - 64);
      continue;
    }
    const op = tok.v;
    switch (op) {
      // --- Illustrator path construction (y up)
      case 'm':
      case 'moveto': {
        flushSub(false);
        cur = { x: num(1), y: num(0) };
        anchors.push({ point: { ...cur }, handleIn: null, handleOut: null, kind: 'corner' });
        pop(2);
        break;
      }
      case 'l':
      case 'L':
      case 'lineto': {
        cur = { x: num(1), y: num(0) };
        anchors.push({ point: { ...cur }, handleIn: null, handleOut: null, kind: op === 'l' ? 'smooth' : 'corner' });
        pop(2);
        break;
      }
      case 'c':
      case 'C':
      case 'curveto': {
        const c1 = { x: num(5), y: num(4) };
        const c2 = { x: num(3), y: num(2) };
        const p = { x: num(1), y: num(0) };
        const prev = anchors[anchors.length - 1];
        if (prev) prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
        anchors.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: op === 'C' ? 'corner' : 'smooth' });
        cur = p;
        pop(6);
        break;
      }
      case 'v':
      case 'V': {
        // first control point = current point
        const c2 = { x: num(3), y: num(2) };
        const p = { x: num(1), y: num(0) };
        anchors.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: op === 'V' ? 'corner' : 'smooth' });
        cur = p;
        pop(4);
        break;
      }
      case 'y':
      case 'Y': {
        // second control point = end point
        const c1 = { x: num(3), y: num(2) };
        const p = { x: num(1), y: num(0) };
        const prev = anchors[anchors.length - 1];
        if (prev) prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
        anchors.push({ point: p, handleIn: null, handleOut: null, kind: op === 'Y' ? 'corner' : 'smooth' });
        cur = p;
        pop(4);
        break;
      }
      case 'h':
      case 'H':
      case 'closepath':
        flushSub(true);
        break;
      case 'rectfill':
      case 'rectstroke': {
        const x = num(3);
        const y = num(2);
        const w = num(1);
        const h = num(0);
        pop(4);
        flushSub(false);
        sps.push({ anchors: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map((p) => ({ point: p, handleIn: null, handleOut: null, kind: 'corner' as const })), closed: true });
        emit(op === 'rectfill', op === 'rectstroke');
        break;
      }
      // --- painting (Illustrator letters and PostScript names)
      case 'f':
      case 'fill':
      case 'eofill':
        renderOp(true, false, true);
        break;
      case 'F':
        renderOp(true, false, false);
        break;
      case 's':
        renderOp(false, true, true);
        break;
      case 'S':
      case 'stroke':
        renderOp(false, true, false);
        break;
      case 'b':
        renderOp(true, true, true);
        break;
      case 'B':
        renderOp(true, true, false);
        break;
      case 'n':
      case 'N':
      case 'newpath':
        if (textType === 1 && textMatrix && anchors.length) {
          // area text: the container path gives the box
          flushSub(true);
          const b = pathBounds(sps);
          if (b) {
            textBox = b;
            textMatrix = multiply(textMatrix, translate(b.x, b.y + b.height));
          }
          sps = [];
          break;
        }
        if (!compound) discard();
        else flushSub(op === 'n');
        break;
      case 'W':
      case 'clip':
      case 'eoclip':
        pendingClip = true;
        break;
      // --- compound paths: the pieces accumulate until *U
      case '*u':
        compound++;
        if (compound === 1) compoundState.paint = null;
        break;
      case '*U': {
        compound = Math.max(0, compound - 1);
        if (!compound) {
          flushSub(true);
          if (sps.length) {
            if (pendingClip) emit(false, false);
            else emit(compoundState.paint?.fill ?? true, compoundState.paint?.stroke ?? false);
          }
          compoundState.paint = null;
        }
        break;
      }
      // --- colours
      case 'k':
      case 'setcmykcolor':
        gs.fill = cmyk(num(3), num(2), num(1), num(0));
        if (op === 'setcmykcolor') gs.stroke = gs.fill;
        pop(4);
        break;
      case 'K':
        gs.stroke = cmyk(num(3), num(2), num(1), num(0));
        pop(4);
        break;
      case 'g':
      case 'setgray': {
        const v = Math.max(0, Math.min(1, num(0)));
        gs.fill = rgbToHex({ r: v * 255, g: v * 255, b: v * 255 });
        if (op === 'setgray') gs.stroke = gs.fill;
        pop(1);
        break;
      }
      case 'G': {
        const v = Math.max(0, Math.min(1, num(0)));
        gs.stroke = rgbToHex({ r: v * 255, g: v * 255, b: v * 255 });
        pop(1);
        break;
      }
      case 'Xa':
      case 'setrgbcolor':
        gs.fill = rgbToHex({ r: num(2) * 255, g: num(1) * 255, b: num(0) * 255 });
        if (op === 'setrgbcolor') gs.stroke = gs.fill;
        pop(3);
        break;
      case 'XA':
        gs.stroke = rgbToHex({ r: num(2) * 255, g: num(1) * 255, b: num(0) * 255 });
        pop(3);
        break;
      case 'x':
      case 'X': {
        // custom (spot) colour: c m y k (name) tint x — the tint is stored as 1 − tint
        const col = tintHex(cmyk(num(5), num(4), num(3), num(2)), num(0));
        if (op === 'x') gs.fill = col;
        else gs.stroke = col;
        pop(6);
        break;
      }
      case 'Xx':
      case 'XX': {
        // AI7 custom RGB colour: r g b (name) tint type Xx (AI8 also writes c m y k r g b (name) tint type)
        let nameAt = -1;
        for (let j = stack.length - 1; j >= 0; j--) if (stack[j].t === 'str') {
          nameAt = j;
          break;
        }
        if (nameAt >= 0) {
          const comps = stack.slice(0, nameAt).filter((t): t is { t: 'num'; v: number } => t.t === 'num').map((t) => t.v);
          const after = stack.slice(nameAt + 1).filter((t): t is { t: 'num'; v: number } => t.t === 'num').map((t) => t.v);
          const tint = after[0] ?? 0;
          let rgb: HexColor;
          if (comps.length >= 7) rgb = rgbToHex({ r: comps[comps.length - 3] * 255, g: comps[comps.length - 2] * 255, b: comps[comps.length - 1] * 255 });
          else if (comps.length >= 4 && comps.length < 7 && after[1] === 0) rgb = cmyk(comps[comps.length - 4], comps[comps.length - 3], comps[comps.length - 2], comps[comps.length - 1]);
          else rgb = rgbToHex({ r: (comps[comps.length - 3] ?? 0) * 255, g: (comps[comps.length - 2] ?? 0) * 255, b: (comps[comps.length - 1] ?? 0) * 255 });
          const col = tintHex(rgb, tint);
          if (op === 'Xx') gs.fill = col;
          else gs.stroke = col;
        }
        stack.length = 0;
        break;
      }
      case 'p':
      case 'P':
        warnings.push('Pattern fills are not supported (flattened to the current colour)');
        stack.length = 0;
        break;
      // --- gradients (instances; definitions come from the setup comments)
      case 'Bb':
        inGradient = true;
        gradientInstance = null;
        break;
      case 'Bh':
        gradientInstance = { ...(gradientInstance ?? { name: '', origin: { x: 0, y: 0 }, angle: 0, length: 1 }), hilite: { angle: num(1), length: num(0) } };
        pop(4);
        break;
      case 'Bg': {
        // flag (name) xOrigin yOrigin angle length a b c d tx ty Bg
        const nameTok = stack[stack.length - 11];
        const name = nameTok && nameTok.t === 'str' ? nameTok.v : '';
        gradientInstance = { ...(gradientInstance ?? {}), name, origin: { x: num(9), y: num(8) }, angle: num(7), length: num(6) } as typeof gradientInstance;
        pop(12);
        break;
      }
      case 'BB': {
        const flag = num(0);
        pop(1);
        const lp = last.path;
        if (flag && lp && lp.type === 'path' && lp.stroke.paint.type === 'none') lp.stroke = strokeStyle();
        inGradient = false;
        gradientInstance = null;
        break;
      }
      case 'Bm':
      case 'Bc':
      case 'Xm':
        pop(6);
        break;
      // --- stroke attributes
      case 'w':
      case 'setlinewidth':
        gs.lineWidth = num(0);
        pop(1);
        break;
      case 'j':
      case 'setlinejoin':
        gs.join = num(0) === 1 ? 'round' : num(0) === 2 ? 'bevel' : 'miter';
        pop(1);
        break;
      case 'J':
      case 'setlinecap':
        gs.cap = num(0) === 1 ? 'round' : num(0) === 2 ? 'square' : 'butt';
        pop(1);
        break;
      case 'd':
      case 'setdash': {
        const arr = stack[stack.length - 2];
        gs.dash = arr && arr.t === 'arr' ? arr.v.filter((t): t is { t: 'num'; v: number } => t.t === 'num').map((t) => t.v) : [];
        pop(2);
        break;
      }
      case 'M':
      case 'setmiterlimit':
        gs.miter = Math.max(1, num(0) || 4);
        pop(1);
        break;
      case 'XR':
        sawXR = true;
        gs.fillRule = num(0) === 1 ? 'evenodd' : 'nonzero';
        pop(1);
        break;
      case 'A':
        locked = num(0) === 1;
        pop(1);
        break;
      case 'O':
      case 'R':
      case 'D':
      case 'i':
      case 'Ap':
      case 'Ar':
      case 'XL':
        pop(1);
        break;
      // --- groups, layers, clipping
      case 'u':
      case 'q':
      case 'gsave': {
        const g = beginGroup(op === 'q' ? 'Clip group' : 'Group');
        if (op !== 'u') {
          gstack.push({ ...gs, dash: [...gs.dash] });
          qGroups.push(g.id);
          extraPush.push(0);
        }
        break;
      }
      case 'U':
      case 'Q':
      case 'grestore': {
        if (op !== 'U') {
          const prev = gstack.pop();
          if (prev) gs = prev;
          qGroups.pop();
          const extra = extraPush.pop() ?? 0;
          for (let k = 0; k < extra; k++) endGroup();
        }
        endGroup();
        break;
      }
      case 'Lb': {
        layerDepth++;
        const g = beginGroup('Layer');
        if (parents.length === 2) layerGroups.add(g.id);
        // visible preview enabled printing dimmed hasMultiLayerMasks colorIndex r g b Lb
        if (stack.length >= 10) {
          g.visible = num(9) !== 0;
          g.locked = num(7) === 0;
        }
        stack.length = 0;
        break;
      }
      case 'LB':
        layerDepth--;
        endGroup();
        break;
      case 'Ln': {
        const name = stack[stack.length - 1];
        const g = parentOf(parents[parents.length - 1]);
        if (name && name.t === 'str' && g && g.type === 'group') g.name = decodeAiString(name.v, encoding);
        pop(1);
        break;
      }
      // --- raster images
      case 'XI': {
        const r = rasters[rasterIndex++];
        stack.length = 0;
        if (!r) break;
        if (!r.src) {
          warnings.push('An embedded image uses an unsupported encoding and was skipped');
          break;
        }
        const img = makeImage(r.src, r.width, r.height, { name: 'Image' });
        img.transform = multiply(gs.ctm, r.matrix);
        addChild(img);
        break;
      }
      case 'XF':
      case 'XG':
      case 'Xh':
      case 'XH':
        if (op === 'XF') warnings.push('Linked images are not embedded in the file and were skipped');
        stack.length = 0;
        break;
      // --- transforms (PostScript)
      case 'translate':
        gs.ctm = multiply(gs.ctm, translate(num(1), num(0)));
        pop(2);
        break;
      case 'scale':
        gs.ctm = multiply(gs.ctm, scaleM(num(1), num(0)));
        pop(2);
        break;
      case 'rotate':
        gs.ctm = multiply(gs.ctm, rotate(num(0)));
        pop(1);
        break;
      case 'concat': {
        const arr = stack[stack.length - 1];
        if (arr && arr.t === 'arr' && arr.v.length === 6 && arr.v.every((t) => t.t === 'num')) {
          const v = arr.v.map((t) => (t as { v: number }).v);
          gs.ctm = multiply(gs.ctm, { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] });
        }
        pop(1);
        break;
      }
      // --- text objects
      case 'To':
        textLines = [];
        textMatrix = null;
        textBox = null;
        textType = num(0);
        textRender = 0;
        pop(1);
        break;
      case 'Tp': {
        // a b c d tx ty startPt Tp
        textMatrix = { a: num(6), b: num(5), c: num(4), d: num(3), e: num(2), f: num(1) };
        pop(7);
        break;
      }
      case 'TP':
        break;
      case 'Tr':
        textRender = num(0);
        pop(1);
        break;
      case 'Tf': {
        // /_fontname size [ascent descent] Tf
        let nameAt = -1;
        for (let j = stack.length - 1; j >= 0; j--) if (stack[j].t === 'name') {
          nameAt = j;
          break;
        }
        if (nameAt >= 0) {
          const nm = stack[nameAt];
          if (nm.t === 'name') fontName = nm.v.replace(/^_/, '');
          const sz = stack[nameAt + 1];
          if (sz && sz.t === 'num' && sz.v > 0) fontSize = sz.v;
        }
        stack.length = 0;
        break;
      }
      case 'Ta':
        textAlign = num(0) === 1 ? 'center' : num(0) === 2 ? 'right' : num(0) >= 3 ? 'justify' : 'left';
        pop(1);
        break;
      case 'Tl':
        textLeading = num(1);
        pop(2);
        break;
      case 'Tt':
        textTracking = num(0);
        pop(1);
        break;
      case 'Tz':
      case 'Tl2':
        pop(2);
        break;
      case 'Ts':
      case 'TA':
      case 'Tq':
      case 'Tc':
      case 'Tw':
      case 'TV':
      case 'Tv':
        pop(1);
        break;
      case 'TC':
      case 'TW':
      case 'Ti':
        pop(3);
        break;
      case 'Tk':
      case 'TK':
        pop(2);
        break;
      case 'Tx':
      case 'TX':
      case 'Tj':
      case 'TJ':
      case 'show': {
        const s = stack[stack.length - 1];
        if (s && s.t === 'str' && op !== 'TX') showText(s.v);
        pop(1);
        break;
      }
      case 'T*':
      case 'T+':
      case 'T-':
        break;
      case 'TO':
        endText();
        break;
      // --- everything else: keep the stack tidy
      default:
        if (op === 'def' || op === 'bind' || op === 'begin' || op === 'end' || op === 'pop') stack.length = Math.max(0, stack.length - (op === 'def' ? 2 : op === 'pop' ? 1 : 0));
        else if (op === 'showpage' || op === '<<' || op === '>>' || op === 'dict' || op === 'findfont' || op === 'scalefont' || op === 'setfont') {
          if (op === 'setfont' || op === 'scalefont' || op === 'findfont') {
            const nameTok = stack.find((t) => t.t === 'name');
            if (nameTok && nameTok.t === 'name') fontName = nameTok.v;
            const sizeTok = [...stack].reverse().find((t) => t.t === 'num');
            if (op === 'scalefont' && sizeTok && sizeTok.t === 'num') fontSize = sizeTok.v;
          }
          stack.length = 0;
        }
        break;
    }
  }
  endText();
  void layerDepth;
  void inGradient;
  let items: ImportedItem[] = root.children.length ? [{ root, nodes }] : [];
  if (root.children.length && root.children.every((id) => layerGroups.has(id))) {
    // an Illustrator document with layers: one item per layer (itemsToLayers turns them into real layers)
    const byId = new Map(nodes.map((n) => [n.id, n]));
    items = root.children.map((id) => {
      const g = byId.get(id)!;
      g.parent = null;
      const list: Node[] = [];
      const visit = (nid: ID) => {
        const n = byId.get(nid);
        if (!n) return;
        list.push(n);
        if (n.type === 'group' || n.type === 'layer') for (const c of n.children) visit(c);
      };
      visit(id);
      return { root: g, nodes: list };
    });
  }
  if (!items.length) warnings.push('No drawable artwork found (unsupported PostScript or an empty file)');
  return { items, width, height, warnings: Array.from(new Set(warnings)) };
}
