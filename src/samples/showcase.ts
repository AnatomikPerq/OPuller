/**
 * Sample document: a showcase of shapes, gradients, strokes, effects, text and a blend.
 */
import type { Document } from '@/model/types';
import { createDocument, makeShape, makeText, makePath, makeLayer } from '@/model/nodes';
import { addNode, setWorldSubPaths } from '@/model/document';
import { translate, rotate, multiply } from '@/geometry/matrix';
import { defaultStroke } from '@/model/defaults';
import { parseSvgPathData } from '@/geometry/path';
import { makeBlend } from '@/blend/ops';

export function showcaseSample(): Document {
  const doc = createDocument({ name: 'Showcase', width: 1400, height: 900, background: '#f7f7f9' });
  const layer = doc.layers[0];
  doc.nodes[layer].name = 'Artwork';

  // title
  addNode(
    doc,
    makeText('OPuller showcase', { style: { fontFamily: 'Montserrat', fontSize: 56, fontWeight: 700, letterSpacing: -1 }, fill: { type: 'solid', color: '#1c1c1e', opacity: 1 }, transform: translate(80, 120), name: 'Title' }),
    layer,
  );
  addNode(
    doc,
    makeText('Live shapes · gradients · strokes · effects · blends · type', { style: { fontFamily: 'Inter', fontSize: 20, fontWeight: 400 }, fill: { type: 'solid', color: '#6e6e73', opacity: 1 }, transform: translate(82, 160), name: 'Subtitle' }),
    layer,
  );

  // gradient rounded rectangle with a drop shadow
  const card = makeShape(
    { kind: 'rect', width: 320, height: 200, radii: [24, 24, 24, 24] },
    {
      name: 'Gradient card',
      fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, spread: 'pad', stops: [{ offset: 0, color: '#7a1f3d', opacity: 1 }, { offset: 1, color: '#ff7a59', opacity: 1 }] },
      stroke: defaultStroke({ paint: { type: 'none' } }),
      transform: translate(80, 220),
      effects: [{ type: 'dropShadow', enabled: true, dx: 0, dy: 12, blur: 18, color: '#7a1f3d', opacity: 0.35 }],
    },
  );
  addNode(doc, card, layer);

  // radial gradient circle
  addNode(
    doc,
    makeShape(
      { kind: 'ellipse', rx: 100, ry: 100 },
      {
        name: 'Radial sphere',
        fill: { type: 'radial', cx: 0.35, cy: 0.3, r: 0.75, spread: 'pad', stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 0.5, color: '#32ade6', opacity: 1 }, { offset: 1, color: '#0a3d62', opacity: 1 }] },
        stroke: defaultStroke({ paint: { type: 'none' } }),
        transform: translate(560, 320),
      },
    ),
    layer,
  );

  // star with dashed stroke
  addNode(
    doc,
    makeShape(
      { kind: 'star', points: 7, outerRadius: 100, innerRadius: 52 },
      {
        name: 'Star',
        fill: { type: 'solid', color: '#ffcc00', opacity: 1 },
        stroke: defaultStroke({ paint: { type: 'solid', color: '#1c1c1e', opacity: 1 }, width: 4, join: 'round', dash: [12, 8], cap: 'round' }),
        transform: multiply(translate(820, 320), rotate(-12)),
      },
    ),
    layer,
  );

  // polygon with an inner glow
  addNode(
    doc,
    makeShape(
      { kind: 'polygon', sides: 6, radius: 95 },
      {
        name: 'Hexagon',
        fill: { type: 'solid', color: '#34c759', opacity: 1 },
        stroke: defaultStroke({ paint: { type: 'solid', color: '#1b7a34', opacity: 1 }, width: 6, join: 'round' }),
        transform: translate(1080, 320),
        effects: [{ type: 'innerGlow', enabled: true, blur: 14, color: '#ffffff', opacity: 0.8 }],
      },
    ),
    layer,
  );

  // arrow line with markers
  addNode(
    doc,
    makeShape(
      { kind: 'line', x1: 0, y1: 0, x2: 420, y2: -40 },
      {
        name: 'Arrow',
        fill: { type: 'none' },
        stroke: defaultStroke({ paint: { type: 'solid', color: '#1c1c1e', opacity: 1 }, width: 3, cap: 'round', markerEnd: 'arrow', markerStart: 'circle' }),
        transform: translate(100, 560),
      },
    ),
    layer,
  );

  // a hand-drawn heart path (cubic Béziers)
  const heart = makePath([], { name: 'Heart', fill: { type: 'solid', color: '#ff2d55', opacity: 1 }, stroke: defaultStroke({ paint: { type: 'none' } }), effects: [{ type: 'dropShadow', enabled: true, dx: 0, dy: 6, blur: 10, color: '#000000', opacity: 0.25 }] });
  addNode(doc, heart, layer);
  setWorldSubPaths(doc, heart.id, parseSvgPathData('M 640 640 C 640 600 600 560 560 580 C 520 600 530 660 640 740 C 750 660 760 600 720 580 C 680 560 640 600 640 640 Z'));

  // blend between two shapes
  const blendLayer = makeLayer({ name: 'Blend' }, 1);
  doc.nodes[blendLayer.id] = blendLayer;
  doc.layers.push(blendLayer.id);
  const a = makeShape({ kind: 'ellipse', rx: 40, ry: 40 }, { name: 'Blend start', fill: { type: 'solid', color: '#5856d6', opacity: 1 }, stroke: defaultStroke({ paint: { type: 'none' } }), transform: translate(820, 640) });
  const b = makeShape({ kind: 'rect', width: 90, height: 90, radii: [8, 8, 8, 8] }, { name: 'Blend end', fill: { type: 'solid', color: '#ff9500', opacity: 1 }, stroke: defaultStroke({ paint: { type: 'none' } }), transform: multiply(translate(1200, 600), rotate(30)) });
  addNode(doc, a, blendLayer.id);
  addNode(doc, b, blendLayer.id);
  makeBlend(doc, [a.id, b.id], { spacing: 'steps', steps: 6 });

  // area text
  addNode(
    doc,
    makeText('Area text wraps inside its box. Edit with the Type tool (T), change fonts in the Character panel, and convert to outlines with Type > Create Outlines.', {
      kind: 'area',
      box: { width: 380, height: 140 },
      style: { fontFamily: 'Lora', fontSize: 18, lineHeight: 1.45 },
      fill: { type: 'solid', color: '#3a3a3c', opacity: 1 },
      transform: translate(80, 640),
      name: 'Area text',
    }),
    layer,
  );

  return doc;
}
