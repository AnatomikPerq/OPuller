import React from 'react';
import { Hand, ZoomIn } from 'lucide-react';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import { useOverlayStore } from '@/canvas/overlayStore';
import { getState, useStore } from '@/store/store';
import { Button, Row } from '@/ui/widgets';
import { fitArtboard, fitAll } from '@/commands/viewCommands';

let panLast: { x: number; y: number } | null = null;

export const handTool: Tool = {
  id: 'hand',
  name: 'Hand Tool',
  shortcut: 'h',
  icon: Hand,
  group: 'navigate',
  order: 900,
  cursor: 'grab',
  hint: 'Drag to pan. Double-click to fit the artboard.',
  showSelectionOverlay: true,
  onPointerDown(e, ctx) {
    panLast = e.screen;
    ctx.setCursor('grabbing');
  },
  onPointerMove(e, ctx) {
    if (!panLast) return;
    ctx.state.panBy(e.screen.x - panLast.x, e.screen.y - panLast.y);
    panLast = e.screen;
  },
  onPointerUp(_e, ctx) {
    panLast = null;
    ctx.setCursor('grab');
  },
  onDoubleClick() {
    fitArtboard();
  },
  cancel() {
    panLast = null;
  },
  Options: HandOptions,
};

function HandOptions() {
  const zoom = useStore((s) => s.zoom);
  return (
    <Row gap={8}>
      <span className="muted">Zoom: {Math.round(zoom * 100)}%</span>
      <Button small onClick={() => fitArtboard()}>
        Fit Artboard
      </Button>
      <Button small onClick={() => fitAll()}>
        Fit All
      </Button>
      <Button small onClick={() => getState().setZoom(1)}>
        100%
      </Button>
    </Row>
  );
}

let zoomStart: { x: number; y: number } | null = null;
let zoomCur: { x: number; y: number } | null = null;

export const zoomTool: Tool = {
  id: 'zoom',
  name: 'Zoom Tool',
  shortcut: 'z',
  icon: ZoomIn,
  group: 'navigate',
  order: 910,
  cursor: 'zoom-in',
  hint: 'Click to zoom in, Alt-click to zoom out, drag to zoom into an area.',
  onPointerDown(e) {
    zoomStart = e.screen;
    zoomCur = e.screen;
  },
  onPointerMove(e, ctx) {
    ctx.setCursor(e.alt ? 'zoom-out' : 'zoom-in');
    if (!zoomStart) return;
    zoomCur = e.screen;
    const s = ctx.state;
    const a = ctx.screenToWorld(zoomStart);
    const b = ctx.screenToWorld(zoomCur);
    useOverlayStore.getState().setMarquee({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
    void s;
  },
  onPointerUp(e, ctx) {
    const s = ctx.state;
    useOverlayStore.getState().setMarquee(null);
    if (zoomStart && zoomCur && Math.hypot(zoomCur.x - zoomStart.x, zoomCur.y - zoomStart.y) > 6) {
      const a = ctx.screenToWorld(zoomStart);
      const b = ctx.screenToWorld(zoomCur);
      s.zoomToRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }, 20);
    } else {
      const factor = e.alt ? 1 / 1.5 : 1.5;
      s.setZoom(s.zoom * factor, e.screen);
    }
    zoomStart = null;
    zoomCur = null;
  },
  onModifiers(e, ctx) {
    ctx.setCursor(e.alt ? 'zoom-out' : 'zoom-in');
  },
  cancel() {
    zoomStart = null;
    zoomCur = null;
    useOverlayStore.getState().setMarquee(null);
  },
  Options: ZoomOptions,
};

function ZoomOptions() {
  const zoom = useStore((s) => s.zoom);
  const presets = [0.25, 0.5, 1, 2, 4, 8];
  return (
    <Row gap={6}>
      <span className="muted">Zoom: {Math.round(zoom * 100)}%</span>
      {presets.map((p) => (
        <Button key={p} small onClick={() => getState().setZoom(p)}>
          {p * 100}%
        </Button>
      ))}
      <Button small onClick={() => fitArtboard()}>
        Fit
      </Button>
    </Row>
  );
}

export const tools: Tool[] = [handTool, zoomTool];

// keep React import used for JSX in older TS configs
void React;
export type { ToolPointerEvent, ToolContext };
