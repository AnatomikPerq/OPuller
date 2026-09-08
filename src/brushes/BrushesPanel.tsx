/**
 * Brushes panel: document brushes with stroke previews. Click applies the
 * brush to the selected paths (or sets it for new Paintbrush strokes);
 * double-click opens Brush Options; the toolbar adds, duplicates, removes and
 * deletes brushes and opens the built-in library.
 */
import React, { useMemo } from 'react';
import { Plus, Trash2, BookOpen, Ban, LayoutGrid, List, Settings2, Copy } from 'lucide-react';
import { useStore, getState, type ContextMenuItem } from '@/store/store';
import type { BrushDef, ID } from '@/model/types';
import { IconButton, PopoverButton } from '@/ui/widgets';
import { useCurrentAppearance } from '@/commands/appearance';
import { defaultStroke } from '@/model/defaults';
import { pathToSvgD } from '@/geometry/path';
import { brushItems, sampleSpine, itemsBounds } from './geometry';
import { useBrushStore } from './store';
import { BRUSH_LIBRARY } from './library';
import { applyBrushCommand, removeBrushStrokeCommand, deleteBrushCommand, duplicateBrushCommand, addLibraryBrush, selectBrushUsers } from './actions';
import { nodesUsingBrush } from './ops';
import './brushes.css';

const KIND_LABEL: Record<BrushDef['kind'], string> = { calligraphic: 'Calligraphic', scatter: 'Scatter', art: 'Art', pattern: 'Pattern' };

/** Preview of a brush on a sample S-curve. */
export function BrushPreview({ def, width = 120, height = 34, color = '#000000' }: { def: BrushDef; width?: number; height?: number; color?: string }) {
  const content = useMemo(() => {
    const spine = sampleSpine(width, height);
    const stroke = defaultStroke({ paint: { type: 'solid', color, opacity: 1 }, width: 1, brush: { id: def.id } });
    let items = brushItems(def, [spine], stroke, 'preview');
    // fit the preview: scale down when the artwork is taller than the box
    let b = itemsBounds(items);
    let t = '';
    if (b && (b.height > height || b.width > width)) {
      const k = Math.min(height / b.height, width / b.width);
      const cx = width / 2;
      const cy = height / 2;
      t = `translate(${cx} ${cy}) scale(${k}) translate(${-(b.x + b.width / 2)} ${-(b.y + b.height / 2)})`;
    }
    return { items, t, b };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, width, height, color]);
  return (
    <svg className="brush-preview" width={width} height={height} viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <g transform={content.t || undefined}>
        {content.items.map((it, i) => (
          <path key={i} d={pathToSvgD(it.subpaths)} fill={it.fill.type === 'solid' ? it.fill.color : it.fill.type === 'none' ? 'none' : '#888'} fillOpacity={it.fill.type === 'solid' ? it.fill.opacity : 1} fillRule={it.fillRule} opacity={it.opacity} stroke={it.stroke && it.stroke.paint.type === 'solid' ? it.stroke.paint.color : 'none'} strokeWidth={it.stroke?.width ?? 0} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>
    </svg>
  );
}

export function BrushesPanel() {
  const brushes = useStore((s) => s.doc.brushes);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const app = useCurrentAppearance();
  const activeId = useBrushStore((s) => s.activeId);
  const view = useBrushStore((s) => s.view);
  const setView = useBrushStore((s) => s.setView);
  const inUse = app.stroke.brush?.id ?? null;
  const active = brushes.find((b) => b.id === activeId) ?? null;
  const previewColor = app.stroke.paint.type === 'solid' ? app.stroke.paint.color : '#000000';

  const menuFor = (def: BrushDef): ContextMenuItem[] => [
    { label: 'Apply to Selection', onSelect: () => applyBrushCommand(def.id) },
    { separator: true },
    { label: 'Brush Options…', onSelect: () => getState().openDialog('brush.options', { id: def.id }) },
    { label: 'Duplicate Brush', onSelect: () => duplicateBrushCommand(def.id) },
    { label: 'Delete Brush', onSelect: () => deleteBrushCommand(def.id) },
    { separator: true },
    { label: `Select All Unused` , disabled: true },
    { label: `Select Strokes Using This Brush (${nodesUsingBrush(doc, def.id).length})`, onSelect: () => selectBrushUsers(def.id) },
  ];
  const onContext = (e: React.MouseEvent, def: BrushDef) => {
    e.preventDefault();
    e.stopPropagation();
    useBrushStore.getState().setActive(def.id);
    getState().openContextMenu({ x: e.clientX, y: e.clientY, items: menuFor(def) });
  };

  return (
    <div className="brushes-panel" data-testid="brushes-panel">
      <div className="br-toolbar">
        <IconButton icon={<LayoutGrid size={14} />} active={view === 'grid'} title="Thumbnail view" onClick={() => setView('grid')} />
        <IconButton icon={<List size={14} />} active={view === 'list'} title="List view" onClick={() => setView('list')} />
        <span className="br-sep" />
        <PopoverButton
          placement="bottom"
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="icon-btn" onClick={toggle} title="Brush libraries" data-testid="brushes-libraries">
              <BookOpen size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="br-library" data-testid="brushes-library-menu">
              <div className="section-title">Add from library</div>
              {(['calligraphic', 'scatter', 'art', 'pattern'] as const).map((kind) => (
                <React.Fragment key={kind}>
                  <div className="br-library-kind">{KIND_LABEL[kind]}</div>
                  {BRUSH_LIBRARY.filter((e) => e.kind === kind).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      data-testid={`brushes-lib-${e.id}`}
                      onClick={() => {
                        addLibraryBrush(e.id);
                        close();
                      }}
                    >
                      <LibPreview id={e.id} />
                      <span>{e.name}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
          )}
        </PopoverButton>
        <span className="br-sep" />
        <IconButton icon={<Ban size={14} />} title="Remove brush stroke (plain stroke)" disabled={!inUse} onClick={() => removeBrushStrokeCommand()} data-testid="brushes-remove" />
        <IconButton icon={<Settings2 size={14} />} title="Brush options…" disabled={!active} onClick={() => active && getState().openDialog('brush.options', { id: active.id })} data-testid="brushes-options" />
        <IconButton icon={<Copy size={14} />} title="Duplicate brush" disabled={!active} onClick={() => active && duplicateBrushCommand(active.id)} />
        <IconButton icon={<Plus size={14} />} title="New brush…" onClick={() => getState().openDialog('brush.new', {})} data-testid="brushes-new" />
        <IconButton icon={<Trash2 size={14} />} title="Delete brush" disabled={!active} onClick={() => active && deleteBrushCommand(active.id)} data-testid="brushes-delete" />
      </div>
      <div className={view === 'grid' ? 'br-grid' : 'br-list'} data-testid="brushes-list">
        {brushes.map((def) => {
          const cls = `${def.id === activeId ? 'selected' : ''} ${def.id === inUse ? 'in-use' : ''}`;
          const title = `${def.name} (${KIND_LABEL[def.kind]})\nClick: apply to the selection / new strokes. Double-click: options.`;
          if (view === 'grid') {
            return (
              <button key={def.id} type="button" className={`br-cell ${cls}`} title={title} onClick={() => applyBrushCommand(def.id)} onDoubleClick={() => getState().openDialog('brush.options', { id: def.id })} onContextMenu={(e) => onContext(e, def)} data-testid={`brush-${def.id}`}>
                <BrushPreview def={def} width={64} height={28} color={previewColor} />
              </button>
            );
          }
          return (
            <button key={def.id} type="button" className={`br-row ${cls}`} title={title} onClick={() => applyBrushCommand(def.id)} onDoubleClick={() => getState().openDialog('brush.options', { id: def.id })} onContextMenu={(e) => onContext(e, def)} data-testid={`brush-${def.id}`}>
              <BrushPreview def={def} width={96} height={26} color={previewColor} />
              <span className="br-row-name">{def.name}</span>
              <span className="br-row-kind">{KIND_LABEL[def.kind]}</span>
            </button>
          );
        })}
        {!brushes.length && <div className="br-empty">No brushes yet. Add some from the library or create one with +.</div>}
      </div>
      <div className="br-footer" data-testid="brushes-status">
        {active ? `${active.name} — ${KIND_LABEL[active.kind]}${inUse === active.id ? ' (applied)' : ''}` : `${brushes.length} brushes`}
        {selection.length === 0 && inUse && <span className="dim"> · new strokes use the brush</span>}
      </div>
    </div>
  );
}

const libCache = new Map<string, BrushDef>();
function LibPreview({ id }: { id: string }) {
  let def = libCache.get(id);
  if (!def) {
    const e = BRUSH_LIBRARY.find((x) => x.id === id);
    if (!e) return null;
    def = e.build();
    libCache.set(id, def);
  }
  return <BrushPreview def={def} width={80} height={22} />;
}

export type { ID };
