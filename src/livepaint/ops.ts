/**
 * Live Paint groups: the selected paths are split into their planar faces
 * (fillable regions) and edges (strokable pieces between intersections). The
 * group carries `data.livePaint`; the bucket tool paints faces / edges.
 */
import type { Document, ID, Node, SubPath, GroupNode, Paint, StrokeStyle } from '@/model/types';
import { makeGroup, makePath, clonePaint, cloneStroke } from '@/model/nodes';
import { addNode, removeNode, groupNodes, ungroupNode, worldSubPaths, sortByPaintOrder, topmostOf, setWorldSubPaths, descendants } from '@/model/document';
import { computeFaceSet } from '@/pathops/faces';
import { splitAtIntersections } from '@/pathops/outline';
import { noStroke } from '@/model/defaults';

export const LIVE_PAINT = 'livePaint';

export function isLivePaintGroup(n: Node | undefined | null): n is GroupNode {
  return !!n && n.type === 'group' && !!n.data && !!(n.data as Record<string, unknown>)[LIVE_PAINT];
}

/** The live paint group containing the node (or the node itself). */
export function livePaintGroupOf(doc: Document, id: ID | null | undefined): ID | null {
  let cur: ID | null = id ?? null;
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (isLivePaintGroup(doc.nodes[cur])) return cur;
    cur = doc.nodes[cur]?.parent ?? null;
  }
  return null;
}

export function isFace(n: Node | undefined | null): boolean {
  return !!n && n.type === 'path' && !!n.data && (n.data as Record<string, unknown>).lpKind === 'face';
}

export function isEdge(n: Node | undefined | null): boolean {
  return !!n && n.type === 'path' && !!n.data && (n.data as Record<string, unknown>).lpKind === 'edge';
}

/**
 * Convert the selected paths into a Live Paint group. Faces take the fill of
 * the top-most source covering them; edges take the stroke of their source
 * (a default thin black stroke when the source has none).
 */
export function makeLivePaint(doc: Document, ids: ID[]): ID | null {
  const paths = sortByPaintOrder(doc, topmostOf(doc, ids)).flatMap((id) => descendants(doc, id, true)).filter((id) => doc.nodes[id]?.type === 'path');
  const unique = Array.from(new Set(paths));
  if (!unique.length) return null;
  const set = computeFaceSet(doc, unique);
  // edges: every source subpath split at intersections with the others
  const edges: Array<{ sps: SubPath[]; stroke: StrokeStyle; source: ID }> = [];
  const geoms = set.geoms.length ? set.geoms : unique.map((id) => ({ id, subpaths: worldSubPaths(doc, id) }));
  for (const g of geoms) {
    const node = doc.nodes[g.id];
    if (!node || node.type !== 'path') continue;
    const others = geoms.filter((o) => o.id !== g.id).map((o) => o.subpaths);
    const stroke = node.stroke.paint.type !== 'none' && node.stroke.width > 0 ? cloneStroke(node.stroke) : cloneStroke({ ...noStroke(), paint: { type: 'solid', color: '#000000', opacity: 1 }, width: 1 });
    for (const sp of g.subpaths) {
      let pieces: SubPath[];
      try {
        pieces = others.length ? splitAtIntersections(sp, others) : [sp];
      } catch {
        pieces = [sp];
      }
      for (const piece of pieces) edges.push({ sps: [piece], stroke, source: g.id });
    }
  }
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  const top = members[members.length - 1];
  const parent = doc.nodes[top].parent;
  const g = makeGroup([], { name: 'Live Paint' });
  g.data = { [LIVE_PAINT]: true };
  const gid = groupNodes(doc, members, g);
  if (!gid) return null;
  const group = doc.nodes[gid] as GroupNode;
  // replace the members by faces + edges
  const fills = new Map<ID, Paint>();
  for (const id of unique) {
    const n = doc.nodes[id];
    if (n && n.type === 'path') fills.set(id, clonePaint(n.fill));
  }
  for (const c of [...group.children]) removeNode(doc, c);
  if (set.faces.length) {
    set.faces.forEach((f, i) => {
      const fill = fills.get(f.source) ?? { type: 'none' };
      const p = makePath([], { name: `Face ${i + 1}`, fill: clonePaint(fill), stroke: noStroke(), fillRule: 'evenodd' });
      p.data = { lpKind: 'face' };
      addNode(doc, p, gid);
      setWorldSubPaths(doc, p.id, f.subpaths);
    });
  } else {
    // a single path (no intersections): its filled area is the only face
    for (const g2 of geoms) {
      const fill = fills.get(g2.id) ?? { type: 'none' };
      const p = makePath([], { name: 'Face 1', fill: clonePaint(fill), stroke: noStroke(), fillRule: 'nonzero' });
      p.data = { lpKind: 'face' };
      addNode(doc, p, gid);
      setWorldSubPaths(doc, p.id, g2.subpaths.map((sp) => ({ ...sp, closed: true })));
    }
  }
  edges.forEach((e, i) => {
    const p = makePath([], { name: `Edge ${i + 1}`, fill: { type: 'none' }, stroke: e.stroke });
    p.data = { lpKind: 'edge' };
    addNode(doc, p, gid);
    setWorldSubPaths(doc, p.id, e.sps);
  });
  void parent;
  return gid;
}

/** Release: the faces and edges become ordinary paths (the group is removed). */
export function releaseLivePaint(doc: Document, gid: ID): ID[] {
  const g = doc.nodes[gid];
  if (!isLivePaintGroup(g)) return [];
  for (const c of g.children) {
    const n = doc.nodes[c];
    if (n && n.data) {
      const { lpKind: _k, ...rest } = n.data as Record<string, unknown>;
      if (Object.keys(rest).length) n.data = rest;
      else delete n.data;
    }
  }
  return ungroupNode(doc, gid);
}

/** Expand: keep the group, drop the live paint behaviour. */
export function expandLivePaint(doc: Document, gid: ID): boolean {
  const g = doc.nodes[gid];
  if (!isLivePaintGroup(g)) return false;
  delete g.data;
  for (const c of g.children) {
    const n = doc.nodes[c];
    if (n && n.data) {
      const { lpKind: _k, ...rest } = n.data as Record<string, unknown>;
      if (Object.keys(rest).length) n.data = rest;
      else delete n.data;
    }
  }
  g.name = 'Group';
  return true;
}

/** Faces and edges of a group. */
export function livePaintParts(doc: Document, gid: ID): { faces: ID[]; edges: ID[] } {
  const g = doc.nodes[gid];
  const faces: ID[] = [];
  const edges: ID[] = [];
  if (!isLivePaintGroup(g)) return { faces, edges };
  for (const c of g.children) {
    const n = doc.nodes[c];
    if (isFace(n)) faces.push(c);
    else if (isEdge(n)) edges.push(c);
  }
  return { faces, edges };
}
