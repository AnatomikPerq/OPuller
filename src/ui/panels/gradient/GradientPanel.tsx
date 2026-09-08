/**
 * Gradient panel: type, stops bar, angle / radial geometry, spread, per-stop
 * fields, presets and the fill/stroke target. Solid paints convert to a
 * gradient using the solid as the first stop.
 */
import React, { useMemo, useRef, useState } from 'react';
import { FlipHorizontal2, Trash2, Ban } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import type { Paint, GradientPaint, LinearGradientPaint, RadialGradientPaint } from '@/model/types';
import { localBounds } from '@/model/document';
import { useCurrentAppearance } from '@/commands/appearance';
import { applyActivePaint } from '@/color/apply';
import { NumberField, Row, Select, Segmented, IconButton, Tooltip } from '@/ui/widgets';
import { paintCss } from '@/ui/ColorPicker';
import { isGradient, clampStopIndex, paintEquals } from '@/color/paint';
import { linearAngle, withLinearAngle, reverseGradient, toGradient, convertGradientType, updateStop, removeStop, GRADIENT_PRESETS, clamp01 } from '@/color/gradient';
import { clampFocal } from '@/color/annotator';
import { GradientBar } from './GradientBar';
import { PaintTargets, PaintPreview, SolidColorPopover } from '../color/shared';
import './gradient.css';

let lastGradient: GradientPaint | null = null;

/** Remember the last gradient edited so the preview button can re-apply it. */
export function rememberGradient(g: GradientPaint): void {
  lastGradient = g;
}

export function GradientPanel() {
  const app = useCurrentAppearance();
  const doc = useStore((s) => s.doc);
  const target = useStore((s) => s.activePaintTarget);
  const setTarget = useStore((s) => s.setActivePaintTarget);
  const stopIndex = useStore((s) => s.activeGradientStop);
  const setStop = useStore((s) => s.setActiveGradientStop);
  const paint: Paint = target === 'fill' ? app.fill : app.stroke.paint;
  const mixed = target === 'fill' ? app.mixedFill : app.mixedStroke;
  const g = isGradient(paint) ? paint : null;
  if (g) lastGradient = g;
  const label = target === 'fill' ? 'Fill' : 'Stroke';

  const aspect = useMemo(() => {
    const id = app.targets[0];
    if (!id) return 1;
    const b = localBounds(doc, id);
    return b && b.height > 1e-6 && b.width > 1e-6 ? b.width / b.height : 1;
  }, [app.targets, doc]);

  const live = (p: GradientPaint) => applyActivePaint(p, false);
  const apply = (p: Paint) => applyActivePaint(p, true);
  const commit = () => getState().commit(label);

  const idx = g ? clampStopIndex(g, stopIndex) : 0;
  const stop = g ? g.stops[idx] : null;
  const [chipPopover, setChipPopover] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  const setType = (t: 'linear' | 'radial') => {
    if (mixed || !g) apply(toGradient(paint, t, stopIndex));
    else if (g.type !== t) apply(convertGradientType(g, t));
  };

  const angle = g && g.type === 'linear' ? linearAngle(g, aspect) : 0;

  return (
    <div className="gradient-panel" data-testid="gradient-panel">
      <div className="gradient-head">
        <Tooltip text={g ? 'Current gradient' : 'Apply the last used gradient'}>
          <button
            type="button"
            className="gradient-preview-btn"
            data-testid="gradient-preview"
            onClick={() => {
              if (g) return;
              const base = lastGradient ?? toGradient(paint, 'linear', stopIndex);
              apply(paint.type === 'solid' ? toGradient(paint, base.type, stopIndex) : base);
            }}
          >
            <PaintPreview paint={mixed ? { type: 'none' } : paint} />
          </button>
        </Tooltip>
        <div className="gradient-head-controls">
          <div className="gradient-head-row">
            <Segmented
              value={g ? g.type : null}
              onChange={setType}
              options={[
                { value: 'linear', label: 'Linear', title: 'Linear gradient' },
                { value: 'radial', label: 'Radial', title: 'Radial gradient' },
              ]}
              className="gradient-type"
            />
            <Tooltip text="Reverse gradient">
              <IconButton icon={<FlipHorizontal2 size={14} />} disabled={!g} onClick={() => g && apply(reverseGradient(g))} data-testid="gradient-reverse" title="Reverse gradient" />
            </Tooltip>
            <Tooltip text="Remove the gradient (None)">
              <IconButton icon={<Ban size={14} />} disabled={paint.type === 'none'} onClick={() => apply({ type: 'none' })} data-testid="gradient-none" title="None" />
            </Tooltip>
          </div>
          <div className="gradient-head-row">
            <PaintTargets fill={app.fill} stroke={app.stroke.paint} mixedFill={app.mixedFill} mixedStroke={app.mixedStroke} target={target} onSelect={setTarget} size={18} testIdPrefix="gradient" />
            <span className="muted small" data-testid="gradient-target-label">
              {label}: {mixed ? 'Mixed' : g ? (g.type === 'linear' ? 'Linear' : 'Radial') : paint.type === 'none' ? 'None' : paint.type === 'solid' ? 'Solid' : 'Pattern'}
            </span>
          </div>
        </div>
      </div>

      {g ? (
        <>
          <GradientBar paint={g} active={idx} onSelect={setStop} onChange={live} onApply={apply} onCommit={commit} />
          {g.type === 'linear' ? (
            <div className="gradient-fields">
              <NumberField
                label="Angle"
                value={Math.round(angle * 10) / 10}
                unit="deg"
                step={1}
                bigStep={15}
                decimals={1}
                onChange={(v) => live(withLinearAngle(g as LinearGradientPaint, v, aspect))}
                onCommit={commit}
                title="Rotate the gradient around its centre"
                data-testid="gradient-angle"
              />
              <Select
                label="Spread"
                value={g.spread}
                options={[
                  { value: 'pad', label: 'Pad' },
                  { value: 'reflect', label: 'Reflect' },
                  { value: 'repeat', label: 'Repeat' },
                ]}
                onChange={(v) => apply({ ...g, spread: v as GradientPaint['spread'] })}
                id="gradient-spread"
                title="How the gradient continues beyond its ends"
              />
            </div>
          ) : (
            <RadialFields g={g as RadialGradientPaint} aspect={aspect} live={live} apply={apply} commit={commit} />
          )}

          {stop && (
            <div className="gradient-stop-row" data-testid="gradient-stop-row">
              <button ref={chipRef} type="button" className="gradient-stop-chip" title="Edit stop colour" onClick={() => setChipPopover(true)} data-testid="gradient-stop-chip">
                <PaintPreview paint={{ type: 'solid', color: stop.color, opacity: stop.opacity }} />
              </button>
              <NumberField
                label="Pos"
                value={Math.round(stop.offset * 1000) / 10}
                min={0}
                max={100}
                unit="%"
                decimals={1}
                width={92}
                onChange={(v) => live(updateStop(g, idx, { offset: clamp01(v / 100) }))}
                onCommit={commit}
                title="Stop location"
                data-testid="gradient-stop-position"
              />
              <NumberField
                label="Opacity"
                value={Math.round(stop.opacity * 100)}
                min={0}
                max={100}
                unit="%"
                decimals={0}
                width={104}
                onChange={(v) => live(updateStop(g, idx, { opacity: clamp01(v / 100) }))}
                onCommit={commit}
                title="Stop opacity"
                data-testid="gradient-stop-opacity"
              />
              <IconButton
                icon={<Trash2 size={13} />}
                title="Delete stop"
                disabled={g.stops.length <= 2}
                onClick={() => {
                  apply(removeStop(g, idx));
                  setStop(Math.max(0, Math.min(idx, g.stops.length - 2)));
                }}
                data-testid="gradient-stop-delete"
              />
              <SolidColorPopover
                open={chipPopover}
                anchor={chipRef.current}
                color={{ type: 'solid', color: stop.color, opacity: stop.opacity }}
                title={`Stop ${idx + 1}`}
                onClose={() => setChipPopover(false)}
                onChange={(c) => live(updateStop(g, idx, { color: c.color, opacity: c.opacity }))}
                onCommit={commit}
              />
            </div>
          )}
        </>
      ) : (
        <div className="gradient-hint" data-testid="gradient-hint">
          {mixed ? 'Mixed paints. ' : ''}Choose Linear or Radial, click the preview, or pick a preset to apply a gradient to the {label.toLowerCase()}.
        </div>
      )}

      <Row gap={6} align="center" style={{ justifyContent: 'space-between' }}>
        <span className="section-title" style={{ marginTop: 2 }}>
          Presets
        </span>
        <span className="muted small">{app.targets.length ? `${app.targets.length} object${app.targets.length > 1 ? 's' : ''}` : 'defaults'}</span>
      </Row>
      <div className="gradient-presets" data-testid="gradient-presets">
        {GRADIENT_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className={`gradient-preset ${g && paintEquals(g, p.paint) ? 'active' : ''}`}
            title={p.name}
            style={{ background: paintCss(p.paint) }}
            onClick={() => apply(JSON.parse(JSON.stringify(p.paint)))}
            data-testid={`gradient-preset-${p.name.replace(/\s+/g, '-').toLowerCase()}`}
          />
        ))}
      </div>
    </div>
  );
}

function RadialFields({ g, aspect, live, apply, commit }: { g: RadialGradientPaint; aspect: number; live: (p: GradientPaint) => void; apply: (p: Paint) => void; commit: () => void }) {
  const setCenter = (cx: number, cy: number) => {
    const dx = cx - g.cx;
    const dy = cy - g.cy;
    const next: RadialGradientPaint = { ...g, cx, cy };
    if (g.fx !== undefined) next.fx = g.fx + dx;
    if (g.fy !== undefined) next.fy = g.fy + dy;
    live(next);
  };
  return (
    <>
      <div className="gradient-fields three">
        <NumberField label="X" value={Math.round(g.cx * 1000) / 10} unit="%" decimals={1} step={1} onChange={(v) => setCenter(v / 100, g.cy)} onCommit={commit} title="Centre X (percent of the object width)" data-testid="gradient-cx" />
        <NumberField label="Y" value={Math.round(g.cy * 1000) / 10} unit="%" decimals={1} step={1} onChange={(v) => setCenter(g.cx, v / 100)} onCommit={commit} title="Centre Y (percent of the object height)" data-testid="gradient-cy" />
        <NumberField
          label="R"
          value={Math.round(g.r * 1000) / 10}
          unit="%"
          decimals={1}
          step={1}
          min={0.1}
          onChange={(v) => {
            const r = Math.max(0.001, v / 100);
            const f = clampFocal({ ...g, r }, g.fx ?? g.cx, g.fy ?? g.cy);
            live({ ...g, r, ...(g.fx !== undefined ? f : {}) });
          }}
          onCommit={commit}
          title="Radius (percent of the object size)"
          data-testid="gradient-radius"
        />
      </div>
      <div className="gradient-fields">
        <NumberField label="Aspect" value={Math.round(aspect * 1000) / 10} unit="%" decimals={1} disabled onChange={() => undefined} title="Ellipse aspect ratio follows the object proportions (width : height)" data-testid="gradient-aspect" />
        <Select
          label="Spread"
          value={g.spread}
          options={[
            { value: 'pad', label: 'Pad' },
            { value: 'reflect', label: 'Reflect' },
            { value: 'repeat', label: 'Repeat' },
          ]}
          onChange={(v) => apply({ ...g, spread: v as GradientPaint['spread'] })}
          id="gradient-spread"
          title="How the gradient continues beyond its edge"
        />
      </div>
    </>
  );
}
