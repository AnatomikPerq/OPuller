/**
 * Canvas context menu: built from registered commands so every module's
 * commands can appear here by adding their ids to the lists below or by
 * calling `addContextMenuSection`.
 */
import { registerContextMenuBuilder } from '@/canvas/viewportSlots';
import { getCommand, isEnabled, runCommand } from '@/commands/registry';
import { getState, type ContextMenuItem } from '@/store/store';
import { shortcutLabel } from '@/util/keys';
import type { HitResult } from '@/canvas/hitTest';
import type { Vec } from '@/model/types';

type Section = (hit: HitResult | null, world: Vec) => ContextMenuItem[];

const sections: Section[] = [];

/** Modules can contribute extra sections (each returns items; a separator is added automatically). */
export function addContextMenuSection(fn: Section): void {
  sections.push(fn);
}

function cmd(id: string, label?: string): ContextMenuItem | null {
  const c = getCommand(id);
  if (!c) return null;
  const s = getState();
  const sc = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut;
  return { label: label ?? c.label, shortcut: shortcutLabel(sc), disabled: !isEnabled(c, s), checked: c.checked?.(s), onSelect: () => runCommand(c.id) };
}

function cmds(ids: string[]): ContextMenuItem[] {
  return ids.map((id) => cmd(id)).filter((x): x is ContextMenuItem => !!x);
}

registerContextMenuBuilder((hit, world) => {
  const s = getState();
  const items: ContextMenuItem[] = [];
  const hasSel = s.selection.length > 0;
  if (hasSel) {
    items.push(...cmds(['edit.undo', 'edit.redo']));
    items.push({ separator: true });
    items.push(...cmds(['edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteInPlace', 'edit.duplicate', 'edit.delete']));
    items.push({ separator: true });
    items.push({ label: 'Arrange', children: cmds(['object.bringToFront', 'object.bringForward', 'object.sendBackward', 'object.sendToBack']) });
    items.push({ label: 'Transform', children: cmds(['object.transformDialog', 'object.transformAgain', 'object.rotate90cw', 'object.rotate90ccw', 'object.flipH', 'object.flipV', 'object.resetTransform']) });
    items.push(...cmds(['object.group', 'object.ungroup', 'object.isolate']));
    items.push({ separator: true });
    items.push({ label: 'Path', children: cmds(['path.join', 'path.average', 'path.outlineStroke', 'path.offset', 'path.simplify', 'path.addAnchors', 'path.reverse', 'path.compoundMake', 'path.compoundRelease']) });
    items.push({ label: 'Pathfinder', children: cmds(['pathfinder.unite', 'pathfinder.minusFront', 'pathfinder.intersect', 'pathfinder.exclude', 'pathfinder.divide', 'pathfinder.trim', 'pathfinder.merge', 'pathfinder.crop', 'pathfinder.outline', 'pathfinder.minusBack']) });
    items.push(...cmds(['object.clipMake', 'object.clipRelease', 'type.createOutlines', 'object.expand', 'object.rasterize', 'image.trace']));
    items.push({ separator: true });
    items.push(...cmds(['object.lock', 'object.hide']));
  } else {
    items.push(...cmds(['edit.undo', 'edit.redo']));
    items.push({ separator: true });
    items.push(...cmds(['edit.paste', 'edit.pasteInPlace', 'select.all']));
    items.push({ separator: true });
    items.push(...cmds(['object.unlockAll', 'object.showAll']));
    items.push({ separator: true });
    items.push(...cmds(['view.rulers', 'view.grid', 'view.guides', 'view.smartGuides', 'view.outline']));
    items.push({ separator: true });
    items.push(...cmds(['view.fitArtboard', 'view.fitAll', 'view.actualSize', 'file.documentSetup']));
  }
  for (const sec of sections) {
    const extra = sec(hit, world);
    if (extra.length) {
      items.push({ separator: true });
      items.push(...extra);
    }
  }
  // drop separators at edges / duplicates
  return items.filter((it, i, arr) => !(it.separator && (i === 0 || i === arr.length - 1 || arr[i - 1].separator)));
});
