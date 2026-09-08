import React, { useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';
import { getTool, onToolsChanged, allTools } from '@/tools/registry';
import { shortcutLabel } from '@/util/keys';
import { useCurrentAppearance, setStrokeProps, setNodeProps } from '@/commands/appearance';
import { NumberField, Row } from './widgets';
import { getState } from '@/store/store';

/** Context-sensitive options for the active tool + quick appearance controls. */
export function ControlBar() {
  const toolId = useStore((s) => s.temporaryTool ?? s.activeTool);
  useSyncExternalStore(onToolsChanged, () => allTools().length, () => 0);
  const tool = getTool(toolId);
  const Options = tool?.Options;
  const app = useCurrentAppearance();
  const selection = useStore((s) => s.selection);
  const units = useStore((s) => s.prefs.units);

  return (
    <div className="controlbar" data-testid="controlbar">
      <span style={{ fontWeight: 600, minWidth: 110 }} className="small">
        {tool?.name ?? ''}
        {tool?.shortcut && <span className="dim"> ({shortcutLabel(tool.shortcut)})</span>}
      </span>
      <div className="divider" style={{ width: 1, height: 20, margin: '0 2px' }} />
      <Row gap={6}>
        <NumberField label="Stroke" value={app.stroke.width} onChange={(v) => setStrokeProps({ width: v }, false)} onCommit={() => getState().commit('Stroke width')} min={0} step={0.5} unit={units} width={120} mixed={app.mixedStroke} title="Stroke weight" />
        {selection.length > 0 && (
          <NumberField label="Opacity" value={app.opacity === null ? null : Math.round(app.opacity * 100)} mixed={app.opacity === null} onChange={(v) => setNodeProps({ opacity: v / 100 }, false)} onCommit={() => getState().commit('Opacity')} min={0} max={100} unit="%" width={100} decimals={0} />
        )}
      </Row>
      <div className="divider" style={{ width: 1, height: 20, margin: '0 2px' }} />
      {Options ? <Options /> : tool?.hint ? <span className="muted">{tool.hint}</span> : null}
    </div>
  );
}
