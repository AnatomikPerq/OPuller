/**
 * Liquify tools (Illustrator's reshape brushes): Warp (Shift+R), Twirl,
 * Pucker, Bloat, Scallop, Crystallize and Wrinkle. Drag over paths to deform
 * them with an elliptical brush; the selection is used when there is one,
 * otherwise every path the brush passes over. Alt-drag resizes the brush
 * (Shift: proportionally), [ and ] change its size. The timed tools keep
 * working while the button is held.
 */
import React from 'react';
import { Pointer, Tornado, Shrink, Expand, Cloud, Snowflake, AudioWaveform } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { Vec } from '@/model/types';
import { getState } from '@/store/store';
import { stepSize } from '../brush/tool';
import { brushOutline, LIQUIFY_KINDS, TOOL_DEFAULTS, type LiquifyKind, type Brush } from '@/liquify/brush';
import { LiquifySession, LIQUIFY_LABELS, brushAt, currentOptions } from '@/liquify/engine';
import { LiquifyOptionsBar, setGlobalBrush } from '@/liquify/register';

interface Resize {
  origin: Vec;
  width: number;
  height: number;
}

let session: LiquifySession | null = null;
let resize: Resize | null = null;
let timer: number | null = null;
let pointerWorld: Vec | null = null;
let pressure = 1;
let leaveTarget: HTMLElement | null = null;

const TICK_MS = 40;

function stopTimer() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

function endSession(ctx: ToolContext, commit: boolean) {
  stopTimer();
  const s = session;
  session = null;
  if (!s) return;
  if (commit) {
    const changed = s.finish();
    ctx.setStatus(changed ? '' : 'No paths under the brush');
  } else s.cancel();
  ctx.requestOverlay();
}

function pressureOf(e: { pointerType: string; pressure: number }): number {
  return e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 1;
}

function onLeave() {
  if (!session && !resize) {
    pointerWorld = null;
    getState().requestOverlay();
  }
}

function BrushOverlay({ ctx, brush }: { ctx: ToolContext; brush: Brush }) {
  const pts = brushOutline(brush, 64).map((p) => ctx.worldToScreen(p));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') + 'Z';
  const c = ctx.worldToScreen({ x: brush.x, y: brush.y });
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={2.5} />
      <path d={d} fill="none" stroke="#fff" strokeWidth={1} />
      <path d={`M${c.x - 4} ${c.y}h8M${c.x} ${c.y - 4}v8`} stroke="rgba(0,0,0,0.6)" strokeWidth={2} />
      <path d={`M${c.x - 4} ${c.y}h8M${c.x} ${c.y - 4}v8`} stroke="#fff" strokeWidth={0.8} />
    </g>
  );
}

interface Def {
  name: string;
  icon: Tool['icon'];
  order: number;
  shortcut?: string;
  hint: string;
}

const DEFS: Record<LiquifyKind, Def> = {
  warp: { name: 'Warp Tool', icon: Pointer, order: 650, shortcut: 'shift+r', hint: 'Drag over paths to push them with the brush (the selection only when there is one). Alt-drag resizes the brush, [ and ] change its size.' },
  twirl: { name: 'Twirl Tool', icon: Tornado, order: 651, hint: 'Hold or drag over paths to twirl them; the longer you hold, the more they turn. Negative rates twirl clockwise.' },
  pucker: { name: 'Pucker Tool', icon: Shrink, order: 652, hint: 'Hold or drag over paths to pull them towards the brush centre.' },
  bloat: { name: 'Bloat Tool', icon: Expand, order: 653, hint: 'Hold or drag over paths to push them away from the brush centre.' },
  scallop: { name: 'Scallop Tool', icon: Cloud, order: 654, hint: 'Hold or drag over an outline to add curved, scalloped details.' },
  crystallize: { name: 'Crystallize Tool', icon: Snowflake, order: 655, hint: 'Hold or drag over an outline to add spiked, crystal-like details.' },
  wrinkle: { name: 'Wrinkle Tool', icon: AudioWaveform, order: 656, hint: 'Hold or drag over an outline to add wrinkle-like details (Horizontal / Vertical set the direction).' },
};

function makeTool(kind: LiquifyKind): Tool {
  const def = DEFS[kind];
  const Options = () => <LiquifyOptionsBar kind={kind} />;
  return {
    id: kind,
    name: def.name,
    shortcut: def.shortcut,
    icon: def.icon,
    group: 'liquify',
    order: def.order,
    cursor: 'crosshair',
    hint: def.hint,
    defaults: TOOL_DEFAULTS[kind] as unknown as Record<string, unknown>,
    Options,
    showSelectionOverlay: true,

    activate(ctx) {
      // a scripted gesture may already be running (setTool + pointer events in one tick): keep it
      pointerWorld = null;
      ctx.setCursor('crosshair');
      leaveTarget = document.querySelector('[data-testid="viewport"]');
      leaveTarget?.addEventListener('pointerleave', onLeave);
    },
    deactivate(ctx) {
      // the seven tools share the gesture state; a tool switch during a scripted
      // gesture must not cancel the session of the tool that is being activated
      if (session && session.kind === kind) endSession(ctx, false);
      resize = null;
      pointerWorld = null;
      leaveTarget?.removeEventListener('pointerleave', onLeave);
      leaveTarget = null;
    },
    isBusy: () => !!session || !!resize,
    cancel(ctx) {
      endSession(ctx, false);
      resize = null;
      ctx.requestOverlay();
    },

    onPointerDown(e, ctx) {
      if (e.button !== 0) return;
      pointerWorld = e.world;
      const o = currentOptions(kind);
      if (e.alt) {
        resize = { origin: e.world, width: o.width, height: o.height };
        ctx.setStatus('Drag to resize the brush (Shift: proportional)');
        ctx.requestOverlay();
        return;
      }
      pressure = pressureOf(e);
      session = new LiquifySession(kind, o, e.world);
      if (!session.hasCandidates()) ctx.setStatus('No paths to reshape');
      else ctx.setStatus(session.fromSelection ? `${LIQUIFY_LABELS[kind]}: reshaping the selection` : LIQUIFY_LABELS[kind]);
      if (kind !== 'warp') {
        session.step(undefined, pressure);
        stopTimer();
        timer = window.setInterval(() => {
          if (!session) return stopTimer();
          session.step(undefined, pressure);
        }, TICK_MS);
      }
      ctx.requestOverlay();
    },

    onPointerMove(e, ctx) {
      pointerWorld = e.world;
      if (resize) {
        const w = Math.abs(e.world.x - resize.origin.x) * 2;
        const h = Math.abs(e.world.y - resize.origin.y) * 2;
        const size = Math.max(w, h);
        resize.width = Math.max(2, Math.min(4000, e.shift ? size : w));
        resize.height = Math.max(2, Math.min(4000, e.shift ? size : h));
        ctx.setStatus(`Brush: ${Math.round(resize.width)} × ${Math.round(resize.height)}`);
        ctx.requestOverlay();
        return;
      }
      if (session) {
        pressure = pressureOf(e);
        if (kind === 'warp') session.warpTo(e.world, pressure);
        else session.moveTo(e.world);
      }
      ctx.requestOverlay();
    },

    onPointerUp(e, ctx) {
      pointerWorld = e.world;
      if (resize) {
        setGlobalBrush({ width: Math.round(resize.width), height: Math.round(resize.height) });
        resize = null;
        ctx.setStatus('');
        ctx.requestOverlay();
        return;
      }
      if (!session) return;
      if (kind === 'warp') session.warpTo(e.world, pressureOf(e));
      endSession(ctx, true);
    },

    onKeyDown(e, ctx) {
      if (e.key === 'Escape' && (session || resize)) {
        this.cancel!(ctx);
        return true;
      }
      if ((e.key === '[' || e.key === ']') && !e.primary) {
        const o = currentOptions(kind);
        const dir = e.key === ']' ? 1 : -1;
        setGlobalBrush({ width: stepSize(o.width, dir, 1, 4000), height: stepSize(o.height, dir, 1, 4000) });
        ctx.requestOverlay();
        return true;
      }
      return false;
    },

    renderOverlay(ctx) {
      const o = currentOptions(kind);
      let brush: Brush | null = null;
      if (resize) brush = { x: resize.origin.x, y: resize.origin.y, rx: resize.width / 2, ry: resize.height / 2, angle: o.angle };
      else if (session) brush = brushAt(session.pointer, o);
      else if (pointerWorld) brush = brushAt(pointerWorld, o);
      if (!brush) return null;
      return <BrushOverlay ctx={ctx} brush={brush} />;
    },
  };
}

export const tools: Tool[] = LIQUIFY_KINDS.map(makeTool);
void React;
