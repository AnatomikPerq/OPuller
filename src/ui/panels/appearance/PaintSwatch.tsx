/**
 * Swatch button that opens a ColorPicker popover. Used by the Appearance and
 * Properties panels for fill / stroke editing.
 */
import React from 'react';
import type { Paint } from '@/model/types';
import { PopoverButton } from '@/ui/widgets';
import { ColorPicker, paintCss } from '@/ui/ColorPicker';

export function paintLabel(p: Paint, mixed = false): string {
  if (mixed) return 'Mixed';
  switch (p.type) {
    case 'none':
      return 'None';
    case 'solid':
      return p.opacity < 1 ? `${p.color} · ${Math.round(p.opacity * 100)}%` : p.color;
    case 'linear':
      return 'Linear gradient';
    case 'radial':
      return 'Radial gradient';
    case 'pattern':
      return 'Pattern';
  }
}

export function PaintSwatch({ paint, mixed, stroke, onChange, onCommit, title, small, allowGradient = true, testId }: {
  paint: Paint;
  mixed?: boolean;
  stroke?: boolean;
  onChange: (p: Paint) => void;
  onCommit?: () => void;
  title?: string;
  small?: boolean;
  allowGradient?: boolean;
  testId?: string;
}) {
  const cls = ['paint-swatch', stroke ? 'stroke' : '', paint.type === 'none' && !mixed ? 'none' : '', mixed ? 'mixed' : '', small ? 'small' : ''].filter(Boolean).join(' ');
  return (
    <PopoverButton
      button={({ toggle, ref }) => (
        <button ref={ref} type="button" className={cls} onClick={toggle} title={title ?? paintLabel(paint, mixed)} data-testid={testId}>
          <div className="paint-preview" style={mixed || paint.type === 'none' ? undefined : { background: paintCss(paint) }} />
        </button>
      )}
    >
      <ColorPicker paint={mixed ? { type: 'solid', color: '#000000', opacity: 1 } : paint} onChange={onChange} onCommit={onCommit} allowGradient={allowGradient} />
    </PopoverButton>
  );
}

void React;
