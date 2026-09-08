/**
 * Paragraph panel: alignment, paragraph spacing, area text box size and
 * point/area conversion.
 */
import React from 'react';
import { AlignLeft, AlignCenter, AlignRight, AlignJustify } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import type { TextNode } from '@/model/types';
import { NumberField, Row, Segmented, Button } from '@/ui/widgets';
import { runCommand } from '@/commands/registry';
import { useTextStyleInfo, applyTextStyle, MIXED, num } from '@/tools/text/textStyle';

export function ParagraphPanel() {
  const info = useTextStyleInfo();
  const units = useStore((s) => s.prefs.units);
  const editingTextId = useStore((s) => s.editingTextId);
  const v = info.values;
  const commit = (label: string) => getState().commit(label);
  const s = getState();
  const nodes = info.ids.map((id) => s.doc.nodes[id]).filter((n): n is TextNode => !!n && n.type === 'text');
  const areas = nodes.filter((n) => n.kind === 'area' && n.box);
  const boxW = areas.length ? (areas.every((n) => n.box!.width === areas[0].box!.width) ? areas[0].box!.width : null) : null;
  const boxH = areas.length ? (areas.every((n) => n.box!.height === areas[0].box!.height) ? areas[0].box!.height : null) : null;
  const setBox = (patch: Partial<{ width: number; height: number }>) =>
    getState().updateDoc((d) => {
      for (const a of areas) {
        const n = d.nodes[a.id];
        if (n && n.type === 'text' && n.box) n.box = { ...n.box, ...patch };
      }
    });
  const hasPoint = nodes.some((n) => n.kind === 'point');
  const hasArea = nodes.some((n) => n.kind === 'area');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="paragraph-panel">
      <Row gap={8}>
        <Segmented
          value={typeof v.textAlign === 'string' ? v.textAlign : null}
          onChange={(a) => applyTextStyle({ textAlign: a })}
          title="Alignment"
          options={[
            { value: 'left', icon: <AlignLeft size={14} />, title: 'Align left (Ctrl+Shift+L)' },
            { value: 'center', icon: <AlignCenter size={14} />, title: 'Align center (Ctrl+Shift+C)' },
            { value: 'right', icon: <AlignRight size={14} />, title: 'Align right (Ctrl+Shift+R)' },
            { value: 'justify', icon: <AlignJustify size={14} />, title: 'Justify (Ctrl+Shift+J)' },
          ]}
        />
      </Row>
      <NumberField
        label={<span title="Space after paragraph">Space after</span>}
        value={num(v.paragraphSpacing)}
        mixed={v.paragraphSpacing === MIXED}
        min={0}
        step={1}
        unit={units}
        width={170}
        onChange={(n) => applyTextStyle({ paragraphSpacing: n }, false)}
        onCommit={() => commit('Paragraph spacing')}
        data-testid="paragraph-spacing"
      />
      {areas.length > 0 && (
        <div className="grid-2">
          <NumberField label="Width" value={boxW} mixed={boxW === null} min={1} unit={units} onChange={(w) => setBox({ width: w })} onCommit={() => commit('Text Box')} data-testid="paragraph-box-width" title="Area text width" />
          <NumberField label="Height" value={boxH} mixed={boxH === null} min={1} unit={units} onChange={(h) => setBox({ height: h })} onCommit={() => commit('Text Box')} data-testid="paragraph-box-height" title="Area text height" />
        </div>
      )}
      {nodes.length > 0 && !editingTextId && (hasPoint || hasArea) && (
        <Row gap={6}>
          {hasPoint && (
            <Button small onClick={() => runCommand('type.convertToArea')} title="Convert point text to area text">
              Convert to Area
            </Button>
          )}
          {hasArea && (
            <Button small onClick={() => runCommand('type.convertToPoint')} title="Convert area text to point text">
              Convert to Point
            </Button>
          )}
        </Row>
      )}
      {!nodes.length && <div className="char-target" style={{ fontSize: 11, color: 'var(--text-dim)' }}>Defaults for new text</div>}
    </div>
  );
}

void React;
