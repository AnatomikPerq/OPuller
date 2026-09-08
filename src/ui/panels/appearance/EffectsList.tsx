/**
 * List of the selection's effects (shared by the Appearance and Effects
 * panels): enable checkbox, name + summary, edit and delete, "Add effect" menu.
 */
import React from 'react';
import { Plus, Pencil, Trash, ChevronUp, ChevronDown } from 'lucide-react';
import type { Effect, ID } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { Checkbox, IconButton, PopoverButton } from '@/ui/widgets';
import { setEffects } from '@/commands/appearance';
import { runCommand } from '@/commands/registry';
import { EFFECT_DEFS, effectDef, effectLabel, effectSummary, cloneEffect, type EffectMenu } from '@/commands/effectCommands/effects';
import { openEffectDialog } from '@/commands/effectCommands/register';

const MENU_GROUPS: EffectMenu[] = ['Stylize', 'Blur', 'Adjust', 'Distort & Transform', '3D'];

export function AddEffectMenu({ disabled, small }: { disabled?: boolean; small?: boolean }) {
  return (
    <PopoverButton
      className="fx-menu"
      placement="bottom-end"
      button={({ toggle, ref }) => (
        <button ref={ref} type="button" className={`btn small ${small ? '' : ''}`} onClick={toggle} disabled={disabled} title="Add an effect to the selection" data-testid="fx-add">
          <Plus size={12} />
          Add effect
        </button>
      )}
    >
      {(close) => (
        <>
          {MENU_GROUPS.map((g) => (
            <React.Fragment key={g}>
              <div className="fx-menu-group">{g}</div>
              {EFFECT_DEFS.filter((d) => d.menu === g && !d.hiddenInMenu).map((d) => {
                const Icon = d.icon;
                return (
                  <button
                    key={d.type}
                    type="button"
                    className="fx-menu-item"
                    data-testid={`fx-add-${d.type}`}
                    onClick={() => {
                      close();
                      runCommand(`effect.${d.type}`);
                    }}
                  >
                    <Icon size={14} />
                    {d.label}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </>
      )}
    </PopoverButton>
  );
}

function sameEffects(a: Effect[], b: Effect[]): boolean {
  return a.length === b.length && a.every((e, i) => JSON.stringify(e) === JSON.stringify(b[i]));
}

export function EffectsList({ ids, showHeader = true }: { ids: ID[]; showHeader?: boolean }) {
  useStore((s) => s.docVersion);
  const doc = getState().doc;
  const first = ids[0] ? doc.nodes[ids[0]] : undefined;
  const effects = first?.effects ?? [];
  const mixed = ids.length > 1 && ids.some((id) => !sameEffects(doc.nodes[id]?.effects ?? [], effects));

  const commitList = (list: Effect[], label: string) => {
    setEffects(list, false, ids);
    getState().commit(label);
  };
  const toggle = (i: number, on: boolean) => {
    const list = effects.map(cloneEffect);
    list[i] = { ...list[i], enabled: on };
    commitList(list, on ? 'Enable Effect' : 'Disable Effect');
  };
  const remove = (i: number) => {
    commitList(effects.filter((_, k) => k !== i), 'Delete Effect');
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= effects.length) return;
    const list = effects.map(cloneEffect);
    const [it] = list.splice(i, 1);
    list.splice(j, 0, it);
    commitList(list, 'Reorder Effects');
  };

  return (
    <div className="fx-list" data-testid="fx-list">
      {showHeader && (
        <div className="fx-list-header">
          <span>Effects</span>
          {effects.length > 0 && <span className="fx-count">{effects.length}</span>}
          <span className="fx-add">
            <AddEffectMenu disabled={!ids.length} small />
          </span>
        </div>
      )}
      {!ids.length && <div className="fx-empty">Select an object to see its effects.</div>}
      {ids.length > 0 && !effects.length && <div className="fx-empty">No effects. Use “Add effect” or the Effect menu.</div>}
      {effects.map((e, i) => {
        const def = effectDef(e.type);
        const Icon = def?.icon;
        return (
          <div key={i} className={`fx-row ${e.enabled ? '' : 'disabled'}`} data-testid={`fx-row-${i}`}>
            <Checkbox checked={e.enabled} onChange={(v) => toggle(i, v)} title={e.enabled ? 'Disable effect' : 'Enable effect'} />
            <span className="fx-icon">{Icon ? <Icon size={13} /> : null}</span>
            <span className="fx-text" onDoubleClick={() => openEffectDialog(e.type, i)}>
              <span className="fx-name">{effectLabel(e)}</span>
              <span className="fx-summary">{effectSummary(e)}</span>
            </span>
            <span className="fx-actions">
              <IconButton icon={<ChevronUp size={12} />} title="Move up" disabled={i === 0} onClick={() => move(i, -1)} size={12} />
              <IconButton icon={<ChevronDown size={12} />} title="Move down" disabled={i === effects.length - 1} onClick={() => move(i, 1)} size={12} />
              <IconButton icon={<Pencil size={12} />} title="Edit effect…" onClick={() => openEffectDialog(e.type, i)} size={12} data-testid={`fx-edit-${i}`} />
              <IconButton icon={<Trash size={12} />} title="Delete effect" onClick={() => remove(i)} size={12} data-testid={`fx-delete-${i}`} />
            </span>
          </div>
        );
      })}
      {mixed && <div className="fx-mixed">Mixed appearances — edits apply the list above to all {ids.length} objects.</div>}
    </div>
  );
}
