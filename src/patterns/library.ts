/**
 * Built-in pattern library: classic fills generated as tile artwork so they
 * stay editable (Object > Pattern > Edit Pattern) and recolourable.
 */
import type { PatternDef, Node, ID, PatternLayout, HexColor } from '@/model/types';
import { makeGroup, makePath, makeShape, newId } from '@/model/nodes';
import { noStroke, defaultStroke } from '@/model/defaults';
import { parseSvgPathData } from '@/geometry/path';
import { ellipseSubPath, polygonSubPath, rectSubPath, starSubPath } from '@/geometry/shapes';
import { translate, rotate, multiply } from '@/geometry/matrix';
import type { SubPath } from '@/model/types';

interface Part {
  sps?: SubPath[];
  d?: string;
  fill?: HexColor;
  stroke?: HexColor;
  strokeWidth?: number;
  at?: { x: number; y: number };
  rotate?: number;
}

interface LibPattern {
  id: string;
  name: string;
  width: number;
  height: number;
  layout?: PatternLayout;
  offset?: number;
  background?: HexColor | null;
  parts: Part[];
}

const INK = '#1c1c1e';

const ITEMS: LibPattern[] = [
  { id: 'dots', name: 'Polka Dots', width: 24, height: 24, parts: [{ sps: [ellipseSubPath(5, 5)], fill: INK, at: { x: 12, y: 12 } }] },
  { id: 'dots-brick', name: 'Dots (brick)', width: 20, height: 20, layout: 'brick-row', parts: [{ sps: [ellipseSubPath(4, 4)], fill: '#c8102e', at: { x: 10, y: 10 } }] },
  { id: 'stripes-h', name: 'Horizontal Stripes', width: 20, height: 20, parts: [{ sps: [rectSubPath(20, 8)], fill: INK }] },
  { id: 'stripes-v', name: 'Vertical Stripes', width: 20, height: 20, parts: [{ sps: [rectSubPath(8, 20)], fill: INK }] },
  { id: 'diagonal', name: 'Diagonal Lines', width: 20, height: 20, parts: [{ d: 'M-5 25 L25 -5', stroke: INK, strokeWidth: 3 }, { d: 'M-5 5 L5 -5', stroke: INK, strokeWidth: 3 }, { d: 'M15 25 L25 15', stroke: INK, strokeWidth: 3 }] },
  { id: 'crosshatch', name: 'Crosshatch', width: 20, height: 20, parts: [{ d: 'M0 0 L20 20', stroke: INK, strokeWidth: 1.5 }, { d: 'M20 0 L0 20', stroke: INK, strokeWidth: 1.5 }] },
  { id: 'grid', name: 'Grid', width: 20, height: 20, parts: [{ d: 'M0 0.75 H20', stroke: '#8e8e93', strokeWidth: 1.5 }, { d: 'M0.75 0 V20', stroke: '#8e8e93', strokeWidth: 1.5 }] },
  { id: 'checker', name: 'Checkerboard', width: 20, height: 20, parts: [{ sps: [rectSubPath(10, 10)], fill: INK }, { sps: [rectSubPath(10, 10)], fill: INK, at: { x: 10, y: 10 } }] },
  { id: 'hexagons', name: 'Hexagons', width: 24, height: 24, layout: 'hex-row', parts: [{ sps: [polygonSubPath(6, 11, 30)], fill: 'none', stroke: INK, strokeWidth: 1.5, at: { x: 12, y: 12 } }] },
  { id: 'bricks', name: 'Bricks', width: 40, height: 20, layout: 'brick-row', background: '#b5533c', parts: [{ sps: [rectSubPath(38, 18, [1, 1, 1, 1])], fill: '#c8102e', at: { x: 1, y: 1 } }] },
  { id: 'waves', name: 'Waves', width: 40, height: 20, parts: [{ d: 'M0 10 C10 0 10 0 20 10 C30 20 30 20 40 10', stroke: '#1da1f2', strokeWidth: 2.5 }] },
  { id: 'stars', name: 'Stars', width: 30, height: 30, layout: 'brick-row', parts: [{ sps: [starSubPath(5, 8, 3.5)], fill: '#ffcc00', at: { x: 15, y: 15 } }] },
  { id: 'confetti', name: 'Confetti', width: 40, height: 40, parts: [
    { sps: [rectSubPath(6, 3)], fill: '#ff2d55', at: { x: 5, y: 8 }, rotate: 30 },
    { sps: [rectSubPath(6, 3)], fill: '#1da1f2', at: { x: 24, y: 6 }, rotate: -40 },
    { sps: [ellipseSubPath(2.5, 2.5)], fill: '#ffcc00', at: { x: 16, y: 22 } },
    { sps: [rectSubPath(6, 3)], fill: '#34c759', at: { x: 30, y: 28 }, rotate: 70 },
    { sps: [ellipseSubPath(2, 2)], fill: '#af52de', at: { x: 8, y: 32 } },
  ] },
  { id: 'scales', name: 'Scales', width: 24, height: 24, layout: 'brick-row', parts: [{ sps: [ellipseSubPath(12, 12)], fill: 'none', stroke: INK, strokeWidth: 1.5, at: { x: 12, y: 12 } }] },
  { id: 'triangles', name: 'Triangles', width: 24, height: 24, layout: 'brick-row', parts: [{ sps: [polygonSubPath(3, 10)], fill: '#5856d6', at: { x: 12, y: 13 } }] },
];

export interface PatternLibraryEntry {
  id: string;
  name: string;
  build: () => PatternDef;
}

function partNode(p: Part, i: number): Node {
  const sps = p.sps ?? parseSvgPathData(p.d ?? '');
  const fill = p.fill && p.fill !== 'none' ? ({ type: 'solid', color: p.fill, opacity: 1 } as const) : ({ type: 'none' } as const);
  const stroke = p.stroke ? defaultStroke({ paint: { type: 'solid', color: p.stroke, opacity: 1 }, width: p.strokeWidth ?? 1, cap: 'round', join: 'round' }) : noStroke();
  const n = makePath(sps, { fill, stroke, name: `Part ${i + 1}` });
  let m = translate(p.at?.x ?? 0, p.at?.y ?? 0);
  if (p.rotate) m = multiply(m, rotate(p.rotate));
  n.transform = m;
  return n;
}

function build(item: LibPattern): PatternDef {
  const root = makeGroup([], { name: item.name });
  root.parent = null;
  const nodes: Record<ID, Node> = { [root.id]: root };
  item.parts.forEach((p, i) => {
    const n = partNode(p, i);
    n.parent = root.id;
    nodes[n.id] = n;
    root.children.push(n.id);
  });
  return { id: newId(), name: item.name, width: item.width, height: item.height, svg: '', nodes, root: root.id, layout: item.layout ?? 'grid', offset: item.offset ?? 0.5, spacing: { x: 0, y: 0 }, background: item.background ?? null };
}

export const PATTERN_LIBRARY: PatternLibraryEntry[] = ITEMS.map((item) => ({ id: item.id, name: item.name, build: () => build(item) }));

export { makeShape };
