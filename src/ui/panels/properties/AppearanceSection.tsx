/**
 * Fill / stroke / opacity / blend mode summary in the Properties panel.
 */
import React from 'react';
import { ExternalLink } from 'lucide-react';
import type { BlendMode } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { NumberField, Select } from '@/ui/widgets';
import { useCurrentAppearance, setFillPaint, setStrokePaint, setStrokeProps, setNodeProps } from '@/commands/appearance';
import { PaintSwatch, paintLabel } from '@/ui/panels/appearance/PaintSwatch';
import { BLEND_MODES } from '@/ui/panels/appearance/AppearancePanel';

export function AppearanceSection() {
  const app = useCurrentAppearance();
  const units = useStore((s) => s.prefs.units);
  const commit = (label: string) => getState().commit(label);
  return (
    <>
      <div className="pp-row">
        <PaintSwatch paint={app.fill} mixed={app.mixedFill} onChange={(p) => setFillPaint(p, false)} onCommit={() => commit('Fill')} testId="pp-fill" />
        <span style={{ width: 40 }}>Fill</span>
        <span className="muted small grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {paintLabel(app.fill, app.mixedFill)}
        </span>
      </div>
      <div className="pp-row">
        <PaintSwatch paint={app.stroke.paint} mixed={app.mixedStroke} stroke onChange={(p) => setStrokePaint(p, false)} onCommit={() => commit('Stroke')} testId="pp-stroke" />
        <span style={{ width: 40 }}>Stroke</span>
        <NumberField value={app.stroke.width} onChange={(v) => setStrokeProps({ width: v }, false)} onCommit={() => commit('Stroke weight')} min={0} step={0.5} unit={units} mixed={app.mixedStroke} title="Stroke weight" data-testid="pp-stroke-width" className="grow" />
      </div>
      <div className="pp-row">
        <NumberField
          label="Opacity"
          value={app.opacity === null ? null : Math.round(app.opacity * 100)}
          mixed={app.opacity === null}
          onChange={(v) => setNodeProps({ opacity: v / 100 }, false)}
          onCommit={() => commit('Opacity')}
          min={0}
          max={100}
          unit="%"
          decimals={0}
          width={104}
          data-testid="pp-opacity"
        />
        <Select value={app.blendMode ?? null} mixed={app.blendMode === null} options={BLEND_MODES} onChange={(v) => setNodeProps({ blendMode: v as BlendMode }, true)} title="Blending mode" className="grow" />
      </div>
      <div className="pp-row">
        <button type="button" className="pp-link" onClick={() => getState().togglePanel('appearance', true)} title="Open the Appearance panel">
          Appearance <ExternalLink size={10} />
        </button>
      </div>
    </>
  );
}
