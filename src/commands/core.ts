/**
 * Core Edit / Object / Select commands.
 */
import { produce } from 'immer';
import { getState } from '@/store/store';
import type { Document, ID, Node, Paint } from '@/model/types';
import { isContainer } from '@/model/types';
import {
  removeNode,
  cloneSubtree,
  addSubtree,
  indexInParent,
  groupNodes,
  ungroupNode,
  moveNode,
  sortByPaintOrder,
  topmostOf,
  selectableNodes,
  getChildren,
  applyWorldMatrix,
  bakeTransform,
  descendants,
  worldMatrix,
  parentWorldMatrix,
  selectionBounds,
} from '@/model/document';
import { makeGroup, createDocument } from '@/model/nodes';
import { translate, multiply, invert } from '@/geometry/matrix';
import { registerCommands, when } from './registry';
import { insertionParent } from '@/tools/shapes/tool';

// ---------------------------------------------------------------------------
// Internal clipboard
// ---------------------------------------------------------------------------

interface ClipboardData {
  /** serialized subtrees (root first) with world-space transforms */
  items: Array<{ root: Node; nodes: Node[] }>;
  /** bounds at copy time */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** cut counter for paste offset */
  pasteCount: number;
}

let clipboard: ClipboardData | null = null;
let externalCopy: ((ids: ID[]) => void) | null = null;

/** IO module can hook system-clipboard SVG export here. */
export function setExternalCopyHandler(fn: ((ids: ID[]) => void) | null): void {
  externalCopy = fn;
}

export function hasClipboard(): boolean {
  return !!clipboard && clipboard.items.length > 0;
}

export function copySelection(): void {
  const s = getState();
  const ids = sortByPaintOrder(s.doc, topmostOf(s.doc, s.selection)).filter((id) => s.doc.nodes[id]?.type !== 'layer');
  if (!ids.length) return;
  const items = ids.map((id) => {
    const { root, nodes } = cloneSubtree(s.doc, id);
    // express the root in world space so it can be pasted anywhere
    root.transform = worldMatrix(s.doc, id);
    root.parent = null;
    return { root, nodes };
  });
  clipboard = { items, bounds: selectionBounds(s.doc, ids), pasteCount: 0 };
  externalCopy?.(ids);
  s.setStatus(`Copied ${ids.length} object${ids.length > 1 ? 's' : ''}`);
}

export function cutSelection(): void {
  copySelection();
  deleteSelection();
}

export interface PasteOptions {
  inPlace?: boolean;
  /** paste in front/back of the selection */
  position?: 'front' | 'back';
  /** offset for repeated pastes */
  offset?: { x: number; y: number };
  /** paste into the target container */
  into?: ID | null;
}

export function pasteClipboard(opts: PasteOptions = {}): ID[] {
  const s = getState();
  if (!clipboard || !clipboard.items.length) return [];
  const clip = clipboard;
  const newIds: ID[] = [];
  let parent: ID | null = opts.into ?? null;
  let index: number | undefined;
  if (!parent && opts.position && s.selection.length) {
    const ref = opts.position === 'front' ? sortByPaintOrder(s.doc, s.selection).pop()! : sortByPaintOrder(s.doc, s.selection)[0];
    parent = s.doc.nodes[ref].parent;
    index = indexInParent(s.doc, ref) + (opts.position === 'front' ? 1 : 0);
  }
  if (!parent) parent = insertionParent();
  if (!parent) return [];
  // offset: paste in place keeps world coords; otherwise nudge by 10px per paste,
  // or centre in the view when the copy is outside the viewport
  let offset = opts.offset ?? { x: 0, y: 0 };
  if (!opts.inPlace && !opts.offset) {
    clip.pasteCount++;
    offset = { x: 10 * clip.pasteCount, y: 10 * clip.pasteCount };
    if (clip.bounds) {
      const vw = s.viewportSize;
      const viewRect = { x: -s.pan.x / s.zoom, y: -s.pan.y / s.zoom, width: vw.width / s.zoom, height: vw.height / s.zoom };
      const b = clip.bounds;
      const visible = b.x + b.width > viewRect.x && b.x < viewRect.x + viewRect.width && b.y + b.height > viewRect.y && b.y < viewRect.y + viewRect.height;
      if (!visible) offset = { x: viewRect.x + viewRect.width / 2 - (b.x + b.width / 2), y: viewRect.y + viewRect.height / 2 - (b.y + b.height / 2) };
    }
  }
  s.updateDoc((d) => {
    const pw = parentWorldMatrix(d, parent!);
    const inv = invert(multiply(pw, d.nodes[parent!].transform));
    clip.items.forEach((item, i) => {
      // fresh ids for every paste
      const tmp: Document = { ...d, nodes: { ...d.nodes } };
      for (const n of item.nodes) tmp.nodes[n.id] = n;
      const { root, nodes } = cloneSubtree(tmp, item.root.id);
      root.transform = multiply(inv, multiply(translate(offset.x, offset.y), root.transform));
      addSubtree(d, root, nodes, parent!, index !== undefined ? index + i : undefined);
      if (root.type === 'path') bakeTransform(d, root.id);
      newIds.push(root.id);
    });
  }, 'Paste');
  s.setSelection(newIds);
  return newIds;
}

// ---------------------------------------------------------------------------
// Selection editing
// ---------------------------------------------------------------------------

export function deleteSelection(): void {
  const s = getState();
  const ids = topmostOf(s.doc, s.selection);
  if (!ids.length) return;
  if (s.selectedAnchors.length && s.activeTool === 'direct') {
    // handled by the direct selection tool (delete anchors)
    return;
  }
  s.updateDoc((d) => {
    for (const id of ids) {
      if (d.nodes[id]?.type === 'layer' && d.layers.length <= 1) continue;
      removeNode(d, id);
    }
    if (!d.layers.length) {
      const layer = { ...createDocument().nodes[createDocument().layers[0]] };
      d.nodes[layer.id] = layer;
      d.layers.push(layer.id);
    }
  }, 'Delete');
  s.clearSelection();
}

export function duplicateSelection(offset = { x: 0, y: 0 }): ID[] {
  const s = getState();
  const ids = sortByPaintOrder(s.doc, topmostOf(s.doc, s.selection)).filter((id) => s.doc.nodes[id]?.type !== 'layer');
  if (!ids.length) return [];
  const newIds: ID[] = [];
  s.updateDoc((d) => {
    for (const id of ids) {
      const { root, nodes } = cloneSubtree(d, id);
      addSubtree(d, root, nodes, d.nodes[id].parent, indexInParent(d, id) + 1);
      if (offset.x || offset.y) applyWorldMatrix(d, root.id, translate(offset.x, offset.y));
      newIds.push(root.id);
    }
  }, 'Duplicate');
  s.setSelection(newIds);
  return newIds;
}

export function selectAll(): void {
  const s = getState();
  s.setSelection(s.isolationId ? getChildren(s.doc, s.isolationId).filter((id) => !s.doc.nodes[id].locked && s.doc.nodes[id].visible) : selectableNodes(s.doc));
}

export function nudgeSelection(dx: number, dy: number): void {
  const s = getState();
  const ids = topmostOf(s.doc, s.selection);
  if (!ids.length) return;
  s.updateDoc((d) => {
    for (const id of ids) applyWorldMatrix(d, id, translate(dx, dy));
  });
  // coalesce repeated nudges into one history step per direction burst
  scheduleCommit('Move');
}

let commitTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleCommit(label: string, delay = 400): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    getState().commit(label);
  }, delay);
}

// ---------------------------------------------------------------------------
// Object commands
// ---------------------------------------------------------------------------

export function groupSelection(): ID | null {
  const s = getState();
  const ids = topmostOf(s.doc, s.selection).filter((id) => s.doc.nodes[id]?.type !== 'layer');
  if (!ids.length) return null;
  const g = makeGroup();
  s.updateDoc((d) => {
    groupNodes(d, ids, g);
  }, 'Group');
  s.setSelection([g.id]);
  return g.id;
}

export function ungroupSelection(): void {
  const s = getState();
  const groups = s.selection.filter((id) => s.doc.nodes[id]?.type === 'group');
  if (!groups.length) return;
  const released: ID[] = [];
  const others = s.selection.filter((id) => !groups.includes(id));
  s.updateDoc((d) => {
    for (const g of groups) released.push(...ungroupNode(d, g));
  }, 'Ungroup');
  s.setSelection(others.concat(released));
}

type ArrangeOp = 'front' | 'forward' | 'backward' | 'back';

export function arrangeSelection(op: ArrangeOp): void {
  const s = getState();
  const ids = sortByPaintOrder(s.doc, topmostOf(s.doc, s.selection)).filter((id) => s.doc.nodes[id]?.type !== 'layer');
  if (!ids.length) return;
  s.updateDoc((d) => {
    const list = op === 'front' || op === 'forward' ? [...ids].reverse() : ids;
    for (const id of list) {
      const parent = d.nodes[id].parent;
      const siblings = getChildren(d, parent);
      const i = siblings.indexOf(id);
      let target = i;
      if (op === 'front') target = siblings.length;
      else if (op === 'back') target = 0;
      else if (op === 'forward') {
        // skip over other selected siblings
        target = i + 1;
        while (target < siblings.length && ids.includes(siblings[target])) target++;
        if (target >= siblings.length) target = siblings.length;
        else target += 1;
      } else if (op === 'backward') {
        target = i - 1;
        while (target >= 0 && ids.includes(siblings[target])) target--;
        if (target < 0) target = 0;
      }
      moveNode(d, id, parent, target);
    }
  }, op === 'front' ? 'Bring to Front' : op === 'back' ? 'Send to Back' : op === 'forward' ? 'Bring Forward' : 'Send Backward');
}

export function setLocked(ids: ID[], locked: boolean): void {
  getState().updateDoc((d) => {
    for (const id of ids) if (d.nodes[id]) d.nodes[id].locked = locked;
  }, locked ? 'Lock' : 'Unlock');
}

export function setHidden(ids: ID[], hidden: boolean): void {
  getState().updateDoc((d) => {
    for (const id of ids) if (d.nodes[id]) d.nodes[id].visible = !hidden;
  }, hidden ? 'Hide' : 'Show');
}

export function unlockAll(): void {
  const s = getState();
  const ids: ID[] = [];
  s.updateDoc((d) => {
    for (const n of Object.values(d.nodes)) {
      if (n.locked && n.type !== 'layer') {
        n.locked = false;
        ids.push(n.id);
      }
    }
  }, 'Unlock All');
  if (ids.length) s.setSelection(ids);
}

export function showAll(): void {
  const s = getState();
  const ids: ID[] = [];
  s.updateDoc((d) => {
    for (const n of Object.values(d.nodes)) {
      if (!n.visible && n.type !== 'layer') {
        n.visible = true;
        ids.push(n.id);
      }
    }
  }, 'Show All');
  if (ids.length) s.setSelection(ids);
}

// ---------------------------------------------------------------------------
// Select menu
// ---------------------------------------------------------------------------

function paintKey(p: Paint): string {
  return JSON.stringify(p);
}

export function selectSame(what: 'fill' | 'stroke' | 'strokeWidth' | 'fillStroke' | 'opacity' | 'blend' | 'type' | 'fontFamily'): void {
  const s = getState();
  const ref = s.selection.map((id) => s.doc.nodes[id]).find((n) => n && (n.type === 'path' || n.type === 'text'));
  if (!ref && what !== 'type' && what !== 'opacity' && what !== 'blend') return;
  const first = s.doc.nodes[s.selection[0]];
  if (!first) return;
  const matches = (n: Node): boolean => {
    switch (what) {
      case 'type':
        return n.type === first.type;
      case 'opacity':
        return n.opacity === first.opacity;
      case 'blend':
        return n.blendMode === first.blendMode;
      case 'fill':
        return (n.type === 'path' || n.type === 'text') && ref !== undefined && paintKey(n.fill) === paintKey((ref as any).fill);
      case 'stroke':
        return (n.type === 'path' || n.type === 'text') && ref !== undefined && paintKey(n.stroke.paint) === paintKey((ref as any).stroke.paint);
      case 'strokeWidth':
        return (n.type === 'path' || n.type === 'text') && ref !== undefined && n.stroke.width === (ref as any).stroke.width;
      case 'fillStroke':
        return (n.type === 'path' || n.type === 'text') && ref !== undefined && paintKey(n.fill) === paintKey((ref as any).fill) && paintKey(n.stroke.paint) === paintKey((ref as any).stroke.paint) && n.stroke.width === (ref as any).stroke.width;
      case 'fontFamily':
        return n.type === 'text' && ref?.type === 'text' && n.style.fontFamily === ref.style.fontFamily;
    }
  };
  const candidates = selectableNodes(s.doc, true);
  const out: ID[] = [];
  for (const id of candidates) {
    const n = s.doc.nodes[id];
    if (n && matches(n)) out.push(id);
  }
  s.setSelection(out);
}

export function selectInverse(): void {
  const s = getState();
  const all = selectableNodes(s.doc);
  const sel = new Set(s.selection);
  s.setSelection(all.filter((id) => !sel.has(id)));
}

export function selectByType(type: Node['type']): void {
  const s = getState();
  s.setSelection(selectableNodes(s.doc, true).filter((id) => s.doc.nodes[id]?.type === type));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerCommands([
  { id: 'edit.undo', label: 'Undo', menu: 'Edit', shortcut: 'mod+z', order: 1, run: () => getState().undo(), enabled: when.canUndo, allowInTextEdit: false },
  { id: 'edit.redo', label: 'Redo', menu: 'Edit', shortcut: ['mod+shift+z', 'mod+y'], order: 2, run: () => getState().redo(), enabled: when.canRedo },
  { id: 'edit.cut', label: 'Cut', menu: 'Edit', shortcut: 'mod+x', order: 10, separatorBefore: true, run: cutSelection, enabled: when.hasSelection },
  { id: 'edit.copy', label: 'Copy', menu: 'Edit', shortcut: 'mod+c', order: 11, run: copySelection, enabled: when.hasSelection },
  { id: 'edit.paste', label: 'Paste', menu: 'Edit', shortcut: 'mod+v', order: 12, run: () => pasteClipboard(), enabled: () => hasClipboard() },
  { id: 'edit.pasteInFront', label: 'Paste in Front', menu: 'Edit', shortcut: 'mod+f', order: 13, run: () => pasteClipboard({ inPlace: true, position: 'front' }), enabled: () => hasClipboard() },
  { id: 'edit.pasteInBack', label: 'Paste in Back', menu: 'Edit', shortcut: 'mod+b', order: 14, run: () => pasteClipboard({ inPlace: true, position: 'back' }), enabled: () => hasClipboard() },
  { id: 'edit.pasteInPlace', label: 'Paste in Place', menu: 'Edit', shortcut: 'mod+shift+v', order: 15, run: () => pasteClipboard({ inPlace: true }), enabled: () => hasClipboard() },
  { id: 'edit.duplicate', label: 'Duplicate', menu: 'Edit', shortcut: 'mod+d', order: 16, run: () => duplicateSelection({ x: 10, y: 10 }), enabled: when.hasSelection },
  { id: 'edit.delete', label: 'Delete', menu: 'Edit', shortcut: ['delete', 'backspace'], order: 17, run: deleteSelection, enabled: when.hasSelection },
  { id: 'edit.nudgeUp', label: 'Nudge Up', shortcut: 'up', hidden: true, run: () => nudgeSelection(0, -getState().prefs.nudge), enabled: when.hasSelection },
  { id: 'edit.nudgeDown', label: 'Nudge Down', shortcut: 'down', hidden: true, run: () => nudgeSelection(0, getState().prefs.nudge), enabled: when.hasSelection },
  { id: 'edit.nudgeLeft', label: 'Nudge Left', shortcut: 'left', hidden: true, run: () => nudgeSelection(-getState().prefs.nudge, 0), enabled: when.hasSelection },
  { id: 'edit.nudgeRight', label: 'Nudge Right', shortcut: 'right', hidden: true, run: () => nudgeSelection(getState().prefs.nudge, 0), enabled: when.hasSelection },
  { id: 'edit.nudgeUpBig', label: 'Nudge Up ×10', shortcut: 'shift+up', hidden: true, run: () => nudgeSelection(0, -getState().prefs.bigNudge), enabled: when.hasSelection },
  { id: 'edit.nudgeDownBig', label: 'Nudge Down ×10', shortcut: 'shift+down', hidden: true, run: () => nudgeSelection(0, getState().prefs.bigNudge), enabled: when.hasSelection },
  { id: 'edit.nudgeLeftBig', label: 'Nudge Left ×10', shortcut: 'shift+left', hidden: true, run: () => nudgeSelection(-getState().prefs.bigNudge, 0), enabled: when.hasSelection },
  { id: 'edit.nudgeRightBig', label: 'Nudge Right ×10', shortcut: 'shift+right', hidden: true, run: () => nudgeSelection(getState().prefs.bigNudge, 0), enabled: when.hasSelection },

  { id: 'select.all', label: 'All', menu: 'Select', shortcut: 'mod+a', order: 1, run: selectAll },
  { id: 'select.none', label: 'Deselect', menu: 'Select', shortcut: 'mod+shift+a', order: 2, run: () => getState().clearSelection(), enabled: when.hasSelection },
  { id: 'select.inverse', label: 'Inverse', menu: 'Select', shortcut: 'mod+alt+i', order: 3, run: selectInverse },
  { id: 'select.sameFill', label: 'Fill Color', menu: 'Select/Same', order: 10, run: () => selectSame('fill'), enabled: when.hasSelection },
  { id: 'select.sameStroke', label: 'Stroke Color', menu: 'Select/Same', order: 11, run: () => selectSame('stroke'), enabled: when.hasSelection },
  { id: 'select.sameStrokeWidth', label: 'Stroke Weight', menu: 'Select/Same', order: 12, run: () => selectSame('strokeWidth'), enabled: when.hasSelection },
  { id: 'select.sameFillStroke', label: 'Fill & Stroke', menu: 'Select/Same', order: 13, run: () => selectSame('fillStroke'), enabled: when.hasSelection },
  { id: 'select.sameOpacity', label: 'Opacity', menu: 'Select/Same', order: 14, run: () => selectSame('opacity'), enabled: when.hasSelection },
  { id: 'select.sameBlend', label: 'Blending Mode', menu: 'Select/Same', order: 15, run: () => selectSame('blend'), enabled: when.hasSelection },
  { id: 'select.sameFont', label: 'Font Family', menu: 'Select/Same', order: 16, run: () => selectSame('fontFamily'), enabled: when.hasTextSelection },
  { id: 'select.allText', label: 'All Text Objects', menu: 'Select/Object', order: 20, run: () => selectByType('text') },
  { id: 'select.allPaths', label: 'All Paths', menu: 'Select/Object', order: 21, run: () => selectByType('path') },
  { id: 'select.allImages', label: 'All Images', menu: 'Select/Object', order: 22, run: () => selectByType('image') },
  { id: 'select.allGroups', label: 'All Groups', menu: 'Select/Object', order: 23, run: () => selectByType('group') },

  { id: 'object.group', label: 'Group', menu: 'Object', shortcut: 'mod+g', order: 100, run: groupSelection, enabled: when.hasSelection },
  { id: 'object.ungroup', label: 'Ungroup', menu: 'Object', shortcut: 'mod+shift+g', order: 101, run: ungroupSelection, enabled: when.hasGroupSelection },
  { id: 'object.bringToFront', label: 'Bring to Front', menu: 'Object/Arrange', shortcut: 'mod+shift+]', order: 110, run: () => arrangeSelection('front'), enabled: when.hasSelection },
  { id: 'object.bringForward', label: 'Bring Forward', menu: 'Object/Arrange', shortcut: 'mod+]', order: 111, run: () => arrangeSelection('forward'), enabled: when.hasSelection },
  { id: 'object.sendBackward', label: 'Send Backward', menu: 'Object/Arrange', shortcut: 'mod+[', order: 112, run: () => arrangeSelection('backward'), enabled: when.hasSelection },
  { id: 'object.sendToBack', label: 'Send to Back', menu: 'Object/Arrange', shortcut: 'mod+shift+[', order: 113, run: () => arrangeSelection('back'), enabled: when.hasSelection },
  { id: 'object.lock', label: 'Lock Selection', menu: 'Object/Lock', shortcut: 'mod+2', order: 120, run: () => { const s = getState(); setLocked(s.selection, true); s.clearSelection(); }, enabled: when.hasSelection },
  { id: 'object.unlockAll', label: 'Unlock All', menu: 'Object/Lock', shortcut: 'mod+alt+2', order: 121, run: unlockAll },
  { id: 'object.hide', label: 'Hide Selection', menu: 'Object/Hide', shortcut: 'mod+3', order: 130, run: () => { const s = getState(); setHidden(s.selection, true); s.clearSelection(); }, enabled: when.hasSelection },
  { id: 'object.showAll', label: 'Show All', menu: 'Object/Hide', shortcut: 'mod+alt+3', order: 131, run: showAll },
  { id: 'object.isolate', label: 'Isolate Selected Group', menu: 'Object', order: 140, run: () => { const s = getState(); const g = s.selection.find((id) => s.doc.nodes[id]?.type === 'group'); if (g) s.setIsolation(g); }, enabled: when.hasGroupSelection },
  { id: 'object.exitIsolation', label: 'Exit Isolation Mode', menu: 'Object', order: 141, run: () => getState().setIsolation(null), enabled: (s) => !!s.isolationId },
]);

/** Helper used by other modules: ids of paths in selection (descending into groups). */
export function selectedPathIds(): ID[] {
  const s = getState();
  const out: ID[] = [];
  for (const id of s.selection) for (const d of descendants(s.doc, id, true)) if (s.doc.nodes[d]?.type === 'path') out.push(d);
  return Array.from(new Set(out));
}

export { isContainer, produce };
