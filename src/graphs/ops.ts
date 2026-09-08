/**
 * Graph document operations: a graph is a group with `data.graph = spec`
 * (plus the frame size) whose children are regenerated from the data.
 */
import type { Document, ID, Node, GroupNode, Rect } from '@/model/types';
import { isContainer } from '@/model/types';
import { makeGroup } from '@/model/nodes';
import { addNode, removeNode, worldBounds } from '@/model/document';
import { multiply, invert, translate, decompose } from '@/geometry/matrix';
import { buildGraph, sampleSpec, DEFAULT_OPTIONS, type GraphSpec, type GraphType } from './build';

export interface GraphData {
  graph: GraphSpec;
  frame: { width: number; height: number };
}

export function isGraph(n: Node | undefined | null): n is GroupNode & { data: GraphData } {
  return !!n && n.type === 'group' && !!n.data && !!(n.data as { graph?: unknown }).graph;
}

export function graphOf(doc: Document, id: ID | null | undefined): ID | null {
  let cur: ID | null = id ?? null;
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (isGraph(doc.nodes[cur])) return cur;
    cur = doc.nodes[cur]?.parent ?? null;
  }
  return null;
}

export function graphSpec(doc: Document, id: ID): GraphSpec | null {
  const n = doc.nodes[id];
  return isGraph(n) ? n.data.graph : null;
}

function normalise(spec: GraphSpec): GraphSpec {
  const rows = spec.data.length;
  const cols = rows ? Math.max(0, ...spec.data.map((r) => r.length)) : 0;
  return {
    type: spec.type,
    data: spec.data.map((r) => Array.from({ length: cols }, (_, i) => Number(r[i] ?? 0) || 0)),
    categories: Array.from({ length: rows }, (_, i) => spec.categories[i] ?? `${i + 1}`),
    series: Array.from({ length: cols }, (_, i) => spec.series[i] ?? `Series ${i + 1}`),
    options: { ...DEFAULT_OPTIONS, ...spec.options, colors: spec.options?.colors?.length ? spec.options.colors : DEFAULT_OPTIONS.colors },
  };
}

/** Create a graph group whose frame is the world rectangle. */
export function createGraph(doc: Document, parent: ID | null, rect: Rect, spec: GraphSpec = sampleSpec()): ID | null {
  let p = parent;
  if (p === null || !doc.nodes[p] || !isContainer(doc.nodes[p])) p = doc.layers[doc.layers.length - 1] ?? null;
  if (p === null) return null;
  const g = makeGroup([], { name: 'Graph' });
  const s = normalise(spec);
  g.data = { graph: s, frame: { width: Math.max(10, rect.width), height: Math.max(10, rect.height) } };
  // group origin at the frame's top-left in the parent's space
  const pw = multiply(invert(parentWorld(doc, p)), translate(rect.x, rect.y));
  g.transform = pw;
  addNode(doc, g, p);
  regenerateGraph(doc, g.id);
  return g.id;
}

function parentWorld(doc: Document, id: ID): import('@/model/types').Matrix {
  const chain: import('@/model/types').Matrix[] = [];
  let n: Node | undefined = doc.nodes[id];
  while (n) {
    chain.push(n.transform);
    n = n.parent ? doc.nodes[n.parent] : undefined;
  }
  let m: import('@/model/types').Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, chain[i]);
  return m;
}

/** Rebuild the children of a graph group from its spec (optionally updating the spec first). */
export function regenerateGraph(doc: Document, id: ID, patch?: Partial<GraphSpec>): boolean {
  const g = doc.nodes[id];
  if (!isGraph(g)) return false;
  const spec = normalise({ ...g.data.graph, ...(patch ?? {}), options: { ...g.data.graph.options, ...(patch?.options ?? {}) } });
  g.data = { ...g.data, graph: spec };
  for (const c of [...g.children]) removeNode(doc, c);
  g.children = [];
  const frame = { x: 0, y: 0, width: g.data.frame.width, height: g.data.frame.height };
  for (const n of buildGraph(spec, frame)) addNode(doc, n, id);
  return true;
}

export function setGraphType(doc: Document, id: ID, type: GraphType): boolean {
  return regenerateGraph(doc, id, { type });
}

/** Adopt the current world size of the group as the new frame (after scaling) and rebuild. */
export function refitGraph(doc: Document, id: ID): boolean {
  const g = doc.nodes[id];
  if (!isGraph(g)) return false;
  const wb = worldBounds(doc, id);
  if (!wb) return false;
  const d = decompose(g.transform);
  g.data = { ...g.data, frame: { width: Math.max(10, wb.width / (Math.abs(d.scaleX) || 1)), height: Math.max(10, wb.height / (Math.abs(d.scaleY) || 1)) } };
  return regenerateGraph(doc, id);
}

/** Graph groups among the ids (or containing them). */
export function graphsOf(doc: Document, ids: ID[]): ID[] {
  return Array.from(new Set(ids.map((id) => graphOf(doc, id)).filter((g): g is ID => !!g)));
}
