/**
 * Inline text editing session: caret/anchor state, editing operations that keep
 * the document in sync (uncommitted `updateDoc` calls, committed on pauses > 1s,
 * on Enter and when the session ends), undo/redo while editing and the sync
 * with `store.editingTextId` (which other modules — the Selection tool, the
 * Layers panel — use to request editing).
 */
import { create } from 'zustand';
import { getState, useStore } from '@/store/store';
import type { ID, TextNode, TextStyle } from '@/model/types';
import { removeNode, isEditable } from '@/model/document';
import { replaceText, wordLeft, wordRight, moveLine, applyStyleToRange, applyStyleToNode, resolvedStyleAt, autoTextName, lineStart, lineEnd, normalizeRuns } from '@/text/editing';
import { ensureLoaded } from '@/text/fonts';
import { layoutFor } from '@/text/outline';

export interface TextEditState {
  id: ID | null;
  /** active end of the selection */
  caret: number;
  /** fixed end of the selection (== caret when collapsed) */
  anchor: number;
  /** x (local) remembered for vertical navigation */
  preferredX: number | null;
  /** style applied to the next typed characters (set by the Character panel with a collapsed caret) */
  pendingStyle: Partial<TextStyle> | null;
  composing: boolean;
  /** text/name when editing started (auto names follow the content) */
  originalText: string;
  originalName: string;
}

export const useTextEdit = create<TextEditState>(() => ({
  id: null,
  caret: 0,
  anchor: 0,
  preferredX: null,
  pendingStyle: null,
  composing: false,
  originalText: '',
  originalName: '',
}));

let commitTimer: ReturnType<typeof setTimeout> | null = null;
let suppressSync = false;
let focusImpl: (() => void) | null = null;

/** The hidden textarea registers its focus function here. */
export function setInputFocusImpl(fn: (() => void) | null): void {
  focusImpl = fn;
}

export function focusInput(): void {
  focusImpl?.();
}

export function isEditing(): boolean {
  return !!useTextEdit.getState().id;
}

export function editingId(): ID | null {
  return useTextEdit.getState().id;
}

export function editingNode(): TextNode | null {
  const id = useTextEdit.getState().id;
  if (!id) return null;
  const n = getState().doc.nodes[id];
  return n && n.type === 'text' ? n : null;
}

export function selectionRange(): { start: number; end: number } {
  const st = useTextEdit.getState();
  return { start: Math.min(st.caret, st.anchor), end: Math.max(st.caret, st.anchor) };
}

export function hasRangeSelection(): boolean {
  const r = selectionRange();
  return r.end > r.start;
}

function clampIndex(n: TextNode | null, i: number): number {
  const len = n ? n.text.length : 0;
  return Math.max(0, Math.min(len, Math.round(i)));
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Start editing a text node. `caret` defaults to the end of the text; pass
 * `anchor` to start with a selection (e.g. 0 to select everything).
 */
export function startEditing(id: ID, caret?: number, anchor?: number): void {
  const s = getState();
  const n = s.doc.nodes[id];
  if (!n || n.type !== 'text') return;
  if (!isEditable(s.doc, id)) {
    s.toast('This text is locked or hidden.', 'info');
    if (s.editingTextId === id) s.setEditingText(null);
    return;
  }
  const st = useTextEdit.getState();
  if (st.id && st.id !== id) finishEditing({ select: false });
  const c = clampIndex(n, caret ?? n.text.length);
  const a = clampIndex(n, anchor ?? c);
  useTextEdit.setState({ id, caret: c, anchor: a, preferredX: null, pendingStyle: null, composing: false, originalText: n.text, originalName: n.name });
  suppressSync = true;
  try {
    if (s.editingTextId !== id) s.setEditingText(id);
    if (!(s.selection.length === 1 && s.selection[0] === id)) s.setSelection([id]);
  } finally {
    suppressSync = false;
  }
  void ensureLoaded(n.style.fontFamily, n.style.fontWeight, n.style.fontStyle);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => focusInput());
}

export interface FinishOptions {
  /** keep the object selected after editing */
  select?: boolean;
  /** switch to the Selection tool */
  switchToSelect?: boolean;
}

/** End the session: commit pending edits, remove the object when it stayed empty. */
export function finishEditing(opts: FinishOptions = {}): void {
  const st = useTextEdit.getState();
  const id = st.id;
  if (!id) return;
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  useTextEdit.setState({ id: null, caret: 0, anchor: 0, preferredX: null, pendingStyle: null, composing: false });
  const s = getState();
  const n = s.doc.nodes[id];
  suppressSync = true;
  try {
    if (n && n.type === 'text') {
      if (n.text.length === 0) {
        if (!s.historyBase.nodes[id]) {
          // created during this session and never committed: drop it with the pending changes
          s.revert();
          if (getState().selection.includes(id)) getState().setSelection(getState().selection.filter((x) => x !== id));
        } else {
          s.updateDoc((d) => removeNode(d, id), 'Delete Empty Text');
        }
      } else {
        s.updateDoc((d) => {
          const nn = d.nodes[id];
          if (!nn || nn.type !== 'text') return;
          if (nn.name === autoTextName(st.originalText) || nn.name === st.originalName) nn.name = autoTextName(nn.text);
          normalizeRuns(nn);
        });
        s.commit('Type');
        if (opts.select) s.setSelection([id]);
      }
    }
    if (getState().editingTextId === id) getState().setEditingText(null);
    if (opts.switchToSelect) getState().setTool('select');
  } finally {
    suppressSync = false;
  }
}

// keep the session in sync with store.editingTextId (set by other modules)
useStore.subscribe(
  (s) => s.editingTextId,
  (id) => {
    if (suppressSync) return;
    const st = useTextEdit.getState();
    if (id && id !== st.id) {
      if (getState().activeTool === 'text') startEditing(id, undefined, 0);
    } else if (!id && st.id) {
      finishEditing({ select: false });
    }
  },
);

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export function scheduleCommit(delay = 1000): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    getState().commit('Type');
  }, delay);
}

export function commitNow(label = 'Type'): void {
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  getState().commit(label);
}

// ---------------------------------------------------------------------------
// Caret / selection
// ---------------------------------------------------------------------------

export function setCaret(caret: number, anchor = caret, preferredX: number | null = null): void {
  const n = editingNode();
  useTextEdit.setState({ caret: clampIndex(n, caret), anchor: clampIndex(n, anchor), preferredX, pendingStyle: null });
}

export function selectAll(): void {
  const n = editingNode();
  if (!n) return;
  useTextEdit.setState({ anchor: 0, caret: n.text.length, preferredX: null, pendingStyle: null });
}

export type CaretMove = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'docStart' | 'docEnd';

export function moveCaret(kind: CaretMove, extend: boolean, word = false): void {
  const n = editingNode();
  if (!n) return;
  const st = useTextEdit.getState();
  const { start, end } = selectionRange();
  const text = n.text;
  let next = st.caret;
  let preferredX: number | null = null;
  switch (kind) {
    case 'left':
      if (!extend && end > start) next = start;
      else next = word ? wordLeft(text, st.caret) : Math.max(0, st.caret - 1);
      break;
    case 'right':
      if (!extend && end > start) next = end;
      else next = word ? wordRight(text, st.caret) : Math.min(text.length, st.caret + 1);
      break;
    case 'up':
    case 'down': {
      const r = moveLine(n.kind === 'path' ? { ...n, kind: 'point' } : n, st.caret, kind === 'up' ? -1 : 1, st.preferredX);
      next = r.index;
      preferredX = r.x;
      break;
    }
    case 'home':
      next = lineStart(layoutFor(n), st.caret, n.style);
      break;
    case 'end':
      next = lineEnd(layoutFor(n), st.caret, n.style);
      break;
    case 'docStart':
      next = 0;
      break;
    case 'docEnd':
      next = text.length;
      break;
  }
  next = clampIndex(n, next);
  useTextEdit.setState({ caret: next, anchor: extend ? st.anchor : next, preferredX, pendingStyle: null });
}

// ---------------------------------------------------------------------------
// Editing operations (uncommitted; committed on pause / exit)
// ---------------------------------------------------------------------------

function edit(fn: (n: TextNode) => void): void {
  const id = useTextEdit.getState().id;
  if (!id) return;
  getState().updateDoc((d) => {
    const n = d.nodes[id];
    if (n && n.type === 'text') fn(n);
  });
}

/** Insert text at the caret (replacing the selection). */
export function insertText(text: string): void {
  const n = editingNode();
  if (!n || !text) return;
  const st = useTextEdit.getState();
  const { start, end } = selectionRange();
  const pending = st.pendingStyle;
  edit((node) => replaceText(node, start, end, text, pending));
  const caret = start + text.length;
  useTextEdit.setState({ caret, anchor: caret, preferredX: null, pendingStyle: null });
  if (text.includes('\n')) commitNow();
  else scheduleCommit();
}

/** Delete the selection, or one character/word before the caret. */
export function deleteBackward(word = false): void {
  const n = editingNode();
  if (!n) return;
  const st = useTextEdit.getState();
  let { start, end } = selectionRange();
  if (end === start) {
    if (start === 0) return;
    start = word ? wordLeft(n.text, start) : start - 1;
  }
  const keepStyle = resolvedStyleAtOverride(n, end);
  edit((node) => replaceText(node, start, end, ''));
  useTextEdit.setState({ caret: start, anchor: start, preferredX: null, pendingStyle: st.pendingStyle ?? keepStyle });
  scheduleCommit();
}

/** Delete the selection, or one character/word after the caret. */
export function deleteForward(word = false): void {
  const n = editingNode();
  if (!n) return;
  let { start, end } = selectionRange();
  if (end === start) {
    if (end >= n.text.length) return;
    end = word ? wordRight(n.text, end) : end + 1;
  }
  edit((node) => replaceText(node, start, end, ''));
  useTextEdit.setState({ caret: start, anchor: start, preferredX: null });
  scheduleCommit();
}

/** When the whole text is deleted, remember its style so re-typing keeps it. */
function resolvedStyleAtOverride(n: TextNode, index: number): Partial<TextStyle> | null {
  if (n.text.length === 0) return null;
  const runs = n.runs && n.runs.length ? n.runs : [{ text: n.text }];
  let pos = 0;
  for (const r of runs) {
    const e = pos + r.text.length;
    if (index <= e && index > pos) return r.style ? { ...r.style } : null;
    pos = e;
  }
  return null;
}

export function replaceSelection(text: string): void {
  insertText(text);
}

export function selectedText(): string {
  const n = editingNode();
  if (!n) return '';
  const { start, end } = selectionRange();
  return n.text.slice(start, end);
}

/**
 * Apply a style patch while editing: to the selected range (run overrides), or —
 * with a collapsed caret — as the typing style (or to the whole object when it
 * is empty / a path text, which cannot carry run styles).
 */
export function applyStyleWhileEditing(patch: Partial<TextStyle>, commit = true): void {
  const n = editingNode();
  if (!n) return;
  const { start, end } = selectionRange();
  const whole = n.kind === 'path' || n.text.length === 0 || (start === 0 && end === n.text.length);
  if (whole) {
    edit((node) => applyStyleToNode(node, patch));
  } else if (end > start) {
    edit((node) => applyStyleToRange(node, start, end, patch));
  } else {
    const st = useTextEdit.getState();
    useTextEdit.setState({ pendingStyle: { ...(st.pendingStyle ?? {}), ...patch } });
    return;
  }
  if (commit) commitNow('Character');
}

/** Resolved style at the caret including the pending typing style. */
export function styleAtCaret(): TextStyle | null {
  const n = editingNode();
  if (!n) return null;
  const st = useTextEdit.getState();
  return { ...resolvedStyleAt(n, st.caret), ...(st.pendingStyle ?? {}) };
}

// ---------------------------------------------------------------------------
// Undo / redo while editing
// ---------------------------------------------------------------------------

function afterHistory(id: ID, prev: TextEditState): void {
  const s = getState();
  const n = s.doc.nodes[id];
  if (n && n.type === 'text') {
    if (s.editingTextId !== id) s.setEditingText(id);
    if (!(s.selection.length === 1 && s.selection[0] === id)) s.setSelection([id]);
    useTextEdit.setState({ id, caret: clampIndex(n, prev.caret), anchor: clampIndex(n, prev.anchor), preferredX: null, pendingStyle: null });
  } else {
    useTextEdit.setState({ id: null, caret: 0, anchor: 0, preferredX: null, pendingStyle: null });
    if (s.editingTextId) s.setEditingText(null);
  }
}

export function undoWhileEditing(): void {
  const st = useTextEdit.getState();
  const id = st.id;
  if (!id) return;
  commitNow();
  suppressSync = true;
  try {
    getState().undo();
    afterHistory(id, st);
  } finally {
    suppressSync = false;
  }
}

export function redoWhileEditing(): void {
  const st = useTextEdit.getState();
  const id = st.id;
  if (!id) return;
  commitNow();
  suppressSync = true;
  try {
    getState().redo();
    afterHistory(id, st);
  } finally {
    suppressSync = false;
  }
}
