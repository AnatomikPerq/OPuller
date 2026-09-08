/**
 * Colour picker: HSB square + hue/alpha sliders + hex/RGB/HSB fields + swatches.
 * Works on Paint values (solid / none / gradient stop colours).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Paint, SolidPaint, GradientPaint } from '@/model/types';
import { hexToHsb, hsbToHex, hexToRgb, rgbToHex, normalizeHex, isValidHex, type HSB } from '@/util/color';
import { NumberField, Row, Segmented, TextField } from './widgets';
import { useStore, getState } from '@/store/store';
import { Pipette } from 'lucide-react';

export interface ColorPickerProps {
  paint: Paint;
  onChange: (p: Paint) => void;
  onCommit?: () => void;
  /** show the None option */
  allowNone?: boolean;
  /** show gradient type toggles (Solid / Linear / Radial) */
  allowGradient?: boolean;
  /** show the document swatches */
  showSwatches?: boolean;
  /** compact width */
  width?: number;
}

const SQUARE = 180;

export function solidOf(paint: Paint): SolidPaint {
  if (paint.type === 'solid') return paint;
  if (paint.type === 'linear' || paint.type === 'radial') {
    const st = getState();
    const stop = paint.stops[Math.min(st.activeGradientStop, paint.stops.length - 1)] ?? paint.stops[0];
    return { type: 'solid', color: stop?.color ?? '#000000', opacity: stop?.opacity ?? 1 };
  }
  return { type: 'solid', color: '#000000', opacity: 1 };
}

export function ColorPicker({ paint, onChange, onCommit, allowNone = true, allowGradient = true, showSwatches = true, width = SQUARE + 40 }: ColorPickerProps) {
  const solid = solidOf(paint);
  const [hsb, setHsb] = useState<HSB>(() => hexToHsb(solid.color));
  const [mode, setMode] = useState<'hex' | 'rgb' | 'hsb'>('hex');
  const lastHex = useRef(solid.color);
  const swatches = useStore((s) => s.doc.swatches);
  const activeStop = useStore((s) => s.activeGradientStop);

  // keep the internal HSB in sync when the colour changes from outside
  useEffect(() => {
    if (solid.color !== lastHex.current) {
      lastHex.current = solid.color;
      setHsb(hexToHsb(solid.color));
    }
  }, [solid.color]);

  const emit = useCallback(
    (next: Partial<SolidPaint>, newHsb?: HSB) => {
      const color = next.color ?? (newHsb ? hsbToHex(newHsb) : solid.color);
      const opacity = next.opacity ?? solid.opacity;
      lastHex.current = color;
      if (newHsb) setHsb(newHsb);
      else if (next.color) setHsb(hexToHsb(color));
      if (paint.type === 'linear' || paint.type === 'radial') {
        const stops = paint.stops.map((s, i) => (i === Math.min(activeStop, paint.stops.length - 1) ? { ...s, color, opacity } : s));
        onChange({ ...paint, stops });
      } else onChange({ type: 'solid', color, opacity });
    },
    [paint, solid, onChange, activeStop],
  );

  const setType = (t: 'none' | 'solid' | 'linear' | 'radial') => {
    if (t === paint.type) return;
    if (t === 'none') onChange({ type: 'none' });
    else if (t === 'solid') onChange({ type: 'solid', color: solid.color, opacity: solid.opacity });
    else {
      const stops = paint.type === 'linear' || paint.type === 'radial' ? paint.stops : [{ offset: 0, color: solid.color, opacity: solid.opacity }, { offset: 1, color: '#ffffff', opacity: 1 }];
      const g: GradientPaint = t === 'linear' ? { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops, spread: 'pad' } : { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops, spread: 'pad' };
      onChange(g);
    }
    onCommit?.();
  };

  // --- drag handlers -----------------------------------------------------
  const squareRef = useRef<HTMLDivElement>(null);
  const dragSquare = (e: React.PointerEvent) => {
    const el = squareRef.current!;
    el.setPointerCapture(e.pointerId);
    const update = (ev: PointerEvent | React.PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      emit({}, { h: hsb.h, s: x * 100, b: (1 - y) * 100 });
    };
    update(e);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onCommit?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const rgb = hexToRgb(solid.color);
  const hueColor = hsbToHex({ h: hsb.h, s: 100, b: 100 });
  const isNone = paint.type === 'none';

  return (
    <div className="color-picker" style={{ width, display: 'flex', flexDirection: 'column', gap: 8 }} data-keyboard-scope>
      {(allowNone || allowGradient) && (
        <Segmented
          value={paint.type === 'pattern' ? 'solid' : paint.type}
          onChange={(v) => setType(v as any)}
          options={[
            ...(allowNone ? [{ value: 'none', label: 'None' }] : []),
            { value: 'solid', label: 'Solid' },
            ...(allowGradient ? [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }] : []),
          ]}
        />
      )}
      {(paint.type === 'linear' || paint.type === 'radial') && <GradientStopsBar paint={paint} onChange={onChange} onCommit={onCommit} />}
      <div
        ref={squareRef}
        className="cp-square"
        onPointerDown={dragSquare}
        style={{
          position: 'relative',
          width: '100%',
          height: SQUARE * 0.75,
          borderRadius: 4,
          cursor: 'crosshair',
          opacity: isNone ? 0.4 : 1,
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: `${hsb.s}%`,
            top: `${100 - hsb.b}%`,
            width: 12,
            height: 12,
            marginLeft: -6,
            marginTop: -6,
            borderRadius: '50%',
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
            background: solid.color,
            pointerEvents: 'none',
          }}
        />
      </div>
      <Row gap={8}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={Math.round(hsb.h)}
            className="cp-hue"
            style={{ width: '100%', accentColor: hueColor, background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)', height: 10, borderRadius: 5, appearance: 'none' }}
            onChange={(e) => emit({}, { ...hsb, h: Number(e.target.value) })}
            onPointerUp={() => onCommit?.()}
            onKeyDown={(e) => e.stopPropagation()}
            title="Hue"
          />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(solid.opacity * 100)}
            style={{ width: '100%', accentColor: '#fff', background: `linear-gradient(to right, transparent, ${solid.color}), repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 0 0/8px 8px`, height: 10, borderRadius: 5, appearance: 'none' }}
            onChange={(e) => emit({ opacity: Number(e.target.value) / 100 })}
            onPointerUp={() => onCommit?.()}
            onKeyDown={(e) => e.stopPropagation()}
            title="Opacity"
          />
        </div>
        <div className="swatch-btn" style={{ width: 30, height: 30 }} title="Current colour">
          <div className="paint-preview" style={{ background: solid.color, opacity: solid.opacity }} />
        </div>
      </Row>
      <Row gap={6}>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'hex', label: 'Hex' }, { value: 'rgb', label: 'RGB' }, { value: 'hsb', label: 'HSB' }]} />
        <div style={{ flex: 1 }} />
        <NumberField label="A" value={Math.round(solid.opacity * 100)} onChange={(v) => emit({ opacity: v / 100 })} onCommit={() => onCommit?.()} min={0} max={100} unit="%" width={70} decimals={0} />
      </Row>
      {mode === 'hex' && (
        <Row>
          <TextField
            label="#"
            value={solid.color.slice(1)}
            mono
            onCommit={(t) => {
              if (isValidHex(t)) {
                emit({ color: normalizeHex(t) });
                onCommit?.();
              }
            }}
          />
          <EyedropperButton onPick={(hex) => { emit({ color: hex }); onCommit?.(); }} />
        </Row>
      )}
      {mode === 'rgb' && (
        <Row gap={4}>
          <NumberField label="R" value={Math.round(rgb.r)} min={0} max={255} decimals={0} onChange={(v) => emit({ color: rgbToHex({ ...rgb, r: v }) })} onCommit={() => onCommit?.()} />
          <NumberField label="G" value={Math.round(rgb.g)} min={0} max={255} decimals={0} onChange={(v) => emit({ color: rgbToHex({ ...rgb, g: v }) })} onCommit={() => onCommit?.()} />
          <NumberField label="B" value={Math.round(rgb.b)} min={0} max={255} decimals={0} onChange={(v) => emit({ color: rgbToHex({ ...rgb, b: v }) })} onCommit={() => onCommit?.()} />
        </Row>
      )}
      {mode === 'hsb' && (
        <Row gap={4}>
          <NumberField label="H" value={Math.round(hsb.h)} min={0} max={360} decimals={0} unit="deg" onChange={(v) => emit({}, { ...hsb, h: v })} onCommit={() => onCommit?.()} />
          <NumberField label="S" value={Math.round(hsb.s)} min={0} max={100} decimals={0} unit="%" onChange={(v) => emit({}, { ...hsb, s: v })} onCommit={() => onCommit?.()} />
          <NumberField label="B" value={Math.round(hsb.b)} min={0} max={100} decimals={0} unit="%" onChange={(v) => emit({}, { ...hsb, b: v })} onCommit={() => onCommit?.()} />
        </Row>
      )}
      {showSwatches && (
        <div className="swatch-grid">
          {swatches.map((sw) => (
            <button
              key={sw.id}
              className={`swatch-btn ${sw.paint.type === 'none' ? 'none' : ''}`}
              title={sw.name}
              style={{ width: 18, height: 18 }}
              onClick={() => {
                if (sw.paint.type === 'solid') emit({ color: sw.paint.color, opacity: sw.paint.opacity });
                else onChange(JSON.parse(JSON.stringify(sw.paint)));
                onCommit?.();
              }}
            >
              <div className="paint-preview" style={{ background: paintCss(sw.paint) }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** CSS background for a paint preview. */
export function paintCss(p: Paint): string {
  switch (p.type) {
    case 'none':
      return 'transparent';
    case 'solid':
      return p.color;
    case 'linear': {
      const ang = (Math.atan2(p.y2 - p.y1, p.x2 - p.x1) * 180) / Math.PI + 90;
      return `linear-gradient(${ang}deg, ${p.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(', ')})`;
    }
    case 'radial':
      return `radial-gradient(circle at ${p.cx * 100}% ${p.cy * 100}%, ${p.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(', ')})`;
    case 'pattern':
      return 'repeating-linear-gradient(45deg, #888 0 4px, #ccc 4px 8px)';
    case 'freeform':
      return p.points.map((pt) => `radial-gradient(circle at ${(pt.x * 100).toFixed(1)}% ${(pt.y * 100).toFixed(1)}%, ${pt.color} 0%, transparent ${(pt.spread * 120).toFixed(0)}%)`).join(', ') || '#888';
    case 'mesh': {
      const c0 = p.nodes[0]?.color ?? '#888';
      const c1 = p.nodes[p.nodes.length - 1]?.color ?? c0;
      return `linear-gradient(135deg, ${c0}, ${c1})`;
    }
  }
}

function GradientStopsBar({ paint, onChange, onCommit }: { paint: GradientPaint; onChange: (p: Paint) => void; onCommit?: () => void }) {
  const active = useStore((s) => s.activeGradientStop);
  const setActive = useStore((s) => s.setActiveGradientStop);
  const barRef = useRef<HTMLDivElement>(null);
  const css = `linear-gradient(to right, ${paint.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(', ')})`;
  const onDown = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    setActive(i);
    const el = barRef.current!;
    el.setPointerCapture(e.pointerId);
    let removed = false;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      if (paint.stops.length > 2 && (ev.clientY < r.top - 30 || ev.clientY > r.bottom + 30)) {
        removed = true;
        return;
      }
      removed = false;
      const stops = paint.stops.map((s, k) => (k === i ? { ...s, offset: t } : s));
      onChange({ ...paint, stops });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (removed && paint.stops.length > 2) {
        const stops = paint.stops.filter((_, k) => k !== i);
        onChange({ ...paint, stops });
        setActive(0);
      }
      onCommit?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const addStop = (e: React.MouseEvent) => {
    const r = barRef.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    // interpolate colour
    const sorted = [...paint.stops].sort((a, b) => a.offset - b.offset);
    let color = sorted[0].color;
    let opacity = sorted[0].opacity;
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k];
      const b = sorted[k + 1];
      if (t >= a.offset && t <= b.offset) {
        const f = b.offset === a.offset ? 0 : (t - a.offset) / (b.offset - a.offset);
        const ca = hexToRgb(a.color);
        const cb = hexToRgb(b.color);
        color = rgbToHex({ r: ca.r + (cb.r - ca.r) * f, g: ca.g + (cb.g - ca.g) * f, b: ca.b + (cb.b - ca.b) * f });
        opacity = a.opacity + (b.opacity - a.opacity) * f;
        break;
      }
    }
    const stops = [...paint.stops, { offset: t, color, opacity }];
    onChange({ ...paint, stops });
    setActive(stops.length - 1);
    onCommit?.();
  };
  return (
    <div style={{ position: 'relative', height: 26, marginBottom: 6 }}>
      <div ref={barRef} onDoubleClick={addStop} onClick={(e) => { if ((e.target as HTMLElement) === barRef.current) addStop(e); }} style={{ position: 'absolute', left: 6, right: 6, top: 0, height: 14, borderRadius: 3, background: `${css}, repeating-conic-gradient(#888 0 25%, #ccc 0 50%) 0 0/8px 8px`, cursor: 'copy' }} title="Click to add a stop; drag a stop away to remove it" />
      {paint.stops.map((s, i) => (
        <div
          key={i}
          onPointerDown={(e) => onDown(e, i)}
          style={{
            position: 'absolute',
            left: `calc(6px + ${s.offset * 100}% - ${s.offset * 12}px)`,
            top: 12,
            width: 12,
            height: 12,
            marginLeft: 0,
            background: s.color,
            border: `2px solid ${i === active ? '#4a90e2' : '#fff'}`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
            borderRadius: 2,
            cursor: 'pointer',
          }}
          title={`Stop ${i + 1}: ${Math.round(s.offset * 100)}%`}
        />
      ))}
    </div>
  );
}

function EyedropperButton({ onPick }: { onPick: (hex: string) => void }) {
  const supported = typeof window !== 'undefined' && 'EyeDropper' in window;
  if (!supported) return null;
  return (
    <button
      className="icon-btn"
      title="Pick a colour from the screen"
      onClick={async () => {
        try {
          const ed = new (window as any).EyeDropper();
          const r = await ed.open();
          if (r?.sRGBHex) onPick(normalizeHex(r.sRGBHex));
        } catch {
          /* cancelled */
        }
      }}
    >
      <Pipette size={14} />
    </button>
  );
}
