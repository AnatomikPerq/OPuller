/**
 * Layers panel: tree of layers / groups / objects (top-most first), visibility &
 * lock toggles, thumbnails, inline rename, selection, drag & drop reordering /
 * reparenting, context menu and footer actions.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SquarePlus, FolderPlus, Trash, Search, X, ChevronsDownUp } from 'lucide-react';
import type { ID, Node } from '@/model/types';
import { isContainer } from '@/model/types';
import { useStore, getState, type ContextMenuItem } from '@/store/store';
import { layerOf, ancestors, descendants, topmostOf, getChildren, isEffectivelyLocked } from '@/model/document';
import { getCommand, isEnabled, runCommand } from '@/commands/registry';
import { shortcutLabel } from '@/util/keys';
import { IconButton } from '@/ui/widgets';
import { LayerRow, type RowHandlers } from './LayerRow';
import { flattenTree, makeNameFilter, rowRange, computeDropTarget, applyDrop, normalizeDragIds, draggingLayers, type LayerRow as RowModel, type DropTarget } from './tree';
import { useLayersUI, isExpanded, setNodeExpanded, toggleNodeExpanded, expandAncestors, selectedLayerIds } from './layersStore';
import { newLayer, newSublayer, deleteLayers, soloVisibility, soloLock, setNodeVisible, setNodeLocked, renameNode, selectContents, lockOthers, hideOthers, mergeLayers, collectInNewLayer, flattenArtwork, duplicateLayers } from '@/commands/layerCommands/ops';
import { deleteSelection } from '@/commands/core';
import './layers.css';

const ROW_H = 26;
const INDENT = 14;
const INDENT_BASE = 48;
const THUMB_LIMIT = 1500;

interface DragState {
  ids: ID[];
  target: DropTarget | null;
}

function cmdItem(id: string, label?: string): ContextMenuItem | null {
  const c = getCommand(id);
  if (!c) return null;
  const s = getState();
  const sc = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut;
  return { label: label ?? c.label, shortcut: shortcutLabel(sc), disabled: !isEnabled(c, s), onSelect: () => runCommand(c.id) };
}

function items(list: Array<ContextMenuItem | null>): ContextMenuItem[] {
  const out = list.filter((x): x is ContextMenuItem => !!x);
  return out.filter((it, i, arr) => !(it.separator && (i === 0 || i === arr.length - 1 || arr[i - 1].separator)));
}

export function LayersPanel() {
  const docVersion = useStore((s) => s.docVersion);
  const selection = useStore((s) => s.selection);
  const activeLayerId = useStore((s) => s.activeLayerId);
  const expandedMap = useLayersUI((s) => s.expanded);
  const filter = useLayersUI((s) => s.filter);
  const layerRows = useLayersUI((s) => s.layerRows);
  const setLayerRows = useLayersUI((s) => s.setLayerRows);
  const setFilter = useLayersUI((s) => s.setFilter);
  const [renaming, setRenaming] = useState<ID | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<RowModel[]>([]);
  const dragRef = useRef<{ ids: ID[]; startX: number; startY: number; active: boolean; pointerId: number; target: DropTarget | null } | null>(null);
  const internalKey = useRef<string>('');

  const doc = getState().doc;
  const rows = useMemo(() => flattenTree(getState().doc, isExpanded, makeNameFilter(filter)), [docVersion, expandedMap, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  rowsRef.current = rows;
  const thumbs = useMemo(() => Object.keys(doc.nodes).length <= THUMB_LIMIT, [docVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // selection lookups
  const selInfo = useMemo(() => {
    const d = getState().doc;
    const selected = new Set(selection);
    const inSelection = new Set<ID>();
    const partial = new Set<ID>();
    for (const id of selection) {
      for (const a of ancestors(d, id)) partial.add(a);
      for (const c of descendants(d, id)) inSelection.add(c);
    }
    return { selected, inSelection, partial };
  }, [selection, docVersion]);

  // reveal selection changes coming from the canvas / commands
  useEffect(() => {
    const key = selection.join(',');
    if (key === internalKey.current) return;
    internalKey.current = key;
    if (!selection.length) return;
    expandAncestors(selection);
    const first = selection[0];
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-row-id="${CSS.escape(first)}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    });
  }, [selection]);

  const markInternal = (ids: ID[]) => {
    internalKey.current = ids.join(',');
  };

  // --- selection logic ----------------------------------------------------
  const clickRow = useCallback(
    (id: ID, mods: { shift: boolean; ctrl: boolean; alt: boolean }) => {
      const s = getState();
      const n = s.doc.nodes[id];
      if (!n) return;
      const ui = useLayersUI.getState();
      if (n.type === 'layer') {
        s.setActiveLayer(id);
        if (mods.alt) {
          const ids = getChildren(s.doc, id).filter((c) => s.doc.nodes[c]?.visible && !s.doc.nodes[c]?.locked);
          markInternal(ids);
          s.setSelection(ids);
        }
        let next: ID[];
        if (mods.ctrl) next = ui.layerRows.includes(id) ? ui.layerRows.filter((x) => x !== id) : ui.layerRows.concat([id]);
        else if (mods.shift && ui.anchorRow && s.doc.nodes[ui.anchorRow]?.type === 'layer') {
          const a = s.doc.layers.indexOf(ui.anchorRow);
          const b = s.doc.layers.indexOf(id);
          next = s.doc.layers.slice(Math.min(a, b), Math.max(a, b) + 1);
        } else next = [id];
        ui.setLayerRows(next);
        ui.setAnchorRow(id);
        return;
      }
      let next: ID[];
      if (mods.ctrl) next = s.selection.includes(id) ? s.selection.filter((x) => x !== id) : s.selection.concat([id]);
      else if (mods.shift && ui.anchorRow && ui.anchorRow !== id) {
        const range = rowRange(rowsRef.current, ui.anchorRow, id);
        const set = new Set(s.selection);
        next = s.selection.concat(range.filter((x) => !set.has(x)));
        next = topmostOf(s.doc, next);
      } else next = [id];
      // never select a node together with one of its ancestors
      next = topmostOf(s.doc, Array.from(new Set(next)));
      markInternal(next);
      s.setSelection(next);
      const layer = layerOf(s.doc, id);
      if (layer && layer.id !== s.activeLayerId) s.setActiveLayer(layer.id);
      if (ui.layerRows.length) ui.setLayerRows([]);
      if (!mods.shift) ui.setAnchorRow(id);
    },
    [],
  );

  // --- context menu -------------------------------------------------------
  const openMenu = useCallback(
    (id: ID, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const s = getState();
      const n = s.doc.nodes[id];
      if (!n) return;
      const isLayer = n.type === 'layer';
      if (isLayer) {
        if (!useLayersUI.getState().layerRows.includes(id)) clickRow(id, { shift: false, ctrl: false, alt: false });
      } else if (!s.selection.includes(id) && !selInfo.inSelection.has(id)) clickRow(id, { shift: false, ctrl: false, alt: false });
      const st = getState();
      const layerIds = selectedLayerIds();
      const menu: Array<ContextMenuItem | null> = [];
      if (isLayer) {
        menu.push({ label: 'Layer Options…', onSelect: () => getState().openDialog('layerOptions', { id }) });
        menu.push({ label: 'Rename', onSelect: () => setRenaming(id) });
        menu.push({ separator: true });
        menu.push({ label: 'New Sublayer', onSelect: () => newSublayer(id) });
        menu.push({ label: layerIds.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer', onSelect: () => duplicateLayers(layerIds) });
        menu.push({ label: layerIds.length > 1 ? 'Delete Layers' : 'Delete Layer', disabled: st.doc.layers.length <= 1, onSelect: () => deleteLayers(layerIds) });
        menu.push({ separator: true });
        menu.push({ label: 'Select All on Layer', onSelect: () => selectContents(id) });
        menu.push({ label: 'Lock Others', onSelect: () => lockOthers(layerIds) });
        menu.push({ label: 'Hide Others', onSelect: () => hideOthers(layerIds) });
        menu.push({ separator: true });
        menu.push({ label: 'Merge Selected Layers', disabled: layerIds.length < 2, onSelect: () => mergeLayers(layerIds) });
        menu.push({ label: 'Flatten Artwork', disabled: st.doc.layers.length < 2, onSelect: () => flattenArtwork(id) });
      } else {
        menu.push({ label: 'Rename', onSelect: () => setRenaming(id) });
        menu.push(cmdItem('edit.duplicate', 'Duplicate'));
        menu.push(cmdItem('edit.delete', 'Delete'));
        menu.push({ separator: true });
        menu.push(cmdItem('object.group', 'Group'));
        menu.push(cmdItem('object.ungroup', 'Ungroup'));
        menu.push(cmdItem('object.isolate', 'Isolate'));
        menu.push(cmdItem('object.clipMake', 'Make Clipping Mask'));
        menu.push(cmdItem('object.clipRelease', 'Release Clipping Mask'));
        menu.push({ separator: true });
        menu.push({ label: 'Lock Others', onSelect: () => lockOthers(getState().selection) });
        menu.push({ label: 'Hide Others', onSelect: () => hideOthers(getState().selection) });
        menu.push({ separator: true });
        menu.push({ label: 'Move to New Layer', onSelect: () => collectInNewLayer() });
        menu.push({ label: 'Merge Selected Layers', disabled: layerIds.length < 2, onSelect: () => mergeLayers(layerIds) });
        menu.push({ label: 'Flatten Artwork', disabled: st.doc.layers.length < 2, onSelect: () => flattenArtwork() });
      }
      st.openContextMenu({ x: e.clientX, y: e.clientY, items: items(menu) });
    },
    [clickRow, selInfo],
  );

  // --- drag & drop --------------------------------------------------------
  const probeAt = (clientX: number, clientY: number) => {
    const list = listRef.current!;
    const r = list.getBoundingClientRect();
    const y = clientY - r.top + list.scrollTop;
    const rowIndex = Math.floor(y / ROW_H);
    const relY = (y - rowIndex * ROW_H) / ROW_H;
    return { rowIndex, relY: Math.max(0, Math.min(1, relY)), x: clientX - r.left, indent: INDENT, indentBase: INDENT_BASE };
  };

  const endDrag = useCallback((apply: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || !d.active) return;
    if (apply && d.target) {
      const s = getState();
      const target = d.target;
      const moved: ID[] = [];
      s.updateDoc((doc) => {
        moved.push(...applyDrop(doc, d.ids, target));
      }, draggingLayers(s.doc, d.ids) ? 'Reorder Layers' : 'Move in Layers');
      if (moved.length && !draggingLayers(s.doc, d.ids)) {
        markInternal(moved);
        s.setSelection(moved);
        if (target.parent) {
          const layer = layerOf(getState().doc, target.parent);
          if (layer) s.setActiveLayer(layer.id);
          setNodeExpanded(target.parent, true);
        }
      }
    }
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !listRef.current) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
        d.active = true;
        setRenaming(null);
      }
      const list = listRef.current;
      const r = list.getBoundingClientRect();
      // auto-scroll near the edges
      if (e.clientY < r.top + 18) list.scrollTop -= 8;
      else if (e.clientY > r.bottom - 18) list.scrollTop += 8;
      const probe = probeAt(e.clientX, e.clientY);
      const target = probe.rowIndex < 0 || probe.rowIndex >= rowsRef.current.length ? null : computeDropTarget(getState().doc, rowsRef.current, d.ids, probe);
      d.target = target;
      setDrag({ ids: d.ids, target });
    };
    const up = () => endDrag(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current?.active) {
        e.stopPropagation();
        endDrag(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
  }, [endDrag]);

  // --- row handlers (stable) ------------------------------------------------
  const handlers = useMemo<RowHandlers>(
    () => ({
      onToggleVisible: (id, alt) => {
        const n = getState().doc.nodes[id];
        if (!n) return;
        if (alt) soloVisibility(id);
        else setNodeVisible(id, !n.visible);
      },
      onToggleLock: (id, alt) => {
        const n = getState().doc.nodes[id];
        if (!n) return;
        if (alt) soloLock(id);
        else setNodeLocked(id, !n.locked);
      },
      onToggleExpand: (id, alt) => {
        if (alt) {
          const d = getState().doc;
          const n = d.nodes[id];
          if (!n) return;
          const open = !isExpanded(id, n);
          for (const x of descendants(d, id, true)) if (isContainer(d.nodes[x])) setNodeExpanded(x, open);
        } else toggleNodeExpanded(id);
      },
      onTarget: (id, shift) => {
        const s = getState();
        const n = s.doc.nodes[id];
        if (!n) return;
        if (n.type === 'layer') {
          const ids = getChildren(s.doc, id).filter((c) => s.doc.nodes[c]?.visible && !s.doc.nodes[c]?.locked);
          const next = shift ? topmostOf(s.doc, Array.from(new Set(s.selection.concat(ids)))) : ids;
          markInternal(next);
          s.setSelection(next);
          s.setActiveLayer(id);
          return;
        }
        if (isEffectivelyLocked(s.doc, id)) return;
        let next: ID[];
        if (shift) next = s.selection.includes(id) ? s.selection.filter((x) => x !== id) : topmostOf(s.doc, s.selection.concat([id]));
        else next = [id];
        markInternal(next);
        s.setSelection(next);
        const layer = layerOf(s.doc, id);
        if (layer) s.setActiveLayer(layer.id);
      },
      onRenameCommit: (id, name) => {
        setRenaming(null);
        renameNode(id, name);
      },
      onRenameCancel: () => setRenaming(null),
      onStartRename: (id) => setRenaming(id),
      onRowDoubleClick: (id) => {
        const n = getState().doc.nodes[id];
        if (!n) return;
        if (n.type === 'layer') getState().openDialog('layerOptions', { id });
        else if (n.type === 'group') getState().setIsolation(id);
        else setRenaming(id);
      },
      onContextMenu: (id, e) => openMenu(id, e),
      onPointerDown: (id, _index, e) => {
        if (e.button !== 0) return;
        const s = getState();
        const n = s.doc.nodes[id];
        if (!n) return;
        const ui = useLayersUI.getState();
        let ids: ID[];
        if (n.type === 'layer') ids = ui.layerRows.includes(id) ? ui.layerRows.filter((x) => s.doc.nodes[x]?.type === 'layer') : [id];
        else if (s.selection.includes(id)) ids = normalizeDragIds(s.doc, s.selection);
        else ids = [id];
        dragRef.current = { ids, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, target: null };
        const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
        // selection happens on pointer-down (Illustrator-like); a drag then moves the (possibly new) selection
        const already = n.type === 'layer' ? ui.layerRows.includes(id) : s.selection.includes(id);
        if (!already || mods.shift || mods.ctrl) {
          clickRow(id, mods);
          const s2 = getState();
          if (n.type !== 'layer' && s2.selection.includes(id)) dragRef.current.ids = normalizeDragIds(s2.doc, s2.selection);
          else if (n.type === 'layer') dragRef.current.ids = useLayersUI.getState().layerRows.includes(id) ? useLayersUI.getState().layerRows : [id];
        }
      },
      onHover: (id) => {
        const s = getState();
        if (id && s.doc.nodes[id]?.type === 'layer') id = null;
        if (dragRef.current?.active) return;
        s.setHover(id);
      },
    }),
    [clickRow, openMenu],
  );

  // click without drag on an already-selected row (no modifiers) selects just that row
  useEffect(() => {
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.active) return;
      const rowEl = (e.target as HTMLElement).closest?.('[data-row-id]') as HTMLElement | null;
      const id = rowEl?.dataset.rowId;
      if (!id || d.ids.length < 2) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = getState();
      const n = s.doc.nodes[id];
      if (!n) return;
      if (n.type === 'layer') useLayersUI.getState().setLayerRows([id]);
      else if (s.selection.includes(id)) {
        markInternal([id]);
        s.setSelection([id]);
      }
    };
    window.addEventListener('pointerup', up, true);
    return () => window.removeEventListener('pointerup', up, true);
  }, []);

  // --- footer actions -----------------------------------------------------
  const deleteFooter = () => {
    const s = getState();
    if (s.selection.length) {
      deleteSelection();
      return;
    }
    const layers = selectedLayerIds();
    if (layers.length && s.doc.layers.length > 1) deleteLayers(layers);
  };
  const collapseAll = () => {
    const d = getState().doc;
    for (const id of Object.keys(d.nodes)) if (isContainer(d.nodes[id]) && d.nodes[id].type === 'group') setNodeExpanded(id, false);
    for (const id of d.layers) setNodeExpanded(id, true);
  };

  const dragSet = useMemo(() => new Set(drag?.ids ?? []), [drag]);
  const lineTarget = drag?.target && drag.target.position !== 'inside' ? drag.target : null;
  const count = useMemo(() => Object.values(doc.nodes).filter((n: Node) => n.type !== 'layer').length, [docVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="layers-panel" data-testid="layers-panel">
      <div className="layers-list" ref={listRef} tabIndex={-1} data-testid="layers-list" onPointerLeave={() => getState().setHover(null)}>
        {rows.length === 0 && <div className="layers-empty">{filter ? 'No layers or objects match the filter.' : 'The document is empty.'}</div>}
        {rows.map((r) => {
          const n = doc.nodes[r.id];
          if (!n) return null;
          const layer = n.type === 'layer' ? n : layerOf(doc, r.id);
          const parent = n.parent ? doc.nodes[n.parent] : undefined;
          const parentVisible = !n.parent || !!(parent && isEffVisible(doc, n.parent));
          const parentLocked = !!n.parent && isEffectivelyLocked(doc, n.parent);
          return (
            <LayerRow
              key={r.id}
              id={r.id}
              index={rows.indexOf(r)}
              depth={r.depth}
              type={n.type}
              shapeKind={n.type === 'path' ? (n.shape?.kind ?? null) : null}
              name={n.name}
              visible={n.visible}
              parentVisible={parentVisible}
              locked={n.locked}
              parentLocked={parentLocked}
              hasChildren={r.hasChildren}
              expanded={r.expanded}
              isClip={r.isClip}
              color={layer?.color ?? '#3b82f6'}
              selected={selInfo.selected.has(r.id)}
              inSelection={selInfo.inSelection.has(r.id)}
              partial={selInfo.partial.has(r.id)}
              active={n.type === 'layer' && r.id === activeLayerId}
              layerSelected={n.type === 'layer' && layerRows.includes(r.id)}
              renaming={renaming === r.id}
              thumbs={thumbs}
              dragging={dragSet.has(r.id)}
              dropInside={!!drag?.target && drag.target.position === 'inside' && drag.target.parent === r.id}
              handlers={handlers}
            />
          );
        })}
        {lineTarget && (
          <div
            className="lr-drop-line"
            data-testid="layer-drop-line"
            style={{
              top: lineTarget.position === 'before' ? lineTarget.rowIndex * ROW_H - 1 : (lineTarget.rowIndex + 1) * ROW_H - 1,
              left: INDENT_BASE + lineTarget.depth * INDENT + 6,
            }}
          />
        )}
      </div>
      <div className="layers-footer">
        <div className="layers-search">
          <Search size={12} className="search-icon" />
          <input value={filter} placeholder="Filter" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="layers-filter" />
          {filter && (
            <button type="button" className="clear-btn" onClick={() => setFilter('')} title="Clear filter">
              <X size={10} />
            </button>
          )}
        </div>
        <span className="layers-count" title="Objects in the document">
          {count}
        </span>
        <IconButton icon={<ChevronsDownUp size={14} />} title="Collapse all groups" onClick={collapseAll} />
        <IconButton icon={<FolderPlus size={14} />} title="New Sublayer (Ctrl+Alt+L)" onClick={() => newSublayer()} data-testid="layers-new-sublayer" />
        <IconButton icon={<SquarePlus size={14} />} title="New Layer (Ctrl+L)" onClick={() => newLayer()} data-testid="layers-new-layer" />
        <IconButton icon={<Trash size={14} />} title="Delete selection / selected layers" onClick={deleteFooter} data-testid="layers-delete" />
      </div>
    </div>
  );
}

function isEffVisible(doc: { nodes: Record<ID, Node> }, id: ID): boolean {
  let n: Node | undefined = doc.nodes[id];
  while (n) {
    if (!n.visible) return false;
    n = n.parent ? doc.nodes[n.parent] : undefined;
  }
  return true;
}
