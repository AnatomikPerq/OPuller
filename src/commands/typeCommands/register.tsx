/**
 * Type menu: Create Outlines, size/style shortcuts, alignment, point/area
 * conversion, change case, type on a path helpers, font upload, panels.
 */
import { getState, type EditorState } from '@/store/store';
import type { ID, TextNode, PathNode } from '@/model/types';
import { addNode, removeNode, indexInParent } from '@/model/document';
import { makeGroup, clonePaint } from '@/model/nodes';
import { multiply, translate } from '@/geometry/matrix';
import { transformSubPaths, reverseSubPath } from '@/geometry/path';
import { registerCommands } from '@/commands/registry';
import { layoutText } from '@/text/layout';
import { changeCaseInRange, replaceText, normalizeRuns, type CaseMode } from '@/text/editing';
import { textToOutlinePaths, OutlineError } from '@/text/outline';
import { nearestFace } from '@/text/fonts';
import { readTextStyle, applyTextStyle, selectedTextIds, MIXED } from '@/tools/text/textStyle';
import { isEditing, editingNode, selectionRange, finishEditing, selectAll, commitNow, useTextEdit } from '@/tools/text/session';

function hasText(s: EditorState): boolean {
  return selectedTextIds(s).length > 0 || isEditing();
}

function textTargets(): ID[] {
  const s = getState();
  const e = editingNode();
  if (e && s.editingTextId === e.id) return [e.id];
  return selectedTextIds(s);
}

// ---------------------------------------------------------------------------
// Create Outlines
// ---------------------------------------------------------------------------

export async function createOutlines(): Promise<void> {
  if (isEditing()) finishEditing({ select: true });
  const s = getState();
  const ids = selectedTextIds(s).filter((id) => (s.doc.nodes[id] as TextNode).text.trim().length > 0);
  if (!ids.length) {
    s.toast('Select a text object to create outlines.', 'info');
    return;
  }
  s.setStatus('Creating outlines…');
  const results = new Map<ID, PathNode[]>();
  const errors: string[] = [];
  for (const id of ids) {
    const n = s.doc.nodes[id];
    if (!n || n.type !== 'text') continue;
    try {
      results.set(id, await textToOutlinePaths(s.doc, n));
    } catch (err: any) {
      errors.push(err instanceof OutlineError ? err.message : String(err?.message ?? err));
    }
  }
  s.setStatus('');
  if (errors.length) getState().toast(errors[0], 'error');
  if (!results.size) return;
  const newIds: ID[] = [];
  getState().updateDoc((d) => {
    for (const [id, paths] of results) {
      const n = d.nodes[id];
      if (!n || n.type !== 'text' || !paths.length) continue;
      const group = makeGroup([], { name: n.name, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects, visible: n.visible, locked: n.locked });
      const parent = n.parent;
      const index = indexInParent(d, id);
      removeNode(d, id);
      addNode(d, group, parent, index);
      for (const p of paths) {
        p.subpaths = transformSubPaths(p.subpaths, n.transform);
        addNode(d, p, group.id);
      }
      newIds.push(group.id);
    }
  }, 'Create Outlines');
  getState().setSelection(newIds);
  if (newIds.length) getState().toast(`Created outlines for ${newIds.length} text object${newIds.length > 1 ? 's' : ''}.`, 'success');
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export function convertToArea(ids = textTargets()): void {
  if (isEditing()) finishEditing({ select: true });
  const s = getState();
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n || n.type !== 'text' || n.kind !== 'point') continue;
      const layout = layoutText(n);
      const b = layout.bounds;
      const width = Math.max(10, Math.ceil(b.width + 2));
      const height = Math.max(10, Math.ceil(b.height + 2));
      // keep the text in place: area origin is the top-left corner of the box
      const left = n.style.textAlign === 'center' ? -width / 2 : n.style.textAlign === 'right' ? -width : b.x;
      n.transform = multiply(n.transform, translate(left, b.y));
      n.kind = 'area';
      n.box = { width, height };
    }
  }, 'Convert to Area Type');
}

export function convertToPoint(ids = textTargets()): void {
  if (isEditing()) finishEditing({ select: true });
  const s = getState();
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n || n.type !== 'text' || n.kind !== 'area' || !n.box) continue;
      const layout = layoutText(n);
      // soft wraps become hard returns so the text keeps its shape
      const breaks: number[] = [];
      for (const line of layout.lines) if (!line.paragraphEnd) breaks.push(line.end);
      for (let i = breaks.length - 1; i >= 0; i--) {
        const at = breaks[i];
        if (at > 0 && /[ \t]/.test(n.text[at - 1])) replaceText(n, at - 1, at, '\n');
        else replaceText(n, at, at, '\n');
      }
      const first = layout.lines[0];
      const asc = first ? first.ascent : n.style.fontSize * 0.8;
      const ox = n.style.textAlign === 'center' ? n.box.width / 2 : n.style.textAlign === 'right' ? n.box.width : 0;
      n.transform = multiply(n.transform, translate(ox, asc));
      n.kind = 'point';
      n.box = undefined;
      if (n.style.textAlign === 'justify') n.style = { ...n.style, textAlign: 'left' };
      normalizeRuns(n);
    }
  }, 'Convert to Point Type');
}

// ---------------------------------------------------------------------------
// Type on a path
// ---------------------------------------------------------------------------

function pathTextTargets(): ID[] {
  const s = getState();
  return textTargets().filter((id) => {
    const n = s.doc.nodes[id];
    return n && n.type === 'text' && n.kind === 'path' && !!n.pathId && s.doc.nodes[n.pathId]?.type === 'path';
  });
}

export function flipTypeOnPath(): void {
  const ids = pathTextTargets();
  if (!ids.length) return;
  getState().updateDoc((d) => {
    const done = new Set<ID>();
    for (const id of ids) {
      const n = d.nodes[id] as TextNode;
      const p = d.nodes[n.pathId!] as PathNode;
      if (done.has(p.id)) continue;
      done.add(p.id);
      p.subpaths = p.subpaths.map(reverseSubPath);
      p.shape = undefined;
      n.pathOffset = 1 - (n.pathOffset ?? 0);
    }
  }, 'Flip Type on Path');
}

export function releaseFromPath(): void {
  if (isEditing()) finishEditing({ select: true });
  const ids = pathTextTargets();
  if (!ids.length) return;
  getState().updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id] as TextNode;
      const p = d.nodes[n.pathId!] as PathNode;
      const saved = (p.data as any)?.typeOnPath as { fill?: unknown; stroke?: unknown } | undefined;
      if (saved) {
        if (saved.fill) p.fill = clonePaint(saved.fill as any);
        if (saved.stroke) p.stroke = { ...(saved.stroke as any) };
        const data = { ...(p.data ?? {}) };
        delete (data as any).typeOnPath;
        p.data = Object.keys(data).length ? data : undefined;
      }
      // place the point text at the start of the path
      const start = p.subpaths[0]?.anchors[0]?.point ?? { x: 0, y: 0 };
      const rel = multiply(p.transform, translate(start.x, start.y));
      n.transform = rel;
      n.kind = 'point';
      n.pathId = null;
      n.pathOffset = 0;
    }
  }, 'Release Type from Path');
}

// ---------------------------------------------------------------------------
// Case / style helpers
// ---------------------------------------------------------------------------

export function changeCase(mode: CaseMode): void {
  const s = getState();
  const e = editingNode();
  if (e && s.editingTextId === e.id) {
    const { start, end } = selectionRange();
    const a = end > start ? start : 0;
    const b = end > start ? end : e.text.length;
    s.updateDoc((d) => {
      const n = d.nodes[e.id];
      if (n && n.type === 'text') changeCaseInRange(n, a, b, mode);
    }, 'Change Case');
    return;
  }
  const ids = selectedTextIds(s);
  if (!ids.length) return;
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (n && n.type === 'text') changeCaseInRange(n, 0, n.text.length, mode);
    }
  }, 'Change Case');
}

export function changeFontSize(delta: number): void {
  const info = readTextStyle();
  const size = info.values.fontSize;
  if (size === MIXED) {
    // scale each target individually
    const s = getState();
    const ids = selectedTextIds(s);
    s.updateDoc((d) => {
      for (const id of ids) {
        const n = d.nodes[id];
        if (!n || n.type !== 'text') continue;
        n.style = { ...n.style, fontSize: Math.max(1, n.style.fontSize + delta) };
        for (const r of n.runs ?? []) if (r.style?.fontSize) r.style.fontSize = Math.max(1, r.style.fontSize + delta);
      }
    }, 'Font size');
    return;
  }
  applyTextStyle({ fontSize: Math.max(1, size + delta) });
}

export function toggleBold(): void {
  const info = readTextStyle();
  const w = info.values.fontWeight;
  const family = typeof info.values.fontFamily === 'string' ? info.values.fontFamily : 'Inter';
  const style = typeof info.values.fontStyle === 'string' ? info.values.fontStyle : 'normal';
  const bold = typeof w === 'number' && w >= 600;
  const target = nearestFace(family, bold ? 400 : 700, style);
  applyTextStyle({ fontWeight: target.weight });
}

export function toggleItalic(): void {
  const info = readTextStyle();
  const st = info.values.fontStyle;
  applyTextStyle({ fontStyle: st === 'italic' ? 'normal' : 'italic' });
}

function toggleDecoration(kind: 'underline' | 'line-through'): void {
  const info = readTextStyle();
  applyTextStyle({ textDecoration: info.values.textDecoration === kind ? 'none' : kind });
}

function setAlign(align: TextNode['style']['textAlign']): void {
  applyTextStyle({ textAlign: align });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerCommands([
  { id: 'type.createOutlines', label: 'Create Outlines', menu: 'Type', shortcut: 'mod+shift+o', order: 10, run: createOutlines, enabled: hasText, allowInTextEdit: true },
  { id: 'type.convertToArea', label: 'Convert to Area Type', menu: 'Type', order: 20, separatorBefore: true, run: () => convertToArea(), enabled: (s) => textTargets().some((id) => (s.doc.nodes[id] as TextNode)?.kind === 'point') },
  { id: 'type.convertToPoint', label: 'Convert to Point Type', menu: 'Type', order: 21, run: () => convertToPoint(), enabled: (s) => textTargets().some((id) => (s.doc.nodes[id] as TextNode)?.kind === 'area') },
  { id: 'type.flipPath', label: 'Flip', menu: 'Type/Type on a Path', order: 30, run: flipTypeOnPath, enabled: () => pathTextTargets().length > 0, allowInTextEdit: true },
  { id: 'type.releasePath', label: 'Release from Path', menu: 'Type/Type on a Path', order: 31, run: releaseFromPath, enabled: () => pathTextTargets().length > 0, allowInTextEdit: true },
  { id: 'type.sizeUp', label: 'Increase Font Size', menu: 'Type/Size', shortcut: 'mod+shift+.', order: 40, run: () => changeFontSize(2), enabled: hasText, allowInTextEdit: true },
  { id: 'type.sizeDown', label: 'Decrease Font Size', menu: 'Type/Size', shortcut: 'mod+shift+,', order: 41, run: () => changeFontSize(-2), enabled: hasText, allowInTextEdit: true },
  { id: 'type.bold', label: 'Bold', menu: 'Type/Style', order: 50, run: toggleBold, allowInTextEdit: true, checked: () => { const w = readTextStyle().values.fontWeight; return typeof w === 'number' && w >= 600; } },
  { id: 'type.italic', label: 'Italic', menu: 'Type/Style', shortcut: 'mod+shift+i', order: 51, run: toggleItalic, allowInTextEdit: true, checked: () => readTextStyle().values.fontStyle === 'italic' },
  { id: 'type.underline', label: 'Underline', menu: 'Type/Style', shortcut: 'mod+shift+u', order: 52, run: () => toggleDecoration('underline'), allowInTextEdit: true, checked: () => readTextStyle().values.textDecoration === 'underline' },
  { id: 'type.strikethrough', label: 'Strikethrough', menu: 'Type/Style', order: 53, run: () => toggleDecoration('line-through'), allowInTextEdit: true, checked: () => readTextStyle().values.textDecoration === 'line-through' },
  { id: 'type.alignLeft', label: 'Align Left', menu: 'Type/Align', shortcut: 'mod+shift+l', order: 60, run: () => setAlign('left'), allowInTextEdit: true, checked: () => readTextStyle().values.textAlign === 'left' },
  { id: 'type.alignCenter', label: 'Align Center', menu: 'Type/Align', shortcut: 'mod+shift+c', order: 61, run: () => setAlign('center'), allowInTextEdit: true, checked: () => readTextStyle().values.textAlign === 'center' },
  { id: 'type.alignRight', label: 'Align Right', menu: 'Type/Align', shortcut: 'mod+shift+r', order: 62, run: () => setAlign('right'), allowInTextEdit: true, checked: () => readTextStyle().values.textAlign === 'right' },
  { id: 'type.alignJustify', label: 'Justify', menu: 'Type/Align', shortcut: 'mod+shift+j', order: 63, run: () => setAlign('justify'), allowInTextEdit: true, checked: () => readTextStyle().values.textAlign === 'justify' },
  { id: 'type.caseUpper', label: 'UPPERCASE', menu: 'Type/Change Case', order: 70, run: () => changeCase('upper'), enabled: hasText, allowInTextEdit: true },
  { id: 'type.caseLower', label: 'lowercase', menu: 'Type/Change Case', order: 71, run: () => changeCase('lower'), enabled: hasText, allowInTextEdit: true },
  { id: 'type.caseTitle', label: 'Title Case', menu: 'Type/Change Case', order: 72, run: () => changeCase('title'), enabled: hasText, allowInTextEdit: true },
  { id: 'type.caseSentence', label: 'Sentence case', menu: 'Type/Change Case', order: 73, run: () => changeCase('sentence'), enabled: hasText, allowInTextEdit: true },
  { id: 'type.selectAllText', label: 'Select All Text', hidden: true, run: () => selectAll(), enabled: () => isEditing(), allowInTextEdit: true },
  { id: 'type.commit', label: 'Commit Text Editing', hidden: true, run: () => { commitNow(); finishEditing({ select: true, switchToSelect: true }); }, enabled: () => isEditing(), allowInTextEdit: true },
  { id: 'type.uploadFont', label: 'Upload Font…', menu: 'Type', order: 90, separatorBefore: true, run: () => getState().openDialog('fontUpload', { applyToSelection: false }), allowInTextEdit: true },
  { id: 'type.characterPanel', label: 'Character Panel', menu: 'Type', shortcut: 'mod+t', order: 100, separatorBefore: true, run: () => getState().togglePanel('character'), allowInTextEdit: true },
  { id: 'type.paragraphPanel', label: 'Paragraph Panel', menu: 'Type', shortcut: 'mod+alt+t', order: 101, run: () => getState().togglePanel('paragraph'), allowInTextEdit: true },
]);

void useTextEdit;
