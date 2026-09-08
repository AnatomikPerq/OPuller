/**
 * Gradient stops editor: a preview bar with draggable stop markers.
 * - click on the bar adds a stop (colour interpolated)
 * - drag a stop to move it, drag it away from the bar to delete it (min 2 stops)
 * - double-click a stop to edit its colour; Delete removes it
 * Uses the store's activeGradientStop as the selected stop.
 */
import React, { useRef, useState } from 'react';
import type { GradientPaint, SolidPaint } from '@/model/types';
import { addStopAt, removeStop, updateStop, stopsCss, clamp01 } from '@/color/gradient';
import { SolidColorPopover } from '../color/shared';
import './gradient.css';

export interface GradientBarProps {
  paint: GradientPaint;
  active: number;
  onSelect: (index: number) => void;
  /** live change (commit=false) */
  onChange: (p: GradientPaint) => void;
  /** discrete change (one history step) */
  onApply: (p: GradientPaint) => void;
  onCommit: () => void;
  height?: number;
  testId?: string;
}

export function GradientBar({ paint, active, onSelect, onChange, onApply, onCommit, height = 16, testId = 'gradient-bar' }: GradientBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ index: number; removing: boolean } | null>(null);
  const [popover, setPopover] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const activeIdx = Math.min(active, paint.stops.length - 1);

  const onStopDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(i);
    const el = barRef.current;
    if (!el) return;
    const start = paint; // geometry at gesture start (deterministic updates)
    const bar = el.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    let removing = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 2) return;
      moved = true;
      const t = clamp01((ev.clientX - bar.left) / Math.max(1, bar.width));
      const away = start.stops.length > 2 && (ev.clientY > bar.bottom + 30 || ev.clientY < bar.top - 30);
      removing = away;
      setDrag({ index: i, removing });
      if (!away) onChange(updateStop(start, i, { offset: t }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (!moved) return;
      if (removing) {
        onApply(removeStop(start, i));
        onSelect(Math.max(0, Math.min(i, start.stops.length - 2)));
        return;
      }
      onCommit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const addAt = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = clamp01((clientX - r.left) / Math.max(1, r.width));
    const { paint: next, index } = addStopAt(paint, t);
    onApply(next);
    onSelect(index);
  };

  const removeAt = (i: number) => {
    if (paint.stops.length <= 2) return;
    onApply(removeStop(paint, i));
    onSelect(Math.max(0, Math.min(i, paint.stops.length - 2)));
  };

  const editStop = popover ? paint.stops[popover.index] : null;

  return (
    <div className="gbar-wrap" data-testid={testId}>
      <div
        ref={barRef}
        className="gbar"
        style={{ height, backgroundImage: `${stopsCss(paint.stops)}, repeating-conic-gradient(#888 0 25%, #ccc 0 50%)` }}
        onClick={(e) => addAt(e.clientX)}
        title="Click to add a colour stop"
        data-testid={`${testId}-strip`}
      />
      <div className="gbar-stops" style={{ top: height }}>
        {paint.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`gbar-stop ${i === activeIdx ? 'active' : ''} ${drag?.index === i && drag.removing ? 'removing' : ''}`}
            style={{ left: `${s.offset * 100}%` }}
            onPointerDown={(e) => onStopDown(e, i)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onSelect(i);
              setPopover({ index: i, anchor: e.currentTarget as HTMLElement });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                removeAt(i);
              }
              e.stopPropagation();
            }}
            title={`Stop ${i + 1}: ${Math.round(s.offset * 100)}% ${s.color.toUpperCase()} ${Math.round(s.opacity * 100)}%\nDrag to move, drag away to delete, double-click to edit`}
            data-testid={`${testId}-stop-${i}`}
            aria-pressed={i === activeIdx}
          >
            <span className="gbar-stop-color" style={{ background: s.color, opacity: s.opacity }} />
          </button>
        ))}
      </div>
      {popover && editStop && (
        <SolidColorPopover
          open
          anchor={popover.anchor}
          color={{ type: 'solid', color: editStop.color, opacity: editStop.opacity }}
          title={`Stop ${popover.index + 1}`}
          onClose={() => setPopover(null)}
          onChange={(c: SolidPaint) => onChange(updateStop(paint, popover.index, { color: c.color, opacity: c.opacity }))}
          onCommit={onCommit}
        />
      )}
    </div>
  );
}
