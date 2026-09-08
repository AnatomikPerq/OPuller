/**
 * Control-bar widgets shared by the freehand tools.
 */
import React from 'react';
import { Slider, Checkbox, Segmented, Row } from '@/ui/widgets';
import './freehand.css';

export function OptionSlider({ label, value, min, max, step = 1, onChange, unit, decimals, title, width = 190 }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: 'px' | '%' | 'none';
  decimals?: number;
  title?: string;
  width?: number;
}) {
  return (
    <span className="fh-opt" title={title}>
      <Slider label={label} value={value} min={min} max={max} step={step} onChange={onChange} unit={unit ?? 'none'} decimals={decimals ?? (step < 1 ? 1 : 0)} width={width} />
    </span>
  );
}

export function OptionCheck({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <Checkbox label={label} checked={checked} onChange={onChange} title={title} />;
}

export function PaintSourceOption({ value, onChange }: { value: 'stroke' | 'fill'; onChange: (v: 'stroke' | 'fill') => void }) {
  return (
    <span className="fh-opt" title="Which of the current colours the stroke is painted with">
      <span className="field-label">Paint</span>
      <Segmented<'stroke' | 'fill'>
        value={value}
        onChange={onChange}
        options={[
          { value: 'stroke', label: 'Stroke', title: 'Use the current stroke colour' },
          { value: 'fill', label: 'Fill', title: 'Use the current fill colour' },
        ]}
      />
    </span>
  );
}

export function OptionsRow({ children }: { children: React.ReactNode }) {
  return (
    <Row gap={12} className="fh-options">
      {children}
    </Row>
  );
}
