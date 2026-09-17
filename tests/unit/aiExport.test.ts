import { describe, it, expect } from 'vitest';
import { exportAi, exportAiAll, psString, isEncodable, postScriptFontName } from '@/io/aiExport';
import { importAi, rgbToBmpDataUrl, decodeAiString } from '@/io/aiImport';
import { createDocument, makeShape, makePath, makeArtboard, makeText } from '@/model/nodes';
import { sampleDocument } from './aiSample';
import { validateAi } from '../aiValidator';
import { addNode, worldBounds } from '@/model/document';
import { ellipseSubPath } from '@/geometry/shapes';
import { translate } from '@/geometry/matrix';
import type { Document, Node, PathNode, TextNode, ImageNode, GroupNode } from '@/model/types';

function nodesOf(res: ReturnType<typeof importAi>): Node[] {
  return res.items.flatMap((it) => it.nodes);
}

function findByName<T extends Node>(nodes: Node[], name: string): T {
  const n = nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named ${name}; have ${nodes.map((x) => x.name).join(', ')}`);
  return n as T;
}

const PT = 72 / 96;

describe('AI export: syntax', () => {
  it('writes a well-formed Illustrator 7/8 document (every operator with the right operands, balanced containers)', () => {
    const doc = sampleDocument();
    const r = exportAi(doc, { scope: 'artboard' });
    const v = validateAi(r.ai);
    expect(v.errors).toEqual([]);
    expect(v.layers).toEqual(['(Artwork)', '(Text & image)']);
    expect(v.ops.Lb).toBe(2);
    expect(v.ops.Bg).toBe(2); // two gradient instances
    expect(v.ops['*u']).toBe(1); // the compound frame
    expect(v.ops.q).toBe(1); // the clip group
    expect(v.ops.W).toBe(1);
    expect(v.ops.To).toBe(2);
    expect(v.ops.XI).toBe(1);
    expect(r.ai).toContain('%AI5_ArtSize: 300 225');
    expect(r.ai).toContain('%AI5_NumLayers: 2');
    expect(r.ai).toContain('2 Bn');
    expect(r.ai).toContain('%AI5_BeginGradient: (Sunset)');
    expect(r.ai).toContain('(Sunset) 0 2 Bd');
    expect(r.ai).toContain('%%DocumentCustomColors: (PANTONE 300 C)');
    expect(r.ai).toContain('%%CMYKCustomColor: 1 0.44 0 0 (PANTONE 300 C)');
    expect(r.ai).toContain('(PANTONE 300 C) 0.5 x'); // 50 % tint is stored as 1 − 0.5
    expect(r.ai).toContain('%%DocumentFonts: Inter-Bold');
    expect(r.ai).toContain('%%+ Roboto-Regular');
    expect(r.ai).toContain('[/_Inter-Bold/Inter-Bold 0 0 1 TZ');
    expect(r.ai).toContain('/_Inter-Bold 18 Tf'); // 24 px = 18 pt
    expect(r.ai).toContain('(Hello AI\\015Second line) Tx 1 0 Tk');
    expect(r.ai).toContain('1 XR'); // even-odd frame
    expect(r.ai).toContain('[6 3] 0 d'); // dash 8/4 px → 6/3 pt
    expect(r.ai).toContain('1 J'); // round caps
    expect(r.ai).toContain('2 j'); // bevel joins
    expect(r.ai).toContain('3 w');
    expect(r.ai).toContain('1 A'); // locked spot rectangle
    expect(r.ai).not.toContain('Hidden');
    expect(r.ai).toContain('0 0 2 2 2 2 8 3 0 0 0 0 XI');
    expect(r.ai).toContain('%ff000000ff000000ffffffff');
    // RGB document: RGB colour operators, gradient stops in RGB style (2)
    expect(r.ai).toContain('1 0 0 Xa');
    expect(r.ai).toMatch(/ 2 50 100 %_Bs/);
    expect(r.warnings.some((w) => w.startsWith('Opacity is not supported'))).toBe(true);
  });

  it('CMYK documents use k / K and CMYK gradient stops', () => {
    const r = exportAi(sampleDocument('cmyk'), { scope: 'artboard' });
    expect(validateAi(r.ai).errors).toEqual([]);
    expect(r.ai).toContain('0 1 1 0 k'); // red
    expect(r.ai).not.toContain(' Xa');
    expect(r.ai).toMatch(/ 1 50 100 %_Bs/);
    expect(r.ai).toContain('%%DocumentCustomColors: (PANTONE 300 C)');
  });

  it('exports one file per artboard and keeps the artboard as the origin', () => {
    const doc = sampleDocument();
    doc.artboards.push(makeArtboard({ name: 'Second', x: 600, y: 0, width: 200, height: 100 }, 1));
    const p = makeShape({ kind: 'rect', width: 50, height: 50, radii: [0, 0, 0, 0] }, { name: 'OnSecond', fill: { type: 'solid', color: '#0000ff', opacity: 1 } });
    p.transform = translate(610, 10);
    addNode(doc, p, doc.layers[0]);
    const all = exportAiAll(doc, { scope: 'artboards' });
    expect(all).toHaveLength(2);
    expect(all[1].name).toBe('Sample-Second');
    expect(all[1].ai).toContain('%AI5_ArtSize: 150 75');
    // the rectangle at world (610,10) sits 10 px from the artboard's left edge and 10 px below its top → AI (7.5, 75−7.5−37.5)
    expect(all[1].ai).toContain('7.5 67.5 m');
    for (const r of all) expect(validateAi(r.ai).errors).toEqual([]);
  });

  it('writes a valid empty document and hidden objects on request', () => {
    const doc = createDocument({ name: 'Empty', width: 100, height: 100 });
    const r = exportAi(doc);
    expect(validateAi(r.ai).errors).toEqual([]);
    expect(r.ai).toContain('%AI5_NumLayers: 1');
    const withHidden = exportAi(sampleDocument(), { includeHidden: true });
    expect(withHidden.ai).toContain('0.0706 0.2039 0.3373 Xa'); // #123456
  });
});

describe('AI export: strings and fonts', () => {
  it('escapes PostScript strings and encodes Cyrillic as Windows-1251 on request', () => {
    expect(psString('a(b)c\\d')).toBe('(a\\(b\\)c\\\\d)');
    expect(psString('line1\nline2')).toBe('(line1\\015line2)');
    expect(psString('café')).toBe('(caf\\351)');
    expect(psString('Привет')).toBe('(??????)');
    expect(psString('Привет', 'cp1251')).toBe('(\\317\\360\\350\\342\\345\\362)');
    expect(psString('Ёж №1', 'cp1251')).toBe('(\\250\\346 \\271 1)'.replace(' \\271 1', ' \\2711'));
    expect(isEncodable('Hello', 'ascii')).toBe(true);
    expect(isEncodable('café', 'ascii')).toBe(false);
    expect(isEncodable('café', 'latin1')).toBe(true);
    expect(isEncodable('Привет', 'latin1')).toBe(false);
    expect(isEncodable('Привет', 'cp1251')).toBe(true);
    expect(isEncodable('你好', 'cp1251')).toBe(false);
  });

  it('round-trips Cyrillic text through Windows-1251 and decodes Windows-1252 punctuation', () => {
    expect(decodeAiString(String.fromCharCode(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2), 'cp1251')).toBe('Привет');
    expect(decodeAiString('12' + String.fromCharCode(0x96) + '14 ' + String.fromCharCode(0x85))).toBe('12–14 …');
    expect(decodeAiString('caf' + String.fromCharCode(0xe9))).toBe('café');
    const doc = createDocument({ name: 'Cyr', width: 200, height: 100 });
    const t = makeText('Привет, мир — №1', { name: 'T', style: { fontFamily: 'Inter', fontSize: 16 } });
    t.transform = translate(10, 50);
    addNode(doc, t, doc.layers[0]);
    const r = exportAi(doc, { encoding: 'cp1251' });
    expect(r.ai).toContain('%AI_OPuller_TextEncoding: cp1251');
    expect(r.ai).toContain('(\\317\\360\\350\\342\\345\\362, \\354\\350\\360 \\227 \\2711) Tx');
    const back = importAi(r.ai);
    const text = nodesOf(back).find((n): n is TextNode => n.type === 'text')!;
    expect(text.text).toBe('Привет, мир — №1');
  });

  it('maps families to PostScript font names', () => {
    expect(postScriptFontName('Inter', 400, false)).toBe('Inter-Regular');
    expect(postScriptFontName('Inter', 700, true)).toBe('Inter-BoldItalic');
    expect(postScriptFontName('Open Sans', 300, false)).toBe('OpenSans-Light');
    expect(postScriptFontName('Arial', 700, false)).toBe('Arial-BoldMT');
    expect(postScriptFontName('Times New Roman', 400, true)).toBe('TimesNewRomanPS-ItalicMT');
    expect(postScriptFontName('Helvetica', 400, false)).toBe('Helvetica');
  });
});

describe('AI export → import round trip', () => {
  it('recovers layers, geometry, colours, strokes, gradients, compound paths, clips, text and images', () => {
    const doc = sampleDocument();
    const r = exportAi(doc, { scope: 'artboard' });
    const back = importAi(r.ai, { name: 'back' });
    expect(back.warnings).toEqual([]);
    expect(back.width).toBeCloseTo(400, 6);
    expect(back.height).toBeCloseTo(300, 6);
    const nodes = nodesOf(back);
    // layers
    // every Illustrator layer comes back as its own item (itemsToLayers keeps them as layers)
    const layerNodes = back.items.map((it) => it.root);
    expect(layerNodes.map((l) => l.name)).toEqual(['Artwork', 'Text & image']);
    // dashed box: position, fill, stroke
    const box = findByName<PathNode>(nodes, 'Path');
    const bb = worldBounds({ ...doc, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) } as Document, box.id)!;
    expect(bb.x).toBeCloseTo(20, 3);
    expect(bb.y).toBeCloseTo(20, 3);
    expect(bb.width).toBeCloseTo(100, 3);
    expect(bb.height).toBeCloseTo(60, 3);
    expect(box.fill).toMatchObject({ type: 'solid', color: '#ff0000' });
    expect(box.stroke.paint).toMatchObject({ type: 'solid', color: '#000000' });
    expect(box.stroke.width).toBeCloseTo(4, 3);
    expect(box.stroke.cap).toBe('round');
    expect(box.stroke.join).toBe('bevel');
    expect(box.stroke.dash.map((d) => +d.toFixed(3))).toEqual([8, 4]);
    // linear gradient on the circle
    const paths = nodes.filter((n): n is PathNode => n.type === 'path');
    const sun = paths.find((p) => p.fill.type === 'linear')!;
    expect(sun).toBeDefined();
    if (sun.fill.type === 'linear') {
      expect(sun.fill.stops.map((s) => s.color)).toEqual(['#ff0000', '#ffff00']);
      expect(sun.fill.x1).toBeCloseTo(0, 2);
      expect(sun.fill.x2).toBeCloseTo(1, 2);
      expect(sun.fill.y1).toBeCloseTo(0, 2);
      expect(sun.fill.y2).toBeCloseTo(0, 2);
    }
    // radial gradient with a focal point on the star
    const star = paths.find((p) => p.fill.type === 'radial')!;
    expect(star).toBeDefined();
    if (star.fill.type === 'radial') {
      expect(star.fill.stops.map((s) => s.color)).toEqual(['#ffffff', '#00ccff', '#000066']);
      expect(star.fill.cx).toBeCloseTo(0.5, 2);
      expect(star.fill.cy).toBeCloseTo(0.5, 2);
      expect(star.fill.r).toBeCloseTo(0.5, 2);
      expect(star.fill.fx).toBeCloseTo(0.3, 2);
      expect(star.fill.fy).toBeCloseTo(0.3, 2);
    }
    // compound path with even-odd rule
    const frame = findByName<PathNode>(nodes, 'Compound path');
    expect(frame.subpaths).toHaveLength(2);
    expect(frame.fillRule).toBe('evenodd');
    expect(frame.fill).toMatchObject({ type: 'solid', color: '#00aa00' });
    // clip group
    const clipGroup = nodes.find((n): n is GroupNode => n.type === 'group' && !!n.clipId)!;
    expect(clipGroup).toBeDefined();
    const clip = nodes.find((n) => n.id === clipGroup.clipId) as PathNode;
    expect(clip.subpaths[0].anchors).toHaveLength(4);
    const blob = nodes.find((n) => n.parent === clipGroup.id && n.id !== clipGroup.clipId) as PathNode;
    expect(blob.fill).toMatchObject({ type: 'solid', color: '#8800ff' });
    expect(blob.stroke.width).toBeCloseTo(2, 3);
    // spot colour at 50 % tint → mixed with white; locked
    const spot = paths.find((p) => p.locked)!;
    expect(spot).toBeDefined();
    expect(spot.fill).toMatchObject({ type: 'solid' });
    if (spot.fill.type === 'solid') {
      const c = parseInt(spot.fill.color.slice(1, 3), 16);
      expect(c).toBeGreaterThan(100); // lighter than the full ink (#0091d9-ish)
    }
    // point text: content, size, alignment, rotation
    const title = nodes.find((n): n is TextNode => n.type === 'text' && n.text.startsWith('Hello'))!;
    expect(title.text).toBe('Hello AI\nSecond line');
    expect(title.style.fontSize).toBeCloseTo(24, 2);
    expect(title.style.fontWeight).toBe(700);
    expect(title.style.fontFamily).toBe('Inter');
    expect(title.style.textAlign).toBe('center');
    expect(title.style.lineHeight).toBeCloseTo(1.25, 2);
    expect(Math.atan2(title.transform.b, title.transform.a) * (180 / Math.PI)).toBeCloseTo(15, 2);
    expect(title.transform.e).toBeCloseTo(200, 3);
    expect(title.transform.f).toBeCloseTo(150, 3);
    // area text keeps its box
    const area = nodes.find((n): n is TextNode => n.type === 'text' && n.kind === 'area')!;
    expect(area).toBeDefined();
    expect(area.box!.width).toBeCloseTo(140, 2);
    expect(area.box!.height).toBeCloseTo(60, 2);
    expect(area.transform.e).toBeCloseTo(20, 3);
    expect(area.transform.f).toBeCloseTo(100, 3);
    // image: pixels and placement (top-left at 340,120, 40×20 px)
    const image = nodes.find((n): n is ImageNode => n.type === 'image')!;
    expect(image).toBeDefined();
    expect(image.src.startsWith('data:image/bmp;base64,')).toBe(true);
    expect(image.naturalWidth).toBe(2);
    expect(image.transform.e).toBeCloseTo(340, 3);
    expect(image.transform.f).toBeCloseTo(120, 3);
    expect(image.transform.a * image.width).toBeCloseTo(40, 3);
    expect(image.transform.d * image.height).toBeCloseTo(20, 3);
  });

  it('keeps anchor smoothness and handles through the round trip', () => {
    const doc = createDocument({ name: 'Curves', width: 200, height: 200 });
    const p = makePath([ellipseSubPath(50, 30, 100, 100)], { name: 'Ellipse', fill: { type: 'solid', color: '#336699', opacity: 1 } });
    addNode(doc, p, doc.layers[0]);
    const r = exportAi(doc);
    expect(r.ai).toMatch(/ c\n/); // smooth anchors → lower-case curve operator
    const back = importAi(r.ai);
    const e = nodesOf(back).find((n) => n.type === 'path') as PathNode;
    expect(e.subpaths[0].anchors).toHaveLength(4);
    expect(e.subpaths[0].closed).toBe(true);
    expect(e.subpaths[0].anchors.every((a) => a.kind === 'smooth')).toBe(true);
    const b = worldBounds({ ...doc, nodes: { [e.id]: e } } as Document, e.id)!;
    expect(b.x).toBeCloseTo(50, 2);
    expect(b.width).toBeCloseTo(100, 2);
    expect(b.height).toBeCloseTo(60, 2);
  });
});

describe('AI import of Illustrator-written files', () => {
  it('reads the layer / gradient example of the file format specification', () => {
    const spec = `%!PS-Adobe-3.0
%%Creator: Adobe Illustrator(r) 7.0
%%BoundingBox: 224 623 268 662
%%HiResBoundingBox: 224.065 623.1667 268 662.5
%%EndComments
%%BeginProlog
%%EndProlog
%%BeginSetup
2 Bn
%AI5_BeginGradient: (Purple, Red & Yellow)
(Purple, Red & Yellow) 0 3 Bd
[
0 0 1 0 1 50 100 %_Bs
0 1 1 0 1 50 50 %_Bs
0.75 1 0 0 1 50 0 %_Bs
BD
%AI5_EndGradient
%AI5_BeginGradient: (Yellow & Orange Radial)
(Yellow & Orange Radial) 1 2 Bd
[
0 0.8 1 0 1 50 100 %_Bs
0 0 1 0 1 50 0 %_Bs
BD
%AI5_EndGradient
%%EndSetup
%AI5_BeginLayer
1 1 1 1 0 0 0 79 128 255 Lb
(Layer 1) Ln
0 A
1 Ap
0 O
800 Ar
0 J 0 j 1 w 4 M []0 d
%AI3_Note:
0 D
0 XR
237.5 636.4792 m
244.9198 636.4792 250.935 641.8612 250.935 648.5 c
250.935 655.1388 244.9198 660.5208 237.5 660.5208 c
230.0802 660.5208 224.065 655.1388 224.065 648.5 c
224.065 641.8612 230.0802 636.4792 237.5 636.4792 c
Bb
0 0 0 0 Bh
1 (Yellow & Orange Radial) 271.5 629.5 0 12.7475 1 0 0 1 -34 -19 Bg
12.7475 0 0 -12.7475 237.5 648.5 Bm
f
0 BB
LB
%AI5_EndLayer--
%AI5_BeginLayer
0 1 0 1 0 0 1 255 79 79 Lb
(Layer 2) Ln
0 A
0 O
800 Ar
0 J 0 j 1 w 4 M []0 d
%AI3_Note:
0 D
0 XR
268 631 m
268 649 L
245 649 L
245 631 L
268 631 L
Bb
1 (Purple, Red & Yellow) 244.5 640 0 24 1 0 0 1 0 0 Bg
12064.0001 0 0 -22 -11819.5001 651 Bc
12 0 0 -22 244.5 651 Bm
12 0 0 -22 256.5 651 Bm
12064.0001 0 0 -22 268.5 651 Bc
f
0 BB
LB
%AI5_EndLayer--
%%PageTrailer
gsave annotatepage grestore showpage
%%Trailer
%%EOF
`;
    const r = importAi(spec, { name: 'spec' });
    expect(r.warnings).toEqual([]);
    const nodes = nodesOf(r);
    const layers = r.items.map((it) => it.root);
    expect(layers.map((l) => l.name)).toEqual(['Layer 1', 'Layer 2']);
    expect(layers[0].visible).toBe(true);
    expect(layers[1].visible).toBe(false);
    expect(layers[1].locked).toBe(true);
    const paths = nodes.filter((n): n is PathNode => n.type === 'path');
    expect(paths).toHaveLength(2);
    const circle = paths.find((p) => p.fill.type === 'radial')!;
    expect(circle).toBeDefined();
    if (circle.fill.type === 'radial') expect(circle.fill.stops.map((s) => s.color)).toEqual(['#ffff00', '#ff3300']);
    const rect = paths.find((p) => p.fill.type === 'linear')!;
    expect(rect).toBeDefined();
    if (rect.fill.type === 'linear') {
      expect(rect.fill.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
      expect(rect.fill.stops[0].color).toBe('#4000ff'); // 0.75 1 0 0 → purple
      expect(rect.fill.x1).toBeCloseTo(0, 1); // origin 244.5 vs rectangle edge 245
      expect(rect.fill.x2).toBeCloseTo(1, 1); // 24 pt vector across the 23 pt rectangle → slightly beyond
    }
  });

  it('reads custom colours with the 1 − tint convention and four-operand Tf', () => {
    const ai = `%!PS-Adobe-3.0
%%Creator: Adobe Illustrator(r) 7.0
%%BoundingBox: 0 0 100 100
%%EndComments
%%EndProlog
%%EndSetup
0 1 1 0 (Red Spot) 0 x
10 10 m
50 10 L
50 50 L
10 50 L
10 10 L
f
0 1 1 0 (Red Spot) 0.5 x
60 10 m
90 10 L
90 50 L
60 50 L
60 10 L
f
0 To
1 0 0 1 10 80 0 Tp
TP
0 g
/_Helvetica-Bold 14 11.2 2.8 Tf
(Spec) Tx
TO
%%Trailer
%%EOF
`;
    const nodes = nodesOf(importAi(ai));
    const paths = nodes.filter((n): n is PathNode => n.type === 'path');
    expect(paths[0].fill).toMatchObject({ color: '#ff0000' });
    expect(paths[1].fill).toMatchObject({ color: '#ff8080' });
    const t = nodes.find((n): n is TextNode => n.type === 'text')!;
    expect(t.style.fontSize).toBeCloseTo(14 * (96 / 72), 3);
    expect(t.style.fontWeight).toBe(700);
  });

  it('decodes XI rasters into BMP data URLs', () => {
    const url = rgbToBmpDataUrl(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]));
    expect(url.startsWith('data:image/bmp;base64,Qk')).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));
    expect(bytes[0]).toBe(0x42);
    expect(bytes[1]).toBe(0x4d);
    expect(bytes.length).toBe(54 + 8); // one padded row
    // pixel order BGR: red then blue
    expect(Array.from(bytes.slice(54, 60))).toEqual([0, 0, 255, 255, 0, 0]);
  });
});

void PT;
