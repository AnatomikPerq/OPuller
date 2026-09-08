/**
 * Type tool registrations: viewport slots (caret/selection overlay, hidden
 * input) and the canvas context-menu section for text objects.
 */
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { addContextMenuSection } from '@/ui/contextMenu/register';
import { getCommand, isEnabled, runCommand } from '@/commands/registry';
import { getState, type ContextMenuItem } from '@/store/store';
import { shortcutLabel } from '@/util/keys';
import { TextEditOverlay } from './TextEditOverlay';
import { TextInputProxy } from './TextInputProxy';
import { selectedTextIds } from './textStyle';
import { isEditing } from './session';

registerViewportSlot('overlay', 'text-edit', TextEditOverlay);
registerViewportSlot('html', 'text-input', TextInputProxy);

function cmd(id: string): ContextMenuItem | null {
  const c = getCommand(id);
  if (!c) return null;
  const s = getState();
  const sc = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut;
  return { label: c.label, shortcut: shortcutLabel(sc), disabled: !isEnabled(c, s), checked: c.checked?.(s), onSelect: () => runCommand(c.id) };
}

function cmds(ids: string[]): ContextMenuItem[] {
  return ids.map(cmd).filter((x): x is ContextMenuItem => !!x);
}

addContextMenuSection(() => {
  const s = getState();
  if (!selectedTextIds(s).length && !isEditing()) return [];
  const items: ContextMenuItem[] = [];
  if (isEditing()) items.push(...cmds(['type.selectAllText']));
  items.push(...cmds(['type.convertToArea', 'type.convertToPoint', 'type.releasePath', 'type.flipPath']));
  items.push({ label: 'Change Case', children: cmds(['type.caseUpper', 'type.caseLower', 'type.caseTitle', 'type.caseSentence']) });
  items.push({ label: 'Style', children: cmds(['type.bold', 'type.italic', 'type.underline', 'type.strikethrough']) });
  return items;
});
