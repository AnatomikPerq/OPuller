/**
 * Text layout engine: measures text with a 2D canvas and produces positioned
 * lines/runs in the text node's local coordinate system.
 *
 * Point text: origin (0,0) is the start of the first baseline (before alignment).
 * Area text: origin (0,0) is the top-left corner of the box; text is wrapped to box.width.
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
  width: number;
  ascent: number;
  descent: number;
  /** index of the first character of this line in the text */
  start: number;
  /** index after the last character (excluding the newline) */
  end: number;
  /** whether this line ends a paragraph */
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
  const c = document.createElement('canvas');
  measureCtx = c.getContext('2d');
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
    m = { width: text.length * style.fontSize * 0.55, ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 };
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

/** Resolve runs into an array of {text, style} with the base style merged in. */
export function resolveRuns(node: TextNode): Array<{ text: string; style: TextStyle }> {
  const runs: TextRun[] = node.runs && node.runs.length ? node.runs : [{ text: node.text }];
  return runs.map((r) => ({ text: r.text, style: { ...node.style, ...(r.style ?? {}) } }));
}

interface Piece {
  text: string;
  style: TextStyle;
  start: number;
  /** true if this piece is whitespace (breakable) */
  space: boolean;
  newline: boolean;
}

/** Split runs into word/space/newline pieces. */
function pieces(node: TextNode): Piece[] {
  const out: Piece[] = [];
  let index = 0;
  for (const run of resolveRuns(node)) {
    const re = /(\n)|(\s+)|([^\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(run.text))) {
      const text = m[0];
      out.push({ text, style: run.style, start: index, space: !!m[2], newline: !!m[1] });
      index += text.length;
    }
  }
  return out;
}

const layoutCache = new WeakMap<TextNode, TextLayout>();

export function layoutText(node: TextNode): TextLayout {
  const cached = layoutCache.get(node);
  if (cached) return cached;
  const l = computeLayout(node);
  layoutCache.set(node, l);
  return l;
}

function computeLayout(node: TextNode): TextLayout {
  const base = node.style;
  const isArea = node.kind === 'area' && node.box;
  const maxWidth = isArea ? node.box!.width : Infinity;
  const ps = pieces(node);
  const lines: LaidLine[] = [];

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
    const asc = curAscent || measure('Hg', base).ascent;
    const desc = curDescent || measure('Hg', base).descent;
    if (first) {
      y = isArea ? asc : 0;
      first = false;
    } else {
      y += lh;
    }
    // trim trailing whitespace width for alignment purposes
    let width = curWidth;
    while (cur.length && /^\s+$/.test(cur[cur.length - 1].text)) {
      width -= cur[cur.length - 1].width;
      cur.pop();
    }
    lines.push({ runs: cur, x: 0, y, width, ascent: asc, descent: desc, start: curStart, end, paragraphEnd });
    if (paragraphEnd) y += base.paragraphSpacing;
    cur = [];
    curWidth = 0;
    curAscent = 0;
    curDescent = 0;
    curMaxSize = 0;
    curLineHeight = 0;
  };

  const addPiece = (p: Piece, text: string) => {
    const m = measure(text, p.style);
    cur.push({ text, style: p.style, x: curWidth, width: m.width, start: p.start });
    curWidth += m.width;
    curAscent = Math.max(curAscent, m.ascent);
    curDescent = Math.max(curDescent, m.descent);
    curMaxSize = Math.max(curMaxSize, p.style.fontSize);
    curLineHeight = Math.max(curLineHeight, p.style.lineHeight);
  };

  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.newline) {
      pushLine(p.start, true);
      curStart = p.start + 1;
      continue;
    }
    const text = applyTransform(p.text, p.style);
    const m = measure(text, p.style);
    if (isArea && !p.space && curWidth > 0 && curWidth + m.width > maxWidth) {
      // wrap before this word
      pushLine(p.start, false);
      curStart = p.start;
    }
    if (isArea && !p.space && m.width > maxWidth && maxWidth > 0) {
      // break a very long word by characters
      let chunk = '';
      let chunkStart = p.start;
      for (const ch of text) {
        const w = measure(chunk + ch, p.style).width;
        if (chunk && curWidth + w > maxWidth) {
          addPiece({ ...p, start: chunkStart }, chunk);
          pushLine(chunkStart + chunk.length, false);
          curStart = chunkStart + chunk.length;
          chunkStart += chunk.length;
          chunk = '';
        }
        chunk += ch;
      }
      if (chunk) addPiece({ ...p, start: chunkStart }, chunk);
      continue;
    }
    addPiece(p, text);
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
      const spaces = line.runs.filter((r) => /^\s+$/.test(r.text));
      if (spaces.length) {
        const extra = (boxWidth - line.width) / spaces.length;
        let shift = 0;
        for (const r of line.runs) {
          r.x += shift;
          if (/^\s+$/.test(r.text)) {
            r.width += extra;
            shift += extra;
          }
        }
        line.width = boxWidth;
      }
      line.x = 0;
    } else line.x = 0;
    line.x += 0;
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

/** Caret position (x, top, height) for a character index. */
export function caretAt(layout: TextLayout, index: number, style: TextStyle): { x: number; y: number; height: number; line: number } {
  let li = layout.lines.length - 1;
  for (let i = 0; i < layout.lines.length; i++) {
    const l = layout.lines[i];
    if (index <= l.end) {
      // an index equal to l.end belongs to this line unless the next line starts here (wrapped)
      const next = layout.lines[i + 1];
      if (index === l.end && next && next.start === index && !l.paragraphEnd) {
        li = i + 1;
      } else li = i;
      break;
    }
  }
  const line = layout.lines[li];
  if (!line) return { x: 0, y: -style.fontSize, height: style.fontSize * 1.2, line: 0 };
  let x = line.x;
  for (const r of line.runs) {
    if (index >= r.start && index <= r.start + r.text.length) {
      const sub = r.text.slice(0, index - r.start);
      x = line.x + r.x + measure(sub, r.style).width;
      break;
    }
    if (index > r.start + r.text.length) x = line.x + r.x + r.width;
  }
  return { x, y: line.y - line.ascent, height: line.ascent + line.descent, line: li };
}

/** Character index nearest to a local point. */
export function indexAtPoint(layout: TextLayout, p: { x: number; y: number }, textLength: number): number {
  if (!layout.lines.length) return 0;
  let line = layout.lines[0];
  for (const l of layout.lines) {
    if (p.y >= l.y - l.ascent) line = l;
  }
  if (p.x <= line.x) return line.start;
  let best = line.end;
  let bestD = Infinity;
  for (const r of line.runs) {
    for (let k = 0; k <= r.text.length; k++) {
      const x = line.x + r.x + measure(r.text.slice(0, k), r.style).width;
      const d = Math.abs(x - p.x);
      if (d < bestD) {
        bestD = d;
        best = r.start + k;
      }
    }
  }
  return Math.max(0, Math.min(textLength, best));
}
