/**
 * Indirection between the pure pattern operations and the SVG renderer (which
 * needs a browser canvas): the renderer registers itself at start-up; in
 * environments without it (unit tests) the cell markup is simply left as is.
 */
import type { Document, PatternDef } from '@/model/types';

export type PatternRenderer = (doc: Document, def: PatternDef) => string;

let renderer: PatternRenderer | null = null;

export function setPatternRenderer(fn: PatternRenderer | null): void {
  renderer = fn;
}

/** A document-shaped view of the pattern artwork. */
export function patternDocument(doc: Document, def: PatternDef): Document | null {
  if (!def.nodes || !def.root) return null;
  return { ...doc, nodes: def.nodes, layers: [def.root] };
}

/** Refresh `def.svg` from the artwork (no-op for markup-only definitions or without a renderer). */
export function refreshPatternSvg(doc: Document, def: PatternDef): void {
  if (!def.nodes || !def.root) return;
  if (renderer) def.svg = renderer(doc, def);
}
