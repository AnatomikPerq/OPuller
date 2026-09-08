/**
 * Mesh tool (U): edits gradient meshes. Click a filled object without a mesh
 * to create one (rows/cols from the options), click inside a mesh to add a
 * row + column through that point, drag nodes and their tangent handles,
 * Alt-click a node to remove its row and column. The Color panel colours the
 * selected node.
 */
import React from 'react';
import { Grid3x3 } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { ID, MeshGradientPaint, Vec, Paint } from '@/model/types';
import { getState } from '@/store/store';
import { appearanceTargets, setFillPaint } from '@/commands/appearance';
import { gradientFrame, bboxToWorld, worldToBbox, type GradientFrame } from '@/color/annotator';
import { nodeScreenOutline } from '@/canvas/SelectionOverlay';
import { useToolOptions } from '@/canvas/toolContext';
import { NumberField, Row, Button, Select } from '@/ui/widgets';
import { makeMesh, baseColorOf, moveNode, setHandle, insertRow, insertCol, removeRow, removeCol, locate, nodeRC, patchEdge, meshNode, type MeshAppearance } from '@/gradients/mesh';
import { localBounds, worldMatrix } from '@/model/document';
import { applyToPoint, invert } from '@/geometry/matrix';
import type { MeshDistortEffect, FreeDistortEffect, Rect, Matrix } from '@/model/types';

interface Options extends Record<string, unknown> {
  rows: number;
  cols: number;
  appearance: MeshAppearance;
  highlight: number;
}

const DEFAULTS: Options = { rows: 4, cols: 4, appearance: 'flat', highlight: 100 };

interface Model {
  id: ID;
  frame: GradientFrame;
  mesh: MeshGradientPaint;
}

type Handle = 'up' | 'down' | 'left' | 'right';
type Gesture = { kind: 'none' } | { kind: 'node'; index: number; model: Model; moved: boolean; start: Vec; alt: boolean } | { kind: 'handle'; index: number; which: Handle; model: Model };

let gesture: Gesture = { kind: 'none' };
let hover: string | null = null;

// ---------------------------------------------------------------------------
// Envelope editing: a selected node with a meshDistort / freeDistort effect
// ---------------------------------------------------------------------------

interface EnvelopeModel {
  id: ID;
  index: number;
  effect: MeshDistortEffect | FreeDistortEffect;
  frame: Rect;
  wm: Matrix;
  inv: Matrix;
}

let envGesture: { index: number; model: EnvelopeModel } | null = null;

function envelopeOf(ctx: ToolContext): EnvelopeModel | null {
  const s = ctx.state;
  for (const id of s.selection) {
    const n = s.doc.nodes[id];
    if (!n) continue;
    const index = n.effects.findIndex((e) => e.enabled && (e.type === 'meshDistort' || e.type === 'freeDistort'));
    if (index < 0) continue;
    const effect = n.effects[index] as MeshDistortEffect | FreeDistortEffect;
    // the frame is the geometry without the envelope effect (its own bounds); use the raw geometry bounds
    const frame = n.type === 'path' ? rawBounds(n.subpaths) : localBounds(s.doc, id);
    if (!frame) continue;
    const wm = worldMatrix(s.doc, id);
    return { id, index, effect, frame, wm, inv: invert(wm) };
  }
  return null;
}

function rawBounds(sps: import('@/model/types').SubPath[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of sps) for (const a of sp.anchors) {
    minX = Math.min(minX, a.point.x);
    minY = Math.min(minY, a.point.y);
    maxX = Math.max(maxX, a.point.x);
    maxY = Math.max(maxY, a.point.y);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: Math.max(maxX - minX, 1e-6), height: Math.max(maxY - minY, 1e-6) } : null;
}

function envPoints(m: EnvelopeModel): Vec[] {
  return m.effect.type === 'meshDistort' ? m.effect.points : m.effect.corners;
}

function envScreen(ctx: ToolContext, m: EnvelopeModel, p: Vec): Vec {
  return ctx.worldToScreen(applyToPoint(m.wm, { x: m.frame.x + p.x * m.frame.width, y: m.frame.y + p.y * m.frame.height }));
}

function envUnit(m: EnvelopeModel, world: Vec): Vec {
  const l = applyToPoint(m.inv, world);
  return { x: (l.x - m.frame.x) / m.frame.width, y: (l.y - m.frame.y) / m.frame.height };
}

function setEnvPoint(m: EnvelopeModel, index: number, p: Vec, commit: boolean): void {
  getState().updateDoc((d) => {
    const n = d.nodes[m.id];
    if (!n) return;
    const e = n.effects[m.index];
    if (!e) return;
    if (e.type === 'meshDistort') n.effects[m.index] = { ...e, points: e.points.map((q, i) => (i === index ? p : q)) };
    else if (e.type === 'freeDistort') n.effects[m.index] = { ...e, corners: e.corners.map((q, i) => (i === index ? p : q)) as FreeDistortEffect['corners'] };
  }, commit ? (m.effect.type === 'meshDistort' ? 'Envelope Mesh' : 'Free Distort') : undefined);
}

function renderEnvelope(ctx: ToolContext, m: EnvelopeModel): React.ReactNode {
  const pts = envPoints(m).map((p) => envScreen(ctx, m, p));
  const hs = Math.max(5, ctx.state.prefs.handleSize - 1);
  const lines: string[] = [];
  if (m.effect.type === 'meshDistort') {
    const { rows, cols } = m.effect;
    for (let r = 0; r <= rows; r++) lines.push(Array.from({ length: cols + 1 }, (_, c) => pts[r * (cols + 1) + c]).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
    for (let c = 0; c <= cols; c++) lines.push(Array.from({ length: rows + 1 }, (_, r) => pts[r * (cols + 1) + c]).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
  } else lines.push(pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + 'Z');
  return (
    <g className="gradient-annotator mesh envelope" data-testid="envelope-annotator">
      {lines.map((d, i) => (
        <path key={i} className="ga-line" d={d} fill="none" />
      ))}
      {pts.map((p, i) => (
        <rect key={i} className={`ga-stop ${envGesture?.index === i ? 'active' : ''}`} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} fill="#fff" data-testid={`envelope-point-${i}`} />
      ))}
    </g>
  );
}

function fillOf(ctx: ToolContext, id: ID): Paint | null {
  const n = ctx.doc.nodes[id];
  return n && (n.type === 'path' || n.type === 'text') ? n.fill : null;
}

function modelOf(ctx: ToolContext): Model | null {
  const s = ctx.state;
  for (const id of appearanceTargets(s.selection)) {
    const p = fillOf(ctx, id);
    if (p && p.type === 'mesh') {
      const frame = gradientFrame(s.doc, id);
      if (frame) return { id, frame, mesh: p };
    }
  }
  return null;
}

function toScreen(ctx: ToolContext, m: Model, p: Vec): Vec {
  return ctx.worldToScreen(bboxToWorld(m.frame, p.x, p.y));
}

function applyMesh(m: Model, mesh: MeshGradientPaint, commit: boolean): void {
  const s = getState();
  s.updateDoc((d) => {
    const n = d.nodes[m.id];
    if (n && (n.type === 'path' || n.type === 'text')) n.fill = mesh;
  }, commit ? 'Gradient Mesh' : undefined);
}

function hit(ctx: ToolContext, m: Model, screen: Vec, tol: number): { kind: 'node'; index: number } | { kind: 'handle'; index: number; which: Handle } | null {
  const active = Math.max(0, Math.min(m.mesh.nodes.length - 1, ctx.state.activeGradientStop));
  const an = m.mesh.nodes[active];
  if (an) {
    for (const which of ['up', 'down', 'left', 'right'] as const) {
      const h = an[which];
      if (!h) continue;
      const p = toScreen(ctx, m, { x: an.x + h.x, y: an.y + h.y });
      if (Math.hypot(p.x - screen.x, p.y - screen.y) <= tol) return { kind: 'handle', index: active, which };
    }
  }
  let best: { index: number; d: number } | null = null;
  m.mesh.nodes.forEach((n, i) => {
    const p = toScreen(ctx, m, n);
    const d = Math.hypot(p.x - screen.x, p.y - screen.y);
    if (d <= tol + 1 && (!best || d < best.d)) best = { index: i, d };
  });
  return best ? { kind: 'node', index: (best as { index: number }).index } : null;
}

/** Create a mesh on the fill of the selected objects. */
export function createMeshOnSelection(opts: Partial<Record<keyof Options, unknown>> = {}, commit = true): number {
  const s = getState();
  const o = { ...DEFAULTS, ...(s.toolOptions.mesh ?? {}), ...opts } as Options;
  const targets = appearanceTargets(s.selection).filter((id) => {
    const n = s.doc.nodes[id];
    return n && (n.type === 'path' || n.type === 'text');
  });
  if (!targets.length) return 0;
  s.updateDoc((d) => {
    for (const id of targets) {
      const n = d.nodes[id];
      if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
      const base = baseColorOf(n.fill);
      n.fill = makeMesh(base.color, { rows: o.rows, cols: o.cols, appearance: o.appearance, highlight: o.highlight }, base.opacity);
    }
  }, commit ? 'Create Gradient Mesh' : undefined);
  getState().setActiveGradientStop(0);
  return targets.length;
}

function MeshOptions() {
  const [opts, set] = useToolOptions<Options>('mesh');
  return (
    <Row gap={8}>
      <NumberField label="Rows" value={opts.rows} min={1} max={50} decimals={0} onChange={(v) => set({ rows: Math.max(1, Math.round(v)) })} width={80} data-testid="mesh-rows" />
      <NumberField label="Columns" value={opts.cols} min={1} max={50} decimals={0} onChange={(v) => set({ cols: Math.max(1, Math.round(v)) })} width={90} data-testid="mesh-cols" />
      <Select label="Appearance" value={opts.appearance} options={[{ value: 'flat', label: 'Flat' }, { value: 'toCenter', label: 'To Center' }, { value: 'toEdge', label: 'To Edge' }]} onChange={(v) => set({ appearance: v as MeshAppearance })} width={140} />
      <NumberField label="Highlight" value={opts.highlight} min={0} max={100} unit="%" decimals={0} onChange={(v) => set({ highlight: v })} width={100} />
      <Button small onClick={() => createMeshOnSelection()} data-testid="mesh-create">
        Create Mesh
      </Button>
      <span className="muted">Click an object to add a mesh; drag nodes / handles; Alt-click a node to remove its lines</span>
    </Row>
  );
}

export const tool: Tool = {
  id: 'mesh',
  name: 'Mesh Tool',
  shortcut: 'u',
  icon: Grid3x3,
  group: 'edit',
  order: 621,
  cursor: 'crosshair',
  hint: 'Gradient mesh: click an object to create / extend a mesh, drag nodes and handles, Alt-click a node removes its lines. Envelopes: drag the mesh points / free distort corners of the selected object.',
  defaults: DEFAULTS,
  Options: MeshOptions,
  showSelectionOverlay: false,

  activate() {
    gesture = { kind: 'none' };
  },
  deactivate(ctx) {
    if (gesture.kind !== 'none') ctx.state.revert();
    gesture = { kind: 'none' };
    hover = null;
  },
  isBusy: () => gesture.kind !== 'none' || !!envGesture,
  cancel(ctx) {
    gesture = { kind: 'none' };
    envGesture = null;
    ctx.state.revert();
    ctx.requestOverlay();
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const env = envelopeOf(ctx);
    if (env) {
      const tol = Math.max(6, s.prefs.handleSize) + 2;
      const pts = envPoints(env);
      let best = -1;
      let bd = Infinity;
      pts.forEach((p, i) => {
        const q = envScreen(ctx, env, p);
        const d = Math.hypot(q.x - e.screen.x, q.y - e.screen.y);
        if (d <= tol && d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) {
        envGesture = { index: best, model: env };
        ctx.setCursor('move');
        return;
      }
    }
    const m = modelOf(ctx);
    const tol = Math.max(6, s.prefs.handleSize);
    if (m) {
      const h = hit(ctx, m, e.screen, tol);
      if (h) {
        s.setActiveGradientStop(h.index);
        if (h.kind === 'node') gesture = { kind: 'node', index: h.index, model: m, moved: false, start: e.screen, alt: e.alt };
        else gesture = { kind: 'handle', index: h.index, which: h.which, model: m };
        return;
      }
      // inside the mesh object: add a row + column through the point
      const ht = ctx.hitTest(e.world);
      if (ht && (ht.target === m.id || ht.id === m.id)) {
        const uv = worldToBbox(m.frame, e.world);
        const loc = locate(m.mesh, { x: uv.u, y: uv.v });
        let mesh = insertRow(m.mesh, loc.r, loc.v);
        mesh = insertCol(mesh, loc.c, loc.u);
        applyMesh(m, mesh, true);
        s.setActiveGradientStop((loc.r + 1) * (mesh.cols + 1) + loc.c + 1);
        return;
      }
    }
    // click another object: select it; if it has no mesh, create one
    const ht = ctx.hitTest(e.world);
    if (!ht) return;
    if (!s.selection.includes(ht.target)) s.setSelection([ht.target]);
    const p = fillOf(ctx, ht.id);
    if (p && p.type !== 'mesh') {
      getState().setSelection([ht.id]);
      createMeshOnSelection();
    }
  },

  onPointerMove(e, ctx) {
    if (envGesture) {
      const u = envUnit(envGesture.model, e.world);
      setEnvPoint(envGesture.model, envGesture.index, u, false);
      return;
    }
    const g = gesture;
    if (g.kind === 'none') {
      const m = modelOf(ctx);
      if (!m) {
        ctx.setCursor('crosshair');
        return;
      }
      const h = hit(ctx, m, e.screen, Math.max(6, ctx.state.prefs.handleSize));
      const key = h ? (h.kind === 'node' ? `node-${h.index}` : `handle-${h.index}-${h.which}`) : null;
      if (key !== hover) {
        hover = key;
        ctx.requestOverlay();
      }
      ctx.setCursor(h ? 'move' : 'crosshair');
      return;
    }
    const m = g.model;
    const uv = worldToBbox(m.frame, e.world);
    const cur = fillOf(ctx, m.id);
    if (!cur || cur.type !== 'mesh') return;
    if (g.kind === 'node') {
      if (!g.moved && Math.hypot(e.screen.x - g.start.x, e.screen.y - g.start.y) < 2) return;
      g.moved = true;
      applyMesh(m, moveNode(cur, g.index, { x: uv.u, y: uv.v }), false);
    } else {
      applyMesh(m, setHandle(cur, g.index, g.which, { x: uv.u, y: uv.v }), false);
    }
  },

  onPointerUp(_e, ctx) {
    if (envGesture) {
      const eg = envGesture;
      envGesture = null;
      ctx.commit(eg.model.effect.type === 'meshDistort' ? 'Envelope Mesh' : 'Free Distort');
      ctx.requestOverlay();
      return;
    }
    const g = gesture;
    gesture = { kind: 'none' };
    if (g.kind === 'none') return;
    if (g.kind === 'node' && !g.moved) {
      if (g.alt) {
        // remove the node's row and column
        const cur = fillOf(ctx, g.model.id);
        if (cur && cur.type === 'mesh') {
          const { r, c } = nodeRC(cur, g.index);
          let mesh = removeRow(cur, r);
          mesh = removeCol(mesh, c);
          if (mesh !== cur) {
            applyMesh(g.model, mesh, true);
            ctx.state.setActiveGradientStop(0);
          }
        }
      }
      ctx.requestOverlay();
      return;
    }
    ctx.commit('Gradient Mesh');
    ctx.requestOverlay();
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture.kind !== 'none') {
      this.cancel!(ctx);
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const s = ctx.state;
    const m = modelOf(ctx);
    const outlines = s.selection.map((id) => {
      const d = nodeScreenOutline(s, id);
      return d ? <path key={id} className="ga-outline" d={d} /> : null;
    });
    const env = envelopeOf(ctx);
    if (env && !m) return <g className="gradient-annotator mesh">{outlines}{renderEnvelope(ctx, env)}</g>;
    if (!m) return <g className="gradient-annotator mesh">{outlines}</g>;
    const mesh = m.mesh;
    const active = Math.max(0, Math.min(mesh.nodes.length - 1, s.activeGradientStop));
    const hs = Math.max(5, s.prefs.handleSize - 1);
    const paths: string[] = [];
    const seg = (pts: Vec[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const N = 8;
    for (let r = 0; r <= mesh.rows; r++) {
      for (let c = 0; c < mesh.cols; c++) {
        const pts: Vec[] = [];
        for (let i = 0; i <= N; i++) pts.push(toScreen(ctx, m, r < mesh.rows ? patchEdge(mesh, r, c, 'top', i / N) : patchEdge(mesh, r - 1, c, 'bottom', i / N)));
        paths.push(seg(pts));
      }
    }
    for (let c = 0; c <= mesh.cols; c++) {
      for (let r = 0; r < mesh.rows; r++) {
        const pts: Vec[] = [];
        for (let i = 0; i <= N; i++) pts.push(toScreen(ctx, m, c < mesh.cols ? patchEdge(mesh, r, c, 'left', i / N) : patchEdge(mesh, r, c - 1, 'right', i / N)));
        paths.push(seg(pts));
      }
    }
    const an = mesh.nodes[active];
    const ap = an ? toScreen(ctx, m, an) : null;
    return (
      <g className="gradient-annotator mesh" data-testid="mesh-annotator">
        {outlines}
        {paths.map((d, i) => (
          <path key={i} className="ga-line" d={d} fill="none" />
        ))}
        {an &&
          ap &&
          (['up', 'down', 'left', 'right'] as const).map((which) => {
            const h = an[which];
            if (!h) return null;
            const p = toScreen(ctx, m, { x: an.x + h.x, y: an.y + h.y });
            return (
              <g key={which}>
                <line className="ga-line" x1={ap.x} y1={ap.y} x2={p.x} y2={p.y} />
                <circle className={`ga-handle ${hover === `handle-${active}-${which}` ? 'hover' : ''}`} cx={p.x} cy={p.y} r={3.5} fill="#fff" data-testid={`mesh-handle-${which}`} />
              </g>
            );
          })}
        {mesh.nodes.map((n, i) => {
          const p = toScreen(ctx, m, n);
          return <rect key={i} className={`ga-stop ${i === active ? 'active' : ''} ${hover === `node-${i}` ? 'hover' : ''}`} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} fill={n.color} data-testid={`mesh-node-${i}`} />;
        })}
      </g>
    );
  },
};

export type { ToolPointerEvent };
void meshNode;
