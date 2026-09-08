/**
 * Sample document: a bird logo built from circles with Pathfinder operations
 * (unite / minus front / intersect). The construction circles are kept on a
 * locked "Construction" layer so the technique can be studied and re-done.
 */
import type { Document, SubPath, ID } from '@/model/types';
import { createDocument, makePath, makeShape, makeLayer, makeText } from '@/model/nodes';
import { addNode, setWorldSubPaths } from '@/model/document';
import { liveShapeSubPaths } from '@/geometry/shapes';
import { transformSubPaths } from '@/geometry/path';
import { translate } from '@/geometry/matrix';
import { booleanOp, uniteAll } from '@/geometry/paperBridge';
import { defaultStroke } from '@/model/defaults';

interface Circle {
  name: string;
  cx: number;
  cy: number;
  r: number;
  role: 'add' | 'cut' | 'lens';
}

/** Construction circles (world units, artboard 1000 × 1000). */
export const BIRD_CIRCLES: Circle[] = [
  { name: '1 · Body', cx: 470, cy: 560, r: 190, role: 'add' },
  { name: '2 · Breast', cx: 600, cy: 440, r: 160, role: 'add' },
  { name: '3 · Head', cx: 630, cy: 320, r: 115, role: 'add' },
  { name: '4 · Beak A', cx: 780.0, cy: 200.0, r: 170.0, role: 'lens' },
  { name: '5 · Beak B', cx: 780.0, cy: 500.0, r: 170.0, role: 'lens' },
  { name: '6 · Tail A', cx: 351.4, cy: 909.5, r: 179.9, role: 'lens' },
  { name: '7 · Tail B', cx: 233.6, cy: 655.5, r: 179.9, role: 'lens' },
  { name: '8 · Feather 1 A', cx: 277.7, cy: 702.5, r: 167.3, role: 'lens' },
  { name: '9 · Feather 1 B', cx: 322.3, cy: 457.5, r: 167.3, role: 'lens' },
  { name: '10 · Feather 2 A', cx: 272.2, cy: 596.0, r: 166.2, role: 'lens' },
  { name: '11 · Feather 2 B', cx: 362.8, cy: 364.0, r: 166.2, role: 'lens' },
  { name: '12 · Feather 3 A', cx: 282.1, cy: 492.7, r: 163.6, role: 'lens' },
  { name: '13 · Feather 3 B', cx: 422.9, cy: 287.3, r: 163.6, role: 'lens' },
];

function circle(cx: number, cy: number, r: number): SubPath[] {
  return transformSubPaths(liveShapeSubPaths({ kind: 'ellipse', rx: r, ry: r }), translate(cx, cy));
}

const geom = (sps: SubPath[]) => ({ subpaths: sps, fillRule: 'nonzero' as const });

/** The bird outline in world coordinates (computed with the geometry kernel). */
export function buildBirdGeometry(): SubPath[] {
  const c = (i: number) => {
    const k = BIRD_CIRCLES[i - 1];
    return circle(k.cx, k.cy, k.r);
  };
  const lens = (a: number, b: number) => booleanOp('intersect', geom(c(a)), geom(c(b)));
  // body + breast + head, then the pointed parts as lenses (intersections of circle pairs)
  const parts = [c(1), c(2), c(3), lens(4, 5), lens(6, 7), lens(8, 9), lens(10, 11), lens(12, 13)];
  return uniteAll(parts.map(geom));
}

export function twitterBirdSample(): Document {
  const doc = createDocument({ name: 'Bird from circles', width: 1000, height: 1000, background: '#ffffff' });
  const layer0 = doc.layers[0];
  const layer = doc.nodes[layer0];
  layer.name = 'Bird';

  // construction layer (below the bird)
  const construction = makeLayer({ name: 'Construction (circles)', color: '#8e8e93' }, 1);
  construction.locked = true;
  doc.nodes[construction.id] = construction;
  doc.layers.unshift(construction.id);
  BIRD_CIRCLES.forEach((k) => {
    const n = makeShape(
      { kind: 'ellipse', rx: k.r, ry: k.r },
      {
        name: k.name,
        fill: k.role === 'cut' ? { type: 'solid', color: '#ff6b6b', opacity: 0.08 } : k.role === 'lens' ? { type: 'solid', color: '#ffd166', opacity: 0.1 } : { type: 'solid', color: '#1da1f2', opacity: 0.08 },
        stroke: defaultStroke({ paint: { type: 'solid', color: k.role === 'cut' ? '#e0245e' : k.role === 'lens' ? '#c98a00' : '#1da1f2', opacity: 0.9 }, width: 1.5, dash: k.role === 'add' ? [] : [6, 4] }),
        transform: translate(k.cx, k.cy),
      },
    );
    addNode(doc, n, construction.id);
  });

  // the bird
  const bird = makePath([], { name: 'Bird', fill: { type: 'solid', color: '#1da1f2', opacity: 1 }, stroke: defaultStroke({ paint: { type: 'none' } }) });
  addNode(doc, bird, layer0);
  setWorldSubPaths(doc, bird.id, buildBirdGeometry());

  // caption
  const caption = makeText('13 circles + Pathfinder = bird\nSelect circles, then use Unite / Minus Front / Intersect — or the Shape Builder (Shift+M).', {
    style: { fontFamily: 'Inter', fontSize: 22, lineHeight: 1.35, textAlign: 'left' },
    fill: { type: 'solid', color: '#48484a', opacity: 1 },
    transform: translate(60, 60),
    name: 'Caption',
  });
  addNode(doc, caption, layer0);
  return doc;
}

export function birdCircleIds(doc: Document): ID[] {
  return Object.values(doc.nodes)
    .filter((n) => n.type === 'path' && n.shape?.kind === 'ellipse')
    .map((n) => n.id);
}
