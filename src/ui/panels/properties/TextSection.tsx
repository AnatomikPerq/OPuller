/**
 * Quick text fields (family / style / size); full editing lives in Character.
 */
import React, { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ID, TextNode } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { NumberField, Select } from '@/ui/widgets';
import { setTextStyle } from '@/commands/appearance';
import { listFamilies, weightsFor, faceLabel, nearestFace, useFontRegistry } from '@/text/fonts';
import { descendants } from '@/model/document';
import { common } from './edit';

function textNodes(ids: ID[]): TextNode[] {
  const doc = getState().doc;
  const out: TextNode[] = [];
  for (const id of ids) for (const d of descendants(doc, id, true)) {
    const n = doc.nodes[d];
    if (n?.type === 'text') out.push(n);
  }
  return out;
}

export function TextSection({ ids }: { ids: ID[] }) {
  useStore((s) => s.docVersion);
  useFontRegistry();
  const nodes = textNodes(ids);
  const family = common(nodes.map((n) => n.style.fontFamily));
  const size = common(nodes.map((n) => n.style.fontSize));
  const weight = common(nodes.map((n) => n.style.fontWeight));
  const style = common(nodes.map((n) => n.style.fontStyle));
  const families = useMemo(() => listFamilies(nodes.map((n) => n.style.fontFamily)), [nodes.length, family]); // eslint-disable-line react-hooks/exhaustive-deps
  const faces = weightsFor(family ?? 'Inter');
  const faceValue = weight !== null && style !== null ? `${weight}|${style}` : '';
  const faceOptions = faces.map((f) => ({ value: `${f.weight}|${f.style}`, label: f.label }));
  if (faceValue && !faceOptions.some((o) => o.value === faceValue)) faceOptions.push({ value: faceValue, label: faceLabel(weight as number, style as 'normal' | 'italic') });
  const chars = nodes.reduce((n, t) => n + t.text.length, 0);
  return (
    <>
      <Select
        value={family}
        mixed={family === null}
        options={families.map((f) => ({ value: f.family, label: f.family }))}
        onChange={(f) => {
          const face = nearestFace(f, weight ?? 400, style ?? 'normal');
          setTextStyle({ fontFamily: f, fontWeight: face.weight, fontStyle: face.style });
        }}
        title="Font family"
        data-testid="pp-font-family"
        id="pp-font-family"
      />
      <div className="pp-grid-2">
        <Select
          value={faceValue}
          mixed={!faceValue}
          options={faceOptions}
          onChange={(v) => {
            const [w, st] = v.split('|');
            setTextStyle({ fontWeight: Number(w), fontStyle: st as 'normal' | 'italic' });
          }}
          title="Font style"
          id="pp-font-face"
        />
        <NumberField value={size} mixed={size === null} onChange={(v) => setTextStyle({ fontSize: Math.max(1, v) }, false)} onCommit={() => getState().commit('Font Size')} min={1} max={2000} unit="px" suffix="pt" title="Font size" data-testid="pp-font-size" />
      </div>
      <div className="pp-row">
        <span className="dim small">
          {nodes.length === 1 ? `${chars} characters` : `${nodes.length} text objects`}
        </span>
        <button type="button" className="pp-link" onClick={() => getState().togglePanel('character', true)} title="Open the Character panel">
          Character <ExternalLink size={10} />
        </button>
      </div>
    </>
  );
}
