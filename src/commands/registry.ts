/**
 * Command registry: menus, shortcuts, context menus and panels all run commands
 * through here so behaviour stays consistent.
 */
import { normalizeShortcut } from '@/util/keys';
import type { EditorState } from '@/store/store';
import { getState } from '@/store/store';

export interface Command {
  id: string;
  label: string;
  /** menu path, e.g. "Object/Arrange" */
  menu?: string;
  shortcut?: string | string[];
  /** ordering within the menu */
  order?: number;
  /** separator before this item in menus */
  separatorBefore?: boolean;
  run: (arg?: unknown) => void | Promise<void>;
  enabled?: (s: EditorState) => boolean;
  checked?: (s: EditorState) => boolean;
  /** hide from menus */
  hidden?: boolean;
  /** allow while editing text */
  allowInTextEdit?: boolean;
}

const commands = new Map<string, Command>();
const byShortcut = new Map<string, Command>();
const listeners = new Set<() => void>();

export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
  const shortcuts = Array.isArray(cmd.shortcut) ? cmd.shortcut : cmd.shortcut ? [cmd.shortcut] : [];
  for (const s of shortcuts) byShortcut.set(normalizeShortcut(s), cmd);
  listeners.forEach((l) => l());
}

export function registerCommands(list: Command[]): void {
  for (const c of list) registerCommand(c);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function allCommands(): Command[] {
  return Array.from(commands.values());
}

export function commandForShortcut(shortcut: string): Command | undefined {
  return byShortcut.get(shortcut);
}

export function isEnabled(cmd: Command, s = getState()): boolean {
  return cmd.enabled ? cmd.enabled(s) : true;
}

export function runCommand(id: string, arg?: unknown): boolean {
  const cmd = commands.get(id);
  if (!cmd) {
    console.warn('Unknown command', id);
    return false;
  }
  if (!isEnabled(cmd)) return false;
  try {
    const r = cmd.run(arg);
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch((err) => {
        console.error(err);
        getState().toast(String(err?.message ?? err), 'error');
      });
    }
  } catch (err: any) {
    console.error(err);
    getState().toast(String(err?.message ?? err), 'error');
  }
  return true;
}

export function onCommandsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Commands grouped by top-level menu and sub-menu, sorted by order. */
export function menuTree(): Map<string, Array<Command | { submenu: string; items: Command[] }>> {
  const tree = new Map<string, Array<Command | { submenu: string; items: Command[] }>>();
  const list = allCommands().filter((c) => c.menu && !c.hidden).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const c of list) {
    const [top, sub] = c.menu!.split('/');
    if (!tree.has(top)) tree.set(top, []);
    const arr = tree.get(top)!;
    if (sub) {
      let entry = arr.find((e) => 'submenu' in e && e.submenu === sub) as { submenu: string; items: Command[] } | undefined;
      if (!entry) {
        entry = { submenu: sub, items: [] };
        arr.push(entry);
      }
      entry.items.push(c);
    } else arr.push(c);
  }
  return tree;
}

/** Fixed order of top-level menus. */
export const MENU_ORDER = ['File', 'Edit', 'Object', 'Type', 'Select', 'Effect', 'View', 'Window', 'Help'];

/** Common `enabled` predicates. */
export const when = {
  hasSelection: (s: EditorState) => s.selection.length > 0,
  multiSelection: (s: EditorState) => s.selection.length > 1,
  singleSelection: (s: EditorState) => s.selection.length === 1,
  hasPathSelection: (s: EditorState) => s.selection.some((id) => s.doc.nodes[id]?.type === 'path'),
  hasTextSelection: (s: EditorState) => s.selection.some((id) => s.doc.nodes[id]?.type === 'text'),
  hasGroupSelection: (s: EditorState) => s.selection.some((id) => s.doc.nodes[id]?.type === 'group'),
  canUndo: (s: EditorState) => s.past.length > 0 || s.doc !== s.historyBase,
  canRedo: (s: EditorState) => s.future.length > 0,
};
