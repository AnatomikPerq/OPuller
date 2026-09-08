/**
 * Pathfinder operations on world-space geometries (Illustrator semantics).
 * Input geoms are in paint order (bottom → top). Results describe new paths:
 * geometry + the id of the original whose appearance they inherit (+ optional
 * paint overrides). Pure: no store / document access.
 */
import type { ID, SubPath, FillRule, Paint, StrokeStyle } from '@/model/types';
import { pathBounds } from '@/geometry/path';
import {
  type PathGeom,
  type Geometry,
  filledGeometry,
  safeBoolean,
  safeUnion,
  unionGeometry,
  planarFaces,
  splitIslands,
  isEmptyGeometry,
  interiorPoint,
  geomAt,
  samePaint,
  faceArea,
  MIN_AREA,
} from './geometry';
import { splitAtIntersections } from './outline';

export type PathfinderOp = 'unite' | 'minusFront' | 'intersect' | 'exclude' | 'divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack';

export interface PathfinderResult {
  subpaths: SubPath[];
  fillRule: FillRule;
  /** id of the original path whose appearance is inherited */
  source: ID;
  fill?: Paint;
  stroke?: StrokeStyle;
  name?: string;
}

export interface PathfinderOutput {
  results: PathfinderResult[];
  /** wrap the results in a group (Illustrator does this for the "Pathfinders" row) */
  group: boolean;
}

export interface PathfinderDef {
  op: PathfinderOp;
  label: string;
  description: string;
  /** minimum number of paths */
  min: number;
  row: 'shape' | 'pathfinder';
}

export const PATHFINDER_OPS: PathfinderDef[] = [
  { op: 'unite', label: 'Unite', description: 'Merge all selected shapes into one path', min: 1, row: 'shape' },
  { op: 'minusFront', label: 'Minus Front', description: 'Subtract the front shapes from the back shape', min: 2, row: 'shape' },
  { op: 'intersect', label: 'Intersect', description: 'Keep only the area shared by all shapes', min: 2, row: 'shape' },
  { op: 'exclude', label: 'Exclude', description: 'Keep the non-overlapping areas (compound path)', min: 2, row: 'shape' },
  { op: 'divide', label: 'Divide', description: 'Split into all non-overlapping faces', min: 2, row: 'pathfinder' },
  { op: 'trim', label: 'Trim', description: 'Remove hidden parts, strokes are dropped', min: 2, row: 'pathfinder' },
  { op: 'merge', label: 'Merge', description: 'Like Trim, then unite adjacent faces of the same fill', min: 2, row: 'pathfinder' },
  { op: 'crop', label: 'Crop', description: 'Keep only what lies inside the front shape', min: 2, row: 'pathfinder' },
  { op: 'outline', label: 'Outline', description: 'Split outlines into open stroked edge segments', min: 2, row: 'pathfinder' },
  { op: 'minusBack', label: 'Minus Back', description: 'Subtract the back shapes from the front shape', min: 2, row: 'shape' },
];

export function pathfinderDef(op: PathfinderOp): PathfinderDef {
  return PATHFINDER_OPS.find((d) => d.op === op)!;
}

const NO_PAINT: Paint = { type: 'none' };

function noStroke(g: PathGeom): StrokeStyle {
  return { ...g.node.stroke, paint: { type: 'none' }, dash: [...g.node.stroke.dash] };
}

function fillColor(p: Paint): string {
  switch (p.type) {
    case 'solid':
      return p.color;
    case 'linear':
    case 'radial':
      return p.stops[0]?.color ?? '#000000';
    default:
      return '#000000';
  }
}

function nonEmpty(subpaths: SubPath[]): boolean {
  return !isEmptyGeometry(subpaths, MIN_AREA);
}

function above(geoms: PathGeom[], i: number): Geometry[] {
  return geoms.slice(i + 1).map(filledGeometry);
}

function below(geoms: PathGeom[], i: number): Geometry[] {
  return geoms.slice(0, i).map(filledGeometry);
}

/** Run a pathfinder operation. `geoms` must be in paint order (bottom first). */
export function runPathfinder(op: PathfinderOp, geoms: PathGeom[]): PathfinderOutput {
  const list = geoms.filter((g) => g.subpaths.length);
  if (!list.length) return { results: [], group: false };
  const top = list[list.length - 1];
  const bottom = list[0];
  switch (op) {
    case 'unite': {
      const sps = safeUnion(list.map(filledGeometry));
      return { results: nonEmpty(sps) ? [{ subpaths: sps, fillRule: 'nonzero', source: top.id }] : [], group: false };
    }
    case 'minusFront': {
      if (list.length < 2) return { results: [], group: false };
      const sps = safeBoolean('subtract', filledGeometry(bottom), unionGeometry(above(list, 0)));
      return { results: nonEmpty(sps) ? [{ subpaths: sps, fillRule: 'nonzero', source: bottom.id }] : [], group: false };
    }
    case 'minusBack': {
      if (list.length < 2) return { results: [], group: false };
      const sps = safeBoolean('subtract', filledGeometry(top), unionGeometry(below(list, list.length - 1)));
      return { results: nonEmpty(sps) ? [{ subpaths: sps, fillRule: 'nonzero', source: top.id }] : [], group: false };
    }
    case 'intersect': {
      if (list.length < 2) return { results: [], group: false };
      let acc: Geometry = filledGeometry(list[0]);
      for (let i = 1; i < list.length; i++) {
        acc = { subpaths: safeBoolean('intersect', acc, filledGeometry(list[i])), fillRule: 'nonzero' };
        if (!acc.subpaths.length) break;
      }
      return { results: nonEmpty(acc.subpaths) ? [{ subpaths: acc.subpaths, fillRule: 'nonzero', source: top.id }] : [], group: false };
    }
    case 'exclude': {
      if (list.length < 2) return { results: [], group: false };
      let acc: Geometry = filledGeometry(list[0]);
      for (let i = 1; i < list.length; i++) {
        acc = { subpaths: safeBoolean('exclude', acc, filledGeometry(list[i])), fillRule: 'evenodd' };
      }
      return { results: nonEmpty(acc.subpaths) ? [{ subpaths: acc.subpaths, fillRule: 'evenodd', source: top.id }] : [], group: false };
    }
    case 'divide': {
      if (list.length < 2) return { results: [], group: false };
      const faces = planarFaces(list.map(filledGeometry));
      const results: PathfinderResult[] = [];
      for (const face of faces) {
        const src = geomAt(list, interiorPoint(face)) ?? top;
        results.push({ subpaths: face, fillRule: 'evenodd', source: src.id });
      }
      return { results: sortResults(results, list), group: true };
    }
    case 'trim': {
      if (list.length < 2) return { results: [], group: false };
      const results: PathfinderResult[] = [];
      list.forEach((g, i) => {
        const ab = above(list, i);
        const sps = ab.length ? safeBoolean('subtract', filledGeometry(g), unionGeometry(ab)) : filledGeometry(g).subpaths;
        if (nonEmpty(sps)) results.push({ subpaths: sps, fillRule: 'nonzero', source: g.id, stroke: noStroke(g) });
      });
      return { results, group: true };
    }
    case 'merge': {
      if (list.length < 2) return { results: [], group: false };
      const trimmed: PathfinderResult[] = [];
      list.forEach((g, i) => {
        const ab = above(list, i);
        const sps = ab.length ? safeBoolean('subtract', filledGeometry(g), unionGeometry(ab)) : filledGeometry(g).subpaths;
        if (nonEmpty(sps)) trimmed.push({ subpaths: sps, fillRule: 'nonzero', source: g.id, stroke: noStroke(g) });
      });
      // unite pieces sharing the same fill, then split into touching islands
      const results: PathfinderResult[] = [];
      const used = new Set<number>();
      trimmed.forEach((r, i) => {
        if (used.has(i)) return;
        const fill = geoms.find((g) => g.id === r.source)!.node.fill;
        const same = trimmed.filter((o, j) => j >= i && !used.has(j) && samePaint(fill, geoms.find((g) => g.id === o.source)!.node.fill));
        same.forEach((o) => used.add(trimmed.indexOf(o)));
        const merged = same.length > 1 ? safeUnion(same.map((o) => ({ subpaths: o.subpaths, fillRule: o.fillRule }))) : r.subpaths;
        for (const island of splitIslands(merged)) results.push({ subpaths: island, fillRule: 'nonzero', source: r.source, stroke: r.stroke });
      });
      return { results, group: true };
    }
    case 'crop': {
      if (list.length < 2) return { results: [], group: false };
      const clip = filledGeometry(top);
      const results: PathfinderResult[] = [];
      for (let i = 0; i < list.length - 1; i++) {
        const g = list[i];
        const sps = safeBoolean('intersect', filledGeometry(g), clip);
        if (nonEmpty(sps)) results.push({ subpaths: sps, fillRule: 'nonzero', source: g.id, stroke: noStroke(g) });
      }
      return { results, group: true };
    }
    case 'outline': {
      if (list.length < 2) return { results: [], group: false };
      const results: PathfinderResult[] = [];
      list.forEach((g, i) => {
        const others = list.filter((_, j) => j !== i).map((o) => o.subpaths);
        const color = fillColor(g.node.fill);
        const stroke: StrokeStyle = { ...g.node.stroke, paint: { type: 'solid', color, opacity: 1 }, width: 1, dash: [], widthProfile: undefined, markerStart: 'none', markerEnd: 'none' };
        for (const sp of g.subpaths) {
          for (const piece of splitAtIntersections(sp, others)) {
            if (piece.anchors.length < 2) continue;
            const b = pathBounds([piece]);
            if (!b) continue;
            results.push({ subpaths: [piece], fillRule: 'nonzero', source: g.id, fill: NO_PAINT, stroke });
          }
        }
      });
      return { results, group: true };
    }
  }
}

/** Order faces bottom→top by their source's paint order, then by area (big first) for stable output. */
function sortResults(results: PathfinderResult[], geoms: PathGeom[]): PathfinderResult[] {
  const order = new Map(geoms.map((g, i) => [g.id, i]));
  return results
    .map((r, i) => ({ r, i, o: order.get(r.source) ?? 0, a: faceArea(r.subpaths) }))
    .sort((x, y) => x.o - y.o || y.a - x.a || x.i - y.i)
    .map((x) => x.r);
}
