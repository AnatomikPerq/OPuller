/**
 * Object > Expand Appearance: feature modules register expanders that turn a
 * live appearance (brush strokes, warp / 3D effects, ...) of one node into
 * plain artwork. The command runs them over the selection until nothing
 * applies any more.
 */
import type { Document, ID } from '@/model/types';
import { registerCommands, when } from '@/commands/registry';
import { getState } from '@/store/store';

export type Expander = (doc: Document, id: ID) => ID[] | null;

const expanders = new Map<string, Expander>();

export function registerExpander(name: string, fn: Expander): void {
  expanders.set(name, fn);
}

/** Expand the appearance of the given ids (mutates a draft). Returns the resulting ids. */
export function expandAppearance(doc: Document, ids: ID[]): { ids: ID[]; changed: number } {
  let changed = 0;
  let current = [...ids];
  for (let round = 0; round < 8; round++) {
    let any = false;
    const next: ID[] = [];
    for (const id of current) {
      let replaced: ID[] | null = null;
      for (const fn of expanders.values()) {
        const r = fn(doc, id);
        if (r) {
          replaced = r;
          break;
        }
      }
      if (replaced) {
        any = true;
        changed++;
        next.push(...replaced);
      } else next.push(id);
    }
    current = next;
    if (!any) break;
  }
  return { ids: current, changed };
}

export function expandAppearanceCommand(): number {
  const s = getState();
  if (!s.selection.length) return 0;
  let result: { ids: ID[]; changed: number } = { ids: s.selection, changed: 0 };
  s.updateDoc((d) => {
    result = expandAppearance(d, s.selection);
  }, 'Expand Appearance');
  const st = getState();
  if (!result.changed) st.toast('Nothing to expand: no brush strokes or live geometry effects in the selection', 'info');
  else st.setSelection(result.ids.filter((id) => !!st.doc.nodes[id]));
  return result.changed;
}

registerCommands([{ id: 'object.expandAppearance', label: 'Expand Appearance', menu: 'Object', order: 61, run: () => expandAppearanceCommand(), enabled: when.hasSelection }]);
