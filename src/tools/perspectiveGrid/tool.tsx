/**
 * Perspective Grid tool (Shift+P): shows the grid and drags its handles —
 * vanishing points (with the horizon), the origin (corner + ground line), the
 * wall height, the grid extent and the vertical vanishing point of three-point
 * grids. Clicking a plane makes it the active plane; 1 / 2 / 3 select the
 * left / horizontal / right plane; Escape returns to the previous tool.
 */
import React from 'react';
import { Grid2x2 } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { PerspectiveGrid, Vec } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { NumberField, Row, Segmented, Slider, Checkbox, Button } from '@/ui/widgets';
import { useOverlayStore } from '@/canvas/overlayStore';
import { usePerspectiveStore } from '@/perspective/store';
import { gridHandles, dragHandle, planeLines, PLANES, PLANE_COLORS, PLANE_LABELS, withType, defaultGrid, type GridHandle } from '@/perspective/grid';
import { pointInPolygon } from '@/perspective/ops';
import { ensureGrid, updateGrid, setActivePlane, setPreset } from '@/perspective/register';

let gesture: { handle: GridHandle; base: PerspectiveGrid; moved: boolean } | null = null;
let hover: GridHandle | null = null;

function gridOf(ctx: ToolContext): PerspectiveGrid | undefined {
  return ctx.state.doc.perspective;
}

function handleAt(ctx: ToolContext, screen: Vec): GridHandle | null {
  const g = gridOf(ctx);
  if (!g) return null;
  const size = ctx.state.prefs.handleSize / 2 + 4;
  for (const h of gridHandles(g)) {
    const p = ctx.worldToScreen(h.point);
    if (Math.abs(p.x - screen.x) <= size && Math.abs(p.y - screen.y) <= size) return h.id;
  }
  return null;
}

function planeAt(g: PerspectiveGrid, world: Vec) {
  // walls first (they overlap the floor near the corner)
  for (const p of ['right', 'left', 'floor'] as const) {
    if (pointInPolygon(world, planeLines(g, p).outline)) return p;
  }
  return null;
}

function finish(ctx: ToolContext) {
  gesture = null;
  useOverlayStore.getState().setHud(null);
  ctx.requestOverlay();
}

export const tool: Tool = {
  id: 'perspectiveGrid',
  name: 'Perspective Grid Tool',
  shortcut: 'shift+p',
  icon: Grid2x2,
  group: 'perspective',
  order: 780,
  cursor: 'default',
  hint: 'Drag the vanishing points, horizon, origin, height and extent handles to edit the grid. Click a plane to make it active (1 / 2 / 3). Esc exits.',
  showSelectionOverlay: false,
  Options: PerspectiveGridOptions,

  activate(ctx) {
    ensureGrid();
    usePerspectiveStore.getState().setVisible(true);
    ctx.requestOverlay();
  },
  deactivate(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    useOverlayStore.getState().setHud(null);
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const g = gridOf(ctx);
    if (!g) return;
    const h = handleAt(ctx, e.screen);
    if (h) {
      gesture = { handle: h, base: g, moved: false };
      ctx.setCursor('grabbing');
      return;
    }
    const plane = planeAt(g, e.world);
    if (plane) setActivePlane(plane);
  },

  onPointerMove(e, ctx) {
    if (!gesture) {
      const h = handleAt(ctx, e.screen);
      if (h !== hover) {
        hover = h;
        ctx.requestOverlay();
      }
      ctx.setCursor(h ? 'grab' : 'default');
      return;
    }
    gesture.moved = true;
    const next = dragHandle(gesture.base, gesture.handle, e.world, e.shift);
    updateGrid(next, null);
    const hud = gesture.handle === 'height' ? `Height: ${Math.round(next.height)}` : gesture.handle.startsWith('extent') ? `Extent: ${Math.round(next.extent)}` : `X: ${Math.round(e.world.x)}  Y: ${Math.round(e.world.y)}`;
    useOverlayStore.getState().setHud({ screen: { x: e.screen.x + 16, y: e.screen.y + 16 }, text: hud });
    ctx.requestOverlay();
  },

  onPointerUp(_e: ToolPointerEvent, ctx) {
    if (!gesture) return;
    if (gesture.moved) ctx.commit('Edit Perspective Grid');
    else ctx.state.revert();
    finish(ctx);
    ctx.setCursor('grab');
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (gesture) {
        this.cancel!(ctx);
        return true;
      }
      const s = ctx.state;
      ctx.setTool(s.previousTool && s.previousTool !== 'perspectiveGrid' ? s.previousTool : 'select');
      return true;
    }
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      setActivePlane(e.key === '1' ? 'left' : e.key === '2' ? 'floor' : 'right');
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const g = gridOf(ctx);
    if (!g) return null;
    const hs = ctx.state.prefs.handleSize + 2;
    const active = usePerspectiveStore.getState().activePlane;
    const badge = ctx.worldToScreen(planeLines(g, active).outline[0]);
    return (
      <g className="perspective-tool-overlay" data-testid="perspective-grid-overlay">
        {gridHandles(g).map((h) => {
          const p = ctx.worldToScreen(h.point);
          const cls = `pg-handle ${gesture?.handle === h.id ? 'active' : hover === h.id ? 'hover' : ''}`;
          return h.id.startsWith('vp') ? (
            <circle key={h.id} className={cls} cx={p.x} cy={p.y} r={hs / 2} data-handle={h.id} data-testid={`perspective-handle-${h.id}`}>
              <title>{h.title}</title>
            </circle>
          ) : (
            <rect key={h.id} className={cls} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} rx={h.id === 'horizon' ? hs / 2 : 1} data-handle={h.id} data-testid={`perspective-handle-${h.id}`}>
              <title>{h.title}</title>
            </rect>
          );
        })}
        <text className="pg-plane-badge" x={badge.x + 6} y={badge.y - 8} fill={PLANE_COLORS[active]}>
          {PLANE_LABELS[active]}
        </text>
      </g>
    );
  },

  isBusy: () => !!gesture,
  cancel(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    useOverlayStore.getState().setHud(null);
    ctx.requestOverlay();
  },
  getCursor() {
    return hover ? 'grab' : 'default';
  },
};

// ---------------------------------------------------------------------------
// Options bar
// ---------------------------------------------------------------------------

function PerspectiveGridOptions() {
  const g = useStore((s) => s.doc.perspective);
  const active = usePerspectiveStore((s) => s.activePlane);
  const drawOn = usePerspectiveStore((s) => s.drawOnPlane);
  if (!g) return null;
  return (
    <Row gap={8}>
      <Segmented
        value={String(g.type)}
        onChange={(v) => updateGrid(withType(g, Number(v) as 1 | 2 | 3), 'Perspective Grid Type')}
        options={[{ value: '1', label: '1-point' }, { value: '2', label: '2-point' }, { value: '3', label: '3-point' }]}
        title="Grid type"
      />
      <Segmented value={active} onChange={(v) => setActivePlane(v as typeof active)} options={PLANES.map((p) => ({ value: p, label: p === 'floor' ? 'Floor' : p === 'left' ? 'Left' : 'Right', title: PLANE_LABELS[p] }))} title="Active plane (1 / 2 / 3)" />
      <NumberField label="Cell" value={Math.round(g.cell)} min={1} onChange={(v) => updateGrid({ cell: Math.max(1, v) }, 'Perspective Grid Cell')} width={90} data-testid="perspective-cell-option" />
      <NumberField label="Extent" value={Math.round(g.extent)} min={10} onChange={(v) => updateGrid({ extent: Math.max(10, v) })} width={100} />
      <NumberField label="Height" value={Math.round(g.height)} min={10} onChange={(v) => updateGrid({ height: Math.max(10, v) })} width={100} />
      <Slider label="Opacity" value={Math.round((g.opacity ?? 0.55) * 100)} min={10} max={100} unit="%" width={140} onChange={(v) => updateGrid({ opacity: v / 100 }, null)} onCommit={() => getState().commit('Perspective Grid Opacity')} />
      <Checkbox checked={drawOn} onChange={(v) => usePerspectiveStore.getState().setDrawOnPlane(v)} label="Draw on active plane" />
      <Button small onClick={() => setPreset(g.type)} title="Reset the grid to the artboard defaults">
        Reset
      </Button>
      <Button small onClick={() => getState().openDialog('perspective.define', {})} title="Define Grid…">
        Define…
      </Button>
      <Button small onClick={() => usePerspectiveStore.getState().setVisible(false)} title="Hide the grid (Shift+Ctrl+I)">
        Hide
      </Button>
    </Row>
  );
}

void defaultGrid;
void React;
