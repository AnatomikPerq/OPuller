/**
 * Blend tool (W): click one path, then another to blend between them; keep
 * clicking to add more objects to the blend. Escape ends the sequence.
 */
import React from 'react';
import { Layers2 } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, Vec } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { worldBounds } from '@/model/document';
import { makeBlend, addToBlend, blendSpec, isBlendGroup, DEFAULT_BLEND, type BlendSpacing } from '@/blend/ops';
import { runCommand } from '@/commands/registry';
import { useToolOptions } from '@/canvas/toolContext';
import { NumberField, Segmented, Button, Row } from '@/ui/widgets';

interface BlendToolOptions extends Record<string, unknown> {
  spacing: BlendSpacing;
  steps: number;
  distance: number;
}

let pending: ID | null = null;
let cursorWorld: Vec | null = null;
let hoverId: ID | null = null;

function pathTarget(ctx: ToolContext, world: Vec): ID | null {
  const hit = ctx.hitTest(world, { enterGroups: true });
  if (!hit) return null;
  const n = ctx.doc.nodes[hit.id];
  return n && n.type === 'path' ? hit.id : null;
}

function center(ctx: ToolContext, id: ID): Vec | null {
  const b = worldBounds(ctx.doc, id);
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}

export const tool: Tool = {
  id: 'blend',
  name: 'Blend Tool',
  shortcut: 'w',
  icon: Layers2,
  group: 'edit',
  order: 633,
  cursor: 'crosshair',
  hint: 'Click one object, then another to blend between them. Keep clicking to extend the blend. Esc finishes.',
  showSelectionOverlay: true,
  defaults: { ...DEFAULT_BLEND } satisfies BlendToolOptions,
  Options: BlendOptions,

  activate() {
    pending = null;
  },
  deactivate(ctx) {
    pending = null;
    hoverId = null;
    ctx.requestOverlay();
  },
  onPointerMove(e, ctx) {
    cursorWorld = e.world;
    const h = pathTarget(ctx, e.world);
    if (h !== hoverId) {
      hoverId = h;
      ctx.requestOverlay();
    } else if (pending) ctx.requestOverlay();
    ctx.setCursor(h ? 'copy' : 'crosshair');
    ctx.setStatus(pending ? 'Click the next object to blend to (Esc to finish)' : h ? 'Click to start a blend from this object' : 'Click a path to start a blend');
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const id = pathTarget(ctx, e.world);
    if (!id) {
      pending = null;
      ctx.requestOverlay();
      return;
    }
    if (!pending) {
      pending = id;
      s.setSelection([id]);
      ctx.requestOverlay();
      return;
    }
    if (pending === id) return;
    const opts = ctx.options<BlendToolOptions>();
    const first = pending;
    const parentOfFirst = s.doc.nodes[first]?.parent;
    let gid: ID | null = null;
    if (parentOfFirst && isBlendGroup(s.doc.nodes[parentOfFirst]) && blendSpec(s.doc.nodes[parentOfFirst])?.sources.includes(first)) {
      // extend the existing blend
      const g = parentOfFirst;
      let ok = false;
      s.updateDoc((d) => {
        ok = addToBlend(d, g, id);
      }, 'Add to Blend');
      if (!ok) {
        s.toast('That object cannot be added to the blend.', 'info');
        return;
      }
      gid = g;
    } else {
      s.updateDoc((d) => {
        gid = makeBlend(d, [first, id], { spacing: opts.spacing, steps: opts.steps, distance: opts.distance });
      }, 'Make Blend');
      if (!gid) {
        s.toast('Blends need two paths.', 'info');
        pending = null;
        return;
      }
    }
    getState().setSelection([gid!]);
    pending = id;
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      if (pending) {
        pending = null;
        ctx.requestOverlay();
        return true;
      }
      return false;
    }
    return false;
  },
  renderOverlay(ctx) {
    const items: React.ReactNode[] = [];
    if (hoverId) {
      const b = worldBounds(ctx.doc, hoverId);
      if (b) {
        const tl = ctx.worldToScreen({ x: b.x, y: b.y });
        items.push(<rect key="hover" x={tl.x} y={tl.y} width={b.width * ctx.zoom} height={b.height * ctx.zoom} fill="none" stroke="#4a90e2" strokeWidth={1} strokeDasharray="3 3" pointerEvents="none" />);
      }
    }
    if (pending) {
      const c = center(ctx, pending);
      if (c) {
        const p = ctx.worldToScreen(c);
        items.push(<circle key="pending" cx={p.x} cy={p.y} r={5} fill="#4a90e2" stroke="#fff" strokeWidth={1.5} pointerEvents="none" />);
        if (cursorWorld) {
          const q = ctx.worldToScreen(cursorWorld);
          items.push(<line key="line" x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#4a90e2" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />);
        }
      }
    }
    return <g className="blend-tool-overlay">{items}</g>;
  },
  cancel(ctx) {
    pending = null;
    ctx.requestOverlay();
  },
};

function BlendOptions() {
  const [opts, set] = useToolOptions<BlendToolOptions>('blend');
  const units = useStore((s) => s.prefs.units);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const hasBlend = selection.some((id) => isBlendGroup(doc.nodes[id]) || (doc.nodes[id]?.parent && isBlendGroup(doc.nodes[doc.nodes[id]!.parent!])));
  return (
    <Row gap={10}>
      <Segmented<BlendSpacing>
        value={opts.spacing}
        options={[
          { value: 'steps', label: 'Steps' },
          { value: 'distance', label: 'Distance' },
          { value: 'smooth', label: 'Smooth' },
        ]}
        onChange={(v) => set({ spacing: v })}
      />
      {opts.spacing === 'steps' && <NumberField label="Steps" value={opts.steps} onChange={(v) => set({ steps: Math.max(1, Math.min(1000, Math.round(v))) })} min={1} max={1000} width={90} />}
      {opts.spacing === 'distance' && <NumberField label="Distance" value={opts.distance} onChange={(v) => set({ distance: Math.max(0.5, v) })} min={0.5} unit={units} width={110} />}
      <Button small disabled={!hasBlend} onClick={() => runCommand('blend.options')}>
        Blend Options…
      </Button>
      <Button small disabled={!hasBlend} onClick={() => runCommand('blend.release')}>
        Release
      </Button>
      <Button small disabled={!hasBlend} onClick={() => runCommand('blend.expand')}>
        Expand
      </Button>
      <span className="muted small">Click two or more paths in sequence.</span>
    </Row>
  );
}

void React;
