/**
 * Pattern operations: build a pattern from artwork, edit its tiling options,
 * expand a pattern fill into real tiles, and the tile group used by the
 * pattern editing mode. All functions mutate an immer draft.
 */
import type { Document, ID, Node, PatternDef, PatternLayout, PathNode, Rect, HexColor, Swatch, Paint } from '@/model/types';
import { isContainer } from '@/model/types';
import { makeGroup, makePath, makeShape, newId } from '@/model/nodes';
import { addNode, addSubtree, cloneSubtree, deepClone, worldMatrix, worldBounds, sortByPaintOrder, topmostOf, removeNode, indexInParent, worldSubPaths, parentWorldMatrix, localBounds } from '@/model/document';
import { multiply, translate, identity, invert, rotate, scale as scaleM, compose } from '@/geometry/matrix';
import { rectUnion } from '@/geometry/vec';
import { noStroke, defaultStroke } from '@/model/defaults';
import { tilesCovering } from './tile';
import { refreshPatternSvg, patternDocument } from './refresh';

export function getPattern(doc: Document, id: ID | null | undefined): PatternDef | undefined {
  return id ? doc.patterns.find((p) => p.id === id) : undefined;
}

export function uniquePatternName(doc: Document, base: string): string {
  const names = new Set(doc.patterns.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
  return base;
}

export interface MakePatternOptions {
  name?: string;
  layout?: PatternLayout;
  offset?: number;
  spacing?: { x: number; y: number };
  background?: HexColor | null;
  /** explicit tile size (defaults to the artwork bounds) */
  width?: number;
  height?: number;
  /** remove the source artwork (default false: Illustrator keeps it) */
  consume?: boolean;
}

/**
 * Build a pattern from world-space nodes. The tile origin is the top-left of
 * the artwork bounds; the artwork is copied into tile space.
 */
export function patternFromNodes(doc: Document, ids: ID[], opts: MakePatternOptions = {}): PatternDef | null {
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  if (!members.length) return null;
  let bounds: Rect | null = null;
  for (const id of members) bounds = rectUnion(bounds, worldBounds(doc, id));
  if (!bounds) return null;
  const root = makeGroup([], { name: opts.name ?? 'Pattern' });
  root.parent = null;
  root.transform = identity();
  const nodes: Record<ID, Node> = { [root.id]: root };
  const toTile = translate(-bounds.x, -bounds.y);
  for (const id of members) {
    const { root: copy, nodes: all } = cloneSubtree(doc, id);
    copy.transform = multiply(toTile, worldMatrix(doc, id));
    copy.parent = root.id;
    for (const n of all) nodes[n.id] = n;
    root.children.push(copy.id);
  }
  const def: PatternDef = {
    id: newId(),
    name: uniquePatternName(doc, opts.name ?? 'New Pattern'),
    width: Math.max(1, opts.width ?? bounds.width),
    height: Math.max(1, opts.height ?? bounds.height),
    svg: '',
    nodes,
    root: root.id,
    layout: opts.layout ?? 'grid',
    offset: opts.offset ?? 0.5,
    spacing: opts.spacing ?? { x: 0, y: 0 },
    background: opts.background ?? null,
  };
  refreshPatternSvg(doc, def);
  return def;
}

/** Add a pattern built from the nodes plus a swatch for it. Returns the definition and swatch. */
export function makePattern(doc: Document, ids: ID[], opts: MakePatternOptions = {}): { def: PatternDef; swatch: Swatch } | null {
  const def = patternFromNodes(doc, ids, opts);
  if (!def) return null;
  doc.patterns.push(def);
  const swatch = patternSwatch(def);
  doc.swatches.push(swatch);
  if (opts.consume) {
    for (const id of sortByPaintOrder(doc, topmostOf(doc, ids))) if (doc.nodes[id] && doc.nodes[id].type !== 'layer') removeNode(doc, id);
  }
  return { def, swatch };
}

export function patternSwatch(def: PatternDef): Swatch {
  return { id: newId(), name: def.name, paint: { type: 'pattern', patternId: def.id, scale: 1, angle: 0 } };
}

export function patternPaint(def: PatternDef): Paint {
  return { type: 'pattern', patternId: def.id, scale: 1, angle: 0 };
}

/** Add a definition (e.g. from a library) with a swatch. */
export function addPatternDef(doc: Document, def: PatternDef, withSwatch = true): PatternDef {
  const copy: PatternDef = { ...deepClone(def), id: newId(), name: uniquePatternName(doc, def.name) };
  doc.patterns.push(copy);
  if (withSwatch) doc.swatches.push(patternSwatch(copy));
  return copy;
}

export type PatternOptionsPatch = Partial<Pick<PatternDef, 'name' | 'width' | 'height' | 'layout' | 'offset' | 'spacing' | 'background'>>;

/** Update tiling options and regenerate the cell markup. */
export function updatePatternOptions(doc: Document, id: ID, patch: PatternOptionsPatch): PatternDef | null {
  const def = getPattern(doc, id);
  if (!def) return null;
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n && n !== def.name) {
      def.name = uniquePatternName(doc, n);
      for (const sw of doc.swatches) if (sw.paint.type === 'pattern' && sw.paint.patternId === id) sw.name = def.name;
    }
  }
  if (patch.width !== undefined) def.width = Math.max(1, patch.width);
  if (patch.height !== undefined) def.height = Math.max(1, patch.height);
  if (patch.layout !== undefined) def.layout = patch.layout;
  if (patch.offset !== undefined) def.offset = Math.max(0, Math.min(1, patch.offset));
  if (patch.spacing !== undefined) def.spacing = { x: patch.spacing.x, y: patch.spacing.y };
  if (patch.background !== undefined) def.background = patch.background;
  refreshPatternSvg(doc, def);
  return def;
}

export function deletePattern(doc: Document, id: ID): void {
  doc.patterns = doc.patterns.filter((p) => p.id !== id);
  doc.swatches = doc.swatches.filter((sw) => !(sw.paint.type === 'pattern' && sw.paint.patternId === id));
  // objects painted with it fall back to a neutral solid
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'path' && n.type !== 'text') continue;
    if (n.fill.type === 'pattern' && n.fill.patternId === id) n.fill = { type: 'solid', color: '#8e8e93', opacity: 1 };
    if (n.stroke.paint.type === 'pattern' && n.stroke.paint.patternId === id) n.stroke = { ...n.stroke, paint: { type: 'solid', color: '#8e8e93', opacity: 1 } };
  }
}

/** Nodes (path/text) painted with the pattern. */
export function nodesUsingPattern(doc: Document, id: ID): ID[] {
  const out: ID[] = [];
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'path' && n.type !== 'text') continue;
    if ((n.fill.type === 'pattern' && n.fill.patternId === id) || (n.stroke.paint.type === 'pattern' && n.stroke.paint.patternId === id)) out.push(n.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editing tile group
// ---------------------------------------------------------------------------

export const TILE_MARK = 'patternTile';

/**
 * Place the tile artwork on the canvas as a group (with a tile-bounds rectangle)
 * for editing in isolation mode. The group carries `data.patternEdit = { id }`.
 */
export function createTileGroup(doc: Document, def: PatternDef, at: { x: number; y: number }, parentId: ID | null): ID | null {
  let parent = parentId;
  if (parent === null || !doc.nodes[parent] || !isContainer(doc.nodes[parent])) parent = doc.layers[doc.layers.length - 1] ?? null;
  if (parent === null) return null;
  const g = makeGroup([], { name: `${def.name} (editing)` });
  g.data = { patternEdit: { id: def.id } };
  g.transform = multiply(invert(worldMatrix(doc, parent)), translate(at.x - def.width / 2, at.y - def.height / 2));
  addNode(doc, g, parent);
  // tile bounds: an unfilled rectangle the user may resize to change the tile
  const tile = makeShape({ kind: 'rect', width: def.width, height: def.height, radii: [0, 0, 0, 0] }, { name: 'Pattern Tile', fill: { type: 'none' }, stroke: defaultStroke({ paint: { type: 'solid', color: '#4a90e2', opacity: 1 }, width: 1, dash: [4, 3] }) });
  tile.data = { [TILE_MARK]: true };
  addNode(doc, tile, g.id);
  const view = patternDocument(doc, def);
  if (view && def.root) {
    const root = def.nodes![def.root];
    if (root && isContainer(root)) {
      for (const cid of root.children) {
        const { root: copy, nodes } = cloneSubtree(view, cid);
        addSubtree(doc, copy, nodes, g.id);
      }
    }
  }
  return g.id;
}

export function isTileGroup(n: Node | undefined | null): n is Node & { type: 'group'; data: { patternEdit: { id: ID } } } {
  return !!n && n.type === 'group' && !!n.data && !!(n.data as { patternEdit?: unknown }).patternEdit;
}

/**
 * Take the artwork of a tile group back into the pattern definition (tile
 * rectangle → tile size, other children → artwork in tile space) and remove
 * the group. Returns the updated definition.
 */
export function commitTileGroup(doc: Document, groupId: ID): PatternDef | null {
  const g = doc.nodes[groupId];
  if (!isTileGroup(g)) return null;
  const def = getPattern(doc, g.data.patternEdit.id);
  if (!def) return null;
  const tileId = g.children.find((c) => !!doc.nodes[c]?.data && !!(doc.nodes[c].data as Record<string, unknown>)[TILE_MARK]);
  let origin = { x: 0, y: 0 };
  if (tileId) {
    const t = doc.nodes[tileId] as PathNode;
    const b = t.shape && t.shape.kind === 'rect' ? { x: 0, y: 0, width: t.shape.width, height: t.shape.height } : localBounds(doc, tileId);
    if (b) {
      const m = t.transform;
      origin = { x: b.x * m.a + b.y * m.c + m.e, y: b.x * m.b + b.y * m.d + m.f };
      def.width = Math.max(1, b.width * Math.hypot(m.a, m.b));
      def.height = Math.max(1, b.height * Math.hypot(m.c, m.d));
    }
  }
  const root = makeGroup([], { name: def.name });
  root.parent = null;
  const nodes: Record<ID, Node> = { [root.id]: root };
  const toTile = translate(-origin.x, -origin.y);
  for (const cid of g.children) {
    if (cid === tileId) continue;
    const { root: copy, nodes: all } = cloneSubtree(doc, cid);
    copy.transform = multiply(toTile, copy.transform);
    copy.parent = root.id;
    for (const n of all) nodes[n.id] = n;
    root.children.push(copy.id);
  }
  def.nodes = nodes;
  def.root = root.id;
  refreshPatternSvg(doc, def);
  removeNode(doc, groupId);
  return def;
}

// ---------------------------------------------------------------------------
// Expand a pattern fill into real tiles
// ---------------------------------------------------------------------------

/**
 * Replace a pattern-filled path with a clipping group containing the tile
 * copies that cover its bounds. Returns the group id.
 */
export function expandPatternFill(doc: Document, nodeId: ID): ID | null {
  const n = doc.nodes[nodeId];
  if (!n || n.type !== 'path' || n.fill.type !== 'pattern') return null;
  const def = getPattern(doc, n.fill.patternId);
  if (!def || !def.nodes || !def.root) return null;
  const view = patternDocument(doc, def)!;
  const paint = n.fill;
  const parentId = n.parent;
  const index = indexInParent(doc, nodeId);
  const bounds = worldBounds(doc, nodeId);
  if (!bounds) return null;
  const clip = makePath(worldSubPaths(doc, nodeId), { name: n.name, fill: { type: 'none' }, stroke: noStroke(), fillRule: n.fillRule });
  const group = makeGroup([], { name: `${n.name} (pattern)`, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects });
  const pw = parentWorldMatrix(doc, nodeId);
  const inv = invert(pw);
  group.transform = identity();
  addNode(doc, group, parentId, index + 1);
  clip.transform = inv;
  addNode(doc, clip, group.id);
  group.clipId = clip.id;
  // pattern space: rotate/scale about the origin, then offset, like the SVG patternTransform
  const pm = compose(inv, translate(paint.x ?? 0, paint.y ?? 0), rotate(paint.angle), scaleM(paint.scale, paint.scale));
  const root = def.nodes[def.root];
  const rootChildren = root && isContainer(root) ? root.children : [];
  // bounds expressed in pattern space to know which tiles are needed
  const invPattern = invert(compose(translate(paint.x ?? 0, paint.y ?? 0), rotate(paint.angle), scaleM(paint.scale, paint.scale)));
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ].map((c) => ({ x: c.x * invPattern.a + c.y * invPattern.c + invPattern.e, y: c.x * invPattern.b + c.y * invPattern.d + invPattern.f }));
  const pb = { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)), width: 0, height: 0 };
  pb.width = Math.max(...corners.map((c) => c.x)) - pb.x;
  pb.height = Math.max(...corners.map((c) => c.y)) - pb.y;
  const tiles = tilesCovering(def, pb, 1);
  for (const t of tiles) {
    // cull tiles fully outside the pattern-space bounds
    if (t.x + def.width < pb.x || t.x > pb.x + pb.width || t.y + def.height < pb.y || t.y > pb.y + pb.height) continue;
    if (def.background) {
      const bg = makeShape({ kind: 'rect', width: def.width, height: def.height, radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: def.background, opacity: 1 }, stroke: noStroke(), name: 'Tile background' });
      bg.transform = multiply(pm, translate(t.x, t.y));
      addNode(doc, bg, group.id);
    }
    for (const cid of rootChildren) {
      const { root: copy, nodes } = cloneSubtree(view, cid);
      copy.transform = multiply(multiply(pm, translate(t.x, t.y)), copy.transform);
      addSubtree(doc, copy, nodes, group.id);
    }
  }
  // stroke stays on a copy of the original path on top
  if (n.stroke.paint.type !== 'none' && n.stroke.width > 0) {
    const strokeCopy = makePath(worldSubPaths(doc, nodeId), { name: `${n.name} stroke`, fill: { type: 'none' }, stroke: deepClone(n.stroke), fillRule: n.fillRule });
    strokeCopy.transform = inv;
    addNode(doc, strokeCopy, group.id);
  }
  removeNode(doc, nodeId);
  return group.id;
}
