/**
 * Built-in symbol library: simple vector icons built from SVG path data
 * (arrows, stars, hearts, pins, clouds, ...). Each entry produces a SymbolDef
 * in symbol space (registration point at the centre).
 */
import type { SymbolDef, Node, ID, Paint } from '@/model/types';
import { makeGroup, makePath, newId } from '@/model/nodes';
import { parseSvgPathData, pathBounds, transformSubPaths } from '@/geometry/path';
import { ellipseSubPath, starSubPath, polygonSubPath, rectSubPath } from '@/geometry/shapes';
import { translate, multiply, scale } from '@/geometry/matrix';
import { noStroke, defaultStroke } from '@/model/defaults';
import type { SubPath } from '@/model/types';

interface LibItem {
  id: string;
  name: string;
  /** parts: path data (SVG, 0..100 box) or subpaths, with a fill colour */
  parts: Array<{ d?: string; sps?: SubPath[]; fill: string; stroke?: string; strokeWidth?: number }>;
  /** target size in px (longest side) */
  size?: number;
}

const SIZE = 64;

const ITEMS: LibItem[] = [
  { id: 'arrow-right', name: 'Arrow', parts: [{ d: 'M5 40 H60 V20 L95 50 L60 80 V60 H5 Z', fill: '#c8102e' }] },
  { id: 'star', name: 'Star', parts: [{ sps: [starSubPath(5, 50, 20)], fill: '#ffcc00' }] },
  { id: 'heart', name: 'Heart', parts: [{ d: 'M50 88 C20 65 5 48 5 30 C5 15 17 5 30 5 C40 5 47 11 50 18 C53 11 60 5 70 5 C83 5 95 15 95 30 C95 48 80 65 50 88 Z', fill: '#ff2d55' }] },
  { id: 'check', name: 'Check mark', parts: [{ d: 'M10 55 L25 40 L42 57 L78 18 L92 32 L42 85 Z', fill: '#34c759' }] },
  { id: 'pin', name: 'Map pin', parts: [{ d: 'M50 5 C30 5 15 20 15 40 C15 65 50 95 50 95 C50 95 85 65 85 40 C85 20 70 5 50 5 Z M50 25 C58 25 65 32 65 40 C65 48 58 55 50 55 C42 55 35 48 35 40 C35 32 42 25 50 25 Z', fill: '#e5484d' }] },
  { id: 'cloud', name: 'Cloud', parts: [{ d: 'M28 80 C14 80 5 70 5 58 C5 47 13 38 24 37 C26 22 38 12 52 12 C66 12 78 22 80 36 C90 37 96 45 96 55 C96 69 86 80 72 80 Z', fill: '#7fd0ff' }] },
  { id: 'bolt', name: 'Lightning', parts: [{ d: 'M58 3 L22 55 L45 55 L38 97 L78 40 L55 40 Z', fill: '#ffcc00' }] },
  { id: 'bubble', name: 'Speech bubble', parts: [{ d: 'M15 10 H85 C92 10 95 13 95 20 V60 C95 67 92 70 85 70 H45 L25 90 L28 70 H15 C8 70 5 67 5 60 V20 C5 13 8 10 15 10 Z', fill: '#ffffff', stroke: '#1c1c1e', strokeWidth: 3 }] },
  { id: 'sun', name: 'Sun', parts: [{ sps: [starSubPath(12, 50, 38)], fill: '#ff9500' }, { sps: [ellipseSubPath(26, 26)], fill: '#ffcc00' }] },
  { id: 'leaf', name: 'Leaf', parts: [{ d: 'M10 90 C10 40 40 10 95 8 C93 60 65 92 10 90 Z M12 88 C40 60 60 40 88 12', fill: '#34c759', stroke: '#1f7a3a', strokeWidth: 2 }] },
  { id: 'hexagon', name: 'Hexagon', parts: [{ sps: [polygonSubPath(6, 48)], fill: '#5856d6' }] },
  { id: 'badge', name: 'Badge', parts: [{ sps: [starSubPath(16, 50, 42)], fill: '#af52de' }, { sps: [ellipseSubPath(30, 30)], fill: '#ffffff' }] },
  { id: 'flower', name: 'Flower', parts: [
    { sps: [ellipseSubPath(14, 22, 0, -26), ellipseSubPath(14, 22, 0, 26), ellipseSubPath(22, 14, -26, 0), ellipseSubPath(22, 14, 26, 0)], fill: '#ff7fb0' },
    { sps: [ellipseSubPath(14, 14)], fill: '#ffcc00' },
  ] },
  { id: 'tag', name: 'Tag', parts: [{ d: 'M5 5 H45 L95 55 L55 95 L5 45 Z M22 22 C26 22 30 26 30 30 C30 34 26 38 22 38 C18 38 14 34 14 30 C14 26 18 22 22 22 Z', fill: '#00b8a9' }] },
  { id: 'gear', name: 'Gear', parts: [{ sps: [starSubPath(8, 48, 38)], fill: '#8e8e93' }, { sps: [ellipseSubPath(14, 14)], fill: '#ffffff' }] },
  { id: 'square', name: 'Rounded square', parts: [{ sps: [rectSubPath(80, 80, [16, 16, 16, 16])], fill: '#1da1f2' }] },
];

export interface SymbolLibraryEntry {
  id: string;
  name: string;
  build: () => SymbolDef;
}

function partSubPaths(p: LibItem['parts'][number]): SubPath[] {
  if (p.sps) return p.sps.map((sp) => ({ anchors: sp.anchors.map((a) => ({ ...a, point: { ...a.point }, handleIn: a.handleIn ? { ...a.handleIn } : null, handleOut: a.handleOut ? { ...a.handleOut } : null })), closed: sp.closed }));
  return parseSvgPathData(p.d ?? '');
}

function buildItem(item: LibItem): SymbolDef {
  const root = makeGroup([], { name: item.name });
  root.parent = null;
  const nodes: Record<ID, Node> = { [root.id]: root };
  const all: SubPath[][] = item.parts.map(partSubPaths);
  // normalise: centre the union bounds at 0,0 and scale the longest side to SIZE
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sps of all) {
    const b = pathBounds(sps);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);
  const k = (item.size ?? SIZE) / Math.max(w, h);
  const m = multiply(scale(k, k), translate(-(minX + w / 2), -(minY + h / 2)));
  item.parts.forEach((p, i) => {
    const fill: Paint = { type: 'solid', color: p.fill, opacity: 1 };
    const stroke = p.stroke ? defaultStroke({ paint: { type: 'solid', color: p.stroke, opacity: 1 }, width: (p.strokeWidth ?? 1) * k, join: 'round', cap: 'round' }) : noStroke();
    const node = makePath(transformSubPaths(all[i], m), { fill, stroke, name: `${item.name} ${i + 1}`, fillRule: 'evenodd' });
    node.parent = root.id;
    nodes[node.id] = node;
    root.children.push(node.id);
  });
  return { id: newId(), name: item.name, nodes, root: root.id, version: 1 };
}

export const SYMBOL_LIBRARY: SymbolLibraryEntry[] = ITEMS.map((item) => ({ id: item.id, name: item.name, build: () => buildItem(item) }));
