/**
 * Info panel: live cursor position, drag distance/angle, selection bounds,
 * fill & stroke, object counts and document size.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Paint, Vec, NodeType } from '@/model/types';
import { useStore, getState, screenToWorld } from '@/store/store';
import { selectionBounds, descendants } from '@/model/document';
import { formatLength } from '@/util/units';
import { useCurrentAppearance } from '@/commands/appearance';
import { paintCss } from '@/ui/ColorPicker';
import { paintLabel } from '@/ui/panels/appearance/PaintSwatch';
import { editTargets, activeArtboard } from '@/ui/panels/properties/edit';
import './info.css';

function PaintChip({ paint, mixed }: { paint: Paint; mixed: boolean }) {
  return (
    <span className="info-paint">
      <span className={`chip ${paint.type === 'none' && !mixed ? 'none' : ''}`}>
        <span style={{ background: mixed ? 'repeating-linear-gradient(135deg, #999 0 2px, #ddd 2px 4px)' : paint.type === 'none' ? '#fff' : paintCss(paint) }} />
      </span>
      <span>{paintLabel(paint, mixed)}</span>
    </span>
  );
}

const TYPE_LABEL: Record<NodeType, string> = { layer: 'layer', group: 'group', path: 'path', text: 'text', image: 'image' };

export function InfoPanel() {
  const units = useStore((s) => s.prefs.units);
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  useStore((s) => s.activeArtboardId);
  const app = useCurrentAppearance();
  const [cursor, setCursor] = useState<Vec>({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ start: Vec; current: Vec } | null>(null);
  const raf = useRef<number | null>(null);
  const pending = useRef<{ cursor: Vec; drag: { start: Vec; current: Vec } | null } | null>(null);
  const dragStart = useRef<Vec | null>(null);

  useEffect(() => {
    const el = document.querySelector('[data-testid="viewport"]') as HTMLElement | null;
    if (!el) return;
    const flush = () => {
      raf.current = null;
      const p = pending.current;
      if (!p) return;
      pending.current = null;
      setCursor(p.cursor);
      setDrag(p.drag);
    };
    const schedule = (c: Vec) => {
      pending.current = { cursor: c, drag: dragStart.current ? { start: dragStart.current, current: c } : null };
      if (raf.current === null) raf.current = requestAnimationFrame(flush);
    };
    const toWorld = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onMove = (e: PointerEvent) => schedule(toWorld(e));
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragStart.current = toWorld(e);
      schedule(dragStart.current);
    };
    const onUp = () => {
      dragStart.current = null;
      pending.current = { cursor: pending.current?.cursor ?? cursor, drag: null };
      if (raf.current === null) raf.current = requestAnimationFrame(flush);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const info = useMemo(() => {
    const s = getState();
    const ab = activeArtboard(s);
    const ox = ab?.x ?? 0;
    const oy = ab?.y ?? 0;
    const targets = editTargets(s, selection);
    const bounds = selectionBounds(s.doc, targets);
    const counts: Partial<Record<NodeType, number>> = {};
    let total = 0;
    for (const id of selection) {
      for (const d of descendants(s.doc, id, true)) {
        const n = s.doc.nodes[d];
        if (!n || n.type === 'layer') continue;
        counts[n.type] = (counts[n.type] ?? 0) + 1;
        total++;
      }
    }
    const typeText = Object.entries(counts)
      .map(([t, c]) => `${c} ${TYPE_LABEL[t as NodeType]}${c === 1 ? '' : 's'}`)
      .join(', ');
    const docSize = ab ? `${formatLength(ab.width, s.prefs.units)} × ${formatLength(ab.height, s.prefs.units)}` : '—';
    return { ox, oy, bounds, total, typeText, docSize, artboards: s.doc.artboards.length, abName: ab?.name ?? '—', nodeCount: Object.values(s.doc.nodes).filter((n) => n.type !== 'layer').length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, docVersion, units]);

  const f = (v: number) => formatLength(v, units);
  const b = info.bounds;
  const dx = drag ? drag.current.x - drag.start.x : 0;
  const dy = drag ? drag.current.y - drag.start.y : 0;

  return (
    <div className="info-panel" data-testid="info-panel">
      <div className="info-block" data-testid="info-cursor">
        <span className="k">X</span>
        <span className="v" data-testid="info-x">{f(cursor.x - info.ox)}</span>
        <span className="k">Y</span>
        <span className="v" data-testid="info-y">{f(cursor.y - info.oy)}</span>
        {drag && (
          <>
            <span className="k">D</span>
            <span className="v">{f(Math.hypot(dx, dy))}</span>
            <span className="k">∠</span>
            <span className="v">{(-(Math.atan2(dy, dx) * 180) / Math.PI).toFixed(1)}°</span>
            <span className="k">ΔX / ΔY</span>
            <span className="v">
              {f(dx)} / {f(dy)}
            </span>
          </>
        )}
      </div>
      <div className="info-title">Selection</div>
      <div className="info-block">
        {b ? (
          <>
            <span className="k">X / Y</span>
            <span className="v" data-testid="info-sel-xy">
              {f(b.x - info.ox)} / {f(b.y - info.oy)}
            </span>
            <span className="k">W / H</span>
            <span className="v" data-testid="info-sel-wh">
              {f(b.width)} / {f(b.height)}
            </span>
          </>
        ) : (
          <>
            <span className="k">Objects</span>
            <span className="v">none</span>
          </>
        )}
        {selection.length > 0 && (
          <>
            <span className="k">Objects</span>
            <span className="v" data-testid="info-count">
              {info.total} ({info.typeText})
            </span>
            <span className="k">Fill</span>
            <span className="v">
              <PaintChip paint={app.fill} mixed={app.mixedFill} />
            </span>
            <span className="k">Stroke</span>
            <span className="v">
              <PaintChip paint={app.stroke.paint} mixed={app.mixedStroke} />
              {app.stroke.paint.type !== 'none' && !app.mixedStroke ? ` · ${f(app.stroke.width)}` : ''}
            </span>
          </>
        )}
      </div>
      <div className="info-title">Document</div>
      <div className="info-block">
        <span className="k">Artboard</span>
        <span className="v">{info.abName}</span>
        <span className="k">Size</span>
        <span className="v" data-testid="info-doc-size">{info.docSize}</span>
        <span className="k">Artboards</span>
        <span className="v">{info.artboards}</span>
        <span className="k">Objects</span>
        <span className="v">{info.nodeCount}</span>
      </div>
    </div>
  );
}
