/**
 * Effect definitions shared by the Effect menu, the effect dialogs and the
 * Appearance / Effects panels: labels, defaults, parameter schemas, summaries
 * and the functions that apply an effect to the selection.
 */
import type { ComponentType } from 'react';
import { CloudFog, Droplets, Sun, SunMedium, Moon, SquareRoundCorner, Palette } from 'lucide-react';
import type { Effect, ID } from '@/model/types';
import { getState } from '@/store/store';
import { formatLength } from '@/util/units';

export type EffectType = Effect['type'];
export type EffectMenu = 'Stylize' | 'Blur' | 'Adjust';

export type ParamKind = 'length' | 'angle' | 'percent' | 'factor' | 'color';

export interface EffectParam {
  key: string;
  label: string;
  kind: ParamKind;
  min: number;
  max: number;
  step?: number;
  /** value of a "neutral" setting, shown as a tick on the slider */
  neutral?: number;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  /** label used in the Effect menu (with ellipsis) */
  menuLabel: string;
  menu: EffectMenu;
  order: number;
  icon: ComponentType<{ size?: number }>;
  description: string;
  defaults: () => Effect;
  params: EffectParam[];
  summary: (e: Effect) => string;
}

const px = (v: number) => formatLength(v, getState().prefs.units, 1).replace(/\s+/g, '');
const pct = (v: number) => `${Math.round(v * 100)}%`;

export const EFFECT_DEFS: EffectDef[] = [
  {
    type: 'dropShadow',
    label: 'Drop Shadow',
    menuLabel: 'Drop Shadow…',
    menu: 'Stylize',
    order: 10,
    icon: Droplets,
    description: 'Soft shadow behind the object.',
    defaults: () => ({ type: 'dropShadow', enabled: true, dx: 4, dy: 4, blur: 4, color: '#000000', opacity: 0.5 }),
    params: [
      { key: 'dx', label: 'X offset', kind: 'length', min: -500, max: 500, step: 1 },
      { key: 'dy', label: 'Y offset', kind: 'length', min: -500, max: 500, step: 1 },
      { key: 'blur', label: 'Blur', kind: 'length', min: 0, max: 250, step: 0.5 },
      { key: 'color', label: 'Color', kind: 'color', min: 0, max: 0 },
      { key: 'opacity', label: 'Opacity', kind: 'percent', min: 0, max: 1, step: 0.01 },
    ],
    summary: (e) => (e.type === 'dropShadow' ? `${px(e.dx)}, ${px(e.dy)} · blur ${px(e.blur)} · ${pct(e.opacity)}` : ''),
  },
  {
    type: 'innerShadow',
    label: 'Inner Shadow',
    menuLabel: 'Inner Shadow…',
    menu: 'Stylize',
    order: 11,
    icon: Moon,
    description: 'Shadow cast inside the object edges.',
    defaults: () => ({ type: 'innerShadow', enabled: true, dx: 3, dy: 3, blur: 4, color: '#000000', opacity: 0.5 }),
    params: [
      { key: 'dx', label: 'X offset', kind: 'length', min: -500, max: 500, step: 1 },
      { key: 'dy', label: 'Y offset', kind: 'length', min: -500, max: 500, step: 1 },
      { key: 'blur', label: 'Blur', kind: 'length', min: 0, max: 250, step: 0.5 },
      { key: 'color', label: 'Color', kind: 'color', min: 0, max: 0 },
      { key: 'opacity', label: 'Opacity', kind: 'percent', min: 0, max: 1, step: 0.01 },
    ],
    summary: (e) => (e.type === 'innerShadow' ? `${px(e.dx)}, ${px(e.dy)} · blur ${px(e.blur)} · ${pct(e.opacity)}` : ''),
  },
  {
    type: 'outerGlow',
    label: 'Outer Glow',
    menuLabel: 'Outer Glow…',
    menu: 'Stylize',
    order: 12,
    icon: Sun,
    description: 'Glow radiating outwards from the object.',
    defaults: () => ({ type: 'outerGlow', enabled: true, blur: 6, color: '#ffffbe', opacity: 0.75 }),
    params: [
      { key: 'blur', label: 'Blur', kind: 'length', min: 0, max: 250, step: 0.5 },
      { key: 'color', label: 'Color', kind: 'color', min: 0, max: 0 },
      { key: 'opacity', label: 'Opacity', kind: 'percent', min: 0, max: 1, step: 0.01 },
    ],
    summary: (e) => (e.type === 'outerGlow' ? `blur ${px(e.blur)} · ${pct(e.opacity)}` : ''),
  },
  {
    type: 'innerGlow',
    label: 'Inner Glow',
    menuLabel: 'Inner Glow…',
    menu: 'Stylize',
    order: 13,
    icon: SunMedium,
    description: 'Glow inside the object edges.',
    defaults: () => ({ type: 'innerGlow', enabled: true, blur: 6, color: '#ffffbe', opacity: 0.75 }),
    params: [
      { key: 'blur', label: 'Blur', kind: 'length', min: 0, max: 250, step: 0.5 },
      { key: 'color', label: 'Color', kind: 'color', min: 0, max: 0 },
      { key: 'opacity', label: 'Opacity', kind: 'percent', min: 0, max: 1, step: 0.01 },
    ],
    summary: (e) => (e.type === 'innerGlow' ? `blur ${px(e.blur)} · ${pct(e.opacity)}` : ''),
  },
  {
    type: 'roundCorners',
    label: 'Round Corners',
    menuLabel: 'Round Corners…',
    menu: 'Stylize',
    order: 14,
    icon: SquareRoundCorner,
    description: 'Rounds every corner of the path (live, non-destructive).',
    defaults: () => ({ type: 'roundCorners', enabled: true, radius: 10 }),
    params: [{ key: 'radius', label: 'Radius', kind: 'length', min: 0, max: 500, step: 0.5 }],
    summary: (e) => (e.type === 'roundCorners' ? `radius ${px(e.radius)}` : ''),
  },
  {
    type: 'blur',
    label: 'Gaussian Blur',
    menuLabel: 'Gaussian Blur…',
    menu: 'Blur',
    order: 20,
    icon: CloudFog,
    description: 'Blurs the object.',
    defaults: () => ({ type: 'blur', enabled: true, radius: 4 }),
    params: [{ key: 'radius', label: 'Radius', kind: 'length', min: 0, max: 250, step: 0.1 }],
    summary: (e) => (e.type === 'blur' ? `radius ${px(e.radius)}` : ''),
  },
  {
    type: 'colorAdjust',
    label: 'Adjust Colors',
    menuLabel: 'Adjust Colors…',
    menu: 'Adjust',
    order: 30,
    icon: Palette,
    description: 'Brightness, contrast, saturation, hue and more.',
    defaults: () => ({ type: 'colorAdjust', enabled: true, brightness: 1, contrast: 1, saturate: 1, hueRotate: 0, grayscale: 0, invert: 0, sepia: 0 }),
    params: [
      { key: 'brightness', label: 'Brightness', kind: 'factor', min: 0, max: 2, step: 0.01, neutral: 1 },
      { key: 'contrast', label: 'Contrast', kind: 'factor', min: 0, max: 2, step: 0.01, neutral: 1 },
      { key: 'saturate', label: 'Saturation', kind: 'factor', min: 0, max: 3, step: 0.01, neutral: 1 },
      { key: 'hueRotate', label: 'Hue', kind: 'angle', min: -180, max: 180, step: 1, neutral: 0 },
      { key: 'grayscale', label: 'Grayscale', kind: 'percent', min: 0, max: 1, step: 0.01 },
      { key: 'sepia', label: 'Sepia', kind: 'percent', min: 0, max: 1, step: 0.01 },
      { key: 'invert', label: 'Invert', kind: 'percent', min: 0, max: 1, step: 0.01 },
    ],
    summary: (e) => {
      if (e.type !== 'colorAdjust') return '';
      const parts: string[] = [];
      if (Math.abs(e.brightness - 1) > 1e-6) parts.push(`B ${pct(e.brightness)}`);
      if (Math.abs(e.contrast - 1) > 1e-6) parts.push(`C ${pct(e.contrast)}`);
      if (Math.abs(e.saturate - 1) > 1e-6) parts.push(`S ${pct(e.saturate)}`);
      if (e.hueRotate) parts.push(`H ${Math.round(e.hueRotate)}°`);
      if (e.grayscale) parts.push(`gray ${pct(e.grayscale)}`);
      if (e.sepia) parts.push(`sepia ${pct(e.sepia)}`);
      if (e.invert) parts.push(`invert ${pct(e.invert)}`);
      return parts.join(' · ') || 'neutral';
    },
  },
];

export function effectDef(type: EffectType): EffectDef {
  return EFFECT_DEFS.find((d) => d.type === type)!;
}

export function effectLabel(e: Effect): string {
  return effectDef(e.type)?.label ?? e.type;
}

export function effectSummary(e: Effect): string {
  return effectDef(e.type)?.summary(e) ?? '';
}

export function cloneEffect(e: Effect): Effect {
  return { ...e };
}

/** How an effect is merged into a node's effect list. */
export type ApplyMode = { kind: 'append' } | { kind: 'replaceType' } | { kind: 'index'; index: number };

/**
 * Apply an effect to the given nodes. `replaceType` updates an existing effect
 * of the same type (or appends); `index` replaces the effect at that index of
 * the first node (other nodes fall back to replaceType).
 */
export function applyEffect(effect: Effect, ids: ID[], mode: ApplyMode, commitLabel?: string): void {
  const s = getState();
  s.updateDoc((d) => {
    ids.forEach((id, k) => {
      const n = d.nodes[id];
      if (!n) return;
      const list = n.effects.map(cloneEffect);
      if (mode.kind === 'index' && k === 0 && list[mode.index]) list[mode.index] = cloneEffect(effect);
      else if (mode.kind === 'append') list.push(cloneEffect(effect));
      else {
        const i = list.findIndex((e) => e.type === effect.type);
        if (i >= 0) list[i] = cloneEffect(effect);
        else list.push(cloneEffect(effect));
      }
      n.effects = list;
    });
  }, commitLabel);
}

let lastApplied: Effect | null = null;
const lastValues: Partial<Record<EffectType, Effect>> = {};

export function rememberEffect(e: Effect): void {
  lastApplied = cloneEffect(e);
  lastValues[e.type] = cloneEffect(e);
}

export function lastEffect(): Effect | null {
  return lastApplied ? cloneEffect(lastApplied) : null;
}

/** Initial values for a new instance of an effect: the last used ones, else defaults. */
export function initialEffect(type: EffectType): Effect {
  const last = lastValues[type];
  return last ? { ...cloneEffect(last), enabled: true } : effectDef(type).defaults();
}

/** Human readable value for a parameter (used in summaries / tooltips). */
export function formatParam(p: EffectParam, v: number): string {
  switch (p.kind) {
    case 'length':
      return px(v);
    case 'angle':
      return `${Math.round(v)}°`;
    case 'percent':
    case 'factor':
      return pct(v);
    default:
      return String(v);
  }
}
