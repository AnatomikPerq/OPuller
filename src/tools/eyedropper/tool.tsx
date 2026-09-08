/**
 * Eyedropper tool (I): click an object to sample its appearance (fill, stroke,
 * stroke options, text style, opacity - per the options bar) and apply it to
 * the selection or the defaults. Alt-click applies the current appearance to
 * the clicked object; Shift-click samples only a colour (from a fill/stroke,
 * gradient point or image pixel) into the active paint target.
 */
import React from 'react';
import { Pipette } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import { useStore, getState } from '@/store/store';
import { setActivePaint } from '@/commands/appearance';
import { useToolOptions } from '@/canvas/toolContext';
import { Checkbox, Row } from '@/ui/widgets';
import { sampleNode, applySample, applyAppearanceToNode, sampleColorAt, sampleImagePixel, DEFAULT_EYEDROPPER_OPTIONS, type EyedropperOptions } from '@/color/sample';
import { EYEDROPPER_CURSOR, EYEDROPPER_APPLY_CURSOR, EYEDROPPER_COLOR_CURSOR } from '../gradient/cursors';

let pressed: { screen: { x: number; y: number }; alt: boolean; shift: boolean } | null = null;
let sampling = false;

function cursorFor(alt: boolean, shift: boolean): string {
  if (alt) return EYEDROPPER_APPLY_CURSOR;
  if (shift) return EYEDROPPER_COLOR_CURSOR;
  return EYEDROPPER_CURSOR;
}

function options(ctx: ToolContext): EyedropperOptions {
  return { ...DEFAULT_EYEDROPPER_OPTIONS, ...ctx.options<Partial<EyedropperOptions>>() };
}

function hitLeaf(ctx: ToolContext, e: ToolPointerEvent) {
  // the leaf under the pointer (groups are entered); locked objects can be sampled too
  return ctx.hitTest(e.world, { enterGroups: true, includeLocked: true });
}

async function sampleAt(e: ToolPointerEvent, ctx: ToolContext): Promise<void> {
  const s = ctx.state;
  const hit = hitLeaf(ctx, e);
  if (!hit) {
    ctx.setStatus('Eyedropper: nothing to sample here');
    return;
  }
  const opts = options(ctx);
  const node = s.doc.nodes[hit.id];
  if (!node) return;

  if (e.alt) {
    // apply the current appearance to the clicked object
    applyAppearanceToNode(hit.id, opts);
    ctx.setStatus(`Applied appearance to ${node.name}`);
    return;
  }

  if (e.shift) {
    // colour only, into the active target
    let c: { color: string; opacity: number } | null = null;
    if (node.type === 'image') {
      if (sampling) return;
      sampling = true;
      try {
        c = await sampleImagePixel(s.doc, hit.id, e.world);
      } finally {
        sampling = false;
      }
    } else c = sampleColorAt(s.doc, hit.id, e.world, hit.kind === 'stroke');
    if (!c) {
      ctx.setStatus('No colour at this point');
      return;
    }
    setActivePaint({ type: 'solid', color: c.color, opacity: c.opacity }, false);
    getState().commit(getState().activePaintTarget === 'fill' ? 'Fill' : 'Stroke');
    ctx.setStatus(`Sampled ${c.color.toUpperCase()}`);
    return;
  }

  const sample = sampleNode(s.doc, hit.id);
  if (!sample) return;
  // do not sample the object onto itself
  const targets = s.selection;
  if (targets.length === 1 && targets[0] === hit.id) {
    ctx.setStatus('Select another object to copy this appearance to');
    return;
  }
  applySample(sample, opts);
  ctx.setStatus(targets.length ? `Copied appearance of ${node.name} to ${targets.length} object${targets.length > 1 ? 's' : ''}` : `Sampled ${node.name} into the defaults`);
}

export const eyedropperTool: Tool = {
  id: 'eyedropper',
  name: 'Eyedropper Tool',
  shortcut: 'i',
  icon: Pipette,
  group: 'edit',
  order: 621,
  cursor: EYEDROPPER_CURSOR,
  hint: 'Click an object to copy its appearance to the selection. Alt+click applies the selection appearance to it. Shift+click samples only the colour under the cursor.',
  showSelectionOverlay: true,
  defaults: { ...DEFAULT_EYEDROPPER_OPTIONS },
  Options: EyedropperOptions,

  activate(ctx) {
    pressed = null;
    ctx.setCursor(EYEDROPPER_CURSOR);
  },
  deactivate(ctx) {
    pressed = null;
    ctx.state.setHover(null);
  },
  isBusy: () => false,

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    pressed = { screen: e.screen, alt: e.alt, shift: e.shift };
    ctx.setCursor(cursorFor(e.alt, e.shift));
  },
  onPointerMove(e, ctx) {
    const s = ctx.state;
    ctx.setCursor(cursorFor(e.alt, e.shift));
    if (pressed) return;
    const hit = hitLeaf(ctx, e);
    s.setHover(hit ? hit.id : null);
  },
  onPointerUp(e, ctx) {
    const p = pressed;
    pressed = null;
    if (!p || e.button !== 0) return;
    // a small drag still counts as a click (Illustrator samples on release)
    void sampleAt({ ...e, alt: e.alt || p.alt, shift: e.shift || p.shift }, ctx);
    ctx.setCursor(cursorFor(e.alt, e.shift));
  },
  onModifiers(e, ctx) {
    ctx.setCursor(cursorFor(e.alt, e.shift));
  },
  onKeyDown(e) {
    if (e.key === 'Escape' && pressed) {
      pressed = null;
      return true;
    }
    return false;
  },
};

function EyedropperOptions() {
  const [opts, set] = useToolOptions<EyedropperOptions>('eyedropper');
  const selection = useStore((s) => s.selection);
  return (
    <Row gap={10}>
      <span className="muted small">Sample:</span>
      <Checkbox checked={!!opts.fill} onChange={(v) => set({ fill: v })} label="Fill" title="Sample the fill paint" />
      <Checkbox checked={!!opts.stroke} onChange={(v) => set({ stroke: v })} label="Stroke" title="Sample the stroke paint" />
      <Checkbox checked={!!opts.strokeOptions} onChange={(v) => set({ strokeOptions: v })} label="Stroke options" title="Sample weight, caps, joins, dashes, arrowheads and width profile" />
      <Checkbox checked={!!opts.textStyle} onChange={(v) => set({ textStyle: v })} label="Text style" title="Sample character formatting from text objects" />
      <Checkbox checked={!!opts.opacity} onChange={(v) => set({ opacity: v })} label="Opacity" title="Sample the object opacity (selection only)" />
      <span className="muted">{selection.length ? `Applies to ${selection.length} selected object${selection.length > 1 ? 's' : ''}` : 'Applies to the defaults for new objects'}</span>
    </Row>
  );
}

export const tool = eyedropperTool;
void React;
