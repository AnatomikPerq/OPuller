/**
 * 9-point reference point selector (Illustrator's reference point locator).
 */
import React from 'react';
import { REF_GRID, REF_LABELS, type RefPoint } from './refPoint';
import './transform.css';

export function RefPointGrid({ value, onChange, disabled, size = 'normal', 'data-testid': testId }: { value: RefPoint; onChange: (r: RefPoint) => void; disabled?: boolean; size?: 'normal' | 'large'; 'data-testid'?: string }) {
  return (
    <div className={`ref-grid ${size} ${disabled ? 'disabled' : ''}`} title="Reference point" data-testid={testId ?? 'ref-grid'} role="radiogroup">
      <svg className="ref-grid-lines" viewBox="0 0 30 30" aria-hidden>
        <rect x={4} y={4} width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1} />
        <path d="M15 4V26M4 15H26" stroke="currentColor" strokeWidth={1} />
      </svg>
      {REF_GRID.flat().map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          className={`ref-cell ${value === r ? 'active' : ''}`}
          title={REF_LABELS[r]}
          data-testid={`ref-${r}`}
          onClick={() => !disabled && onChange(r)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
