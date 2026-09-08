/**
 * Shape tools: Rectangle (M), Rounded Rectangle, Ellipse (L), Polygon, Star, Line (\).
 * Drag to draw; Shift constrains proportions; Alt draws from the centre;
 * arrow keys change sides/points while dragging; click without dragging creates
 * a default-sized shape.
 */
import React from 'react';
import { Square, SquareRoundCorner, Circle, Hexagon, Star, Minus } from 'lucide-react';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import type { LiveShape, ID, Vec, PathNode } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { makeShape } from '@/model/nodes';
import { addNode, refreshLiveShape } from '@/model/document';
import { translate } from '@/geometry/matrix';
import { useOverlayStore } from '@/canvas/overlayStore';
import type { SnapSession } from '@/canvas/snap';
import { formatLength } from '@/util/units';
import { NumberField, Checkbox, Row, Select } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';

type Kind = 'rect' | 'roundRect' | 'ellipse' | 'polygon' | 'star' | 'line';

interface Draw {
  id: ID;
  start: Vec;
  snap: SnapSession;
  kind: Kind;
  moved: boolean;
}

let draw: Draw | null = null;

/** Where new objects go: the isolation group, or the active layer (top). */
export function insertionParent(): ID | null {
  const s = getState();
  if (s.isolationId && s.doc.nodes[s.isolationId]) return s.isolationId;
  const layer = s.activeLayerId && s.doc.nodes[s.activeLayerId] ? s.activeLayerId : s.doc.layers[s.doc.layers.length - 1];
  if (!layer) return null;
  const ln = s.doc.nodes[layer];
  if (ln.locked || !ln.visible) {
    const alt = [...s.doc.layers].reverse().find((l) => !s.doc.nodes[l].locked && s.doc.nodes[l].visible);
    return alt ?? layer;
  }
  return layer;
}

function shapeFor(kind: Kind, w: number, h: number, opts: Record<string, unknown>): LiveShape {
  switch (kind) {
    case 'rect':
      return { kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] };
    case 'roundRect': {
      const r = Number(opts.radius ?? 12);
      return { kind: 'rect', width: w, height: h, radii: [r, r, r, r] };
    }
    case 'ellipse':
      return { kind: 'ellipse', rx: w / 2, ry: h / 2 };
    case 'polygon':
      return { kind: 'polygon', sides: Number(opts.sides ?? 6), radius: Math.max(w, h) / 2 };
    case 'star': {
      const ratio = Number(opts.innerRatio ?? 0.5);
      const R = Math.max(w, h) / 2;
      return { kind: 'star', points: Number(opts.points ?? 5), outerRadius: R, innerRadius: R * ratio };
    }
    case 'line':
      return { kind: 'line', x1: 0, y1: 0, x2: w, y2: h };
  }
}

function centeredKind(kind: Kind): boolean {
  return kind === 'ellipse' || kind === 'polygon' || kind === 'star';
}

function updateShape(ctx: ToolContext, e: ToolPointerEvent, d: Draw) {
  const s = ctx.state;
  const opts = ctx.options<Record<string, unknown>>();
  let p = e.world;
  if (!e.primary) {
    const sr = d.snap.snap(p);
    p = sr.point;
    ctx.setSnapGuides(sr);
  }
  let dx = p.x - d.start.x;
  let dy = p.y - d.start.y;
  const fromCenter = e.alt || (opts.fromCenter as boolean);
  if (d.kind === 'line') {
    if (e.shift) {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(ang) * len;
      dy = Math.sin(ang) * len;
    }
    s.updateDoc((doc) => {
      const n = doc.nodes[d.id] as PathNode;
      if (!n) return;
      n.shape = { kind: 'line', x1: 0, y1: 0, x2: dx, y2: dy };
      n.transform = translate(d.start.x, d.start.y);
      refreshLiveShape(n);
    });
    useOverlayStore.getState().setHud({ screen: e.screen, text: `L: ${formatLength(Math.hypot(dx, dy), s.prefs.units)}\n∠ ${((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(1)}°` });
    return;
  }
  if (e.shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  let x = d.start.x;
  let y = d.start.y;
  let w = dx;
  let h = dy;
  if (fromCenter) {
    x = d.start.x - dx;
    y = d.start.y - dy;
    w = dx * 2;
    h = dy * 2;
  }
  // normalise negative sizes
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  const isPolyLike = d.kind === 'polygon' || d.kind === 'star';
  if (isPolyLike) {
    // polygons/stars are drawn from the centre with radius = distance
    const cx = d.start.x;
    const cy = d.start.y;
    const r = Math.hypot(p.x - d.start.x, p.y - d.start.y);
    const angle = Math.atan2(p.y - d.start.y, p.x - d.start.x);
    s.updateDoc((doc) => {
      const n = doc.nodes[d.id] as PathNode;
      if (!n) return;
      n.shape = shapeFor(d.kind, r * 2, r * 2, opts);
      const rot = e.shift ? 0 : (angle * 180) / Math.PI + 90;
      const rad = (rot * Math.PI) / 180;
      n.transform = { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad), e: cx, f: cy };
      refreshLiveShape(n);
    });
    useOverlayStore.getState().setHud({ screen: e.screen, text: `R: ${formatLength(r, s.prefs.units)}` });
    return;
  }
  s.updateDoc((doc) => {
    const n = doc.nodes[d.id] as PathNode;
    if (!n) return;
    n.shape = shapeFor(d.kind, w, h, opts);
    n.transform = d.kind === 'ellipse' ? translate(x + w / 2, y + h / 2) : translate(x, y);
    refreshLiveShape(n);
  });
  useOverlayStore.getState().setHud({ screen: e.screen, text: `W: ${formatLength(w, s.prefs.units)}\nH: ${formatLength(h, s.prefs.units)}` });
}

function makeShapeTool(kind: Kind, def: Omit<Tool, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'group' | 'cancel'>): Tool {
  return {
    ...def,
    group: 'shapes',
    cursor: 'crosshair',
    showSelectionOverlay: true,
    onPointerDown(e, ctx) {
      if (e.button !== 0) return;
      const s = ctx.state;
      const parent = insertionParent();
      if (!parent) return;
      const opts = ctx.options<Record<string, unknown>>();
      const snap = ctx.beginSnap();
      const sr = e.primary ? null : snap.snap(e.world);
      const start = sr ? sr.point : e.world;
      const node = makeShape(shapeFor(kind, 0, 0, opts), {
        fill: kind === 'line' ? { type: 'none' } : s.appearance.fill,
        stroke: kind === 'line' && s.appearance.stroke.paint.type === 'none' ? { ...s.appearance.stroke, paint: { type: 'solid', color: '#000000', opacity: 1 } } : s.appearance.stroke,
        transform: translate(start.x, start.y),
      });
      if (kind === 'roundRect') node.name = 'Rounded Rectangle';
      s.updateDoc((doc) => addNode(doc, node, parent));
      s.setSelection([node.id]);
      draw = { id: node.id, start, snap, kind, moved: false };
    },
    onPointerMove(e, ctx) {
      if (!draw) {
        ctx.setCursor('crosshair');
        return;
      }
      draw.moved = true;
      updateShape(ctx, e, draw);
    },
    onPointerUp(e, ctx) {
      const d = draw;
      draw = null;
      ctx.setSnapGuides(null);
      useOverlayStore.getState().setHud(null);
      if (!d) return;
      const s = ctx.state;
      const n = s.doc.nodes[d.id] as PathNode | undefined;
      if (!n) return;
      const opts = ctx.options<Record<string, unknown>>();
      const tiny = !d.moved || Math.hypot(e.world.x - d.start.x, e.world.y - d.start.y) < 2 / s.zoom;
      if (tiny) {
        // click: default sized shape centred/at the click
        const size = Number(opts.defaultSize ?? 100);
        s.updateDoc((doc) => {
          const nn = doc.nodes[d.id] as PathNode;
          if (kind === 'line') {
            nn.shape = { kind: 'line', x1: 0, y1: 0, x2: size, y2: 0 };
            nn.transform = translate(d.start.x, d.start.y);
          } else {
            nn.shape = shapeFor(kind, size, size, opts);
            nn.transform = centeredKind(kind) ? translate(d.start.x, d.start.y) : translate(d.start.x - size / 2, d.start.y - size / 2);
          }
          refreshLiveShape(nn);
        });
      }
      ctx.commit(`Create ${n.name}`);
    },
    onKeyDown(e, ctx) {
      if (!draw) return false;
      if (kind === 'polygon' || kind === 'star') {
        const key = kind === 'polygon' ? 'sides' : 'points';
        const cur = Number(ctx.options<Record<string, unknown>>()[key] ?? (kind === 'polygon' ? 6 : 5));
        if (e.key === 'ArrowUp') {
          ctx.setOptions({ [key]: Math.min(100, cur + 1) });
          return true;
        }
        if (e.key === 'ArrowDown') {
          ctx.setOptions({ [key]: Math.max(3, cur - 1) });
          return true;
        }
      }
      if (e.key === 'Escape') {
        this.cancel!(ctx);
        return true;
      }
      return false;
    },
    cancel(ctx) {
      if (draw) {
        ctx.state.revert();
        draw = null;
      }
      ctx.setSnapGuides(null);
      useOverlayStore.getState().setHud(null);
    },
    isBusy: () => !!draw,
  };
}

function ShapeOptions({ kind }: { kind: Kind }) {
  const toolId = kindToolId(kind);
  const [opts, set] = useToolOptions<Record<string, unknown>>(toolId);
  const units = useStore((s) => s.prefs.units);
  return (
    <Row gap={10}>
      {kind === 'roundRect' && <NumberField label="Radius" value={Number(opts.radius ?? 12)} onChange={(v) => set({ radius: v })} min={0} unit={units} width={120} />}
      {kind === 'polygon' && <NumberField label="Sides" value={Number(opts.sides ?? 6)} onChange={(v) => set({ sides: Math.round(v) })} min={3} max={100} width={90} />}
      {kind === 'star' && (
        <>
          <NumberField label="Points" value={Number(opts.points ?? 5)} onChange={(v) => set({ points: Math.round(v) })} min={3} max={100} width={90} />
          <NumberField label="Inner ratio" value={Number(opts.innerRatio ?? 0.5) * 100} onChange={(v) => set({ innerRatio: v / 100 })} min={1} max={99} unit="%" width={110} />
        </>
      )}
      <NumberField label="Click size" value={Number(opts.defaultSize ?? 100)} onChange={(v) => set({ defaultSize: v })} min={1} unit={units} width={130} title="Size used when clicking without dragging" />
      <Checkbox checked={!!opts.fromCenter} onChange={(v) => set({ fromCenter: v })} label="From center" />
      {kind !== 'line' && (
        <Select
          label="Preset"
          value={''}
          options={[
            { value: '', label: '—' },
            { value: '100', label: '100 × 100' },
            { value: '200', label: '200 × 200' },
            { value: '512', label: '512 × 512' },
            { value: '1024', label: '1024 × 1024' },
          ]}
          onChange={(v) => v && set({ defaultSize: Number(v) })}
          width={120}
        />
      )}
    </Row>
  );
}

function kindToolId(kind: Kind): string {
  return kind === 'rect' ? 'rect' : kind === 'roundRect' ? 'roundrect' : kind;
}

export const tools: Tool[] = [
  makeShapeTool('rect', { id: 'rect', name: 'Rectangle Tool', shortcut: 'm', icon: Square, order: 300, hint: 'Drag to draw a rectangle. Shift: square, Alt: from center.', Options: () => <ShapeOptions kind="rect" />, defaults: { defaultSize: 100, fromCenter: false } }),
  makeShapeTool('roundRect', { id: 'roundrect', name: 'Rounded Rectangle Tool', icon: SquareRoundCorner, order: 301, hint: 'Drag to draw a rounded rectangle.', Options: () => <ShapeOptions kind="roundRect" />, defaults: { radius: 12, defaultSize: 100, fromCenter: false } }),
  makeShapeTool('ellipse', { id: 'ellipse', name: 'Ellipse Tool', shortcut: 'l', icon: Circle, order: 302, hint: 'Drag to draw an ellipse. Shift: circle, Alt: from center.', Options: () => <ShapeOptions kind="ellipse" />, defaults: { defaultSize: 100, fromCenter: false } }),
  makeShapeTool('polygon', { id: 'polygon', name: 'Polygon Tool', icon: Hexagon, order: 303, hint: 'Drag from the center. Up/Down arrows change the number of sides.', Options: () => <ShapeOptions kind="polygon" />, defaults: { sides: 6, defaultSize: 100 } }),
  makeShapeTool('star', { id: 'star', name: 'Star Tool', icon: Star, order: 304, hint: 'Drag from the center. Up/Down arrows change the number of points.', Options: () => <ShapeOptions kind="star" />, defaults: { points: 5, innerRatio: 0.5, defaultSize: 100 } }),
  makeShapeTool('line', { id: 'line', name: 'Line Segment Tool', shortcut: '\\', icon: Minus, order: 305, hint: 'Drag to draw a line. Shift constrains to 45°.', Options: () => <ShapeOptions kind="line" />, defaults: { defaultSize: 100 } }),
];

void React;
