/**
 * Graph tool (J): drag a rectangle to create a graph of the chosen type, then
 * the Graph Data dialog opens. A click creates a default-sized graph.
 */
import React from 'react';
import { BarChart3 } from 'lucide-react';
import type { Tool } from '../types';
import type { Vec } from '@/model/types';
import { getState } from '@/store/store';
import { useOverlayStore } from '@/canvas/overlayStore';
import { useToolOptions } from '@/canvas/toolContext';
import { Row, Select } from '@/ui/widgets';
import { rectFromPoints } from '@/geometry/vec';
import { GRAPH_TYPES, type GraphType } from '@/graphs/build';
import { createGraphCommand } from '@/graphs/register';

interface Options extends Record<string, unknown> {
  type: GraphType;
}

let drag: { start: Vec; current: Vec } | null = null;

function GraphOptions() {
  const [opts, set] = useToolOptions<Options>('graph');
  return (
    <Row gap={8}>
      <Select label="Graph type" value={opts.type} options={GRAPH_TYPES.map((t) => ({ value: t.id, label: t.label }))} onChange={(v) => set({ type: v as GraphType })} width={190} id="graph-tool-type" />
      <span className="muted">Drag to define the graph area (Shift: square, Alt: from the centre); the data editor opens afterwards.</span>
    </Row>
  );
}

export const tool: Tool = {
  id: 'graph',
  name: 'Graph Tool',
  shortcut: 'j',
  icon: BarChart3,
  group: 'text',
  order: 450,
  cursor: 'crosshair',
  hint: 'Drag to create a graph; edit its data in the dialog that opens (Object > Graph > Data…).',
  defaults: { type: 'column' } satisfies Options,
  Options: GraphOptions,
  showSelectionOverlay: true,

  isBusy: () => !!drag,
  cancel(ctx) {
    drag = null;
    useOverlayStore.getState().setMarquee(null);
    ctx.requestOverlay();
  },
  onPointerDown(e) {
    if (e.button !== 0) return;
    drag = { start: e.world, current: e.world };
  },
  onPointerMove(e, ctx) {
    if (!drag) return;
    let cur = e.world;
    if (e.shift) {
      const dx = cur.x - drag.start.x;
      const dy = cur.y - drag.start.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      cur = { x: drag.start.x + Math.sign(dx || 1) * m, y: drag.start.y + Math.sign(dy || 1) * m };
    }
    drag.current = cur;
    const r = e.alt ? { x: drag.start.x - (cur.x - drag.start.x), y: drag.start.y - (cur.y - drag.start.y), width: (cur.x - drag.start.x) * 2, height: (cur.y - drag.start.y) * 2 } : rectFromPoints(drag.start, cur);
    useOverlayStore.getState().setMarquee({ x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) });
    ctx.requestOverlay();
  },
  onPointerUp(e, ctx) {
    const d = drag;
    drag = null;
    useOverlayStore.getState().setMarquee(null);
    if (!d) return;
    const opts = ctx.options<Options>();
    let r = rectFromPoints(d.start, d.current);
    if (e.alt) r = { x: d.start.x - (d.current.x - d.start.x), y: d.start.y - (d.current.y - d.start.y), width: Math.abs(d.current.x - d.start.x) * 2, height: Math.abs(d.current.y - d.start.y) * 2 };
    if (r.width < 20 || r.height < 20) r = { x: d.start.x, y: d.start.y, width: 400, height: 260 };
    const id = createGraphCommand(r, { type: opts.type });
    if (id) getState().openDialog('graph.data', { id });
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && drag) {
      this.cancel!(ctx);
      return true;
    }
    return false;
  },
};

void React;
