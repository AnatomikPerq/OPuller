/**
 * Gradient panel section for freeform gradients: mode (points / lines), the
 * selected point's colour, opacity and spread, add / delete points.
 */
import React, { useRef, useState } from 'react';
import { Plus, Trash2, Spline } from 'lucide-react';
import type { FreeformGradientPaint, Paint } from '@/model/types';
import { NumberField, Segmented, IconButton, Row, Tooltip } from '@/ui/widgets';
import { PaintPreview, SolidColorPopover } from '../color/shared';
import { addFreeformPoint, removeFreeformPoint, updateFreeformPoint, setFreeformMode, startNewLine } from '@/gradients/freeform';

export function FreeformFields({ paint, index, setIndex, live, apply, commit }: { paint: FreeformGradientPaint; index: number; setIndex: (i: number) => void; live: (p: Paint) => void; apply: (p: Paint) => void; commit: () => void }) {
  const idx = Math.max(0, Math.min(paint.points.length - 1, index));
  const pt = paint.points[idx];
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="gradient-freeform" data-testid="gradient-freeform">
      <Row gap={6}>
        <Segmented
          value={paint.mode}
          onChange={(m) => apply(setFreeformMode(paint, m))}
          options={[
            { value: 'points', label: 'Points', title: 'Every point blends independently' },
            { value: 'lines', label: 'Lines', title: 'Points connected into colour lines' },
          ]}
        />
        {paint.mode === 'lines' && (
          <Tooltip text="Start a new line with the next points">
            <IconButton icon={<Spline size={14} />} onClick={() => apply(startNewLine(paint))} title="New line" />
          </Tooltip>
        )}
        <span style={{ flex: 1 }} />
        <Tooltip text="Add a point at the centre">
          <IconButton
            icon={<Plus size={14} />}
            onClick={() => {
              const r = addFreeformPoint(paint, { x: 0.5, y: 0.5 });
              apply(r.paint);
              setIndex(r.index);
            }}
            data-testid="freeform-add"
            title="Add point"
          />
        </Tooltip>
        <Tooltip text="Delete the selected point">
          <IconButton
            icon={<Trash2 size={14} />}
            disabled={paint.points.length <= 1}
            onClick={() => {
              apply(removeFreeformPoint(paint, idx));
              setIndex(Math.max(0, Math.min(idx, paint.points.length - 2)));
            }}
            data-testid="freeform-delete"
            title="Delete point"
          />
        </Tooltip>
      </Row>
      <div className="gradient-freeform-points" data-testid="freeform-points">
        {paint.points.map((p, i) => (
          <button key={i} type="button" className={`gradient-freeform-point ${i === idx ? 'active' : ''}`} style={{ background: p.color, opacity: 0.4 + 0.6 * p.opacity }} title={`Point ${i + 1}: ${p.color.toUpperCase()} at ${(p.x * 100).toFixed(0)} %, ${(p.y * 100).toFixed(0)} %`} onClick={() => setIndex(i)} data-testid={`freeform-point-${i}`} />
        ))}
      </div>
      {pt && (
        <div className="gradient-stop-row" data-testid="freeform-point-row">
          <button ref={chipRef} type="button" className="gradient-stop-chip" title="Edit point colour" onClick={() => setOpen(true)} data-testid="freeform-point-chip">
            <PaintPreview paint={{ type: 'solid', color: pt.color, opacity: pt.opacity }} />
          </button>
          <NumberField label="Opacity" value={Math.round(pt.opacity * 100)} min={0} max={100} unit="%" decimals={0} width={100} onChange={(v) => live(updateFreeformPoint(paint, idx, { opacity: Math.max(0, Math.min(1, v / 100)) }))} onCommit={commit} data-testid="freeform-point-opacity" />
          <NumberField label="Spread" value={Math.round(pt.spread * 100)} min={2} max={300} unit="%" decimals={0} width={100} onChange={(v) => live(updateFreeformPoint(paint, idx, { spread: Math.max(0.02, v / 100) }))} onCommit={commit} title="How far the colour reaches (percent of the object size)" data-testid="freeform-point-spread" />
          <SolidColorPopover open={open} anchor={chipRef.current} color={{ type: 'solid', color: pt.color, opacity: pt.opacity }} title={`Point ${idx + 1}`} onClose={() => setOpen(false)} onChange={(c) => live(updateFreeformPoint(paint, idx, { color: c.color, opacity: c.opacity }))} onCommit={commit} />
        </div>
      )}
      <div className="gradient-hint">Gradient tool (G): drag points on the object, click to add, Delete removes, double-click edits the colour.</div>
    </div>
  );
}
