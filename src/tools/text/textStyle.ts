/**
 * Reading and applying text styles for the Character/Paragraph panels, the
 * Options bar and the Type commands. Targets, in order:
 *  - the selected range while editing (run overrides),
 *  - the whole selected text objects (including text inside selected groups),
 *  - the appearance defaults for new text when nothing is selected.
 */
import { getState, useStore, type EditorState } from '@/store/store';
import type { ID, TextNode, TextStyle } from '@/model/types';
import { descendants } from '@/model/document';
import { setTextStyle } from '@/commands/appearance';
import { resolveRuns } from '@/text/layout';
import { stylesInRange, NODE_LEVEL_KEYS } from '@/text/editing';
import { useTextEdit, editingNode, selectionRange, applyStyleWhileEditing, styleAtCaret, hasRangeSelection } from './session';

export const MIXED = Symbol('mixed');
export type Mixed = typeof MIXED;

export type StyleValues = { [K in keyof TextStyle]: TextStyle[K] | Mixed };

export type StyleTarget = 'range' | 'caret' | 'nodes' | 'defaults';

export interface TextStyleInfo {
  values: StyleValues;
  target: StyleTarget;
  /** text node ids affected */
  ids: ID[];
  /** kinds of the affected nodes */
  kinds: Array<TextNode['kind']>;
}

/** Text node ids in the selection (descending into groups). */
export function selectedTextIds(s: EditorState = getState()): ID[] {
  const out: ID[] = [];
  for (const id of s.selection) for (const d of descendants(s.doc, id, true)) if (s.doc.nodes[d]?.type === 'text' && !out.includes(d)) out.push(d);
  return out;
}

function aggregate(samples: TextStyle[], nodeLevel?: TextStyle[]): StyleValues {
  const first = samples[0];
  const out = { ...first } as StyleValues;
  for (const key of Object.keys(first) as Array<keyof TextStyle>) {
    const pool = NODE_LEVEL_KEYS.includes(key) && nodeLevel ? nodeLevel : samples;
    const v = pool[0][key];
    (out as any)[key] = pool.every((st) => st[key] === v) ? v : MIXED;
  }
  return out;
}

/** Current text style for the UI (mixed values are marked with MIXED). */
export function readTextStyle(s: EditorState = getState()): TextStyleInfo {
  const editing = editingNode();
  if (editing && s.editingTextId === editing.id) {
    const { start, end } = selectionRange();
    if (end > start && editing.kind !== 'path') {
      return { values: aggregate(stylesInRange(editing, start, end), [editing.style]), target: 'range', ids: [editing.id], kinds: [editing.kind] };
    }
    const st = styleAtCaret() ?? editing.style;
    return { values: aggregate([st], [editing.style]), target: 'caret', ids: [editing.id], kinds: [editing.kind] };
  }
  const ids = selectedTextIds(s);
  if (ids.length) {
    const samples: TextStyle[] = [];
    const nodeLevel: TextStyle[] = [];
    const kinds: Array<TextNode['kind']> = [];
    for (const id of ids) {
      const n = s.doc.nodes[id] as TextNode;
      nodeLevel.push(n.style);
      kinds.push(n.kind);
      const runs = resolveRuns(n).filter((r) => r.text.length > 0);
      if (runs.length) for (const r of runs) samples.push(r.style);
      else samples.push(n.style);
    }
    return { values: aggregate(samples, nodeLevel), target: 'nodes', ids, kinds };
  }
  return { values: aggregate([s.appearance.textStyle]), target: 'defaults', ids: [], kinds: [] };
}

/** Hook version: recomputes on selection/doc/editing changes. */
export function useTextStyleInfo(): TextStyleInfo {
  useStore((s) => s.selection);
  useStore((s) => s.docVersion);
  useStore((s) => s.editingTextId);
  useStore((s) => s.appearance.textStyle);
  useTextEdit((s) => s.caret);
  useTextEdit((s) => s.anchor);
  useTextEdit((s) => s.pendingStyle);
  return readTextStyle();
}

/**
 * Apply a style patch to the current target. `commit` false leaves the change
 * uncommitted (scrubbing); call `getState().commit(label)` afterwards.
 */
export function applyTextStyle(patch: Partial<TextStyle>, commit = true): void {
  // drop keys that would not change anything (a blurred field re-applying its
  // value must not create a phantom history step)
  const current = readTextStyle().values;
  const effective: Partial<TextStyle> = {};
  for (const k of Object.keys(patch) as Array<keyof TextStyle>) {
    const v = (patch as any)[k];
    if (v !== undefined && current[k] !== MIXED && current[k] === v) continue;
    (effective as any)[k] = v;
  }
  if (!Object.keys(effective).length) return;
  patch = effective;
  const editing = editingNode();
  if (editing && getState().editingTextId === editing.id) {
    const nodeLevelOnly = Object.keys(patch).every((k) => NODE_LEVEL_KEYS.includes(k as keyof TextStyle));
    if (nodeLevelOnly || (!hasRangeSelection() && editing.text.length === 0)) {
      getState().updateDoc((d) => {
        const n = d.nodes[editing.id];
        if (n && n.type === 'text') {
          n.style = { ...n.style, ...patch };
          for (const r of n.runs ?? []) if (r.style) for (const k of Object.keys(patch)) delete (r.style as any)[k];
        }
      }, commit ? 'Text style' : undefined);
      return;
    }
    applyStyleWhileEditing(patch, commit);
    return;
  }
  setTextStyle(patch, commit);
}

export function num(v: number | Mixed | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

export function isMixed(v: unknown): boolean {
  return v === MIXED;
}
