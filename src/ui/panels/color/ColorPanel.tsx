/**
 * Color panel: fill/stroke targets, colour mode (HSB/RGB/HSL/Hex/Gray/CMYK),
 * sliders with live preview tracks, spectrum bar, quick None/Black/White,
 * opacity and "add to swatches". Edits apply to the selection or the defaults
 * through commands/appearance; while a gradient is targeted the active stop is
 * edited (state.activeGradientStop).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Plus, Check } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { useCurrentAppearance } from '@/commands/appearance';
import { applyActivePaint } from '@/color/apply';
import { NumberField, Row, Select, TextField, PopoverButton, IconButton, Tooltip } from '@/ui/widgets';
import { isValidHex, normalizeHex } from '@/util/color';
import { COLOR_MODES, CHANNELS, hexToChannels, channelsToHex, channelTrackCss, clampChannels, spectrumColorAt, SPECTRUM_CSS, invertHex, complementHex, type ColorMode } from '@/color/models';
import { activeSolid, withActiveColor, isGradient, paintTypeLabel } from '@/color/paint';
import { addSwatch } from '@/color/actions';
import { findSwatchByPaint } from '@/color/swatches';
import { PaintTargets } from './shared';
import './color.css';

const MODE_KEY = 'opuller.colorPanel.mode';

function loadMode(): ColorMode {
  try {
    const m = localStorage.getItem(MODE_KEY) as ColorMode | null;
    if (m && COLOR_MODES.some((x) => x.id === m)) return m;
  } catch {
    /* ignore */
  }
  return 'hsb';
}

export function ColorPanel() {
  const app = useCurrentAppearance();
  const target = useStore((s) => s.activePaintTarget);
  const setTarget = useStore((s) => s.setActivePaintTarget);
  const stopIndex = useStore((s) => s.activeGradientStop);
  const swatches = useStore((s) => s.doc.swatches);
  const paint = target === 'fill' ? app.fill : app.stroke.paint;
  const mixed = target === 'fill' ? app.mixedFill : app.mixedStroke;
  const solid = activeSolid(paint, stopIndex);
  const gradient = isGradient(paint);
  const isNone = paint.type === 'none';

  const [mode, setModeState] = useState<ColorMode>(loadMode);
  const setMode = (m: ColorMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  // Channel values live in local state so that hue survives S/B = 0 while dragging.
  const [vals, setVals] = useState<number[]>(() => hexToChannels(mode, solid.color));
  const lastHex = useRef(solid.color);
  useEffect(() => {
    if (solid.color !== lastHex.current) {
      lastHex.current = solid.color;
      setVals(hexToChannels(mode, solid.color));
    }
  }, [solid.color, mode]);
  useEffect(() => {
    setVals(hexToChannels(mode, lastHex.current));
  }, [mode]);

  const label = target === 'fill' ? 'Fill' : 'Stroke';
  const commit = useCallback(() => getState().commit(label), [label]);

  const applyHex = useCallback(
    (hex: string, doCommit: boolean, opacity?: number) => {
      lastHex.current = hex;
      applyActivePaint(withActiveColor(paint, stopIndex, { color: hex, opacity }), doCommit);
    },
    [paint, stopIndex],
  );

  const setChannel = (i: number, v: number, doCommit = false) => {
    const next = clampChannels(mode, vals.map((x, k) => (k === i ? v : x)));
    setVals(next);
    applyHex(channelsToHex(mode, next), doCommit);
  };

  const applyOpacity = (o: number, doCommit: boolean) => {
    applyActivePaint(withActiveColor(paint, stopIndex, { opacity: Math.max(0, Math.min(1, o)) }), doCommit);
  };

  // --- spectrum bar --------------------------------------------------------
  const spectrumRef = useRef<HTMLDivElement>(null);
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  const onSpectrumDown = (e: React.PointerEvent) => {
    const el = spectrumRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const pick = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
      const y = Math.max(0, Math.min(1, (ev.clientY - r.top) / Math.max(1, r.height)));
      setMarker({ x, y });
      const hex = spectrumColorAt(x, y);
      lastHex.current = hex;
      setVals(hexToChannels(mode, hex));
      applyActivePaint(withActiveColor(paint, stopIndex, { color: hex }), false);
    };
    pick(e);
    const move = (ev: PointerEvent) => pick(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      commit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const chans = CHANNELS[mode];
  const tracks = useMemo(() => chans.map((_, i) => channelTrackCss(mode, i, vals)), [chans, mode, vals]);
  const inSwatches = !mixed && !!findSwatchByPaint(swatches, paint);
  const targetsDesc = app.targets.length === 0 ? 'Defaults for new objects' : app.targets.length === 1 ? '1 object' : `${app.targets.length} objects`;

  return (
    <div className="color-panel" data-testid="color-panel">
      <div className="color-panel-head">
        <PaintTargets fill={app.fill} stroke={app.stroke.paint} mixedFill={app.mixedFill} mixedStroke={app.mixedStroke} target={target} onSelect={setTarget} />
        <div className="cp-target-info">
          <span className="cp-target-name" data-testid="color-target-label">
            {label}: {mixed ? 'Mixed' : paintTypeLabel(paint)}
          </span>
          <span className="cp-target-sub">{targetsDesc}</span>
        </div>
        <Select value={mode} options={COLOR_MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => setMode(v as ColorMode)} width={92} title="Colour mode" id="color-mode" />
        <PopoverButton
          placement="bottom-end"
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="icon-btn" onClick={toggle} title="Panel menu" data-testid="color-menu">
              <Menu size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="cp-menu" data-testid="color-menu-list">
              {COLOR_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={mode === m.id ? 'checked' : ''}
                  onClick={() => {
                    setMode(m.id);
                    close();
                  }}
                >
                  <span style={{ width: 12 }}>{mode === m.id && <Check size={12} />}</span>
                  {m.label}
                </button>
              ))}
              <div className="cp-menu-sep" />
              <button
                type="button"
                disabled={isNone || mixed}
                onClick={() => {
                  applyHex(invertHex(solid.color), true);
                  close();
                }}
              >
                <span style={{ width: 12 }} />
                Invert
              </button>
              <button
                type="button"
                disabled={isNone || mixed}
                onClick={() => {
                  applyHex(complementHex(solid.color), true);
                  close();
                }}
              >
                <span style={{ width: 12 }} />
                Complement
              </button>
              <div className="cp-menu-sep" />
              <button
                type="button"
                disabled={isNone || mixed}
                onClick={() => {
                  addSwatch(paint);
                  close();
                }}
              >
                <span style={{ width: 12 }} />
                Create New Swatch…
              </button>
            </div>
          )}
        </PopoverButton>
      </div>

      {gradient && (
        <div className="cp-stop-note" data-testid="color-stop-note">
          <span className="cp-stop-chip" style={{ background: solid.color }} />
          Editing gradient stop {Math.min(stopIndex, paint.stops.length - 1) + 1} of {paint.stops.length}
        </div>
      )}

      {mode !== 'hex' && (
        <div className={`cp-channels ${isNone || mixed ? 'disabled' : ''}`} data-testid="color-channels">
          {chans.map((ch, i) => (
            <div className="cp-channel" key={ch.key}>
              <span className="cp-channel-label" title={ch.label}>
                {ch.label}
              </span>
              <input
                type="range"
                className="cp-range"
                min={ch.min}
                max={ch.max}
                step={1}
                value={mixed ? ch.min : Math.round(vals[i] ?? ch.min)}
                style={{ backgroundImage: tracks[i] }}
                onChange={(e) => setChannel(i, Number(e.target.value))}
                onPointerUp={commit}
                onKeyUp={commit}
                onKeyDown={(e) => e.stopPropagation()}
                title={`${ch.label} ${ch.unit === 'deg' ? '(degrees)' : ch.unit === '%' ? '(%)' : ''}`}
                data-testid={`color-slider-${ch.key}`}
              />
              <NumberField
                value={mixed ? null : Math.round(vals[i] ?? ch.min)}
                mixed={mixed}
                min={ch.min}
                max={ch.max}
                decimals={0}
                unit={ch.unit === 'deg' ? 'deg' : ch.unit === '%' ? '%' : 'none'}
                scrub={false}
                onChange={(v) => setChannel(i, v)}
                onCommit={() => commit()}
                data-testid={`color-field-${ch.key}`}
              />
            </div>
          ))}
        </div>
      )}

      <div className="cp-spectrum-row">
        <div ref={spectrumRef} className="cp-spectrum" style={{ background: SPECTRUM_CSS }} onPointerDown={onSpectrumDown} title="Click or drag to pick a colour" data-testid="color-spectrum">
          {marker && !isNone && <span className="cp-spectrum-marker" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%`, background: solid.color }} />}
        </div>
        <Tooltip text="None" shortcut="/">
          <button type="button" className="cp-quick none" onClick={() => applyActivePaint({ type: 'none' }, true)} data-testid="color-quick-none" aria-label="None" />
        </Tooltip>
        <Tooltip text="White">
          <button type="button" className="cp-quick white" onClick={() => applyHex('#ffffff', true)} data-testid="color-quick-white" aria-label="White" />
        </Tooltip>
        <Tooltip text="Black">
          <button type="button" className="cp-quick black" onClick={() => applyHex('#000000', true)} data-testid="color-quick-black" aria-label="Black" />
        </Tooltip>
      </div>

      <div className="cp-hex-row">
        <TextField
          label="#"
          mono
          value={mixed ? '' : isNone ? '' : solid.color.slice(1)}
          placeholder={mixed ? '—' : isNone ? 'none' : undefined}
          id="color-hex"
          title="Hex colour (Enter to apply)"
          onCommit={(t) => {
            const v = t.trim();
            if (v && isValidHex(v)) {
              const hex = normalizeHex(v);
              applyHex(hex, true);
            }
          }}
        />
        <NumberField
          label="Opacity"
          value={mixed || isNone ? null : Math.round(solid.opacity * 100)}
          mixed={mixed}
          disabled={isNone}
          min={0}
          max={100}
          decimals={0}
          unit="%"
          width={104}
          onChange={(v) => applyOpacity(v / 100, false)}
          onCommit={() => commit()}
          data-testid="color-opacity"
        />
      </div>

      <Row gap={6}>
        <input
          type="range"
          className="cp-range alpha"
          min={0}
          max={100}
          step={1}
          disabled={isNone || mixed}
          value={mixed || isNone ? 100 : Math.round(solid.opacity * 100)}
          style={{ backgroundImage: `linear-gradient(to right, transparent, ${solid.color}), repeating-conic-gradient(#888 0 25%, #ccc 0 50%)` }}
          onChange={(e) => applyOpacity(Number(e.target.value) / 100, false)}
          onPointerUp={commit}
          onKeyUp={commit}
          onKeyDown={(e) => e.stopPropagation()}
          title="Opacity"
          data-testid="color-opacity-slider"
        />
        <IconButton
          icon={<Plus size={14} />}
          title={inSwatches ? 'This colour is already a swatch' : 'Add to swatches'}
          disabled={isNone || mixed || inSwatches}
          onClick={() => addSwatch(paint)}
          data-testid="color-add-swatch"
        />
      </Row>
    </div>
  );
}
