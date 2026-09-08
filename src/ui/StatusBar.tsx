import React, { useEffect, useState } from 'react';
import { useStore, getState } from '@/store/store';
import { formatLength } from '@/util/units';
import { Select } from './widgets';
import { getTool } from '@/tools/registry';
import { screenToWorld } from '@/store/store';

export function StatusBar() {
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const status = useStore((s) => s.status);
  const artboards = useStore((s) => s.doc.artboards);
  const activeArtboardId = useStore((s) => s.activeArtboardId);
  const setActiveArtboard = useStore((s) => s.setActiveArtboard);
  const units = useStore((s) => s.prefs.units);
  const toolId = useStore((s) => s.temporaryTool ?? s.activeTool);
  const selection = useStore((s) => s.selection);
  const isolation = useStore((s) => s.isolationId);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const el = document.querySelector('[data-testid="viewport"]');
    if (!el) return;
    const onMove = (e: Event) => {
      const pe = e as PointerEvent;
      const r = (el as HTMLElement).getBoundingClientRect();
      setCursor(screenToWorld({ x: pe.clientX - r.left, y: pe.clientY - r.top }));
    };
    el.addEventListener('pointermove', onMove);
    return () => el.removeEventListener('pointermove', onMove);
  }, []);

  const tool = getTool(toolId);
  const ab = artboards.find((a) => a.id === activeArtboardId);
  const ox = ab?.x ?? 0;
  const oy = ab?.y ?? 0;

  return (
    <div className="statusbar" data-testid="statusbar">
      <div className="status-item">
        <input
          type="text"
          className="mono"
          style={{ width: 62, height: 18, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px', color: 'var(--text)' }}
          value={`${Math.round(zoom * 100)}%`}
          onChange={() => {}}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              const v = parseFloat((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(v) && v > 0) setZoom(v / 100);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          title="Zoom"
        />
      </div>
      <div className="status-item">
        <Select
          value={activeArtboardId ?? ''}
          options={artboards.map((a, i) => ({ value: a.id, label: `${i + 1}. ${a.name}` }))}
          onChange={(v) => setActiveArtboard(v)}
          width={160}
        />
      </div>
      <div className="status-item mono" style={{ minWidth: 190 }} title="Cursor position (relative to the active artboard)">
        X: {formatLength(cursor.x - ox, units)} &nbsp; Y: {formatLength(cursor.y - oy, units)}
      </div>
      {isolation && (
        <div className="status-item" style={{ color: 'var(--accent-strong)' }}>
          Isolation: {getState().doc.nodes[isolation]?.name}
        </div>
      )}
      <div className="status-item">{selection.length ? `${selection.length} selected` : ''}</div>
      <div className="status-item" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {status || tool?.hint || ''}
      </div>
    </div>
  );
}
