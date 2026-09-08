/**
 * Effect menu: Stylize / Blur / Adjust submenus, Apply Last Effect, Clear Effects.
 */
import { registerCommands, when } from '@/commands/registry';
import { getState, type EditorState } from '@/store/store';
import { setEffects } from '@/commands/appearance';
import { EFFECT_DEFS, applyEffect, lastEffect, effectLabel, type EffectType } from './effects';

/** Nodes an effect is applied to: the selection itself (groups get the effect as a whole). */
export function effectTargets(s: EditorState = getState()): string[] {
  return s.selection.filter((id) => !!s.doc.nodes[id]);
}

export function openEffectDialog(type: EffectType, index?: number): void {
  const s = getState();
  if (!effectTargets(s).length) return;
  const def = EFFECT_DEFS.find((d) => d.type === type);
  s.openDialog(def?.dialog ?? 'effect', index !== undefined ? { type, index } : { type });
}

export function applyLastEffect(): void {
  const e = lastEffect();
  const ids = effectTargets();
  if (!e || !ids.length) return;
  applyEffect(e, ids, { kind: 'replaceType' }, effectLabel(e));
}

export function clearEffects(): void {
  const ids = effectTargets();
  if (!ids.length) return;
  setEffects([], false, ids);
  getState().commit('Clear Effects');
}

const hasEffects = (s: EditorState) => s.selection.some((id) => (s.doc.nodes[id]?.effects.length ?? 0) > 0);

registerCommands([
  { id: 'effect.applyLast', label: 'Apply Last Effect', menu: 'Effect', shortcut: 'mod+shift+e', order: 1, run: applyLastEffect, enabled: (s) => when.hasSelection(s) && !!lastEffect() },
  { id: 'effect.lastDialog', label: 'Last Effect…', menu: 'Effect', shortcut: 'mod+alt+shift+e', order: 2, run: () => { const e = lastEffect(); if (e) openEffectDialog(e.type); }, enabled: (s) => when.hasSelection(s) && !!lastEffect() },
  ...EFFECT_DEFS.map((d) => ({
    id: `effect.${d.type}`,
    label: d.menuLabel,
    menu: `Effect/${d.menu}`,
    order: 10 + d.order,
    run: () => openEffectDialog(d.type),
    enabled: when.hasSelection,
    hidden: d.hiddenInMenu,
  })),
  { id: 'effect.clear', label: 'Clear Effects', menu: 'Effect', order: 100, separatorBefore: true, run: clearEffects, enabled: hasEffects },
]);
