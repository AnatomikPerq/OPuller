/**
 * Tool auto-registration. Every `src/tools/<name>/tool.tsx` module exporting
 * `tool` (a Tool) or `tools` (Tool[]) is registered automatically.
 */
import { registerTools } from './registry';
import type { Tool } from './types';

const modules = import.meta.glob<{ tool?: Tool; tools?: Tool[]; default?: Tool | Tool[] }>('./*/tool.tsx', { eager: true });

const list: Tool[] = [];
for (const path of Object.keys(modules).sort()) {
  const mod = modules[path];
  if (mod.tools) list.push(...mod.tools);
  if (mod.tool) list.push(mod.tool);
  if (!mod.tool && !mod.tools && mod.default) {
    if (Array.isArray(mod.default)) list.push(...mod.default);
    else list.push(mod.default);
  }
}
registerTools(list);

export * from './registry';
export * from './types';
