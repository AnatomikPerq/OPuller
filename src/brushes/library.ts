/**
 * Built-in brush library: calligraphic presets, scatter (dots, stars, leaves,
 * confetti), art (arrow, tapered, chalk, ribbon) and pattern (dashes, chain,
 * dots, zigzag, rope) brushes built from simple artwork.
 */
import type { BrushDef, BrushArtwork, Node, ID, SubPath, HexColor } from '@/model/types';
import { makeGroup, makePath, newId } from '@/model/nodes';
import { parseSvgPathData } from '@/geometry/path';
import { ellipseSubPath, starSubPath, polygonSubPath, rectSubPath } from '@/geometry/shapes';
import { translate, rotate, multiply } from '@/geometry/matrix';
import { noStroke, defaultStroke } from '@/model/defaults';

interface Part {
  d?: string;
  sps?: SubPath[];
  fill?: HexColor | 'none';
  stroke?: HexColor;
  strokeWidth?: number;
  at?: { x: number; y: number };
  rotate?: number;
}

function art(name: string, parts: Part[]): BrushArtwork {
  const root = makeGroup([], { name });
  root.parent = null;
  const nodes: Record<ID, Node> = { [root.id]: root };
  parts.forEach((p, i) => {
    const sps = p.sps ?? parseSvgPathData(p.d ?? '');
    const fill = p.fill && p.fill !== 'none' ? ({ type: 'solid', color: p.fill, opacity: 1 } as const) : ({ type: 'none' } as const);
    const stroke = p.stroke ? defaultStroke({ paint: { type: 'solid', color: p.stroke, opacity: 1 }, width: p.strokeWidth ?? 1, cap: 'round', join: 'round' }) : noStroke();
    const n = makePath(sps, { fill, stroke, name: `${name} ${i + 1}` });
    let m = translate(p.at?.x ?? 0, p.at?.y ?? 0);
    if (p.rotate) m = multiply(m, rotate(p.rotate));
    n.transform = m;
    n.parent = root.id;
    nodes[n.id] = n;
    root.children.push(n.id);
  });
  return { nodes, root: root.id };
}

const K = '#000000';

export interface BrushLibraryEntry {
  id: string;
  name: string;
  kind: BrushDef['kind'];
  build: () => BrushDef;
}

function calligraphic(id: string, name: string, size: number, angle: number, roundness: number): BrushLibraryEntry {
  return { id, name, kind: 'calligraphic', build: () => ({ id: newId(), name, kind: 'calligraphic', size, angle, roundness }) };
}

export const BRUSH_LIBRARY: BrushLibraryEntry[] = [
  calligraphic('cal-1-round', '1 pt Round', 1.33, 0, 100),
  calligraphic('cal-3-round', '3 pt Round', 4, 0, 100),
  calligraphic('cal-5-flat', '5 pt Flat', 6.7, 45, 15),
  calligraphic('cal-10-oval', '10 pt Oval', 13.3, 30, 55),
  calligraphic('cal-15-flat', '15 pt Flat', 20, 60, 10),
  calligraphic('cal-25-round', '25 pt Round', 33, 0, 100),
  {
    id: 'sc-dots',
    name: 'Dots',
    kind: 'scatter',
    build: () => ({ id: newId(), name: 'Dots', kind: 'scatter', art: art('Dot', [{ sps: [ellipseSubPath(4, 4)], fill: K }]), size: [60, 140], spacing: [120, 180], scatter: [-80, 80], rotation: [0, 0], rotationRelativeTo: 'page', colorization: 'tints' }),
  },
  {
    id: 'sc-stars',
    name: 'Stars',
    kind: 'scatter',
    build: () => ({ id: newId(), name: 'Stars', kind: 'scatter', art: art('Star', [{ sps: [starSubPath(5, 7, 3)], fill: '#ffcc00' }]), size: [50, 150], spacing: [100, 200], scatter: [-120, 120], rotation: [-180, 180], rotationRelativeTo: 'page', colorization: 'none' }),
  },
  {
    id: 'sc-leaves',
    name: 'Leaves',
    kind: 'scatter',
    build: () => ({ id: newId(), name: 'Leaves', kind: 'scatter', art: art('Leaf', [{ d: 'M0 0 C6 -6 14 -6 18 0 C14 6 6 6 0 0 Z M2 0 L16 0', fill: '#34c759', stroke: '#1f7a3a', strokeWidth: 0.6 }]), size: [70, 130], spacing: [60, 110], scatter: [-60, 60], rotation: [-40, 40], rotationRelativeTo: 'path', colorization: 'none' }),
  },
  {
    id: 'sc-confetti',
    name: 'Confetti',
    kind: 'scatter',
    build: () => ({
      id: newId(),
      name: 'Confetti',
      kind: 'scatter',
      art: art('Confetti', [
        { sps: [rectSubPath(6, 3)], fill: '#ff2d55', at: { x: -8, y: -4 }, rotate: 30 },
        { sps: [rectSubPath(6, 3)], fill: '#1da1f2', at: { x: 4, y: 2 }, rotate: -50 },
        { sps: [ellipseSubPath(2, 2)], fill: '#ffcc00', at: { x: -2, y: 5 } },
      ]),
      size: [60, 140],
      spacing: [40, 90],
      scatter: [-150, 150],
      rotation: [-180, 180],
      rotationRelativeTo: 'page',
      colorization: 'none',
    }),
  },
  {
    id: 'art-arrow',
    name: 'Arrow',
    kind: 'art',
    build: () => ({ id: newId(), name: 'Arrow', kind: 'art', art: art('Arrow', [{ d: 'M0 -3 H70 V-10 L100 0 L70 10 V3 H0 Z', fill: K }]), width: 100, stretch: 'stretch', colorization: 'tints' }),
  },
  {
    id: 'art-tapered',
    name: 'Tapered Stroke',
    kind: 'art',
    build: () => ({ id: newId(), name: 'Tapered Stroke', kind: 'art', art: art('Tapered', [{ d: 'M0 0 C30 -8 70 -8 100 0 C70 8 30 8 0 0 Z', fill: K }]), width: 100, stretch: 'stretch', colorization: 'tints' }),
  },
  {
    id: 'art-chalk',
    name: 'Chalk',
    kind: 'art',
    build: () => ({
      id: newId(),
      name: 'Chalk',
      kind: 'art',
      art: art('Chalk', [
        { d: 'M0 -4 L12 -6 L25 -3 L40 -6 L55 -2 L70 -5 L85 -3 L100 -4 L100 3 L88 5 L72 2 L60 6 L45 3 L30 5 L15 2 L0 4 Z', fill: K },
        { d: 'M5 0 L20 -1 L35 1 L50 -1 L65 1 L80 0 L95 1', stroke: '#ffffff', strokeWidth: 0.8 },
      ]),
      width: 100,
      stretch: 'stretch',
      colorization: 'tints',
    }),
  },
  {
    id: 'art-ribbon',
    name: 'Ribbon',
    kind: 'art',
    build: () => ({
      id: newId(),
      name: 'Ribbon',
      kind: 'art',
      art: art('Ribbon', [
        { d: 'M0 -8 H100 V8 H0 Z', fill: '#c8102e' },
        { d: 'M0 -3 H100 V3 H0 Z', fill: '#ff7f9f' },
        { d: 'M0 -8 L8 0 L0 8 Z', fill: '#7a1f3d' },
        { d: 'M100 -8 L92 0 L100 8 Z', fill: '#7a1f3d' },
      ]),
      width: 100,
      stretch: 'stretch',
      colorization: 'none',
    }),
  },
  {
    id: 'pat-dashes',
    name: 'Dashes',
    kind: 'pattern',
    build: () => ({ id: newId(), name: 'Dashes', kind: 'pattern', side: art('Dash', [{ sps: [rectSubPath(12, 3, [1.5, 1.5, 1.5, 1.5])], fill: K, at: { x: 0, y: -1.5 } }]), scale: 100, spacing: 60, fit: 'space', colorization: 'tints' }),
  },
  {
    id: 'pat-dots',
    name: 'Dot Chain',
    kind: 'pattern',
    build: () => ({ id: newId(), name: 'Dot Chain', kind: 'pattern', side: art('Dot', [{ sps: [ellipseSubPath(3, 3)], fill: K, at: { x: 3, y: 0 } }]), scale: 100, spacing: 80, fit: 'space', colorization: 'tints' }),
  },
  {
    id: 'pat-chain',
    name: 'Chain',
    kind: 'pattern',
    build: () => ({ id: newId(), name: 'Chain', kind: 'pattern', side: art('Link', [{ d: 'M2 0 C2 -4 5 -6 9 -6 H15 C19 -6 22 -4 22 0 C22 4 19 6 15 6 H9 C5 6 2 4 2 0 Z M5 0 C5 -2.5 7 -3.5 9 -3.5 H15 C17 -3.5 19 -2.5 19 0 C19 2.5 17 3.5 15 3.5 H9 C7 3.5 5 2.5 5 0 Z', fill: K }]), scale: 100, spacing: 0, fit: 'stretch', colorization: 'tints' }),
  },
  {
    id: 'pat-zigzag',
    name: 'Zigzag',
    kind: 'pattern',
    build: () => ({ id: newId(), name: 'Zigzag', kind: 'pattern', side: art('Zig', [{ d: 'M0 4 L5 -4 L10 4 L15 -4 L20 4', stroke: K, strokeWidth: 1.5 }]), scale: 100, spacing: 0, fit: 'stretch', colorization: 'tints' }),
  },
  {
    id: 'pat-rope',
    name: 'Rope',
    kind: 'pattern',
    build: () => ({
      id: newId(),
      name: 'Rope',
      kind: 'pattern',
      side: art('Rope', [
        { d: 'M0 -5 H16 V5 H0 Z', fill: '#d4a24c' },
        { d: 'M0 5 C4 2 4 -2 8 -5 M8 5 C12 2 12 -2 16 -5', stroke: '#8a5a1a', strokeWidth: 1.5 },
      ]),
      scale: 100,
      spacing: 0,
      fit: 'stretch',
      colorization: 'none',
    }),
  },
  {
    id: 'pat-arrows',
    name: 'Arrow Line',
    kind: 'pattern',
    build: () => ({
      id: newId(),
      name: 'Arrow Line',
      kind: 'pattern',
      side: art('Line', [{ d: 'M0 -1.5 H20 V1.5 H0 Z', fill: K }]),
      start: art('Tail', [{ sps: [ellipseSubPath(4, 4)], fill: K, at: { x: 4, y: 0 } }]),
      end: art('Head', [{ d: 'M0 -7 L14 0 L0 7 Z', fill: K }]),
      scale: 100,
      spacing: 0,
      fit: 'stretch',
      colorization: 'tints',
    }),
  },
];

export { polygonSubPath };
