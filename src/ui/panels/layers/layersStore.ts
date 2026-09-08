/**
 * UI state of the Layers panel that is not part of the document: expansion
 * overrides (so that undo does not collapse rows), the panel-local selection of
 * layer rows, the filter text and the anchor row for shift-range selection.
 */
import { create } from 'zustand';
import { produce } from 'immer';
import type { ID, Node } from '@/model/types';
import { isContainer } from '@/model/types';
import { getState, setState } from '@/store/store';
import { defaultExpanded } from './tree';

export interface LayersUIState {
  expanded: Record<ID, boolean>;
  /** selected layer rows (layers are never part of the artwork selection) */
  layerRows: ID[];
  filter: string;
  anchorRow: ID | null;
  setLayerRows: (ids: ID[]) => void;
  setFilter: (text: string) => void;
  setAnchorRow: (id: ID | null) => void;
}

export const useLayersUI = create<LayersUIState>((set) => ({
  expanded: {},
  layerRows: [],
  filter: '',
  anchorRow: null,
  setLayerRows: (layerRows) => set({ layerRows }),
  setFilter: (filter) => set({ filter }),
  setAnchorRow: (anchorRow) => set({ anchorRow }),
}));

export function isExpanded(id: ID, node: Node): boolean {
  const o = useLayersUI.getState().expanded[id];
  return o !== undefined ? o : defaultExpanded(node);
}

/**
 * Expand/collapse a container. The flag is remembered in the panel and written
 * to the node silently (no history step, no dirty flag) so it survives saving.
 */
export function setNodeExpanded(id: ID, expanded: boolean): void {
  const ui = useLayersUI.getState();
  if (ui.expanded[id] !== expanded) useLayersUI.setState({ expanded: { ...ui.expanded, [id]: expanded } });
  const s = getState();
  const n = s.doc.nodes[id];
  if (!n || !isContainer(n) || n.expanded === expanded) return;
  const next = produce(s.doc, (d) => {
    const nn = d.nodes[id];
    if (isContainer(nn)) nn.expanded = expanded;
  });
  setState({ doc: next, historyBase: s.historyBase === s.doc ? next : s.historyBase });
}

export function toggleNodeExpanded(id: ID): void {
  const n = getState().doc.nodes[id];
  if (!n) return;
  setNodeExpanded(id, !isExpanded(id, n));
}

/** Expand every ancestor of the given nodes (used to reveal the selection). */
export function expandAncestors(ids: ID[]): void {
  const doc = getState().doc;
  for (const id of ids) {
    let cur = doc.nodes[id]?.parent ?? null;
    let guard = 0;
    while (cur && guard++ < 1000) {
      const n = doc.nodes[cur];
      if (!n) break;
      if (!isExpanded(cur, n)) setNodeExpanded(cur, true);
      cur = n.parent;
    }
  }
}

/** Selected layer rows that still exist, or the active layer as a fallback. */
export function selectedLayerIds(): ID[] {
  const s = getState();
  const rows = useLayersUI.getState().layerRows.filter((id) => s.doc.nodes[id]?.type === 'layer');
  if (rows.length) return rows;
  return s.activeLayerId && s.doc.nodes[s.activeLayerId] ? [s.activeLayerId] : [];
}
