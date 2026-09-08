/**
 * Text layout engine: measures text with a 2D canvas and produces positioned
 * lines/runs in the text node's local coordinate system.
 *
 * Point text: origin (0,0) is the start of the first baseline (before alignment).
 * Area text: origin (0,0) is the top-left corner of the box; text is wrapped to box.width.
 * Path text: laid out like a single-line point text; the tool/outline code maps the
 * x offsets onto the path.
 *
 * Runs keep their trailing whitespace (so carets can be placed after a space) but a
 * line's `width` excludes trailing whitespace for alignment purposes. Words that span
 * several runs (style boundaries inside a word) are wrapped as a unit; tabs advance to
 * the next tab stop; text-transform is applied per character so that character indices
 * stay stable.
 */
import type { TextNode, TextStyle, TextRun, Rect } from '@/model/types';

export interface LaidRun {
  text: string;
  style: TextStyle;
  /** x offset of this run within the line (relative to line.x) */
  x: number;
  width: number;
  /** index of the first character of this run within the whole text */
  start: number;
}

export interface LaidLine {
  runs: LaidRun[];
  /** x of the line start (after alignment) */
  x: number;
  /** baseline y */
  y: number;
  /** width excluding trailing whitespace */
  width: number;
  ascent: number;
  descent: number;
  /** index of the first character of this line in the text */
  start: number;
  /** index after the last character (excluding the newline) */
  end: number;
  /** whether this line ends a paragraph (hard return / end of text) */
  paragraphEnd: boolean;
}

export interface TextLayout {
  lines: LaidLine[];
  bounds: Rect;
  /** whether area text overflowed the box */
  overflow: boolean;
  /** logical size (for point text this is the text extents) */
  width: number;
  height: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

export function fontString(style: TextStyle): string {
  const family = /[\s,]/.test(style.fontFamily) ? `"${style.fontFamily}"` : style.fontFamily;
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${family}, sans-serif`;
}

export interface Metrics {
  width: number;
  ascent: number;
  descent: number;
}

const metricsCache = new Map<string, Metrics>();

export function measure(text: string, style: TextStyle): Metrics {
  const key = fontString(style) + '|' + style.letterSpacing + '|' + text;
  const cached = metricsCache.get(key);
  if (cached) return cached;
  const c = ctx();
  let m: Metrics;
  if (!c) {
    m = { width: text.length * style.fontSize * 0.55 + style.letterSpacing * text.length, ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 };
  } else {
    c.font = fontString(style);
    try {
      (c as any).letterSpacing = `${style.letterSpacing}px`;
    } catch {
      /* unsupported */
    }
    const tm = c.measureText(text);
    let width = tm.width;
    if (!('letterSpacing' in c) && style.letterSpacing && text.length > 0) width += style.letterSpacing * text.length;
    const ascent = (tm as any).fontBoundingBoxAscent ?? style.fontSize * 0.8;
    const descent = (tm as any).fontBoundingBoxDescent ?? style.fontSize * 0.2;
    m = { width, ascent, descent };
  }
  if (metricsCache.size > 20000) metricsCache.clear();
  metricsCache.set(key, m);
  return m;
}

export function clearMeasureCache(): void {
  metricsCache.clear();
}

export function applyTransform(text: string, style: TextStyle): string {
  switch (style.textTransform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
    default:
      return text;
  }
}

/**
 * Apply the text transform to a piece of text while keeping its length (characters
 * whose case mapping changes the length, e.g. "ß" → "SS", are left untouched).
 * `wordStart` tells whether the piece begins a word (for capitalize).
 */
export function transformPiece(text: string, style: TextStyle, wordStart = true): string {
  const mode = style.textTransform;
  if (mode === 'none' || !text) return text;
  if (mode === 'capitalize') {
    if (!wordStart) return text;
    const first = text[0].toUpperCase();
    return (first.length === 1 ? first : text[0]) + text.slice(1);
  }
  const t = mode === 'uppercase' ? text.toUpperCase() : text.toLowerCase();
  if (t.length === text.length) return t;
  let out = '';
  for (const ch of text) {
    const u = mode === 'uppercase' ? ch.toUpperCase() : ch.toLowerCase();
    out += u.length === ch.length ? u : ch;
  }
  return out;
}

/** Resolve runs into an array of {text, style} with the base style merged in. */
export function resolveRuns(node: TextNode): Array<{ text: string; style: TextStyle }> {
  const runs: TextRun[] = node.runs && node.runs.length ? node.runs : [{ text: node.text }];
  return runs.map((r) => ({ text: r.text, style: { ...node.style, ...(r.style ?? {}) } }));
}

interface Piece {
  text: string;
  style: TextStyle;
  start: number;
  kind: 'word' | 'space' | 'tab' | 'newline';
}

/** Split runs into word/space/tab/newline pieces. */
function pieces(node: TextNode): Piece[] {
  const out: Piece[] = [];
  let index = 0;
  for (const run of resolveRuns(node)) {
    const re = /(\n)|(\t)|([^\S\n\t]+)|([^\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(run.text))) {
      const text = m[0];
      out.push({ text, style: run.style, start: index, kind: m[1] ? 'newline' : m[2] ? 'tab' : m[3] ? 'space' : 'word' });
      index += text.length;
    }
  }
  return out;
}

/** A word possibly made of several styled pieces (no whitespace inside). */
interface Word {
  parts: Array<{ text: string; style: TextStyle; start: number; width: number; metrics: Metrics }>;
  width: number;
  start: number;
}

export function isWhitespace(text: string): boolean {
  return /^\s+$/.test(text);
}

let layoutCache = new WeakMap<TextNode, TextLayout>();
let generation = 0;

/** Drop all cached layouts (e.g. after a web font finished loading). */
export function invalidateLayouts(): void {
  layoutCache = new WeakMap();
  generation++;
}

/** Bumps whenever layouts were invalidated; handy for memo keys. */
export function layoutGeneration(): number {
  return generation;
}

export function layoutText(node: TextNode): TextLayout {
  const cached = layoutCache.get(node);
  if (cached) return cached;
  const l = computeLayout(node);
  layoutCache.set(node, l);
  return l;
}

const EPS = 1e-6;

function computeLayout(node: TextNode): TextLayout {
  const base = node.style;
  const isArea = node.kind === 'area' && !!node.box;
  const maxWidth = isArea ? Math.max(0, node.box!.width) : Infinity;
  const ps = pieces(node);
  const lines: LaidLine[] = [];
  const baseMetrics = measure('Hg', base);

  let cur: LaidRun[] = [];
  let curWidth = 0;
  let curStart = 0;
  let curAscent = 0;
  let curDescent = 0;
  let curMaxSize = 0;
  let curLineHeight = 0;
  let y = 0;
  let first = true;

  const pushLine = (end: number, paragraphEnd: boolean) => {
    const size = curMaxSize || base.fontSize;
    const lh = (curLineHeight || base.lineHeight) * size;
    const asc = curAscent || baseMetrics.ascent;
    const desc = curDescent || baseMetrics.descent;
    if (first) {
      y = isArea ? asc : 0;
      first = false;
    } else {
      y += lh;
    }
    // width for alignment excludes trailing whitespace (runs are kept for carets)
    let width = curWidth;
    for (let i = cur.length - 1; i >= 0 && isWhitespace(cur[i].text); i--) width -= cur[i].width;
    lines.push({ runs: cur, x: 0, y, width: Math.max(0, width), ascent: asc, descent: desc, start: curStart, end, paragraphEnd });
    if (paragraphEnd) y += base.paragraphSpacing;
    cur = [];
    curWidth = 0;
    curAscent = 0;
    curDescent = 0;
    curMaxSize = 0;
    curLineHeight = 0;
  };

  const addRun = (text: string, style: TextStyle, start: number, width: number, m: Metrics) => {
    cur.push({ text, style, x: curWidth, width, start });
    curWidth += width;
    curAscent = Math.max(curAscent, m.ascent);
    curDescent = Math.max(curDescent, m.descent);
    curMaxSize = Math.max(curMaxSize, style.fontSize);
    curLineHeight = Math.max(curLineHeight, style.lineHeight);
  };

  // group consecutive word pieces into words
  let i = 0;
  while (i < ps.length) {
    const p = ps[i];
    if (p.kind === 'newline') {
      pushLine(p.start, true);
      curStart = p.start + 1;
      i++;
      continue;
    }
    if (p.kind === 'tab') {
      const tabW = Math.max(1, p.style.fontSize * 2);
      const rem = curWidth % tabW;
      const w = rem < EPS ? tabW : tabW - rem;
      addRun(p.text, p.style, p.start, w, measure(' ', p.style));
      i++;
      continue;
    }
    if (p.kind === 'space') {
      const m = measure(p.text, p.style);
      addRun(p.text, p.style, p.start, m.width, m);
      i++;
      continue;
    }
    // word: collect all consecutive word pieces
    const word: Word = { parts: [], width: 0, start: p.start };
    let k = i;
    while (k < ps.length && ps[k].kind === 'word') {
      const q = ps[k];
      const text = transformPiece(q.text, q.style, k === i);
      const m = measure(text, q.style);
      word.parts.push({ text, style: q.style, start: q.start, width: m.width, metrics: m });
      word.width += m.width;
      k++;
    }
    i = k;
    if (isArea && cur.length > 0 && curWidth + word.width > maxWidth + EPS) {
      // wrap before this word
      pushLine(word.start, false);
      curStart = word.start;
    }
    if (isArea && word.width > maxWidth + EPS && maxWidth > 0) {
      // break a very long word by characters
      for (const part of word.parts) {
        let chunk = '';
        let chunkStart = part.start;
        for (const ch of part.text) {
          const w = measure(chunk + ch, part.style).width;
          if (chunk && curWidth + w > maxWidth + EPS) {
            const cm = measure(chunk, part.style);
            addRun(chunk, part.style, chunkStart, cm.width, cm);
            pushLine(chunkStart + chunk.length, false);
            curStart = chunkStart + chunk.length;
            chunkStart += chunk.length;
            chunk = '';
          }
          chunk += ch;
        }
        if (chunk) {
          const cm = measure(chunk, part.style);
          addRun(chunk, part.style, chunkStart, cm.width, cm);
        }
      }
      continue;
    }
    for (const part of word.parts) addRun(part.text, part.style, part.start, part.width, part.metrics);
  }
  // final line (always, so empty text still has a caret line)
  pushLine(node.text.length, true);

  // alignment
  const align = base.textAlign;
  const boxWidth = isArea ? node.box!.width : Math.max(0, ...lines.map((l) => l.width));
  for (const line of lines) {
    const ref = isArea ? boxWidth : 0;
    if (align === 'center') line.x = isArea ? (ref - line.width) / 2 : -line.width / 2;
    else if (align === 'right') line.x = isArea ? ref - line.width : -line.width;
    else if (align === 'justify' && isArea && !line.paragraphEnd && line.runs.length > 1) {
      // stretch the spaces between words (not the trailing ones)
      let lastWord = -1;
      for (let r = 0; r < line.runs.length; r++) if (!isWhitespace(line.runs[r].text)) lastWord = r;
      const spaces = line.runs.slice(0, Math.max(0, lastWord)).filter((r) => isWhitespace(r.text));
      if (spaces.length) {
        const extra = (boxWidth - line.width) / spaces.length;
        let shift = 0;
        for (let r = 0; r < line.runs.length; r++) {
          const run = line.runs[r];
          run.x += shift;
          if (r < lastWord && isWhitespace(run.text)) {
            run.width += extra;
            shift += extra;
          }
        }
        line.width = boxWidth;
      }
      line.x = 0;
    } else line.x = 0;
  }

  // bounds
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + Math.max(line.width, 1));
    minY = Math.min(minY, line.y - line.ascent);
    maxY = Math.max(maxY, line.y + line.descent);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1;
    minY = -base.fontSize;
    maxY = 0;
  }
  let bounds: Rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  let overflow = false;
  if (isArea) {
    bounds = { x: 0, y: 0, width: node.box!.width, height: node.box!.height };
    overflow = maxY > node.box!.height + 0.5;
  }
  return { lines, bounds, overflow, width: maxX - minX, height: maxY - minY };
}

/** Index of the line that holds the caret for a character index. */
export function lineIndexAt(layout: TextLayout, index: number): number {
  let li = layout.lines.length - 1;
  for (let i = 0; i < layout.lines.length; i++) {
    const l = layout.lines[i];
    if (index <= l.end) {
      // an index equal to l.end belongs to this line unless the next line starts here (wrapped)
      const next = layout.lines[i + 1];
      if (index === l.end && next && next.start === index && !l.paragraphEnd) li = i + 1;
      else li = i;
      break;
    }
  }
  return li;
}

/**
 * The character index where a caret sits at the visual end of a line: for wrapped
 * lines this excludes the trailing whitespace that belongs to this line.
 */
export function visualLineEnd(line: LaidLine): number {
  if (line.paragraphEnd) return line.end;
  let e = line.end;
  for (let i = line.runs.length - 1; i >= 0 && isWhitespace(line.runs[i].text); i--) e = line.runs[i].start;
  return Math.max(line.start, e);
}

/** x position (local) of a character index within a line. */
export function xAtIndex(line: LaidLine, index: number): number {
  let x = line.x;
  for (const r of line.runs) {
    if (index >= r.start && index <= r.start + r.text.length) {
      const k = index - r.start;
      if (r.text === '\t') return line.x + r.x + (k > 0 ? r.width : 0);
      const sub = r.text.slice(0, k);
      // justified spaces may be wider than measured
      if (isWhitespace(r.text) && r.text.length > 0) return line.x + r.x + (r.width * k) / r.text.length;
      return line.x + r.x + measure(sub, r.style).width;
    }
    if (index > r.start + r.text.length) x = line.x + r.x + r.width;
  }
  return x;
}

/** Caret position (x, top, height) for a character index. */
export function caretAt(layout: TextLayout, index: number, style: TextStyle): { x: number; y: number; height: number; line: number } {
  const li = lineIndexAt(layout, index);
  const line = layout.lines[li];
  if (!line) return { x: 0, y: -style.fontSize, height: style.fontSize * 1.2, line: 0 };
  return { x: xAtIndex(line, index), y: line.y - line.ascent, height: line.ascent + line.descent, line: li };
}

/** Character index nearest to a local point. */
export function indexAtPoint(layout: TextLayout, p: { x: number; y: number }, textLength: number): number {
  if (!layout.lines.length) return 0;
  let line = layout.lines[0];
  for (const l of layout.lines) {
    if (p.y >= l.y - l.ascent) line = l;
  }
  return indexAtLineX(line, p.x, textLength);
}

/** Character index nearest to x on a given line. */
export function indexAtLineX(line: LaidLine, x: number, textLength: number): number {
  if (x <= line.x) return line.start;
  const vEnd = visualLineEnd(line);
  let best = vEnd;
  let bestD = Math.abs(xAtIndex(line, vEnd) - x);
  for (const r of line.runs) {
    for (let k = 0; k <= r.text.length; k++) {
      const idx = r.start + k;
      if (idx > vEnd) break;
      const rx = xAtIndex(line, idx);
      const d = Math.abs(rx - x);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  }
  return Math.max(0, Math.min(textLength, best));
}

/** Resolved style of the character before `index` (or the first character). */
export function styleAtIndex(node: TextNode, index: number): TextStyle {
  const runs = resolveRuns(node);
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const end = pos + r.text.length;
    if (index <= end && (index > pos || i === 0)) return r.style;
    if (index > pos && index <= end) return r.style;
    pos = end;
  }
  return runs.length ? runs[runs.length - 1].style : { ...node.style };
}
