/**
 * Tiny SVG preview of a node for the Layers panel. Rendered with the static
 * renderer in the node's parent space; memoised on the identity of the node
 * and all of its descendants so untouched rows never re-render.
 */
import React, { memo, useMemo, useRef } from 'react';
import type { Document, ID, Node } from '@/model/types';
import { useStore } from '@/store/store';
import { StaticDocument } from '@/canvas/Renderer';
import { localBounds, descendants } from '@/model/document';
import { applyToRect } from '@/geometry/matrix';

function sameNodes(a: Node[], b: Node[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function renderThumb(doc: Document, id: ID): React.ReactNode {
  const n = doc.nodes[id];
  if (!n) return null;
  const lb = localBounds(doc, id);
  if (!lb) return null;
  const b = applyToRect(n.transform, lb);
  const size = Math.max(b.width, b.height, 1e-3);
  const pad = size * 0.08 + 0.5;
  const w = Math.max(b.width, 1e-3);
  const h = Math.max(b.height, 1e-3);
  // hidden nodes are still previewed (the renderer skips invisible nodes)
  const d = n.visible ? doc : { ...doc, nodes: { ...doc.nodes, [id]: { ...n, visible: true } as Node } };
  return (
    <svg viewBox={`${b.x - pad} ${b.y - pad} ${w + pad * 2} ${h + pad * 2}`} preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <StaticDocument doc={d} ids={[id]} prefix={`th-${id}-`} exportMode={false} />
    </svg>
  );
}

export const LayerThumb = memo(function LayerThumb({ id }: { id: ID }) {
  const doc = useStore((s) => s.doc);
  const sigRef = useRef<Node[]>([]);
  const sig = descendants(doc, id, true).map((d) => doc.nodes[d]);
  if (!sameNodes(sig, sigRef.current)) sigRef.current = sig;
  const stable = sigRef.current;
  const content = useMemo(() => renderThumb(doc, id), [stable, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`lr-thumb ${content ? '' : 'empty'}`}>{content}</div>;
});
