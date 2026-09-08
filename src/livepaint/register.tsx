/**
 * Live Paint wiring: Object > Live Paint commands (Make, Release, Expand,
 * Select faces / edges) and the scripting API.
 */
import { registerCommands, when, type Command } from '@/commands/registry';
import { getState, type EditorState } from '@/store/store';
import type { ID } from '@/model/types';
import { makeLivePaint, releaseLivePaint, expandLivePaint, isLivePaintGroup, livePaintGroupOf, livePaintParts } from './ops';

export function makeLivePaintCommand(ids?: ID[]): ID | null {
  const s = getState();
  const targets = ids ?? s.selection;
  if (!targets.length) {
    s.toast('Select paths to make a Live Paint group', 'info');
    return null;
  }
  let gid: ID | null = null;
  s.updateDoc((d) => {
    gid = makeLivePaint(d, targets);
  }, 'Make Live Paint');
  if (gid) getState().setSelection([gid]);
  return gid;
}

function groupsOf(s: EditorState): ID[] {
  return Array.from(new Set(s.selection.map((id) => livePaintGroupOf(s.doc, id)).filter((g): g is ID => !!g)));
}

const hasGroup = (s: EditorState) => groupsOf(s).length > 0;

const commands: Command[] = [
  { id: 'livepaint.make', label: 'Make', menu: 'Object/Live Paint', shortcut: 'mod+alt+x', order: 750, run: () => makeLivePaintCommand(), enabled: (s) => when.hasSelection(s) && !hasGroup(s) },
  {
    id: 'livepaint.release',
    label: 'Release',
    menu: 'Object/Live Paint',
    order: 751,
    run: () => {
      const s = getState();
      const groups = groupsOf(s);
      let out: ID[] = [];
      s.updateDoc((d) => {
        for (const g of groups) out = out.concat(releaseLivePaint(d, g));
      }, 'Release Live Paint');
      getState().setSelection(out);
    },
    enabled: hasGroup,
  },
  {
    id: 'livepaint.expand',
    label: 'Expand',
    menu: 'Object/Live Paint',
    order: 752,
    run: () => {
      const s = getState();
      const groups = groupsOf(s);
      s.updateDoc((d) => {
        for (const g of groups) expandLivePaint(d, g);
      }, 'Expand Live Paint');
      getState().setSelection(groups);
    },
    enabled: hasGroup,
  },
  { id: 'livepaint.selectFaces', label: 'Select All Faces', menu: 'Object/Live Paint', order: 753, separatorBefore: true, run: () => { const s = getState(); const ids = groupsOf(s).flatMap((g) => livePaintParts(s.doc, g).faces); s.setSelection(ids); }, enabled: hasGroup },
  { id: 'livepaint.selectEdges', label: 'Select All Edges', menu: 'Object/Live Paint', order: 754, run: () => { const s = getState(); const ids = groupsOf(s).flatMap((g) => livePaintParts(s.doc, g).edges); s.setSelection(ids); }, enabled: hasGroup },
];
registerCommands(commands);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  livepaint: { makeLivePaint, releaseLivePaint, expandLivePaint, isLivePaintGroup, livePaintGroupOf, livePaintParts, makeLivePaintCommand },
};
