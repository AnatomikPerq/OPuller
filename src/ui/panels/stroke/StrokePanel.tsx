/**
 * Stroke panel: weight (+ presets), caps, joins, miter limit, alignment,
 * dashes, arrowheads (+ scale, swap) and width profiles. Mixed values show as
 * empty fields. Edits go through setStrokeProps (selection or defaults).
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown, ArrowLeftRight, FlipHorizontal2 } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import type { Arrowhead, LineCap, LineJoin, StrokeAlign, StrokeStyle, WidthPoint } from '@/model/types';
import { setStrokeProps } from '@/commands/appearance';
import { applyStrokePatch, strokePatchChanges } from '@/color/apply';
import { NumberField, Segmented, Checkbox, IconButton, PopoverButton, Tooltip } from '@/ui/widgets';
import { strokeSummary, MIXED, WEIGHT_PRESETS, dashPairs, pairsToDash, DEFAULT_DASH, ARROWHEADS, WIDTH_PROFILES, profilePoints, detectProfile, flipProfile, type ProfileId, type StrokeSummary } from '@/color/stroke';
import { formatNumber, pxToUnit, UNIT_LABELS } from '@/util/units';
import { CapIcon, JoinIcon, AlignIcon, ArrowheadPreview, ProfilePreview } from './icons';
import './stroke.css';

function useStrokeSummary(): StrokeSummary {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const appearance = useStore((s) => s.appearance);
  return useMemo(() => strokeSummary({ ...getState(), selection, doc, appearance }), [selection, doc, appearance]);
}

type Patch = Partial<Omit<StrokeStyle, 'paint'>>;

function applyStroke(patch: Patch, label: string, commit = true): void {
  applyStrokePatch(patch, label, commit);
}

const num = <T,>(v: T | typeof MIXED): T | null => (v === MIXED ? null : v);

export function StrokePanel() {
  const sum = useStrokeSummary();
  const units = useStore((s) => s.prefs.units);
  const width = num(sum.width);
  const cap = num(sum.cap);
  const join = num(sum.join);
  const align = num(sum.align);
  const miter = num(sum.miterLimit);
  const dash = num(sum.dash);
  const dashOffset = num(sum.dashOffset);
  const markerStart = num(sum.markerStart);
  const markerEnd = num(sum.markerEnd);
  const markerScale = num(sum.markerScale);
  const profile = sum.widthProfile === MIXED ? MIXED : sum.widthProfile;
  const dashed = dash !== null && dash.length > 0;
  const [pairs, setPairs] = useState<number[]>(() => dashPairs(dash ?? []));
  // keep the local dash slots in sync with the selection
  const dashKey = JSON.stringify(dash);
  const [lastKey, setLastKey] = useState(dashKey);
  if (dashKey !== lastKey) {
    setLastKey(dashKey);
    setPairs(dashPairs(dash ?? []));
  }

  const setWeight = (w: number, commit: boolean) => {
    const patch: Patch = { width: Math.max(0, w) };
    if (!strokePatchChanges(patch)) return;
    // scale an existing width profile with the weight (Illustrator behaviour)
    if (profile !== MIXED && profile && profile.length && width && width > 0 && Math.abs(w - width) > 1e-9) {
      const k = w / width;
      patch.widthProfile = profile.map((p) => ({ ...p, width: p.width * k, left: p.left !== undefined ? p.left * k : undefined, right: p.right !== undefined ? p.right * k : undefined }));
    }
    setStrokeProps(patch, false);
    if (commit) getState().commit('Stroke Weight');
  };

  const setDashSlot = (i: number, v: number, commit: boolean) => {
    const next = pairs.slice();
    next[i] = Math.max(0, v);
    setPairs(next);
    applyStroke({ dash: pairsToDash(next) }, 'Dashed Line', commit);
  };

  const toggleDashed = (on: boolean) => {
    if (on) {
      const p = pairsToDash(pairs).length ? pairs : dashPairs(DEFAULT_DASH);
      setPairs(p);
      applyStroke({ dash: pairsToDash(p) }, 'Dashed Line');
    } else applyStroke({ dash: [] }, 'Solid Line');
  };

  const currentProfile: ProfileId | null | typeof MIXED = profile === MIXED ? MIXED : detectProfile(profile, width ?? 1);
  const profileDef = currentProfile !== MIXED && currentProfile ? WIDTH_PROFILES.find((p) => p.id === currentProfile) : undefined;

  const applyProfile = (id: ProfileId) => {
    const pts = profilePoints(id, width ?? 1);
    applyStroke({ widthProfile: pts }, id === 'uniform' ? 'Uniform Stroke' : 'Width Profile');
  };
  const flip = () => {
    if (profile === MIXED || !profile || !profile.length) return;
    applyStroke({ widthProfile: flipProfile(profile as WidthPoint[]) }, 'Flip Width Profile');
  };

  return (
    <div className="stroke-panel" data-testid="stroke-panel">
      <div className="stroke-row">
        <NumberField
          label="Weight"
          value={width}
          mixed={sum.width === MIXED}
          min={0}
          step={0.5}
          bigStep={5}
          unit={units}
          width={150}
          onChange={(v) => setWeight(v, false)}
          onCommit={() => getState().commit('Stroke Weight')}
          title="Stroke weight"
          data-testid="stroke-weight"
        />
        <PopoverButton
          width={200}
          placement="bottom"
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="icon-btn" style={{ width: 18 }} onClick={toggle} title="Weight presets" data-testid="stroke-weight-presets">
              <ChevronDown size={12} />
            </button>
          )}
        >
          {(close) => (
            <div className="stroke-presets">
              {WEIGHT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={width !== null && Math.abs(width - p) < 1e-6 ? 'active' : ''}
                  onClick={() => {
                    setWeight(p, true);
                    close();
                  }}
                >
                  {formatNumber(pxToUnit(p, units), 2)} {UNIT_LABELS[units]}
                </button>
              ))}
            </div>
          )}
        </PopoverButton>
        <div style={{ flex: 1 }} />
        <NumberField label="Limit" value={miter} mixed={sum.miterLimit === MIXED} min={1} max={500} decimals={1} width={86} disabled={join !== 'miter' && join !== null} onChange={(v) => applyStroke({ miterLimit: v }, 'Miter Limit', false)} onCommit={() => getState().commit('Miter Limit')} title="Miter limit (miter joins only)" data-testid="stroke-miter" />
      </div>

      <div className="stroke-row">
        <span className="stroke-label">Cap</span>
        <Segmented<LineCap>
          value={cap}
          onChange={(v) => applyStroke({ cap: v }, 'Stroke Cap')}
          options={[
            { value: 'butt', icon: <CapIcon kind="butt" />, title: 'Butt cap' },
            { value: 'round', icon: <CapIcon kind="round" />, title: 'Round cap' },
            { value: 'square', icon: <CapIcon kind="square" />, title: 'Projecting cap' },
          ]}
          className="stroke-caps"
        />
        <span className="stroke-label" style={{ minWidth: 0, marginLeft: 6 }}>
          Corner
        </span>
        <Segmented<LineJoin>
          value={join}
          onChange={(v) => applyStroke({ join: v }, 'Stroke Join')}
          options={[
            { value: 'miter', icon: <JoinIcon kind="miter" />, title: 'Miter join' },
            { value: 'round', icon: <JoinIcon kind="round" />, title: 'Round join' },
            { value: 'bevel', icon: <JoinIcon kind="bevel" />, title: 'Bevel join' },
          ]}
          className="stroke-joins"
        />
      </div>

      <div className="stroke-row">
        <span className="stroke-label">Align</span>
        <Segmented<StrokeAlign>
          value={align}
          onChange={(v) => applyStroke({ align: v }, 'Align Stroke')}
          options={[
            { value: 'center', icon: <AlignIcon kind="center" />, title: 'Align stroke to center' },
            { value: 'inside', icon: <AlignIcon kind="inside" />, title: 'Align stroke to inside' },
            { value: 'outside', icon: <AlignIcon kind="outside" />, title: 'Align stroke to outside' },
          ]}
          className="stroke-align"
        />
        <div style={{ flex: 1 }} />
        <span className="muted small">{sum.hasTargets ? '' : 'Defaults'}</span>
      </div>

      <div className="stroke-row">
        <Checkbox checked={dashed} indeterminate={sum.dash === MIXED} onChange={toggleDashed} label="Dashed line" title="Dashed line: dash/gap lengths in px" className="stroke-dashed" />
        <div style={{ flex: 1 }} />
        <NumberField label="Offset" value={dashOffset} mixed={sum.dashOffset === MIXED} disabled={!dashed} unit={units} width={104} onChange={(v) => applyStroke({ dashOffset: v }, 'Dash Offset', false)} onCommit={() => getState().commit('Dash Offset')} title="Dash offset" data-testid="stroke-dash-offset" />
      </div>
      <div className={`stroke-dash-grid ${dashed ? '' : 'disabled'}`} data-testid="stroke-dash-grid">
        {pairs.map((v, i) => (
          <NumberField
            key={i}
            label={i % 2 === 0 ? 'dash' : 'gap'}
            value={sum.dash === MIXED ? null : v || null}
            mixed={sum.dash === MIXED}
            min={0}
            unit={units}
            placeholder="–"
            onChange={(nv) => setDashSlot(i, nv, false)}
            onCommit={() => getState().commit('Dashed Line')}
            data-testid={`stroke-dash-${i}`}
          />
        ))}
      </div>
      {dashed && (
        <svg className="stroke-dash-preview" viewBox="0 0 200 10" preserveAspectRatio="none">
          <line x1={0} y1={5} x2={200} y2={5} stroke="currentColor" strokeWidth={3} strokeDasharray={dash!.join(' ')} strokeDashoffset={dashOffset ?? 0} strokeLinecap={cap ?? 'butt'} />
        </svg>
      )}

      <div className="stroke-row">
        <span className="stroke-label">Arrowheads</span>
        <div style={{ flex: 1 }} />
        <NumberField label="Scale" value={markerScale === null ? null : Math.round(markerScale * 100)} mixed={sum.markerScale === MIXED} min={10} max={1000} decimals={0} unit="%" width={104} onChange={(v) => applyStroke({ markerScale: v / 100 }, 'Arrowhead Scale', false)} onCommit={() => getState().commit('Arrowhead Scale')} title="Arrowhead scale relative to the stroke weight" data-testid="stroke-arrow-scale" />
      </div>
      <div className="stroke-arrow-row">
        <ArrowheadPicker value={markerStart} mixed={sum.markerStart === MIXED} start onChange={(v) => applyStroke({ markerStart: v }, 'Arrowhead')} testId="stroke-arrow-start" />
        <Tooltip text="Swap start and end arrowheads">
          <IconButton icon={<ArrowLeftRight size={14} />} title="Swap arrowheads" disabled={markerStart === null || markerEnd === null} onClick={() => markerStart !== null && markerEnd !== null && applyStroke({ markerStart: markerEnd, markerEnd: markerStart }, 'Swap Arrowheads')} data-testid="stroke-arrow-swap" />
        </Tooltip>
        <ArrowheadPicker value={markerEnd} mixed={sum.markerEnd === MIXED} onChange={(v) => applyStroke({ markerEnd: v }, 'Arrowhead')} testId="stroke-arrow-end" />
      </div>

      <div className="stroke-row">
        <span className="stroke-label">Profile</span>
        <PopoverButton
          placement="bottom"
          button={({ toggle, ref }) => (
            <button ref={ref} type="button" className="stroke-picker-btn" onClick={toggle} title="Width profile" data-testid="stroke-profile">
              {currentProfile === MIXED ? (
                <span className="stroke-picker-name">—</span>
              ) : profileDef ? (
                <>
                  <ProfilePreview points={profileDef.points} />
                  <span className="stroke-picker-name">{profileDef.name}</span>
                </>
              ) : (
                <span className="stroke-picker-name">Custom</span>
              )}
              <ChevronDown size={12} className="stroke-picker-chevron" />
            </button>
          )}
        >
          {(close) => (
            <div className="stroke-picker-list" data-testid="stroke-profile-list">
              {WIDTH_PROFILES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={currentProfile === p.id ? 'active' : ''}
                  onClick={() => {
                    applyProfile(p.id);
                    close();
                  }}
                  data-testid={`stroke-profile-${p.id}`}
                >
                  <ProfilePreview points={p.points} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </PopoverButton>
        <Tooltip text="Flip the profile along the path">
          <IconButton icon={<FlipHorizontal2 size={14} />} title="Flip profile" disabled={profile === MIXED || !profile || !profile.length} onClick={flip} data-testid="stroke-profile-flip" />
        </Tooltip>
      </div>
    </div>
  );
}

function ArrowheadPicker({ value, mixed, start, onChange, testId }: { value: Arrowhead | null; mixed: boolean; start?: boolean; onChange: (v: Arrowhead) => void; testId: string }) {
  const name = mixed ? '—' : ARROWHEADS.find((a) => a.id === value)?.name ?? 'None';
  return (
    <PopoverButton
      placement="bottom"
      button={({ toggle, ref }) => (
        <button ref={ref} type="button" className="stroke-picker-btn" onClick={toggle} title={start ? 'Start arrowhead' : 'End arrowhead'} data-testid={testId}>
          <ArrowheadPreview kind={mixed || value === null ? 'none' : value} start={start} width={36} />
          <span className="stroke-picker-name">{name}</span>
          <ChevronDown size={12} className="stroke-picker-chevron" />
        </button>
      )}
    >
      {(close) => (
        <div className="stroke-picker-list" data-testid={`${testId}-list`}>
          {ARROWHEADS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={value === a.id ? 'active' : ''}
              onClick={() => {
                onChange(a.id);
                close();
              }}
              data-testid={`${testId}-${a.id}`}
            >
              <ArrowheadPreview kind={a.id} start={start} />
              {a.name}
            </button>
          ))}
        </div>
      )}
    </PopoverButton>
  );
}
