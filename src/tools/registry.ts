import type { Tool } from './types';
export type { Tool };

const tools = new Map<string, Tool>();
const listeners = new Set<() => void>();

export function registerTool(tool: Tool): void {
  tools.set(tool.id, tool);
  listeners.forEach((l) => l());
}

export function registerTools(list: Tool[]): void {
  for (const t of list) tools.set(t.id, t);
  listeners.forEach((l) => l());
}

export function getTool(id: string): Tool | undefined {
  return tools.get(id);
}

export function allTools(): Tool[] {
  return Array.from(tools.values()).sort((a, b) => a.order - b.order);
}

/** Toolbar groups: ordered list of [groupId, tools[]]. */
export function toolGroups(): Array<{ id: string; tools: Tool[] }> {
  const groups = new Map<string, Tool[]>();
  for (const t of allTools()) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group)!.push(t);
  }
  return Array.from(groups.entries())
    .map(([id, list]) => ({ id, tools: list.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.tools[0].order - b.tools[0].order);
}

export function onToolsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Find a tool by shortcut string (normalized "shift+m" form). */
export function toolByShortcut(shortcut: string): Tool | undefined {
  const s = shortcut.toLowerCase();
  for (const t of tools.values()) if (t.shortcut && t.shortcut.toLowerCase() === s) return t;
  return undefined;
}
