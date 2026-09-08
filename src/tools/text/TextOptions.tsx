/**
 * Control bar options for the Type tool: font, style, size, alignment, and the
 * text-on-path / area text specific fields.
 */
import React from 'react';
import { AlignLeft, AlignCenter, AlignRight, AlignJustify, FlipHorizontal2, Unlink } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import type { TextNode } from '@/model/types';
import { NumberField, Row, Select, Segmented, Button, IconButton } from '@/ui/widgets';
import { runCommand } from '@/commands/registry';
import { weightsFor, nearestFace, faceLabel, useFontRegistry } from '@/text/fonts';
import { FontFamilyPicker } from '@/ui/panels/character/FontFamilyPicker';
import { useTextStyleInfo, applyTextStyle, MIXED, num } from './textStyle';
import { useTextEdit } from './session';

export function TextOptions() {
  const info = useTextStyleInfo();
  const units = useStore((s) => s.prefs.units);
  useFontRegistry();
  const editingId = useTextEdit((s) => s.id);
  const v = info.values;
  const family = typeof v.fontFamily === 'string' ? v.fontFamily : '';
  const faces = weightsFor(family || 'Inter');
  const faceValue = typeof v.fontWeight === 'number' && typeof v.fontStyle === 'string' ? `${v.fontWeight}|${v.fontStyle}` : '';
  const faceOptions = faces.map((f) => ({ value: `${f.weight}|${f.style}`, label: f.label }));
  if (faceValue && !faceOptions.some((o) => o.value === faceValue)) faceOptions.push({ value: faceValue, label: faceLabel(v.fontWeight as number, v.fontStyle as 'normal' | 'italic') });
  const commit = (label: string) => getState().commit(label);

  // node-specific fields
  const s = getState();
  const first = info.ids.map((id) => s.doc.nodes[id]).find((n): n is TextNode => !!n && n.type === 'text');
  const pathText = first && first.kind === 'path' ? first : null;
  const areaText = first && first.kind === 'area' && first.box ? first : null;

  return (
    <Row gap={8}>
      <FontFamilyPicker value={family} mixed={v.fontFamily === MIXED} onChange={(f) => applyTextStyle({ fontFamily: f, ...nearestFacePatch(f, v) })} width={170} compact />
      <Select value={faceValue} mixed={!faceValue} options={faceOptions} width={120} title="Font style" onChange={(val) => {
        const [w, st] = val.split('|');
        applyTextStyle({ fontWeight: Number(w), fontStyle: st as 'normal' | 'italic' });
      }} />
      <NumberField label="Size" value={num(v.fontSize)} mixed={v.fontSize === MIXED} min={1} max={2000} step={1} unit="px" width={110} onChange={(n) => applyTextStyle({ fontSize: n }, false)} onCommit={() => commit('Font size')} title="Font size (Ctrl+Shift+. / Ctrl+Shift+,)" data-testid="text-options-size" />
      <Segmented
        value={typeof v.textAlign === 'string' ? v.textAlign : null}
        onChange={(a) => applyTextStyle({ textAlign: a })}
        options={[
          { value: 'left', icon: <AlignLeft size={14} />, title: 'Align left (Ctrl+Shift+L)' },
          { value: 'center', icon: <AlignCenter size={14} />, title: 'Align center (Ctrl+Shift+C)' },
          { value: 'right', icon: <AlignRight size={14} />, title: 'Align right (Ctrl+Shift+R)' },
          { value: 'justify', icon: <AlignJustify size={14} />, title: 'Justify (Ctrl+Shift+J)' },
        ]}
      />
      {pathText && (
        <>
          <div className="text-options-sep" />
          <NumberField
            label="Path offset"
            value={Math.round((pathText.pathOffset ?? 0) * 1000) / 10}
            min={0}
            max={100}
            step={1}
            unit="%"
            width={130}
            decimals={1}
            title="Start position of the text along the path"
            data-testid="text-options-path-offset"
            onChange={(p) => getState().updateDoc((d) => {
              const n = d.nodes[pathText.id];
              if (n && n.type === 'text') n.pathOffset = Math.max(0, Math.min(1, p / 100));
            })}
            onCommit={() => commit('Path Offset')}
          />
          <IconButton icon={<FlipHorizontal2 size={15} />} title="Flip type to the other side of the path" onClick={() => runCommand('type.flipPath')} />
          <IconButton icon={<Unlink size={15} />} title="Release from path" onClick={() => runCommand('type.releasePath')} />
        </>
      )}
      {areaText && (
        <>
          <div className="text-options-sep" />
          <NumberField label="W" value={areaText.box!.width} min={1} unit={units} width={110} onChange={(w) => setBox(areaText.id, { width: w })} onCommit={() => commit('Text Box')} title="Area text width" />
          <NumberField label="H" value={areaText.box!.height} min={1} unit={units} width={110} onChange={(h) => setBox(areaText.id, { height: h })} onCommit={() => commit('Text Box')} title="Area text height" />
        </>
      )}
      {first && !editingId && (
        <>
          <div className="text-options-sep" />
          {first.kind === 'point' && (
            <Button small onClick={() => runCommand('type.convertToArea')} title="Convert point text to area text">
              To Area
            </Button>
          )}
          {first.kind === 'area' && (
            <Button small onClick={() => runCommand('type.convertToPoint')} title="Convert area text to point text">
              To Point
            </Button>
          )}
          <Button small onClick={() => runCommand('type.createOutlines')} title="Create Outlines (Ctrl+Shift+O)">
            Outlines
          </Button>
        </>
      )}
      {!first && <span className="muted">Click to place point text, drag for area text, click an open path for type on a path.</span>}
    </Row>
  );
}

function setBox(id: string, patch: Partial<{ width: number; height: number }>): void {
  getState().updateDoc((d) => {
    const n = d.nodes[id];
    if (n && n.type === 'text' && n.box) n.box = { ...n.box, ...patch };
  });
}

/** When changing the family, snap weight/style to a face the family has. */
export function nearestFacePatch(family: string, v: { fontWeight: unknown; fontStyle: unknown }): { fontWeight?: number; fontStyle?: 'normal' | 'italic' } {
  if (typeof v.fontWeight !== 'number' || typeof v.fontStyle !== 'string') return {};
  const f = nearestFace(family, v.fontWeight, v.fontStyle as 'normal' | 'italic');
  const patch: { fontWeight?: number; fontStyle?: 'normal' | 'italic' } = {};
  if (f.weight !== v.fontWeight) patch.fontWeight = f.weight;
  if (f.style !== v.fontStyle) patch.fontStyle = f.style;
  return patch;
}

void React;
