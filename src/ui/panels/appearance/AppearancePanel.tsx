/**
 * Appearance panel: fill, stroke, opacity, blend mode and the effect list of
 * the selection (or the defaults for new objects when nothing is selected).
 */
import React from 'react';
import { Square, Circle, Folder, Type, Image as ImageIcon, Spline, Layers } from 'lucide-react';
import type { BlendMode, Node } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { NumberField, Select, Button, Divider } from '@/ui/widgets';
import { useCurrentAppearance, setFillPaint, setStrokePaint, setStrokeProps, setNodeProps } from '@/commands/appearance';
import { PaintSwatch, paintLabel } from './PaintSwatch';
import { EffectsList } from './EffectsList';
import './appearance.css';

export const BLEND_MODES: Array<{ value: BlendMode; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

export function nodeTypeIcon(n: Node | undefined, size = 13): React.ReactNode {
  if (!n) return <Layers size={size} />;
  switch (n.type) {
    case 'layer':
      return <Layers size={size} />;
    case 'group':
      return <Folder size={size} />;
    case 'text':
      return <Type size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    default:
      return n.shape?.kind === 'ellipse' ? <Circle size={size} /> : n.shape?.kind === 'rect' ? <Square size={size} /> : <Spline size={size} />;
  }
}

export function selectionTitle(): { title: string; node?: Node } {
  const s = getState();
  if (!s.selection.length) return { title: 'No selection' };
  if (s.selection.length === 1) {
    const n = s.doc.nodes[s.selection[0]];
    return { title: n?.name ?? 'Object', node: n };
  }
  return { title: `${s.selection.length} objects` };
}

export function AppearancePanel() {
  const app = useCurrentAppearance();
  const selection = useStore((s) => s.selection);
  useStore((s) => s.docVersion);
  const units = useStore((s) => s.prefs.units);
  const hasSel = selection.length > 0;
  const { title, node } = selectionTitle();
  const commit = (label: string) => getState().commit(label);

  const clearAppearance = () => {
    const s = getState();
    setFillPaint({ type: 'none' }, false);
    setStrokePaint({ type: 'none' }, false);
    if (hasSel) {
      s.updateDoc((d) => {
        for (const id of s.selection) {
          const n = d.nodes[id];
          if (n) n.effects = [];
        }
      });
      s.commit('Clear Appearance');
    }
  };
  const reduceToBasic = () => {
    const s = getState();
    if (!hasSel) return;
    s.updateDoc((d) => {
      for (const id of s.selection) {
        const n = d.nodes[id];
        if (!n) continue;
        n.effects = [];
        n.opacity = 1;
        n.blendMode = 'normal';
      }
    }, 'Reduce to Basic Appearance');
  };

  return (
    <div className="appearance-panel" data-testid="appearance-panel">
      <div className="ap-header">
        {nodeTypeIcon(node)}
        <span className="ap-title">{title}</span>
        {!hasSel && <span className="dim">· defaults for new objects</span>}
      </div>
      <div className="ap-row">
        <PaintSwatch paint={app.fill} mixed={app.mixedFill} onChange={(p) => setFillPaint(p, false)} onCommit={() => commit('Fill')} testId="ap-fill" />
        <span className="ap-row-label">Fill</span>
        <span className="ap-value">{paintLabel(app.fill, app.mixedFill)}</span>
      </div>
      <div className="ap-row">
        <PaintSwatch paint={app.stroke.paint} mixed={app.mixedStroke} stroke onChange={(p) => setStrokePaint(p, false)} onCommit={() => commit('Stroke')} testId="ap-stroke" />
        <span className="ap-row-label">Stroke</span>
        <span className="ap-value">{paintLabel(app.stroke.paint, app.mixedStroke)}</span>
        <NumberField value={app.stroke.width} onChange={(v) => setStrokeProps({ width: v }, false)} onCommit={() => commit('Stroke weight')} min={0} step={0.5} unit={units} width={78} mixed={app.mixedStroke} title="Stroke weight" data-testid="ap-stroke-width" />
      </div>
      <div className="ap-row">
        <NumberField
          label="Opacity"
          value={hasSel ? (app.opacity === null ? null : Math.round(app.opacity * 100)) : 100}
          mixed={hasSel && app.opacity === null}
          onChange={(v) => setNodeProps({ opacity: v / 100 }, false)}
          onCommit={() => commit('Opacity')}
          min={0}
          max={100}
          unit="%"
          decimals={0}
          width={96}
          disabled={!hasSel}
          data-testid="ap-opacity"
        />
        <Select
          value={hasSel ? (app.blendMode ?? null) : 'normal'}
          mixed={hasSel && app.blendMode === null}
          options={BLEND_MODES}
          onChange={(v) => setNodeProps({ blendMode: v as BlendMode }, true)}
          disabled={!hasSel}
          title="Blending mode"
          width={118}
        />
      </div>
      <Divider />
      <EffectsList ids={selection} />
      <div className="ap-actions">
        <Button small onClick={clearAppearance} title="Fill: none, stroke: none, no effects" data-testid="ap-clear">
          Clear appearance
        </Button>
        <Button small onClick={reduceToBasic} disabled={!hasSel} title="Remove effects, opacity and blend mode" data-testid="ap-reduce">
          Reduce to basic
        </Button>
      </div>
    </div>
  );
}
