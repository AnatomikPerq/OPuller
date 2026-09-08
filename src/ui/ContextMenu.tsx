import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { useStore, type ContextMenuItem } from '@/store/store';

/** A list of menu items with submenus. */
export function MenuList({ items, onClose, style, className }: { items: ContextMenuItem[]; onClose: () => void; style?: React.CSSProperties; className?: string }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  return (
    <div ref={ref} className={`menu ${className ?? ''}`} style={style} role="menu" data-keyboard-scope>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-separator" />;
        const hasSub = !!it.children?.length;
        return (
          <div
            key={i}
            className={`menu-item ${it.disabled ? 'disabled' : ''} ${openSub === i ? 'open' : ''}`}
            role="menuitem"
            aria-disabled={it.disabled}
            onPointerEnter={(e) => {
              if (timer.current) clearTimeout(timer.current);
              if (hasSub) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSubPos({ left: r.right - 2, top: r.top - 4 });
                setOpenSub(i);
              } else {
                timer.current = window.setTimeout(() => setOpenSub(null), 150);
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled) return;
              if (hasSub) return;
              it.onSelect?.();
              onClose();
            }}
          >
            {it.checked && (
              <span className="menu-check">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
            <span>{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
            {hasSub && <ChevronRight size={12} className="menu-arrow" />}
            {hasSub && openSub === i && subPos && (
              <SubMenu items={it.children!} onClose={onClose} pos={subPos} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubMenu({ items, onClose, pos }: { items: ContextMenuItem[]; onClose: () => void; pos: { left: number; top: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(pos);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = pos.left;
    let top = pos.top;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, pos.left - r.width - 180);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setP({ left, top });
  }, [pos]);
  return createPortal(
    <div ref={ref} style={{ position: 'fixed', left: p.left, top: p.top, zIndex: 1300 }} onClick={(e) => e.stopPropagation()}>
      <MenuList items={items} onClose={onClose} style={{ position: 'static' }} />
    </div>,
    document.body,
  );
}

export function ContextMenuHost() {
  const menu = useStore((s) => s.contextMenu);
  const close = useStore((s) => s.openContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.('.menu')) return;
      close(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', () => close(null));
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menu, close]);

  if (!menu) return null;
  return createPortal(
    <div ref={ref} className="context-menu" style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}>
      <MenuList items={menu.items} onClose={() => close(null)} style={{ position: 'static' }} />
    </div>,
    document.body,
  );
}
