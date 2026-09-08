export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

/**
 * Normalize a keyboard event to a shortcut string like "ctrl+shift+z" or "shift+m".
 * "mod" in definitions means ctrl on Windows/Linux and cmd on macOS.
 */
export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  const primary = IS_MAC ? e.metaKey : e.ctrlKey;
  if (primary) parts.push('mod');
  if (IS_MAC ? e.ctrlKey : e.metaKey) parts.push(IS_MAC ? 'ctrl' : 'meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  if (key === 'arrowup') key = 'up';
  if (key === 'arrowdown') key = 'down';
  if (key === 'arrowleft') key = 'left';
  if (key === 'arrowright') key = 'right';
  if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return parts.join('+');
  // use the physical key for letters/digits so layouts (e.g. Cyrillic) still work
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Semicolon') key = ';';
  else if (e.code === 'Quote') key = "'";
  else if (e.code === 'Backquote') key = '`';
  parts.push(key);
  return parts.join('+');
}

/** Normalize a definition like "Ctrl+Shift+Z" / "mod+z" to the canonical form. */
export function normalizeShortcut(def: string): string {
  const parts = def
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  let key = '';
  for (const p of parts) {
    if (p === 'mod' || p === 'cmd' || p === 'command' || p === 'ctrl' || p === 'control') mods.push(p === 'ctrl' || p === 'control' ? (IS_MAC ? 'ctrl' : 'mod') : 'mod');
    else if (p === 'alt' || p === 'option') mods.push('alt');
    else if (p === 'shift') mods.push('shift');
    else if (p === 'meta' || p === 'win') mods.push(IS_MAC ? 'mod' : 'meta');
    else key = p === 'escape' ? 'esc' : p === 'plus' ? '=' : p;
  }
  const order = ['mod', 'ctrl', 'meta', 'alt', 'shift'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return Array.from(new Set(mods)).concat(key ? [key] : []).join('+');
}

/** Human readable label for menus. */
export function shortcutLabel(def: string | undefined): string {
  if (!def) return '';
  const n = normalizeShortcut(def);
  return n
    .split('+')
    .map((p) => {
      switch (p) {
        case 'mod':
          return IS_MAC ? '⌘' : 'Ctrl';
        case 'ctrl':
          return IS_MAC ? '⌃' : 'Ctrl';
        case 'meta':
          return 'Win';
        case 'alt':
          return IS_MAC ? '⌥' : 'Alt';
        case 'shift':
          return IS_MAC ? '⇧' : 'Shift';
        case 'esc':
          return 'Esc';
        case 'space':
          return 'Space';
        case 'up':
          return '↑';
        case 'down':
          return '↓';
        case 'left':
          return '←';
        case 'right':
          return '→';
        case 'delete':
          return 'Del';
        case 'backspace':
          return '⌫';
        case 'enter':
          return 'Enter';
        default:
          return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
      }
    })
    .join(IS_MAC ? '' : '+');
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return !!t.closest('[data-keyboard-scope]');
}
