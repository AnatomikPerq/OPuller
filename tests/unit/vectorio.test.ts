import { describe, it, expect } from 'vitest';
import { importAi, looksLikeAiOrEps } from '@/io/aiImport';
import { exportEps } from '@/io/epsExport';
import { pdfOffset } from '@/io/pdfImport';
import { createDocument, makeShape, makePath } from '@/model/nodes';
import { addNode, worldBounds } from '@/model/document';
import { rectSubPath } from '@/geometry/shapes';

const AI8 = `%!PS-Adobe-3.0 EPSF-3.0
%%Creator: Adobe Illustrator(R) 8.0
%%BoundingBox: 0 0 200 100
%%HiResBoundingBox: 0 0 200 100
%%EndComments
%%BeginProlog
/foo { bar } def
%%EndProlog
%%BeginSetup
%%EndSetup
%AI5_BeginLayer
1 1 1 1 0 0 0 79 128 255 Lb
(Layer 1) Ln
0 A
u
0 0 1 0 k
0 0 0 1 K
2 w
10 10 m
90 10 L
90 60 L
10 60 L
10 10 l
b
*u
1 0 0 0 k
110 10 m
190 10 L
190 90 L
110 90 L
h
f
130 30 m
170 30 L
170 70 L
130 70 L
h
f
*U
U
0 To
1 0 0 1 20 80 0 Tp
TP
0 Tr
0 g
/_Helvetica-Bold 14 Tf
(Hello AI) Tx
TO
LB
%AI5_EndLayer--
%%Trailer
%%EOF
`;

describe('AI / EPS import', () => {
  it('recognises PostScript files and PDF headers', () => {
    expect(looksLikeAiOrEps(AI8)).toBe(true);
    expect(looksLikeAiOrEps('<svg/>')).toBe(false);
    expect(pdfOffset(new TextEncoder().encode('%PDF-1.5 ...'))).toBe(0);
    expect(pdfOffset(new TextEncoder().encode('%!PS\n%PDF-1.4'))).toBe(5);
    expect(pdfOffset(new TextEncoder().encode('nothing here'))).toBe(-1);
  });

  it('imports Illustrator 8 artwork: layers, groups, compound paths, colours and text', () => {
    const r = importAi(AI8, { name: 'test' });
    expect(r.items).toHaveLength(1);
    expect(r.width).toBeCloseTo(200 * (96 / 72), 6);
    const nodes = r.items[0].nodes;
    const paths = nodes.filter((n) => n.type === 'path');
    expect(paths).toHaveLength(2);
    const rect = paths.find((p) => p.name === 'Path') as any;
    expect(rect.fill.color).toBe('#ffff00'); // 0 0 1 0 k → yellow
    expect(rect.stroke.paint.color).toBe('#000000');
    expect(rect.stroke.width).toBeCloseTo(2 * (96 / 72), 4);
    expect(rect.subpaths[0].closed).toBe(true);
    // y is flipped: the rectangle from y=10..60 (PostScript) sits at the bottom of the 100pt box
    const doc = createDocument();
    for (const n of nodes) doc.nodes[n.id] = n;
    doc.layers = [];
    const b = worldBounds({ ...doc, layers: [r.items[0].root.id] } as any, rect.id)!;
    expect(b.y).toBeCloseTo(40 * (96 / 72), 4);
    const compound = paths.find((p) => p.name === 'Compound path') as any;
    expect(compound.subpaths).toHaveLength(2);
    expect(compound.fillRule).toBe('evenodd');
    expect(compound.fill.color).toBe('#00ffff');
    const text = nodes.find((n) => n.type === 'text') as any;
    expect(text.text).toBe('Hello AI');
    expect(text.style.fontWeight).toBe(700);
    const groups = nodes.filter((n) => n.type === 'group');
    expect(groups.some((g) => g.name === 'Layer 1')).toBe(true);
  });

  it('imports plain PostScript operators', () => {
    const ps = `%!PS-Adobe-2.0 EPSF-2.0\n%%BoundingBox: 0 0 100 100\n1 0 0 setrgbcolor\nnewpath 10 10 moveto 50 10 lineto 50 50 lineto closepath fill\n0 0 1 setrgbcolor 4 setlinewidth 60 60 moveto 90 90 lineto stroke\nshowpage\n`;
    const r = importAi(ps);
    const paths = r.items[0].nodes.filter((n) => n.type === 'path') as any[];
    expect(paths).toHaveLength(2);
    expect(paths[0].fill.color).toBe('#ff0000');
    expect(paths[1].stroke.paint.color).toBe('#0000ff');
    expect(paths[1].fill.type).toBe('none');
  });
});

describe('EPS export', () => {
  it('writes a valid EPS with paths, strokes, gradients and clipping', () => {
    const doc = createDocument({ width: 200, height: 100 });
    const rect = makeShape({ kind: 'rect', width: 50, height: 30, radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: '#ff0000', opacity: 1 }, transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 } });
    addNode(doc, rect, doc.layers[0]);
    const grad = makePath([rectSubPath(40, 40)], { fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, spread: 'pad', stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] }, transform: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 20 } });
    addNode(doc, grad, doc.layers[0]);
    const r = exportEps(doc, { scope: 'artboard' });
    expect(r.eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0')).toBe(true);
    expect(r.eps).toContain('%%BoundingBox: 0 0 150 75');
    expect(r.eps).toContain('1 0 0 setrgbcolor fill');
    expect(r.eps).toContain('/ShadingType 2');
    expect(r.eps).toContain('shfill');
    expect(r.eps).toContain('stroke');
    expect(r.eps.trim().endsWith('%%EOF')).toBe(true);
    // y is flipped: the red rect's first moveto is at PostScript y = (100 - 10 - 30) pt
    const m = r.eps.match(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) moveto/);
    expect(m).toBeTruthy();
    expect(Number(m![2])).toBeCloseTo((100 - 10) * 0.75, 3);
    const cmyk = exportEps(doc, { scope: 'artboard', cmyk: true });
    expect(cmyk.eps).toContain('setcmykcolor');
  });
});
