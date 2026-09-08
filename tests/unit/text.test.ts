import { describe, it, expect } from 'vitest';
import { makeText } from '@/model/nodes';
import type { TextNode } from '@/model/types';
import { layoutText, caretAt, indexAtPoint, visualLineEnd, lineIndexAt, transformPiece, measure } from '@/text/layout';
import { replaceText, deleteText, applyStyleToRange, applyStyleToNode, normalizeRuns, wordLeft, wordRight, wordRangeAt, paragraphRangeAt, changeCase, changeCaseInRange, moveLine, stylesInRange, resolvedStyleAt } from '@/text/editing';
import { parseUnicodeRange, inRanges, faceLabel } from '@/text/fonts';
import { PathSampler, glyphPositions, pathTextStart } from '@/text/outline';

function node(text: string, extra: Partial<TextNode> = {}): TextNode {
  const n = makeText(text, { style: { fontFamily: 'Inter', fontSize: 20, lineHeight: 1.2 } });
  return { ...n, ...extra } as TextNode;
}

describe('editing model: runs stay in sync with text', () => {
  it('inserts text inheriting the style of the character before the caret', () => {
    const n = node('Hello world');
    n.runs = [
      { text: 'Hello', style: { fontWeight: 700 } },
      { text: ' world' },
    ];
    replaceText(n, 5, 5, '!!');
    expect(n.text).toBe('Hello!! world');
    expect(n.runs).toEqual([
      { text: 'Hello!!', style: { fontWeight: 700 } },
      { text: ' world', style: undefined },
    ]);
    replaceText(n, 0, 0, 'X');
    expect(n.text).toBe('XHello!! world');
    expect(n.runs[0].text).toBe('XHello!!');
    expect(n.runs[0].style).toEqual({ fontWeight: 700 });
  });

  it('inserts with a typing style override as its own run', () => {
    const n = node('abc');
    replaceText(n, 1, 1, 'X', { fontStyle: 'italic' });
    expect(n.text).toBe('aXbc');
    expect(n.runs.map((r) => r.text)).toEqual(['a', 'X', 'bc']);
    expect(n.runs[1].style).toEqual({ fontStyle: 'italic' });
  });

  it('deletes across run boundaries and merges equal runs', () => {
    const n = node('Hello world');
    n.runs = [
      { text: 'Hello', style: { fontWeight: 700 } },
      { text: ' world' },
    ];
    deleteText(n, 3, 8);
    expect(n.text).toBe('Helrld');
    expect(n.runs.map((r) => r.text)).toEqual(['Hel', 'rld']);
    // clearing the override merges back into one run
    applyStyleToRange(n, 0, 3, { fontWeight: undefined });
    expect(n.runs).toEqual([{ text: 'Helrld', style: undefined }]);
  });

  it('applies a style to a range by splitting runs', () => {
    const n = node('Hello world');
    applyStyleToRange(n, 2, 7, { fontSize: 40 });
    expect(n.runs.map((r) => r.text)).toEqual(['He', 'llo w', 'orld']);
    expect(n.runs[1].style).toEqual({ fontSize: 40 });
    expect(stylesInRange(n, 0, 11).map((s) => s.fontSize)).toEqual([20, 40, 20]);
    expect(resolvedStyleAt(n, 4).fontSize).toBe(40);
    expect(resolvedStyleAt(n, 2).fontSize).toBe(20);
    // node-level style change clears overrides for that key
    applyStyleToNode(n, { fontSize: 30 });
    expect(n.runs).toEqual([{ text: 'Hello world', style: undefined }]);
    expect(n.style.fontSize).toBe(30);
  });

  it('drops overrides equal to the base style and keeps an empty run for empty text', () => {
    const n = node('ab');
    n.runs = [{ text: 'ab', style: { fontSize: 20, letterSpacing: 0 } }];
    normalizeRuns(n);
    expect(n.runs).toEqual([{ text: 'ab', style: undefined }]);
    deleteText(n, 0, 2);
    expect(n.text).toBe('');
    expect(n.runs.length).toBe(1);
    expect(n.runs[0].text).toBe('');
  });

  it('repairs runs that got out of sync with the text', () => {
    const n = node('hello world');
    n.runs = [{ text: 'hello' }];
    normalizeRuns(n);
    expect(n.runs.map((r) => r.text).join('')).toBe('hello world');
  });
});

describe('word / paragraph boundaries', () => {
  const t = 'Hello, big world\nsecond line';
  it('moves by words', () => {
    expect(wordRight(t, 0)).toBe(5); // before the comma (punctuation is its own stop)
    expect(wordRight(t, 5)).toBe(7); // after ", "
    expect(wordRight(t, 7)).toBe(11); // "big "
    expect(wordLeft(t, 11)).toBe(7);
    expect(wordLeft(t, 5)).toBe(0);
    expect(wordRight(t, 16)).toBe(16); // stops before the newline
  });
  it('selects words and paragraphs', () => {
    expect(wordRangeAt(t, 2)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt(t, 12)).toEqual({ start: 11, end: 16 });
    expect(paragraphRangeAt(t, 3)).toEqual({ start: 0, end: 16 });
    expect(paragraphRangeAt(t, 20)).toEqual({ start: 17, end: 28 });
  });
  it('changes case keeping the character count', () => {
    expect(changeCase('hello WORLD. fine', 'upper')).toBe('HELLO WORLD. FINE');
    expect(changeCase('hello WORLD. fine', 'lower')).toBe('hello world. fine');
    expect(changeCase('hello WORLD. fine', 'title')).toBe('Hello World. Fine');
    expect(changeCase('hello WORLD. fine', 'sentence')).toBe('Hello world. Fine');
    const n = node('one two');
    n.runs = [{ text: 'one', style: { fontWeight: 700 } }, { text: ' two' }];
    changeCaseInRange(n, 0, 7, 'upper');
    expect(n.text).toBe('ONE TWO');
    expect(n.runs.map((r) => r.text)).toEqual(['ONE', ' TWO']);
  });
});

describe('layout', () => {
  it('lays out point text on one baseline and keeps trailing spaces for carets', () => {
    const n = node('Hello ');
    const l = layoutText(n);
    expect(l.lines.length).toBe(1);
    expect(l.lines[0].y).toBe(0);
    const c5 = caretAt(l, 5, n.style);
    const c6 = caretAt(l, 6, n.style);
    expect(c6.x).toBeGreaterThan(c5.x);
    expect(l.lines[0].width).toBeCloseTo(measure('Hello', n.style).width, 5);
  });

  it('wraps area text into lines and reports overflow', () => {
    const n = node('The quick brown fox jumps over the lazy dog', { kind: 'area', box: { width: 120, height: 40 } });
    const l = layoutText(n);
    expect(l.lines.length).toBeGreaterThan(2);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(120.001);
    expect(l.overflow).toBe(true);
    // a wrapped line keeps its trailing space but the visual end excludes it
    const first = l.lines[0];
    expect(first.paragraphEnd).toBe(false);
    expect(n.text[first.end - 1]).toBe(' ');
    expect(visualLineEnd(first)).toBe(first.end - 1);
    // caret at the wrap index belongs to the next line
    expect(lineIndexAt(l, first.end)).toBe(1);
    expect(lineIndexAt(l, first.end - 1)).toBe(0);
  });

  it('does not break a word that spans two runs', () => {
    const n = node('aaaa bbbbbbbbbb cccc', { kind: 'area', box: { width: 130, height: 100 } });
    n.runs = [{ text: 'aaaa bbbbb', style: { fontWeight: 700 } }, { text: 'bbbbb cccc' }];
    const l = layoutText(n);
    // the word "bbbbbbbbbb" (two runs) must start a line as a unit
    const line = l.lines.find((ln) => ln.runs.some((r) => r.text === 'bbbbb'));
    expect(line).toBeTruthy();
    const idx = line!.runs.findIndex((r) => r.text === 'bbbbb');
    expect(line!.runs[idx + 1]?.text).toBe('bbbbb');
    expect(idx).toBe(0);
  });

  it('breaks very long words by characters', () => {
    const n = node('abcdefghijklmnopqrstuvwxyz', { kind: 'area', box: { width: 60, height: 200 } });
    const l = layoutText(n);
    expect(l.lines.length).toBeGreaterThan(2);
    expect(l.lines.map((ln) => ln.runs.map((r) => r.text).join('')).join('')).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('handles empty lines, tabs and paragraph spacing', () => {
    const n = node('a\n\nb\tc');
    n.style.paragraphSpacing = 10;
    const l = layoutText(n);
    expect(l.lines.length).toBe(3);
    expect(l.lines[1].runs.length).toBe(0);
    expect(l.lines[1].y - l.lines[0].y).toBeCloseTo(24 + 10, 5);
    const tabRun = l.lines[2].runs.find((r) => r.text === '\t');
    expect(tabRun).toBeTruthy();
    expect(tabRun!.width).toBeGreaterThan(0);
    const c = caretAt(l, 3, n.style);
    expect(c.line).toBe(2);
  });

  it('aligns and finds indices from points', () => {
    const n = node('Hi there');
    n.style.textAlign = 'center';
    const l = layoutText(n);
    expect(l.lines[0].x).toBeCloseTo(-l.lines[0].width / 2, 5);
    expect(indexAtPoint(l, { x: -1000, y: 0 }, n.text.length)).toBe(0);
    expect(indexAtPoint(l, { x: 1000, y: 0 }, n.text.length)).toBe(n.text.length);
    const mid = caretAt(l, 3, n.style).x;
    expect(indexAtPoint(l, { x: mid, y: -5 }, n.text.length)).toBe(3);
  });

  it('moves between lines keeping the preferred x', () => {
    const n = node('Hello world\nHi');
    const r = moveLine(n, 8, 1, null);
    expect(r.index).toBeGreaterThanOrEqual(12);
    expect(r.index).toBeLessThanOrEqual(14);
    const back = moveLine(n, r.index, -1, r.x);
    expect(back.index).toBe(8);
  });

  it('applies text transforms per character without changing lengths', () => {
    const st = { ...node('').style, textTransform: 'uppercase' as const };
    expect(transformPiece('straße', st)).toBe('STRAßE');
    const cap = { ...st, textTransform: 'capitalize' as const };
    expect(transformPiece('hello', cap, true)).toBe('Hello');
    expect(transformPiece('hello', cap, false)).toBe('hello');
  });
});

describe('fonts helpers', () => {
  it('parses unicode ranges', () => {
    const r = parseUnicodeRange('U+0000-00FF, U+0131, U+0152-0153, U+02??');
    expect(r).toEqual([
      [0, 255],
      [0x131, 0x131],
      [0x152, 0x153],
      [0x200, 0x2ff],
    ]);
    expect(inRanges(r, 0x41)).toBe(true);
    expect(inRanges(r, 0x410)).toBe(false);
    expect(inRanges(null, 0x410)).toBe(true);
    expect(parseUnicodeRange('')).toBeNull();
  });
  it('labels faces', () => {
    expect(faceLabel(400, 'normal')).toBe('Regular');
    expect(faceLabel(400, 'italic')).toBe('Italic');
    expect(faceLabel(700, 'italic')).toBe('Bold Italic');
  });
});

describe('outline helpers', () => {
  it('samples points along a path by arc length', () => {
    const sp = { closed: false, anchors: [{ point: { x: 0, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' as const }, { point: { x: 100, y: 0 }, handleIn: null, handleOut: null, kind: 'corner' as const }, { point: { x: 100, y: 50 }, handleIn: null, handleOut: null, kind: 'corner' as const }] };
    const s = new PathSampler(sp);
    expect(s.total).toBeCloseTo(150, 5);
    const a = s.at(50);
    expect(a.point.x).toBeCloseTo(50, 3);
    expect(a.tangent.x).toBeCloseTo(1, 5);
    const b = s.at(125);
    expect(b.point.x).toBeCloseTo(100, 3);
    expect(b.point.y).toBeCloseTo(25, 3);
    expect(b.tangent.y).toBeCloseTo(1, 5);
    expect(s.lengthAt(1, 0.5)).toBeCloseTo(125, 3);
  });
  it('places glyphs at layout positions and honours text-anchor on paths', () => {
    const n = node('ab');
    const l = layoutText(n);
    const g = glyphPositions(l);
    expect(g.map((x) => x.ch)).toEqual(['a', 'b']);
    expect(g[1].x).toBeCloseTo(g[0].step, 5);
    expect(pathTextStart({ ...n, pathOffset: 0.5 }, l, 200)).toBeCloseTo(100, 5);
    expect(pathTextStart({ ...n, pathOffset: 0.5, style: { ...n.style, textAlign: 'center' } }, l, 200)).toBeCloseTo(100 - l.lines[0].width / 2, 5);
  });
});
