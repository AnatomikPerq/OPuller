import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useStore, getState, type ContextMenuItem } from '@/store/store';
import { menuTree, MENU_ORDER, runCommand, isEnabled, onCommandsChanged, type Command } from '@/commands/registry';
import { shortcutLabel } from '@/util/keys';
import { MenuList } from './ContextMenu';
import { panelsSnapshot, onPanelsChanged } from './panels/registry';

function commandItem(c: Command, s: ReturnType<typeof getState>): ContextMenuItem {
  const sc = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut;
  return {
    label: c.label,
    shortcut: shortcutLabel(sc),
    disabled: !isEnabled(c, s),
    checked: c.checked ? c.checked(s) : undefined,
    onSelect: () => runCommand(c.id),
  };
}

function buildMenu(top: string): ContextMenuItem[] {
  const s = getState();
  const tree = menuTree();
  const entries = tree.get(top) ?? [];
  const items: ContextMenuItem[] = [];
  for (const e of entries) {
    if ('submenu' in e) {
      items.push({ label: e.submenu, children: e.items.map((c) => commandItem(c, s)) });
    } else {
      if (e.separatorBefore && items.length) items.push({ separator: true });
      items.push(commandItem(e, s));
    }
  }
  if (top === 'Window') {
    if (items.length) items.push({ separator: true });
    for (const p of panelsSnapshot()) {
      items.push({
        label: p.title,
        checked: s.panels[p.id] ?? p.defaultVisible ?? true,
        shortcut: shortcutLabel(p.shortcut),
        onSelect: () => getState().togglePanel(p.id),
      });
    }
  }
  return items;
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const barRef = useRef<HTMLDivElement>(null);
  // re-render when commands/panels register or state changes affecting enabled flags
  useSyncExternalStore(onCommandsChanged, () => menuTree().size, () => 0);
  useSyncExternalStore(onPanelsChanged, () => panelsSnapshot().length, () => 0);
  useStore((s) => s.selection.length);
  useStore((s) => s.past.length);
  useStore((s) => s.future.length);
  useStore((s) => s.view);
  useStore((s) => s.panels);
  const dirty = useStore((s) => s.dirty);
  const fileName = useStore((s) => s.fileName);
  const docName = useStore((s) => s.doc.name);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('.menu') || t.closest?.('.menu-trigger')) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${fileName ?? docName} — OPuller`;
  }, [dirty, fileName, docName]);

  const menus = MENU_ORDER.filter((m) => menuTree().has(m) || m === 'Window' || m === 'Help');

  const openMenu = (name: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 2 });
    setOpen(name);
  };

  return (
    <div className="menubar" ref={barRef} role="menubar">
      <button type="button" className="app-logo" title="Home — projects, recent files, samples" onClick={() => runCommand('file.home')} data-testid="home-button">
        <img src="/favicon.svg" alt="" />
        <span>OPuller</span>
      </button>
      {menus.map((m) => (
        <button
          key={m}
          className={`menu-trigger ${open === m ? 'open' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault();
            if (open === m) setOpen(null);
            else openMenu(m, e.currentTarget);
          }}
          onPointerEnter={(e) => {
            if (open && open !== m) openMenu(m, e.currentTarget);
          }}
        >
          {m}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <span className="muted small" style={{ paddingRight: 6 }}>
        {dirty ? '• ' : ''}
        {fileName ?? docName}
      </span>
      {open &&
        createPortal(
          <div style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1000 }}>
            <MenuList items={buildMenu(open)} onClose={() => setOpen(null)} style={{ position: 'static' }} />
          </div>,
          document.body,
        )}
    </div>
  );
}
