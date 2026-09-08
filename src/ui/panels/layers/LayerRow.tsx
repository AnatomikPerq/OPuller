/**
 * One row of the Layers panel. Pure props + a stable handlers object so that
 * React.memo keeps untouched rows from re-rendering.
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, LockOpen, ChevronRight, Layers, Folder, Crop, Square, Circle, Hexagon, Star, Minus, Spline, Type, Image as ImageIcon } from 'lucide-react';
import type { ID, NodeType, LiveShape } from '@/model/types';
import { LayerThumb } from './Thumbnail';

export interface RowHandlers {
  onToggleVisible(id: ID, alt: boolean): void;
  onToggleLock(id: ID, alt: boolean): void;
  onToggleExpand(id: ID, alt: boolean): void;
  onTarget(id: ID, shift: boolean): void;
  onRenameCommit(id: ID, name: string): void;
  onRenameCancel(): void;
  onStartRename(id: ID): void;
  onRowDoubleClick(id: ID): void;
  onContextMenu(id: ID, e: React.MouseEvent): void;
  onPointerDown(id: ID, index: number, e: React.PointerEvent): void;
  onHover(id: ID | null): void;
}

export interface RowProps {
  id: ID;
  index: number;
  depth: number;
  type: NodeType;
  shapeKind: LiveShape['kind'] | null;
  name: string;
  visible: boolean;
  parentVisible: boolean;
  locked: boolean;
  parentLocked: boolean;
  hasChildren: boolean;
  expanded: boolean;
  isClip: boolean;
  color: string;
  /** node itself is selected */
  selected: boolean;
  /** an ancestor is selected (the row is part of a selected object) */
  inSelection: boolean;
  /** some descendant is selected */
  partial: boolean;
  /** active layer */
  active: boolean;
  /** layer row selected in the panel */
  layerSelected: boolean;
  renaming: boolean;
  thumbs: boolean;
  dragging: boolean;
  dropInside: boolean;
  handlers: RowHandlers;
}

function TypeIcon({ type, shapeKind, isClip }: { type: NodeType; shapeKind: LiveShape['kind'] | null; isClip: boolean }) {
  const size = 12;
  if (type === 'layer') return <Layers size={size} />;
  if (type === 'group') return isClip ? <Crop size={size} /> : <Folder size={size} />;
  if (type === 'text') return <Type size={size} />;
  if (type === 'image') return <ImageIcon size={size} />;
  switch (shapeKind) {
    case 'rect':
      return <Square size={size} />;
    case 'ellipse':
      return <Circle size={size} />;
    case 'polygon':
      return <Hexagon size={size} />;
    case 'star':
      return <Star size={size} />;
    case 'line':
      return <Minus size={size} />;
    default:
      return <Spline size={size} />;
  }
}

function RenameInput({ id, name, handlers }: { id: ID; name: string; handlers: RowHandlers }) {
  const [text, setText] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    handlers.onRenameCommit(id, text);
  };
  return (
    <input
      ref={ref}
      value={text}
      data-testid={`layer-rename-${id}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          done.current = true;
          handlers.onRenameCancel();
        }
      }}
    />
  );
}

export const LayerRow = memo(function LayerRow(p: RowProps) {
  const h = p.handlers;
  const cls = [
    'lr-row',
    p.type === 'layer' ? 'layer' : '',
    p.selected || p.inSelection ? 'selected' : '',
    p.layerSelected ? 'layer-selected' : '',
    p.active ? 'active-layer' : '',
    !p.visible || !p.parentVisible ? 'is-hidden' : '',
    p.locked || p.parentLocked ? 'is-locked' : '',
    p.dragging ? 'dragging' : '',
    p.dropInside ? 'drop-inside' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const eyeTitle = p.visible ? 'Toggle visibility (Alt-click: solo)' : 'Show';
  const lockTitle = p.locked ? 'Unlock' : 'Toggle lock (Alt-click: lock others)';
  return (
    <div
      className={cls}
      data-row-id={p.id}
      data-row-index={p.index}
      data-testid={`layer-row-${p.id}`}
      style={{ ['--depth' as string]: p.depth }}
      onPointerDown={(e) => h.onPointerDown(p.id, p.index, e)}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.lr-name')) return;
        h.onRowDoubleClick(p.id);
      }}
      onContextMenu={(e) => h.onContextMenu(p.id, e)}
      onPointerEnter={() => h.onHover(p.id)}
      onPointerLeave={() => h.onHover(null)}
    >
      <button
        type="button"
        className={`lr-toggle ${!p.visible ? 'off' : ''} ${p.visible && !p.parentVisible ? 'inherited' : ''}`}
        title={eyeTitle}
        data-testid={`layer-eye-${p.id}`}
        aria-pressed={p.visible}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          h.onToggleVisible(p.id, e.altKey);
        }}
      >
        {p.visible ? <Eye size={13} /> : <EyeOff size={13} className="ghost" />}
      </button>
      <button
        type="button"
        className={`lr-toggle ${p.locked ? 'on' : ''} ${!p.locked && p.parentLocked ? 'inherited' : ''}`}
        title={lockTitle}
        data-testid={`layer-lock-${p.id}`}
        aria-pressed={p.locked}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          h.onToggleLock(p.id, e.altKey);
        }}
      >
        {p.locked ? <Lock size={12} /> : p.parentLocked ? <Lock size={12} /> : <LockOpen size={12} className="ghost" />}
      </button>
      <span className="lr-color" style={{ background: p.color }} />
      <span className="lr-indent" />
      <span
        className={`lr-disclosure ${p.hasChildren ? 'has-children' : ''} ${p.expanded ? 'open' : ''}`}
        data-testid={p.hasChildren ? `layer-expand-${p.id}` : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (p.hasChildren) h.onToggleExpand(p.id, e.altKey);
        }}
        title={p.hasChildren ? (p.expanded ? 'Collapse (Alt: all)' : 'Expand (Alt: all)') : undefined}
      >
        {p.hasChildren && <ChevronRight size={12} />}
      </span>
      {p.thumbs ? <LayerThumb id={p.id} /> : <span style={{ width: 4 }} />}
      <span className="lr-type">
        <TypeIcon type={p.type} shapeKind={p.shapeKind} isClip={p.isClip} />
      </span>
      <span className="lr-name" onDoubleClick={(e) => { e.stopPropagation(); h.onStartRename(p.id); }} title={p.name}>
        {p.renaming ? (
          <RenameInput id={p.id} name={p.name} handlers={h} />
        ) : (
          <>
            {p.name}
            {p.isClip && <span className="lr-clip-tag">(clip)</span>}
          </>
        )}
      </span>
      <span className={`lr-selmark ${p.selected || p.inSelection ? 'full' : p.partial ? 'partial' : ''}`} style={{ background: p.color }} />
      <button
        type="button"
        className={`lr-target ${p.selected ? 'on' : ''}`}
        title={p.type === 'layer' ? 'Select all artwork on this layer (Shift: add)' : 'Select this object (Shift: add/remove)'}
        data-testid={`layer-target-${p.id}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          h.onTarget(p.id, e.shiftKey);
        }}
      />
    </div>
  );
});
