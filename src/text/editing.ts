/**
 * Pure text editing model: operations on a TextNode's `text` + `runs` that keep
 * both in sync, range styling with run splitting/merging, word/paragraph
 * boundaries and caret navigation helpers. All mutating functions expect an
 * immer draft (or a mutable copy) of the node.
 */
import type { TextNode, TextRun, TextStyle } from '@/model/types';
import { layoutText, caretAt, indexAtLineX, visualLineEnd, resolveRuns, type TextLayout } from './layout';

export const STYLE_KEYS: Array<keyof TextStyle> = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textDecoration',
  'textTransform',
  'baselineShift',
  'paragraphSpacing',
];

/** Keys that are paragraph/object level and never live on runs. */
export const NODE_LEVEL_KEYS: Array<keyof TextStyle> = ['textAlign', 'paragraphSpacing'];

function styleKey(s: Partial<TextStyle> | undefined): string {
  if (!s) return '';
  const keys = Object.keys(s).sort();
  return keys.map((k) => `${k}=${JSON.stringify((s as any)[k])}`).join(';');
}

/**
 * Normalise runs: ensure the concatenation equals `text`, drop empty runs, drop
 * overrides equal to the base style and merge adjacent runs with equal styles.
 * At least one run is kept (possibly empty) so an empty object remembers its style.
 */
export function normalizeRuns(node: TextNode): void {
  let runs: TextRun[] = node.runs && node.runs.length ? node.runs.map((r) => ({ text: r.text, style: r.style ? { ...r.style } : undefined })) : [{ text: node.text }];
  // sync with text
  const joined = runs.map((r) => r.text).join('');
  if (joined !== node.text) {
    if (node.text.startsWith(joined)) {
      runs[runs.length - 1].text += node.text.slice(joined.length);
    } else {
      // give up on run boundaries: keep the first run's style
      runs = [{ text: node.text, style: runs[0]?.style }];
    }
  }
  for (const r of runs) {
    if (!r.style) continue;
    for (const k of Object.keys(r.style) as Array<keyof TextStyle>) {
      if (NODE_LEVEL_KEYS.includes(k) || (r.style as any)[k] === undefined || (r.style as any)[k] === node.style[k]) delete (r.style as any)[k];
    }
    if (!Object.keys(r.style).length) r.style = undefined;
  }
  const out: TextRun[] = [];
  for (const r of runs) {
    if (!r.text.length) continue;
    const last = out[out.length - 1];
    if (last && styleKey(last.style) === styleKey(r.style)) last.text += r.text;
    else out.push(r);
  }
  if (!out.length) out.push({ text: '', style: runs[0]?.style });
  node.runs = out;
}

/** Make sure a run boundary exists at `index`; returns the index of the run starting there. */
function splitRunAt(runs: TextRun[], index: number): number {
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const end = pos + r.text.length;
    if (index === pos) return i;
    if (index > pos && index < end) {
      const a: TextRun = { text: r.text.slice(0, index - pos), style: r.style ? { ...r.style } : undefined };
      const b: TextRun = { text: r.text.slice(index - pos), style: r.style ? { ...r.style } : undefined };
      runs.splice(i, 1, a, b);
      return i + 1;
    }
    pos = end;
  }
  return runs.length;
}

/** Run index + offset of the character before `index` (used for style inheritance). */
export function runAt(runs: TextRun[], index: number): { run: number; offset: number } {
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const end = pos + runs[i].text.length;
    if (index <= end && (index > pos || i === 0)) return { run: i, offset: index - pos };
    pos = end;
  }
  return { run: Math.max(0, runs.length - 1), offset: runs[runs.length - 1]?.text.length ?? 0 };
}

/** Style override (partial) of the character before `index`. */
export function overrideAt(node: TextNode, index: number): Partial<TextStyle> | undefined {
  const runs = node.runs && node.runs.length ? node.runs : [{ text: node.text }];
  const { run } = runAt(runs, index);
  return runs[run]?.style;
}

/** Fully resolved style of the character before `index`. */
export function resolvedStyleAt(node: TextNode, index: number): TextStyle {
  return { ...node.style, ...(overrideAt(node, index) ?? {}) };
}

/**
 * Replace the range [start, end) with `text`. Inserted text inherits the style of
 * the character before `start` unless `override` is given (typing style).
 */
export function replaceText(node: TextNode, start: number, end: number, text: string, override?: Partial<TextStyle> | null): void {
  const len = node.text.length;
  start = Math.max(0, Math.min(len, start));
  end = Math.max(start, Math.min(len, end));
  if (!node.runs || !node.runs.length) node.runs = [{ text: node.text }];
  normalizeRuns(node);
  const runs = node.runs;
  // delete
  if (end > start) {
    const a = splitRunAt(runs, start);
    const b = splitRunAt(runs, end);
    runs.splice(a, b - a);
  }
  // insert
  if (text) {
    const i = splitRunAt(runs, start);
    const inheritFrom = i > 0 ? runs[i - 1] : runs[i];
    const baseOverride = inheritFrom?.style ? { ...inheritFrom.style } : undefined;
    if (override && Object.keys(override).length) {
      const style = { ...(baseOverride ?? {}), ...override };
      runs.splice(i, 0, { text, style });
    } else if (i > 0) {
      runs[i - 1].text += text;
    } else if (runs[i]) {
      runs[i].text = text + runs[i].text;
    } else runs.push({ text, style: baseOverride });
  }
  node.text = node.text.slice(0, start) + text + node.text.slice(end);
  normalizeRuns(node);
}

export function deleteText(node: TextNode, start: number, end: number): void {
  replaceText(node, start, end, '');
}

/** Apply a style patch to the range [start, end) as run overrides. Undefined values clear the override. */
export function applyStyleToRange(node: TextNode, start: number, end: number, patch: Partial<TextStyle>): void {
  const len = node.text.length;
  start = Math.max(0, Math.min(len, start));
  end = Math.max(start, Math.min(len, end));
  if (!node.runs || !node.runs.length) node.runs = [{ text: node.text }];
  normalizeRuns(node);
  if (end === start) return;
  const runs = node.runs;
  const a = splitRunAt(runs, start);
  const b = splitRunAt(runs, end);
  for (let i = a; i < b; i++) {
    const r = runs[i];
    const style: Partial<TextStyle> = { ...(r.style ?? {}) };
    for (const k of Object.keys(patch) as Array<keyof TextStyle>) {
      const v = (patch as any)[k];
      if (v === undefined) delete (style as any)[k];
      else (style as any)[k] = v;
    }
    r.style = Object.keys(style).length ? style : undefined;
  }
  normalizeRuns(node);
}

/** Apply a patch to the whole object: base style changes and run overrides for those keys are cleared. */
export function applyStyleToNode(node: TextNode, patch: Partial<TextStyle>): void {
  node.style = { ...node.style, ...patch };
  for (const r of node.runs ?? []) if (r.style) for (const k of Object.keys(patch)) delete (r.style as any)[k];
  normalizeRuns(node);
}

/** Resolved styles of all runs overlapping [start, end) (for mixed-value detection). */
export function stylesInRange(node: TextNode, start: number, end: number): TextStyle[] {
  const out: TextStyle[] = [];
  let pos = 0;
  for (const r of resolveRuns(node)) {
    const rEnd = pos + r.text.length;
    if (rEnd > start && pos < end) out.push(r.style);
    pos = rEnd;
  }
  if (!out.length) out.push(resolvedStyleAt(node, start));
  return out;
}

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}_'’]/u;

export function isWordChar(ch: string): boolean {
  return WORD_RE.test(ch);
}

/** Start of the word to the left of `i` (Ctrl+Left semantics). */
export function wordLeft(text: string, i: number): number {
  let k = Math.max(0, Math.min(text.length, i));
  while (k > 0 && /\s/.test(text[k - 1])) k--;
  if (k > 0 && isWordChar(text[k - 1])) while (k > 0 && isWordChar(text[k - 1])) k--;
  else if (k > 0) k--;
  return k;
}

/** Start of the next word to the right of `i` (Ctrl+Right semantics). */
export function wordRight(text: string, i: number): number {
  let k = Math.max(0, Math.min(text.length, i));
  if (k < text.length && isWordChar(text[k])) while (k < text.length && isWordChar(text[k])) k++;
  else if (k < text.length && !/\s/.test(text[k])) k++;
  while (k < text.length && /\s/.test(text[k]) && text[k] !== '\n') k++;
  return k;
}

/** Range of the word (or whitespace run) at index `i` (double-click). */
export function wordRangeAt(text: string, i: number): { start: number; end: number } {
  if (!text.length) return { start: 0, end: 0 };
  let k = Math.max(0, Math.min(text.length - 1, i));
  if (i >= text.length) k = text.length - 1;
  const cls = (ch: string) => (ch === '\n' ? 'n' : isWordChar(ch) ? 'w' : /\s/.test(ch) ? 's' : 'p');
  const c = cls(text[k]);
  if (c === 'n') return { start: k, end: k };
  let start = k;
  let end = k + 1;
  while (start > 0 && cls(text[start - 1]) === c) start--;
  while (end < text.length && cls(text[end]) === c) end++;
  return { start, end };
}

/** Range of the paragraph containing index `i` (triple-click). */
export function paragraphRangeAt(text: string, i: number): { start: number; end: number } {
  let start = Math.max(0, Math.min(text.length, i));
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = start;
  while (end < text.length && text[end] !== '\n') end++;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Caret navigation using the layout
// ---------------------------------------------------------------------------

export function lineStart(layout: TextLayout, index: number, style: TextStyle): number {
  const li = caretAt(layout, index, style).line;
  return layout.lines[li]?.start ?? 0;
}

export function lineEnd(layout: TextLayout, index: number, style: TextStyle): number {
  const li = caretAt(layout, index, style).line;
  const line = layout.lines[li];
  return line ? visualLineEnd(line) : index;
}

/** Move up/down by one line keeping the preferred x. Returns the new index and the x used. */
export function moveLine(node: TextNode, index: number, dir: -1 | 1, preferredX: number | null): { index: number; x: number } {
  const layout = layoutText(node);
  const c = caretAt(layout, index, node.style);
  const x = preferredX ?? c.x;
  const target = layout.lines[c.line + dir];
  if (!target) return { index: dir < 0 ? 0 : node.text.length, x };
  return { index: indexAtLineX(target, x, node.text.length), x };
}

// ---------------------------------------------------------------------------
// Case transforms
// ---------------------------------------------------------------------------

export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence';

/** Change the case of text keeping the character count (so run boundaries stay valid). */
export function changeCase(text: string, mode: CaseMode): string {
  const map = (ch: string, fn: (s: string) => string) => {
    const u = fn(ch);
    return u.length === ch.length ? u : ch;
  };
  const chars = Array.from(text);
  const out: string[] = [];
  let sentenceStart = true;
  let wordStart = true;
  for (const ch of chars) {
    let r = ch;
    switch (mode) {
      case 'upper':
        r = map(ch, (s) => s.toUpperCase());
        break;
      case 'lower':
        r = map(ch, (s) => s.toLowerCase());
        break;
      case 'title':
        r = wordStart && isWordChar(ch) ? map(ch, (s) => s.toUpperCase()) : map(ch, (s) => s.toLowerCase());
        break;
      case 'sentence':
        r = sentenceStart && isWordChar(ch) ? map(ch, (s) => s.toUpperCase()) : map(ch, (s) => s.toLowerCase());
        break;
    }
    out.push(r);
    if (isWordChar(ch)) {
      wordStart = false;
      sentenceStart = false;
    } else {
      wordStart = true;
      if (/[.!?\n]/.test(ch)) sentenceStart = true;
    }
  }
  return out.join('');
}

/** Apply a case change to a range of a node (text + runs stay in sync). */
export function changeCaseInRange(node: TextNode, start: number, end: number, mode: CaseMode): void {
  const len = node.text.length;
  start = Math.max(0, Math.min(len, start));
  end = Math.max(start, Math.min(len, end));
  if (end === start) return;
  const before = node.text.slice(0, start);
  const mid = changeCase(node.text.slice(start, end), mode);
  if (mid.length !== end - start) return;
  node.text = before + mid + node.text.slice(end);
  if (!node.runs || !node.runs.length) {
    node.runs = [{ text: node.text }];
    return;
  }
  let pos = 0;
  for (const r of node.runs) {
    r.text = node.text.slice(pos, pos + r.text.length);
    pos += r.text.length;
  }
  normalizeRuns(node);
}

/** Name derived from the text (same rule as makeText). */
export function autoTextName(text: string): string {
  return text.split('\n')[0].slice(0, 24) || 'Text';
}
