import { describe, it, expect } from 'vitest';
import { createDocument, makePath, makeShape } from '@/model/nodes';
import { addNode } from '@/model/document';
import { collectColors, mapColors, invertColor, grayscaleColor, saturateColor, harmonyPalette, reduceColors, nearestColor, blendColors, shiftHsb, balanceColor } from '@/color/editColors';
import { tintColor, linkedPaint, propagateSwatch, unlinkSwatch, hexToCmyk, cmykToHex, cmykName, plainPaint } from '@/color/globals';
import { printerMarksSvg, marksMargin, expandByBleed, anyMarks, DEFAULT_MARKS } from '@/print/marks';
import type { Swatch } from '@/model/types';

function docWithRects(colors: string[]) {
  const doc = createDocument();
  const ids: string[] = [];
  colors.forEach((c, i) => {
    const n = makeShape({ kind: 'rect', width: 50, height: 50, radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: c, opacity: 1 }, transform: { a: 1, b: 0, c: 0, d: 1, e: i * 100, f: 0 } });
    addNode(doc, n, doc.layers[0]);
    ids.push(n.id);
  });
  return { doc, ids };
}

describe('edit colors', () => {
  it('collects distinct colours with usage counts', () => {
    const { doc, ids } = docWithRects(['#ff0000', '#ff0000', '#00ff00']);
    const uses = collectColors(doc, ids);
    expect(uses.map((u) => [u.color, u.count])).toEqual([
      ['#000000', 3], // default stroke
      ['#ff0000', 2],
      ['#00ff00', 1],
    ]);
    expect(collectColors(doc, ids, { strokes: false }).map((u) => u.color)).toEqual(['#ff0000', '#00ff00']);
  });

  it('maps fills, strokes and gradient stops', () => {
    const { doc, ids } = docWithRects(['#ff0000']);
    const grad = makePath([], { fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, spread: 'pad', stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }] } });
    addNode(doc, grad, doc.layers[0]);
    const n = mapColors(doc, [...ids, grad.id], invertColor);
    expect(n).toBe(4);
    const rect = doc.nodes[ids[0]] as any;
    expect(rect.fill.color).toBe('#00ffff');
    expect(rect.stroke.paint.color).toBe('#ffffff');
    expect((doc.nodes[grad.id] as any).fill.stops.map((s: any) => s.color)).toEqual(['#000000', '#ffffff']);
  });

  it('colour maths: grayscale, saturate, shift, balance', () => {
    expect(grayscaleColor('#ff0000')).toBe('#4c4c4c');
    expect(saturateColor('#808080', 1)).toBe('#808080'); // no hue → stays gray
    expect(saturateColor('#ff8080', -1)).toBe('#ffffff');
    expect(shiftHsb('#ff0000', { hue: 120, saturation: 0, brightness: 0 })).toBe('#00ff00');
    expect(balanceColor('#808080', { r: 50, g: 0, b: 0, c: 0, m: 0, y: 0, k: 0, mode: 'rgb' })).toBe('#ff8080');
    expect(balanceColor('#ffffff', { r: 0, g: 0, b: 0, c: 100, m: 0, y: 0, k: 0, mode: 'cmyk' })).toBe('#00ffff');
  });

  it('harmonies and reduction produce palettes', () => {
    const p = harmonyPalette('#ff0000', 'triad', 3);
    expect(p).toHaveLength(3);
    expect(p[0]).toBe('#ff0000');
    expect(nearestColor('#fe0101', p)).toBe('#ff0000');
    const reduced = reduceColors(
      [
        { color: '#ff0000', count: 5 },
        { color: '#fe0000', count: 3 },
        { color: '#0000ff', count: 2 },
      ],
      2,
    );
    expect(reduced).toHaveLength(2);
    expect(nearestColor('#0000ff', reduced)).toBe('#0000ff');
  });

  it('blends fills front to back', () => {
    const { doc, ids } = docWithRects(['#000000', '#123456', '#ffffff']);
    // ids[2] is frontmost; blend goes from front (#ffffff) to back (#000000)
    expect(blendColors(doc, ids, 'stack')).toBe(1);
    expect((doc.nodes[ids[1]] as any).fill.color).toBe('#808080');
    expect(blendColors(doc, ids, 'x')).toBe(1);
  });
});

describe('global colours', () => {
  const sw: Swatch = { id: 'g1', name: 'Brand', paint: { type: 'solid', color: '#0000ff', opacity: 1 }, kind: 'global' };

  it('tints mix with white', () => {
    expect(tintColor('#0000ff', 100)).toBe('#0000ff');
    expect(tintColor('#0000ff', 0)).toBe('#ffffff');
    expect(tintColor('#0000ff', 50)).toBe('#8080ff');
    expect(linkedPaint(sw, 50)).toEqual({ type: 'solid', color: '#8080ff', opacity: 1, swatchId: 'g1', tint: 50 });
  });

  it('propagates swatch edits to linked paints and unlinks', () => {
    const { doc, ids } = docWithRects(['#0000ff']);
    (doc.nodes[ids[0]] as any).fill = linkedPaint(sw, 50);
    const edited = { ...sw, paint: { type: 'solid' as const, color: '#00ff00', opacity: 1 } };
    expect(propagateSwatch(doc, edited)).toBe(1);
    expect((doc.nodes[ids[0]] as any).fill.color).toBe('#80ff80');
    unlinkSwatch(doc, 'g1');
    expect((doc.nodes[ids[0]] as any).fill).toEqual({ type: 'solid', color: '#80ff80', opacity: 1 });
    expect(plainPaint(linkedPaint(sw, 100))).toEqual({ type: 'solid', color: '#0000ff', opacity: 1 });
  });

  it('CMYK round trips', () => {
    expect(hexToCmyk('#00ffff')).toEqual({ c: 100, m: 0, y: 0, k: 0 });
    expect(cmykToHex({ c: 0, m: 100, y: 100, k: 0 })).toBe('#ff0000');
    expect(cmykName({ c: 0, m: 0, y: 0, k: 100 })).toBe('C=0 M=0 Y=0 K=100');
  });
});

describe('printer marks', () => {
  it('expands regions and draws marks outside the bleed box', () => {
    const trim = { x: 0, y: 0, width: 100, height: 50 };
    const bleed = { top: 3, right: 3, bottom: 3, left: 3 };
    expect(expandByBleed(trim, bleed)).toEqual({ x: -3, y: -3, width: 106, height: 56 });
    expect(anyMarks(DEFAULT_MARKS)).toBe(true);
    expect(marksMargin(DEFAULT_MARKS, bleed)).toBeGreaterThan(20);
    const svg = printerMarksSvg(trim, bleed, { ...DEFAULT_MARKS, info: 'Doc' });
    expect(svg).toContain('<g id="printer-marks"');
    expect((svg.match(/<line /g) ?? []).length).toBe(8 + 8); // 8 trim lines + 8 registration cross lines
    expect((svg.match(/<circle /g) ?? []).length).toBe(8);
    expect(svg).toContain('>Doc<');
    expect(printerMarksSvg(trim, bleed, { trimMarks: false, registrationMarks: false, colorBars: false, pageInfo: false })).toBe('');
  });
});
