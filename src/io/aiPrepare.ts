/**
 * Prepares a document for the Illustrator (AI 8) exporter: the format has no
 * brushes, patterns, live effects, variable-width strokes or text on a path,
 * so those are expanded into plain artwork on a copy of the document, text
 * that cannot stay editable is converted to outlines and raster images are
 * decoded. Browser only (uses the appearance expanders, opentype fonts and a
 * canvas); the exporter itself (aiExport.ts) stays pure.
 */
import type { Document, ID, Node, PathNode, TextNode } from '@/model/types';
import { isContainer } from '@/model/types';
import { deepClone, descendants, addNode, removeNode, indexInParent } from '@/model/document';
import { makeGroup, makePath, clonePaint, cloneStroke } from '@/model/nodes';
import { noStroke } from '@/model/defaults';
import { expandAppearance } from '@/appearance/expand';
import { expandPatternFill } from '@/patterns/ops';
import { variableWidthOutlines } from '@/geometry/widthProfile';
import { effectiveSubPaths } from '@/canvas/effectiveGeometry';
import { textToOutlinePaths } from '@/text/outline';
import { prepareRasterImages } from './rasterHex';
import { isEncodable } from './aiExport';

/** 'auto' keeps ASCII text editable and outlines the rest; 'editable' keeps every text object (see AiOptions.encoding); 'outlines' converts all text. */
export type AiTextMode = 'auto' | 'editable' | 'outlines';

export interface AiPrepareOptions {
  /** restrict the work to these subtrees (selection export) */
  ids?: ID[];
  textMode?: AiTextMode;
  encoding?: 'latin1' | 'cp1251';
}

export interface AiPrepareResult {
  doc: Document;
  /** text objects that could not be outlined (kept editable) */
  failed: string[];
  warnings: string[];
}

function scopeIds(doc: Document, ids?: ID[]): ID[] {
  if (!ids) return Object.keys(doc.nodes).filter((id) => doc.nodes[id].type !== 'layer');
  const out = new Set<ID>();
  for (const id of ids) {
    if (!doc.nodes[id]) continue;
    out.add(id);
    for (const d of descendants(doc, id)) out.add(d);
  }
  return Array.from(out);
}

/** Replace a variable-width stroke by its filled outline (a group when the path is also filled). */
function expandWidthProfile(doc: Document, id: ID): void {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path' || !n.stroke.widthProfile?.length || n.stroke.paint.type === 'none' || n.stroke.width <= 0) return;
  const outline = variableWidthOutlines(effectiveSubPaths(n), n.stroke.widthProfile, n.stroke.width);
  if (!outline.length) return;
  const strokePath = makePath(outline, { name: `${n.name} (stroke)`, fill: clonePaint(n.stroke.paint), stroke: noStroke(), fillRule: 'nonzero' });
  if (n.fill.type === 'none') {
    strokePath.transform = n.transform;
    strokePath.locked = n.locked;
    strokePath.visible = n.visible;
    strokePath.name = n.name;
    const parent = n.parent;
    const index = indexInParent(doc, id);
    removeNode(doc, id);
    addNode(doc, strokePath, parent, index);
    return;
  }
  const g = makeGroup([], { name: n.name, transform: n.transform, visible: n.visible, locked: n.locked, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects });
  const parent = n.parent;
  const index = indexInParent(doc, id);
  const fillPath = makePath(effectiveSubPaths(n), { name: n.name, fill: clonePaint(n.fill), stroke: noStroke(), fillRule: n.fillRule });
  removeNode(doc, id);
  addNode(doc, g, parent, index);
  addNode(doc, fillPath, g.id);
  addNode(doc, strokePath, g.id);
}

function needsOutline(doc: Document, t: TextNode, mode: AiTextMode, encoding: 'latin1' | 'cp1251'): boolean {
  if (mode === 'outlines') return true;
  if (t.kind === 'path' && t.pathId && doc.nodes[t.pathId]) return true;
  if (t.fill.type !== 'none' && t.fill.type !== 'solid') return true;
  if (t.stroke.paint.type !== 'none' && t.stroke.paint.type !== 'solid') return true;
  if (t.stroke.paint.type !== 'none' && (t.stroke.widthProfile?.length || t.stroke.brush)) return true;
  if (mode === 'editable') return !isEncodable(t.text, encoding);
  return !isEncodable(t.text, 'ascii');
}

async function outlineText(doc: Document, t: TextNode, failed: string[]): Promise<void> {
  try {
    const paths = await textToOutlinePaths(doc, t);
    if (!paths.length) return;
    const group = makeGroup([], { name: t.name, transform: t.transform, opacity: t.opacity, blendMode: t.blendMode, effects: t.effects, visible: t.visible, locked: t.locked });
    const parent = t.parent;
    const index = indexInParent(doc, t.id);
    removeNode(doc, t.id);
    addNode(doc, group, parent, index);
    for (const p of paths) {
      // glyph outlines carry the text's paint only; an unpainted stroke must not keep a brush / width profile
      p.stroke = t.stroke.paint.type === 'none' ? noStroke() : cloneStroke(p.stroke);
      addNode(doc, p, group.id);
    }
  } catch (e: any) {
    failed.push(`${t.name}: ${e?.message ?? e}`);
  }
}

/** Copy of the document with everything the AI format cannot express turned into plain artwork. */
export async function prepareDocumentForAi(source: Document, opts: AiPrepareOptions = {}): Promise<AiPrepareResult> {
  const doc = deepClone(source);
  const warnings: string[] = [];
  const failed: string[] = [];
  const mode = opts.textMode ?? 'auto';
  const encoding = opts.encoding ?? 'latin1';
  // 1. text that the format cannot keep editable → outlines (first: text on a path must still find its path
  //    before brush expansion replaces path nodes)
  let outlined = 0;
  for (const id of scopeIds(doc, opts.ids)) {
    const nd = doc.nodes[id];
    if (!nd || nd.type !== 'text' || !nd.text.trim()) continue;
    if (needsOutline(doc, nd as TextNode, mode, encoding)) {
      await outlineText(doc, nd as TextNode, failed);
      outlined++;
    }
  }
  if (outlined && mode !== 'outlines') warnings.push(`${outlined} text object${outlined === 1 ? '' : 's'} converted to outlines (text on a path, gradient text or characters outside the AI text encoding)`);
  // 2. live appearance: brush strokes, warp / distort / 3D geometry effects
  const ids = scopeIds(doc, opts.ids);
  const r = expandAppearance(doc, ids);
  if (r.changed) warnings.push(`${r.changed} brush stroke${r.changed === 1 ? '' : 's'} / live effect${r.changed === 1 ? '' : 's'} expanded`);
  // 3. pattern fills → tiles in a clipping group
  let patterns = 0;
  for (const id of scopeIds(doc, opts.ids)) {
    const nd = doc.nodes[id];
    if (nd && nd.type === 'path' && nd.fill.type === 'pattern' && expandPatternFill(doc, id)) patterns++;
  }
  if (patterns) warnings.push(`${patterns} pattern fill${patterns === 1 ? '' : 's'} expanded into tiles`);
  // 4. variable-width strokes → filled outlines
  for (const id of scopeIds(doc, opts.ids)) expandWidthProfile(doc, id);
  // 5. raster images
  await prepareRasterImages(doc, opts.ids ? scopeIds(doc, opts.ids) : undefined);
  return { doc, failed, warnings };
}

/** Paths of the tree in paint order (helper for tests). */
export function pathsOf(doc: Document, root: ID): PathNode[] {
  const out: PathNode[] = [];
  const visit = (id: ID) => {
    const nd: Node | undefined = doc.nodes[id];
    if (!nd) return;
    if (nd.type === 'path') out.push(nd);
    else if (isContainer(nd)) for (const c of nd.children) visit(c);
  };
  visit(root);
  return out;
}
