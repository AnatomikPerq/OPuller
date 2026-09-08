/**
 * Global keyboard handling: tool shortcuts, command shortcuts, temporary tools
 * (Space = hand), modifier notifications for the active tool.
 */
import { getState } from '@/store/store';
import { getTool, toolByShortcut } from '@/tools/registry';
import { commandForShortcut, runCommand, isEnabled } from '@/commands/registry';
import { toolContext } from '@/canvas/toolContext';
import { eventToShortcut, isEditableTarget } from '@/util/keys';
import type { ToolKeyEvent } from '@/tools/types';
import { IS_MAC } from '@/util/keys';

function toToolKeyEvent(e: KeyboardEvent): ToolKeyEvent {
  return {
    key: e.key,
    code: e.code,
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    primary: IS_MAC ? e.metaKey : e.ctrlKey,
    repeat: e.repeat,
    native: e,
  };
}

let spaceDown = false;

export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const s = getState();
    const editable = isEditableTarget(e.target);
    const tool = getTool(s.temporaryTool ?? s.activeTool);
    const shortcut = eventToShortcut(e);

    // Escape always reaches the tool / closes UI
    if (e.key === 'Escape') {
      if (s.contextMenu) {
        s.openContextMenu(null);
        return;
      }
      if (s.dialog) {
        s.closeDialog();
        return;
      }
    }

    if (editable && !s.editingTextId) return; // typing in an input field
    if (s.dialog) return;

    // Text editing: only the text tool sees keys (plus a few global ones)
    if (s.editingTextId) {
      const handled = tool?.onKeyDown?.(toToolKeyEvent(e), toolContext);
      if (handled) {
        e.preventDefault();
        return;
      }
      const cmd = commandForShortcut(shortcut);
      if (cmd && cmd.allowInTextEdit) {
        e.preventDefault();
        runCommand(cmd.id);
      }
      return;
    }

    // Space: temporary hand tool
    if (e.code === 'Space' && !e.repeat && !s.temporaryTool) {
      spaceDown = true;
      if (!tool?.isBusy?.()) {
        s.setTemporaryTool('hand');
        s.setCursor('grab');
      }
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      return;
    }

    // tool gets the first chance
    if (tool?.onKeyDown?.(toToolKeyEvent(e), toolContext)) {
      e.preventDefault();
      return;
    }

    // modifier-only keys
    if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) {
      tool?.onModifiers?.(toToolKeyEvent(e), toolContext);
      if (e.key === 'Alt') e.preventDefault();
      return;
    }

    // commands
    const cmd = commandForShortcut(shortcut);
    if (cmd) {
      e.preventDefault();
      if (isEnabled(cmd, s)) runCommand(cmd.id);
      return;
    }

    // tool shortcuts (single keys / shift+key) — not while busy
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !tool?.isBusy?.()) {
      const t = toolByShortcut(shortcut);
      if (t) {
        e.preventDefault();
        s.setTool(t.id);
        return;
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const s = getState();
    if (e.code === 'Space') {
      spaceDown = false;
      if (s.temporaryTool === 'hand') {
        s.setTemporaryTool(null);
        const t = getTool(s.activeTool);
        s.setCursor(t?.getCursor?.(toolContext) ?? t?.cursor ?? 'default');
      }
      return;
    }
    const tool = getTool(s.temporaryTool ?? s.activeTool);
    if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) {
      tool?.onModifiers?.(toToolKeyEvent(e), toolContext);
      return;
    }
    tool?.onKeyUp?.(toToolKeyEvent(e), toolContext);
  };

  const onBlur = () => {
    const s = getState();
    spaceDown = false;
    if (s.temporaryTool === 'hand') s.setTemporaryTool(null);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}

export function isSpaceDown(): boolean {
  return spaceDown;
}
