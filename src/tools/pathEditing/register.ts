/**
 * Commands of the anchor editing module (Direct Selection / Pen / Anchor tools).
 */
import './pathEditing.css';
import { getState } from '@/store/store';
import type { EditorState } from '@/store/store';
import { registerCommands, when } from '@/commands/registry';
import { deleteAnchors, allAnchorRefs, validAnchors, convertAnchor, dedupeRefs, editablePathIds } from './anchors';

const hasAnchors = (s: EditorState) => s.selectedAnchors.length > 0;

/** Delete the selected anchors (Delete key in the Direct Selection tool). */
export function deleteSelectedAnchors(): void {
  const s = getState();
  const refs = validAnchors(s.doc, dedupeRefs(s.selectedAnchors));
  if (!refs.length) return;
  let removed: string[] = [];
  s.updateDoc((d) => {
    removed = deleteAnchors(d, refs).removedNodes;
  }, refs.length > 1 ? 'Delete Anchors' : 'Delete Anchor');
  const st = getState();
  st.setSelection(
    st.selection.filter((id) => !removed.includes(id)),
    [],
  );
}

/** Select every anchor of the selected paths (and their group children). */
export function selectAllAnchors(): void {
  const s = getState();
  const ids = editablePathIds(s.doc, s.selection);
  if (!ids.length) return;
  s.setSelectedAnchors(allAnchorRefs(s.doc, ids));
}

export function convertSelectedAnchors(kind: 'smooth' | 'corner'): void {
  const s = getState();
  const refs = validAnchors(s.doc, dedupeRefs(s.selectedAnchors));
  if (!refs.length) return;
  s.updateDoc((d) => {
    for (const r of refs) convertAnchor(d, r, kind);
  }, kind === 'smooth' ? 'Convert to Smooth' : 'Convert to Corner');
}

registerCommands([
  { id: 'path.deleteAnchors', label: 'Delete Anchor Points', hidden: true, run: deleteSelectedAnchors, enabled: hasAnchors },
  { id: 'path.selectAllAnchors', label: 'All Anchor Points', menu: 'Select', order: 4, run: selectAllAnchors, enabled: when.hasPathSelection },
  { id: 'path.anchorsToSmooth', label: 'Convert Anchors to Smooth', menu: 'Object/Path', order: 70, separatorBefore: true, run: () => convertSelectedAnchors('smooth'), enabled: hasAnchors },
  { id: 'path.anchorsToCorner', label: 'Convert Anchors to Corner', menu: 'Object/Path', order: 71, run: () => convertSelectedAnchors('corner'), enabled: hasAnchors },
]);
