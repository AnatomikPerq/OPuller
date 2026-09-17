/** A realistic document for the AI export tests: two layers, shapes, gradients, compound path, clip group, text, spot colour, image, hidden and locked objects. */
import { setPreparedRaster } from '@/io/rasterHex';
import { createDocument, makeShape, makePath, makeGroup, makeText, makeImage, makeLayer } from '@/model/nodes';
import { addNode } from '@/model/document';
import { rectSubPath, ellipseSubPath } from '@/geometry/shapes';
import { translate, multiply, rotate } from '@/geometry/matrix';
import type { Document } from '@/model/types';

// ---------------------------------------------------------------------------
// A realistic document: two layers, shapes, gradients, compound path, clip
// group, text, spot colour, image, hidden and locked objects.
// ---------------------------------------------------------------------------

export function sampleDocument(colorMode: 'rgb' | 'cmyk' = 'rgb'): Document {
  const doc = createDocument({ name: 'Sample', width: 400, height: 300 });
  doc.colorMode = colorMode;
  const spot = { id: 'sw-spot', name: 'PANTONE 300 C', paint: { type: 'solid' as const, color: '#005eb8', opacity: 1 }, kind: 'spot' as const, cmyk: { c: 100, m: 44, y: 0, k: 0 } };
  doc.swatches.push(spot);
  doc.swatches.push({ id: 'sw-grad', name: 'Sunset', paint: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ffff00', opacity: 1 }], spread: 'pad' } });
  const layer1 = doc.layers[0];
  doc.nodes[layer1].name = 'Artwork';
  // 1. dashed rectangle
  const rect = makeShape({ kind: 'rect', width: 100, height: 60, radii: [0, 0, 0, 0] }, { name: 'Box', fill: { type: 'solid', color: '#ff0000', opacity: 1 }, stroke: { paint: { type: 'solid', color: '#000000', opacity: 1 }, width: 4, cap: 'round', join: 'bevel', miterLimit: 4, dash: [8, 4], dashOffset: 0, align: 'center', markerStart: 'none', markerEnd: 'none', markerScale: 1 } });
  rect.transform = translate(20, 20);
  addNode(doc, rect, layer1);
  // 2. circle with a linear gradient (the document's Sunset swatch)
  const circle = makeShape({ kind: 'ellipse', rx: 40, ry: 40 }, { name: 'Sun', fill: doc.swatches.find((s) => s.id === 'sw-grad')!.paint, stroke: { paint: { type: 'none' }, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, align: 'center', markerStart: 'none', markerEnd: 'none', markerScale: 1 } });
  circle.transform = translate(220, 80);
  addNode(doc, circle, layer1);
  // 3. compound path (frame with a hole, even-odd)
  const frame = makePath([rectSubPath(80, 80), { ...rectSubPath(40, 40), anchors: rectSubPath(40, 40).anchors.map((a) => ({ ...a, point: { x: a.point.x + 20, y: a.point.y + 20 } })) }], { name: 'Frame', fillRule: 'evenodd', fill: { type: 'solid', color: '#00aa00', opacity: 1 }, stroke: { paint: { type: 'none' }, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, align: 'center', markerStart: 'none', markerEnd: 'none', markerScale: 1 } });
  frame.transform = translate(300, 20);
  addNode(doc, frame, layer1);
  // 4. radial gradient with a focal point on a star
  const star = makeShape({ kind: 'star', points: 5, outerRadius: 40, innerRadius: 18 }, { name: 'Star', fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, fx: 0.3, fy: 0.3, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 0.5, color: '#00ccff', opacity: 1 }, { offset: 1, color: '#000066', opacity: 1 }], spread: 'pad' } });
  star.transform = translate(80, 200);
  addNode(doc, star, layer1);
  // 5. clip group: ellipse clipped by a rectangle, inside a group
  const group = makeGroup([], { name: 'Clipped' });
  addNode(doc, group, layer1);
  const clipRect = makePath([rectSubPath(120, 50)], { name: 'Mask', fill: { type: 'none' }, stroke: { paint: { type: 'none' }, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, align: 'center', markerStart: 'none', markerEnd: 'none', markerScale: 1 } });
  clipRect.transform = translate(150, 200);
  addNode(doc, clipRect, group.id);
  group.clipId = clipRect.id;
  const ell = makePath([ellipseSubPath(90, 40, 210, 225)], { name: 'Blob', fill: { type: 'solid', color: '#8800ff', opacity: 0.5 }, stroke: { paint: { type: 'solid', color: '#220044', opacity: 1 }, width: 2, cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, align: 'center', markerStart: 'none', markerEnd: 'none', markerScale: 1 } });
  addNode(doc, ell, group.id);
  // 6. spot colour at 50 % tint, locked
  const spotRect = makeShape({ kind: 'rect', width: 60, height: 30, radii: [0, 0, 0, 0] }, { name: 'Spot', fill: { type: 'solid', color: '#7faedb', opacity: 1, swatchId: 'sw-spot', tint: 50 }, stroke: { paint: { type: 'none' }, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, align: 'center', markerStart: 'none', markerEnd: 'none', markerScale: 1 } });
  spotRect.transform = translate(300, 240);
  spotRect.locked = true;
  addNode(doc, spotRect, layer1);
  // 7. hidden path (skipped unless includeHidden)
  const hidden = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] }, { name: 'Hidden', fill: { type: 'solid', color: '#123456', opacity: 1 } });
  hidden.visible = false;
  addNode(doc, hidden, layer1);
  // second layer: text and an image
  const layer2 = makeLayer({ name: 'Text & image', color: '#ff40ff' }, 1);
  doc.nodes[layer2.id] = layer2;
  doc.layers.push(layer2.id);
  const text = makeText('Hello AI\nSecond line', { name: 'Title', style: { fontFamily: 'Inter', fontSize: 24, fontWeight: 700, lineHeight: 1.25, textAlign: 'center' }, fill: { type: 'solid', color: '#202020', opacity: 1 } });
  text.transform = multiply(translate(200, 150), rotate(15));
  addNode(doc, text, layer2.id);
  const area = makeText('Area text flows inside a box.', { name: 'Area', kind: 'area', box: { width: 140, height: 60 }, style: { fontFamily: 'Roboto', fontSize: 12, fontWeight: 400, textAlign: 'left' } });
  area.transform = translate(20, 100);
  addNode(doc, area, layer2.id);
  setPreparedRaster('img:test', { width: 2, height: 2, hex: 'ff000000ff000000ffffffff' });
  const img = makeImage('img:test', 2, 2, { name: 'Pixels', width: 40, height: 20 });
  img.transform = translate(340, 120);
  addNode(doc, img, layer2.id);
  return doc;
}

