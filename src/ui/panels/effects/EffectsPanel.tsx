/**
 * Effects panel: the selection's effect list plus a gallery of all effects.
 */
import React from 'react';
import { useStore } from '@/store/store';
import { Divider } from '@/ui/widgets';
import { runCommand } from '@/commands/registry';
import { EFFECT_DEFS } from '@/commands/effectCommands/effects';
import { EffectsList } from '@/ui/panels/appearance/EffectsList';
import '@/ui/panels/appearance/appearance.css';

export function EffectsPanel() {
  const selection = useStore((s) => s.selection);
  const hasSel = selection.length > 0;
  return (
    <div className="effects-panel" data-testid="effects-panel">
      <EffectsList ids={selection} />
      <Divider />
      <div className="fx-gallery-title">Add effect</div>
      <div className="fx-gallery">
        {EFFECT_DEFS.map((d) => {
          const Icon = d.icon;
          return (
            <button key={d.type} type="button" className="fx-tile" disabled={!hasSel} title={`${d.description}${hasSel ? '' : ' (select an object first)'}`} onClick={() => runCommand(`effect.${d.type}`)} data-testid={`fx-tile-${d.type}`}>
              <Icon size={18} />
              <span>{d.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
