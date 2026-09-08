/**
 * Illustrator native (AI 3–8 "PostScript" format) and Illustrator EPS import:
 * a small PostScript tokenizer plus an interpreter for the Adobe Illustrator
 * drawing operators (m l c v y h f F s S b B N n k K g G Xa XA w j J d u U
 * *u *U q Q W Lb LB Ln To TO Tp TP Tf Tx TX Ta) and the generic PostScript
 * operators (moveto lineto curveto closepath fill stroke setrgbcolor ...),
 * enough for artwork exported by Illustrator and most simple EPS files.
 */
import type { Node, ID, SubPath, Anchor, Matrix, Vec, HexColor, Paint, StrokeStyle } from '@/model/types';
import { makePath, makeGroup, makeText } from '@/model/nodes';
import { noStroke, defaultStroke } from '@/model/defaults';
import { multiply, translate, scale as scaleM, rotate } from '@/geometry/matrix';
import { transformSubPaths } from '@/geometry/path';
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

const FONT_MAP: Array<[RegExp, string]> = [
  [/times|georgia|garamond|serif/i, 'Lora'],
  [/courier|mono/i, 'Source Code Pro'],
  [/impact|bebas/i, 'Bebas Neue'],
  [/montserrat/i, 'Montserrat'],
  [/roboto/i, 'Roboto'],
  [/open ?sans/i, 'Open Sans'],
  [/oswald/i, 'Oswald'],
  [/playfair/i, 'Playfair Display'],
];

function mapFont(name: string): { fontFamily: string; fontWeight: number; fontStyle: 'normal' | 'italic' } {
  let fontFamily = 'Inter';
  for (const [re, fam] of FONT_MAP) if (re.test(name)) {
    fontFamily = fam;
    break;
  }
  return { fontFamily, fontWeight: /bold|black|heavy/i.test(name) ? 700 : 400, fontStyle: /italic|oblique/i.test(name) ? 'italic' : 'normal' };
}

/** Parse Illustrator / EPS text into import items (world px, y down, origin at the bounding box's top-left). */
export function importAi(text: string, opts: { name?: string } = {}): AiImportResult {
  const warnings: string[] = [];
  const bbox = parseBoundingBox(text) ?? { x0: 0, y0: 0, x1: 595, y1: 842 };
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
  const tokens = tokenize(body);
  const root = makeGroup([], { name: opts.name ?? 'Artwork' });
  const nodes: Node[] = [root];
  const parents: ID[] = [root.id];
  const parentOf = (id: ID) => nodes.find((n) => n.id === id);
  const addChild = (n: Node) => {
    const p = parentOf(parents[parents.length - 1]);
    n.parent = p?.id ?? root.id;
    if (p && p.type === 'group') p.children.push(n.id);
    nodes.push(n);
  };
  let gs: GState = { ctm: base, fill: '#000000', stroke: '#000000', fillOn: true, strokeOn: true, lineWidth: 1, cap: 'butt', join: 'miter', dash: [] };
  const gstack: GState[] = [];
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
  let pendingClip = false;
  // text state
  let textMatrix: Matrix | null = null;
  let fontSize = 12;
  let fontName = 'Helvetica';
  let textAlign: 'left' | 'center' | 'right' = 'left';
  let textLeading = 0;
  let textLines: string[] = [];
  const flushSub = (closed: boolean) => {
    if (anchors.length) sps.push({ anchors, closed });
    anchors = [];
  };
  const emit = (fill: boolean, stroke: boolean) => {
    flushSub(false);
    if (!sps.length) return;
    if (pendingClip) {
      // clipping path: open a clip group
      const world = transformSubPaths(sps, gs.ctm);
      const g = makeGroup([], { name: 'Clip group' });
      addChild(g);
      const clip = makePath(world, { fill: { type: 'none' }, stroke: noStroke(), name: 'Clipping path' });
      clip.parent = g.id;
      g.children.push(clip.id);
      g.clipId = clip.id;
      nodes.push(clip);
      parents.push(g.id);
      pendingClip = false;
      sps = [];
      return;
    }
    const world = transformSubPaths(sps, gs.ctm);
    const k = Math.hypot(gs.ctm.a, gs.ctm.b) || 1;
    const fp: Paint = fill ? { type: 'solid', color: gs.fill, opacity: 1 } : { type: 'none' };
    const st: StrokeStyle = stroke ? defaultStroke({ paint: { type: 'solid', color: gs.stroke, opacity: 1 }, width: Math.max(0.1, gs.lineWidth * k), cap: gs.cap, join: gs.join, dash: gs.dash.map((d) => d * k) }) : noStroke();
    const p = makePath(world, { fill: fp, stroke: st, fillRule: 'nonzero', name: fill ? 'Path' : 'Stroke' });
    addChild(p);
    sps = [];
  };
  const discard = () => {
    flushSub(false);
    if (pendingClip && sps.length) emit(false, false);
    sps = [];
    pendingClip = false;
  };
  const startCompound = () => {
    compound++;
  };
  const endCompound = () => {
    compound = Math.max(0, compound - 1);
  };
  const beginGroup = (name = 'Group') => {
    const g = makeGroup([], { name });
    addChild(g);
    parents.push(g.id);
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
    textLines.push(s);
  };
  const endText = () => {
    if (!textLines.length || !textMatrix) {
      textLines = [];
      textMatrix = null;
      return;
    }
    const m = multiply(gs.ctm, textMatrix);
    const str = textLines.join('\n');
    const font = mapFont(fontName);
    const t = makeText(str, { name: str.slice(0, 24), style: { fontSize: fontSize * PT * (Math.hypot(gs.ctm.a, gs.ctm.b) / PT || 1), ...font, textAlign, lineHeight: textLeading && fontSize ? Math.max(0.5, textLeading / fontSize) : 1.2 }, fill: { type: 'solid', color: gs.fill, opacity: 1 } });
    // PostScript text is y-up: flip so glyphs stand upright in our y-down space
    t.transform = multiply(m, { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 });
    addChild(t);
    textLines = [];
    textMatrix = null;
  };
  let layerDepth = 0;
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
        anchors.push({ point: { ...cur }, handleIn: null, handleOut: null, kind: 'corner' });
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
        anchors.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: 'smooth' });
        cur = p;
        pop(6);
        break;
      }
      case 'v':
      case 'V': {
        // first control point = current point
        const c2 = { x: num(3), y: num(2) };
        const p = { x: num(1), y: num(0) };
        anchors.push({ point: p, handleIn: { x: c2.x - p.x, y: c2.y - p.y }, handleOut: null, kind: 'smooth' });
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
        anchors.push({ point: p, handleIn: null, handleOut: null, kind: 'smooth' });
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
      case 'F':
      case 'fill':
      case 'eofill':
        if (compound) flushSub(true);
        else {
          flushSub(true);
          emit(true, false);
        }
        break;
      case 's':
      case 'S':
      case 'stroke':
        if (compound) flushSub(op === 's');
        else {
          flushSub(op === 's');
          emit(false, true);
        }
        break;
      case 'b':
      case 'B':
        if (compound) flushSub(op === 'b');
        else {
          flushSub(op === 'b');
          emit(true, true);
        }
        break;
      case 'n':
      case 'N':
      case 'newpath':
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
        startCompound();
        break;
      case '*U': {
        endCompound();
        if (!compound) {
          // the last painting operator before *U decided fill/stroke; assume fill (evenodd)
          flushSub(true);
          if (sps.length) {
            const world = transformSubPaths(sps, gs.ctm);
            const p = makePath(world, { fill: { type: 'solid', color: gs.fill, opacity: 1 }, stroke: noStroke(), fillRule: 'evenodd', name: 'Compound path' });
            addChild(p);
            sps = [];
          }
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
        // custom (spot) colour: c m y k (name) tint x
        const tint = num(0);
        const c = cmyk(num(5), num(4), num(3), num(2));
        const col = tint < 1 ? rgbToHex({ r: 255 - (255 - parseInt(c.slice(1, 3), 16)) * tint, g: 255 - (255 - parseInt(c.slice(3, 5), 16)) * tint, b: 255 - (255 - parseInt(c.slice(5, 7), 16)) * tint }) : c;
        if (op === 'x') gs.fill = col;
        else gs.stroke = col;
        pop(6);
        break;
      }
      case 'Xx':
      case 'XX': {
        // AI8 custom colour: c m y k r g b (name) type tint Xx
        const tint = num(0);
        const rgb = rgbToHex({ r: num(5) * 255, g: num(4) * 255, b: num(3) * 255 });
        const col = tint < 1 ? rgbToHex({ r: 255 - (255 - parseInt(rgb.slice(1, 3), 16)) * tint, g: 255 - (255 - parseInt(rgb.slice(3, 5), 16)) * tint, b: 255 - (255 - parseInt(rgb.slice(5, 7), 16)) * tint }) : rgb;
        if (op === 'Xx') gs.fill = col;
        else gs.stroke = col;
        pop(10);
        break;
      }
      case 'p':
      case 'P':
        warnings.push('Pattern fills are not supported (flattened to the current colour)');
        stack.length = 0;
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
        pop(1);
        break;
      // --- groups, layers, clipping
      case 'u':
      case 'q':
      case 'gsave':
        if (op !== 'u') gstack.push({ ...gs, dash: [...gs.dash] });
        beginGroup(op === 'q' ? 'Clip group' : 'Group');
        break;
      case 'U':
      case 'Q':
      case 'grestore': {
        if (op !== 'U') {
          const prev = gstack.pop();
          if (prev) gs = prev;
        }
        endGroup();
        break;
      }
      case 'Lb':
        layerDepth++;
        beginGroup('Layer');
        break;
      case 'LB':
        layerDepth--;
        endGroup();
        break;
      case 'Ln': {
        const name = stack[stack.length - 1];
        const g = parentOf(parents[parents.length - 1]);
        if (name && name.t === 'str' && g && g.type === 'group') g.name = name.v;
        pop(1);
        break;
      }
      case 'A':
        pop(1);
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
        pop(1);
        break;
      case 'Tp': {
        // a b c d tx ty 0 Tp
        textMatrix = { a: num(6), b: num(5), c: num(4), d: num(3), e: num(2), f: num(1) };
        pop(7);
        break;
      }
      case 'TP':
        break;
      case 'Tf': {
        const size = num(0);
        const name = stack[stack.length - 2];
        if (name && name.t === 'name') fontName = name.v.replace(/^_/, '');
        if (size) fontSize = size;
        pop(2);
        break;
      }
      case 'Ta':
        textAlign = num(0) === 1 ? 'center' : num(0) === 2 ? 'right' : 'left';
        pop(1);
        break;
      case 'Tl':
        textLeading = num(1);
        pop(2);
        break;
      case 'Tx':
      case 'TX':
      case 'Tj':
      case 'TJ':
      case 'show': {
        const s = stack[stack.length - 1];
        if (s && s.t === 'str') showText(s.v);
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
  const items: ImportedItem[] = root.children.length ? [{ root, nodes }] : [];
  if (!items.length) warnings.push('No drawable artwork found (unsupported PostScript or an empty file)');
  return { items, width, height, warnings: Array.from(new Set(warnings)) };
}
