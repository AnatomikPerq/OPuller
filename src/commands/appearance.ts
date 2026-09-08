/**
 * Appearance commands: apply fill/stroke/opacity/etc. to the selection or, when
 * nothing is selected, to the defaults used for new objects.
 */
import { useStore, getState } from '@/store/store';
import type { Paint, StrokeStyle, ID, Node, TextStyle, BlendMode, Effect } from '@/model/types';
import { descendants } from '@/model/document';
import { clonePaint } from '@/model/nodes';
import { registerCommands, when } from './registry';
import { useMemo } from 'react';

/** Leaf nodes (path/text) affected by appearance edits. */
export function appearanceTargets(ids = getState().selection): ID[] {
  const s = getState();
  const out: ID[] = [];
  for (const id of ids) for (const d of descendants(s.doc, id, true)) {
    const n = s.doc.nodes[d];
    if (n && (n.type === 'path' || n.type === 'text')) out.push(d);
  }
  return Array.from(new Set(out));
}

export function setFillPaint(paint: Paint, commit = true): void {
  const s = getState();
  const targets = appearanceTargets();
  if (!targets.length) {
    s.setAppearance({ fill: clonePaint(paint) });
    return;
  }
  s.updateDoc((d) => {
    for (const id of targets) {
      const n = d.nodes[id];
      if (n.type === 'path' || n.type === 'text') n.fill = clonePaint(paint);
    }
  }, commit ? 'Fill' : undefined);
  s.setAppearance({ fill: clonePaint(paint) });
}

export function setStrokePaint(paint: Paint, commit = true): void {
  const s = getState();
  const targets = appearanceTargets();
  if (!targets.length) {
    s.setAppearance({ stroke: { ...s.appearance.stroke, paint: clonePaint(paint) } });
    return;
  }
  s.updateDoc((d) => {
    for (const id of targets) {
      const n = d.nodes[id];
      if (n.type === 'path' || n.type === 'text') {
        n.stroke = { ...n.stroke, paint: clonePaint(paint) };
        if (paint.type !== 'none' && n.stroke.width <= 0) n.stroke.width = 1;
      }
    }
  }, commit ? 'Stroke' : undefined);
  s.setAppearance({ stroke: { ...s.appearance.stroke, paint: clonePaint(paint) } });
}

export function setStrokeProps(patch: Partial<Omit<StrokeStyle, 'paint'>>, commit = true): void {
  const s = getState();
  const targets = appearanceTargets();
  if (!targets.length) {
    s.setAppearance({ stroke: { ...s.appearance.stroke, ...patch } });
    return;
  }
  s.updateDoc((d) => {
    for (const id of targets) {
      const n = d.nodes[id];
      if (n.type === 'path' || n.type === 'text') n.stroke = { ...n.stroke, ...patch, dash: patch.dash ? [...patch.dash] : n.stroke.dash };
    }
  }, commit ? 'Stroke' : undefined);
  s.setAppearance({ stroke: { ...s.appearance.stroke, ...patch } });
}

export function setNodeProps(patch: Partial<Pick<Node, 'opacity' | 'blendMode' | 'name' | 'visible' | 'locked'>>, commit = true, ids = getState().selection): void {
  const s = getState();
  if (!ids.length) return;
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (n) Object.assign(n, patch);
    }
  }, commit ? 'Edit' : undefined);
}

export function setEffects(effects: Effect[], commit = true, ids = getState().selection): void {
  const s = getState();
  s.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (n) n.effects = effects.map((e) => ({ ...e }));
    }
  }, commit ? 'Effects' : undefined);
}

export function setTextStyle(patch: Partial<TextStyle>, commit = true): void {
  const s = getState();
  const targets = s.selection.flatMap((id) => descendants(s.doc, id, true)).filter((id) => s.doc.nodes[id]?.type === 'text');
  if (!targets.length) {
    s.setAppearance({ textStyle: { ...s.appearance.textStyle, ...patch } });
    return;
  }
  s.updateDoc((d) => {
    for (const id of targets) {
      const n = d.nodes[id];
      if (n.type === 'text') {
        n.style = { ...n.style, ...patch };
        // clear per-run overrides for the properties being set
        for (const r of n.runs) if (r.style) for (const k of Object.keys(patch)) delete (r.style as any)[k];
      }
    }
  }, commit ? 'Text style' : undefined);
  s.setAppearance({ textStyle: { ...s.appearance.textStyle, ...patch } });
}

export function swapFillStroke(): void {
  const s = getState();
  const targets = appearanceTargets();
  if (!targets.length) {
    const { fill, stroke } = s.appearance;
    s.setAppearance({ fill: clonePaint(stroke.paint), stroke: { ...stroke, paint: clonePaint(fill) } });
    return;
  }
  s.updateDoc((d) => {
    for (const id of targets) {
      const n = d.nodes[id];
      if (n.type === 'path' || n.type === 'text') {
        const f = n.fill;
        n.fill = clonePaint(n.stroke.paint);
        n.stroke = { ...n.stroke, paint: clonePaint(f) };
      }
    }
  }, 'Swap Fill & Stroke');
  const cur = currentAppearance();
  s.setAppearance({ fill: cur.fill, stroke: cur.stroke });
}

export function defaultFillStroke(): void {
  setFillPaint({ type: 'solid', color: '#ffffff', opacity: 1 }, false);
  setStrokePaint({ type: 'solid', color: '#000000', opacity: 1 }, false);
  setStrokeProps({ width: 1 }, false);
  getState().commit('Default Fill & Stroke');
}

export interface CurrentAppearance {
  fill: Paint;
  stroke: StrokeStyle;
  mixedFill: boolean;
  mixedStroke: boolean;
  opacity: number | null;
  blendMode: BlendMode | null;
  textStyle: TextStyle;
  /** ids the appearance was derived from */
  targets: ID[];
}

/** Appearance shown in the toolbar/panels: from the selection or the defaults. */
export function currentAppearance(state = getState()): CurrentAppearance {
  const targets = appearanceTargets(state.selection);
  if (!targets.length) {
    return { fill: state.appearance.fill, stroke: state.appearance.stroke, mixedFill: false, mixedStroke: false, opacity: null, blendMode: null, textStyle: state.appearance.textStyle, targets: [] };
  }
  const first = state.doc.nodes[targets[0]] as Extract<Node, { fill: Paint }>;
  let mixedFill = false;
  let mixedStroke = false;
  const fk = JSON.stringify(first.fill);
  const sk = JSON.stringify(first.stroke);
  for (const id of targets.slice(1)) {
    const n = state.doc.nodes[id] as Extract<Node, { fill: Paint }>;
    if (JSON.stringify(n.fill) !== fk) mixedFill = true;
    if (JSON.stringify(n.stroke) !== sk) mixedStroke = true;
  }
  const selNodes = state.selection.map((id) => state.doc.nodes[id]).filter(Boolean);
  const opacity = selNodes.length && selNodes.every((n) => n.opacity === selNodes[0].opacity) ? selNodes[0].opacity : null;
  const blendMode = selNodes.length && selNodes.every((n) => n.blendMode === selNodes[0].blendMode) ? selNodes[0].blendMode : null;
  const textNode = targets.map((id) => state.doc.nodes[id]).find((n) => n.type === 'text');
  return { fill: first.fill, stroke: first.stroke, mixedFill, mixedStroke, opacity, blendMode, textStyle: textNode && textNode.type === 'text' ? textNode.style : state.appearance.textStyle, targets };
}

/** React hook version. */
export function useCurrentAppearance(): CurrentAppearance {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const appearance = useStore((s) => s.appearance);
  return useMemo(() => currentAppearance({ ...getState(), selection, doc, appearance }), [selection, doc, appearance]);
}

/** Paint currently targeted by the colour UI (fill or stroke). */
export function activePaint(state = getState()): Paint {
  const a = currentAppearance(state);
  return state.activePaintTarget === 'fill' ? a.fill : a.stroke.paint;
}

export function setActivePaint(paint: Paint, commit = true): void {
  if (getState().activePaintTarget === 'fill') setFillPaint(paint, commit);
  else setStrokePaint(paint, commit);
}

registerCommands([
  { id: 'appearance.swap', label: 'Swap Fill & Stroke', shortcut: 'shift+x', hidden: true, run: swapFillStroke },
  { id: 'appearance.default', label: 'Default Fill & Stroke', shortcut: 'd', hidden: true, run: defaultFillStroke },
  { id: 'appearance.toggleTarget', label: 'Toggle Fill/Stroke', shortcut: 'x', hidden: true, run: () => getState().setActivePaintTarget(getState().activePaintTarget === 'fill' ? 'stroke' : 'fill') },
  { id: 'appearance.none', label: 'None', shortcut: '/', hidden: true, run: () => setActivePaint({ type: 'none' }) },
  { id: 'appearance.solid', label: 'Color', shortcut: ',', hidden: true, run: () => { const p = activePaint(); if (p.type !== 'solid') setActivePaint({ type: 'solid', color: p.type === 'linear' || p.type === 'radial' ? p.stops[0].color : '#000000', opacity: 1 }); } },
  { id: 'appearance.gradient', label: 'Gradient', shortcut: '.', hidden: true, run: () => { const p = activePaint(); if (p.type !== 'linear' && p.type !== 'radial') setActivePaint({ type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, spread: 'pad', stops: [{ offset: 0, color: p.type === 'solid' ? p.color : '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] }); } },
  { id: 'appearance.opacityUp', label: 'Increase Opacity', hidden: true, run: () => { const s = getState(); const a = currentAppearance(); setNodeProps({ opacity: Math.min(1, (a.opacity ?? 1) + 0.1) }); void s; }, enabled: when.hasSelection },
]);
