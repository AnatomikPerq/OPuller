/**
 * Small UI pieces shared by the colour panels and tools: paint previews,
 * fill/stroke target swatches and a stop colour popover.
 */
import React from 'react';
import type { Paint, SolidPaint, Document, CMYK } from '@/model/types';
import { paintCss, ColorPicker } from '@/ui/ColorPicker';
import { Popover, NumberField } from '@/ui/widgets';
import { cmykToHex } from '@/color/globals';
import { useStore } from '@/store/store';
import './color.css';

/** Checkerboard-backed preview of any paint (with the red "none" slash). */
export function PaintPreview({ paint, className, style, stroke, title }: { paint: Paint; className?: string; style?: React.CSSProperties; stroke?: boolean; title?: string }) {
  const doc = useStore((s) => s.doc);
  return (
    <span className={`cpaint ${paint.type === 'none' ? 'none' : ''} ${stroke ? 'as-stroke' : ''} ${className ?? ''}`} style={style} title={title}>
      {paint.type === 'pattern' ? <PatternThumb paint={paint} doc={doc} /> : paint.type !== 'none' && <span className="cpaint-fill" style={{ background: paintCss(paint), opacity: paint.type === 'solid' ? paint.opacity : 1 }} />}
    </span>
  );
}

function PatternThumb({ paint, doc }: { paint: Extract<Paint, { type: 'pattern' }>; doc: Document }) {
  const def = doc.patterns.find((p) => p.id === paint.patternId);
  if (!def) return <span className="cpaint-fill" style={{ background: paintCss(paint) }} />;
  return (
    <svg className="cpaint-fill" viewBox={`0 0 ${def.width} ${def.height}`} preserveAspectRatio="xMidYMid slice" dangerouslySetInnerHTML={{ __html: def.svg }} />
  );
}

/** Fill/stroke overlapping swatches with the active one highlighted. */
export function PaintTargets({
  fill,
  stroke,
  mixedFill,
  mixedStroke,
  target,
  onSelect,
  size = 30,
  testIdPrefix = 'color',
}: {
  fill: Paint;
  stroke: Paint;
  mixedFill?: boolean;
  mixedStroke?: boolean;
  target: 'fill' | 'stroke';
  onSelect: (t: 'fill' | 'stroke') => void;
  size?: number;
  testIdPrefix?: string;
}) {
  const total = Math.round(size * 1.55);
  return (
    <div className="ptargets" style={{ width: total, height: total }} data-testid={`${testIdPrefix}-targets`}>
      <button
        type="button"
        className={`ptarget fill ${target === 'fill' ? 'active' : ''}`}
        style={{ width: size, height: size }}
        title="Fill (X toggles fill/stroke)"
        onClick={() => onSelect('fill')}
        data-testid={`${testIdPrefix}-fill-swatch`}
        aria-pressed={target === 'fill'}
      >
        <PaintPreview paint={fill} />
        {mixedFill && <span className="ptarget-mixed">?</span>}
      </button>
      <button
        type="button"
        className={`ptarget stroke ${target === 'stroke' ? 'active' : ''}`}
        style={{ width: size, height: size }}
        title="Stroke (X toggles fill/stroke)"
        onClick={() => onSelect('stroke')}
        data-testid={`${testIdPrefix}-stroke-swatch`}
        aria-pressed={target === 'stroke'}
      >
        <PaintPreview paint={stroke} stroke />
        {mixedStroke && <span className="ptarget-mixed">?</span>}
      </button>
    </div>
  );
}

/** Colour picker popover for a single solid colour (gradient stops, swatches). */
export function SolidColorPopover({
  open,
  anchor,
  color,
  onClose,
  onChange,
  onCommit,
  title,
  placement = 'bottom',
  children,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  color: SolidPaint;
  onClose: () => void;
  onChange: (c: SolidPaint) => void;
  onCommit?: () => void;
  title?: React.ReactNode;
  placement?: 'bottom' | 'top' | 'left' | 'right' | 'bottom-end';
  children?: React.ReactNode;
}) {
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} className="solid-color-popover">
      {title !== undefined && <div className="section-title">{title}</div>}
      <ColorPicker
        paint={color}
        allowNone={false}
        allowGradient={false}
        onChange={(p) => {
          if (p.type === 'solid') onChange(p);
        }}
        onCommit={onCommit}
      />
      {children}
    </Popover>
  );
}

/** C/M/Y/K sliders + fields (0..100 %) with a colour preview. */
export function CmykFields({ value, onChange, onCommit, preview, testIdPrefix = 'cmyk' }: { value: CMYK; onChange: (v: CMYK) => void; onCommit?: () => void; preview?: string; testIdPrefix?: string }) {
  const keys: Array<keyof CMYK> = ['c', 'm', 'y', 'k'];
  const set = (k: keyof CMYK, v: number) => onChange({ ...value, [k]: Math.max(0, Math.min(100, Math.round(v))) });
  return (
    <div className="cmyk-fields" data-testid={`${testIdPrefix}-fields`}>
      <div className="cmyk-preview" style={{ background: preview ?? cmykToHex(value) }} />
      {keys.map((k) => (
        <React.Fragment key={k}>
          <span className="field-label">{k.toUpperCase()}</span>
          <input type="range" min={0} max={100} step={1} value={Math.round(value[k])} onChange={(e) => set(k, Number(e.target.value))} onPointerUp={() => onCommit?.()} onKeyUp={() => onCommit?.()} onKeyDown={(e) => e.stopPropagation()} data-testid={`${testIdPrefix}-slider-${k}`} />
          <NumberField value={Math.round(value[k])} min={0} max={100} decimals={0} unit="%" width={64} scrub={false} onChange={(v) => set(k, v)} onCommit={() => onCommit?.()} data-testid={`${testIdPrefix}-${k}`} />
        </React.Fragment>
      ))}
    </div>
  );
}
