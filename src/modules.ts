/**
 * Module auto-loading.
 *
 * Any file named `register.ts` / `register.tsx` under `src/` is imported for its
 * side effects (registering commands, panels, dialogs, viewport slots, ...).
 * Tools are picked up separately from `src/tools/<name>/tool.tsx`.
 *
 * Modules therefore never need to edit a central list: drop a `register.ts`
 * next to your feature and it is wired in.
 */
import './tools';
import './commands/core';
import './commands/viewCommands';
import './commands/appearance';

const registrations = import.meta.glob(['./**/register.ts', './**/register.tsx'], { eager: true });
export const loadedModules = Object.keys(registrations).sort();
