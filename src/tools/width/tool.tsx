/**
 * Width tool (Shift+W): variable-width strokes. Drag on a stroked path to add a
 * width point and set its width; drag a width point's handles to change the
 * width (Alt: one side only), drag the point itself to slide it along the path.
 * Double-click a point to edit the values, Delete removes the selected point.
 */
import React, { useState } from 'react';
import { MoveHorizontal, Trash2, Eraser } from 'lucide-react';
import type { Tool, ToolContext } from '../types';
import type { ID, Vec, PathNode, SubPath, WidthPoint, Document, Matrix } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { worldMatrix } from '@/model/document';
import { invert, applyToPoint, applyToVector, scaleFactor } from '@/geometry/matrix';
import { nearestPointOnPath, segmentCubic, subpathLength, locationAtOffset, tangentAt, pathToSvgD, transformSubPaths } from '@/geometry/path';
import { cubicLength, cubicSplit } from '@/geometry/bezier';
import { widthAt, variableWidthOutlines } from '@/geometry/widthProfile';
import { allEditablePaths, selectedEditablePaths } from '@/tools/freehand/apply';
import { registerCommands, when } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { NumberField, Button, IconButton, Row, Checkbox } from '@/ui/widgets';
import { formatLength } from '@/util/units';

const HL = '#4a90e2';

interface Hover {
  nodeId: ID;
  /** 0..1 along the subpath */
  offset: number;
  subpath: number;
  /** local point / normal */
  point: Vec;
  normal: Vec;
  /** existing width point index under the cursor (or -1) */
  index: number;
  /** what part is under the cursor */
  part: 'path' | 'point' | 'left' | 'right';
}

type Gesture =
  | { kind: 'width'; nodeId: ID; index: number; base: Document; side: 'both' | 'left' | 'right'; subpath: number }
  | { kind: 'slide'; nodeId: ID; index: number; base: Document; subpath: number };

let hover: Hover | null = null;
let gesture: Gesture | null = null;
let selected: { nodeId: ID; index: number } | null = null;

const HANDLE_R = 4;

function strokedPaths(ctx: ToolContext): ID[] {
  const s = ctx.state;
  const ok = (id: ID) => {
    const n = s.doc.nodes[id] as PathNode | undefined;
    return !!n && n.type === 'path' && n.stroke.paint.type !== 'none' && n.stroke.width > 0;
  };
  const sel = selectedEditablePaths(s).filter(ok);
  const all = allEditablePaths(s).filter((id) => ok(id) && !sel.includes(id));
  return sel.concat(all);
}

/** Normalised offset (0..1) of a location on a subpath. */
function offsetOf(sp: SubPath, segment: number, t: number): number {
  const total = subpathLength(sp);
  if (total <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < segment; i++) acc += cubicLength(segmentCubic(sp, i));
  const [left] = cubicSplit(segmentCubic(sp, segment), t);
  acc += cubicLength(left);
  return Math.max(0, Math.min(1, acc / total));
}

function localNormal(sp: SubPath, segment: number, t: number): Vec {
  const d = tangentAt(sp, segment, t);
  return { x: -d.y, y: d.x };
}

interface PointGeom {
  point: Vec;
  normal: Vec;
  left: Vec;
  right: Vec;
  subpath: number;
}

/** World-space geometry of a width point (position + side handle points). */
function widthPointGeom(doc: Document, n: PathNode, wp: WidthPoint, subpathIndex = 0): PointGeom | null {
  const sp = n.subpaths[subpathIndex] ?? n.subpaths[0];
  if (!sp || sp.anchors.length < 2) return null;
  const loc = locationAtOffset(sp, wp.offset);
  const nrm = { x: -loc.tangent.y, y: loc.tangent.x };
  const l = wp.left ?? wp.width / 2;
  const r = wp.right ?? wp.width / 2;
  const m = worldMatrix(doc, n.id);
  const p = loc.point;
  return {
    point: applyToPoint(m, p),
    normal: applyToVector(m, nrm),
    left: applyToPoint(m, { x: p.x + nrm.x * l, y: p.y + nrm.y * l }),
    right: applyToPoint(m, { x: p.x - nrm.x * r, y: p.y - nrm.y * r }),
    subpath: n.subpaths.indexOf(sp),
  };
}

function findHover(ctx: ToolContext, world: Vec): Hover | null {
  const s = ctx.state;
  const tolScreen = s.prefs.handleSize / 2 + 4;
  const ids = strokedPaths(ctx);
  // 1. existing width points / handles of the selected or hovered node
  for (const id of ids) {
    const n = s.doc.nodes[id] as PathNode;
    const profile = n.stroke.widthProfile ?? [];
    for (let i = 0; i < profile.length; i++) {
      const g = widthPointGeom(s.doc, n, profile[i]);
      if (!g) continue;
      const sp = ctx.worldToScreen(world);
      const test = (p: Vec) => {
        const q = ctx.worldToScreen(p);
        return Math.hypot(q.x - sp.x, q.y - sp.y) <= tolScreen;
      };
      const m = invert(worldMatrix(s.doc, id));
      const lp = applyToPoint(m, g.point);
      const nrm = { x: -1, y: 0 };
      const base = { nodeId: id, offset: profile[i].offset, subpath: g.subpath, point: lp, normal: nrm, index: i };
      if (test(g.point)) return { ...base, part: 'point' };
      if (test(g.left)) return { ...base, part: 'left' };
      if (test(g.right)) return { ...base, part: 'right' };
    }
  }
  // 2. the path itself
  const tol = ctx.tolerance() * 2;
  let best: { id: ID; loc: ReturnType<typeof nearestPointOnPath>; local: Vec; sps: SubPath[] } | null = null;
  for (const id of ids) {
    const n = s.doc.nodes[id] as PathNode;
    const m = worldMatrix(s.doc, id);
    const local = applyToPoint(invert(m), world);
    const loc = nearestPointOnPath(n.subpaths, local);
    if (!loc) continue;
    const dWorld = loc.distance * scaleFactor(m);
    const half = (n.stroke.width * scaleFactor(m)) / 2;
    if (dWorld <= tol + half) {
      if (!best || loc.distance < best.loc!.distance) best = { id, loc, local, sps: n.subpaths };
      if (selectedEditablePaths(s).includes(id)) break;
    }
  }
  if (!best || !best.loc) return null;
  const sp = best.sps[best.loc.subpath];
  return {
    nodeId: best.id,
    offset: offsetOf(sp, best.loc.segment, best.loc.t),
    subpath: best.loc.subpath,
    point: best.loc.point,
    normal: localNormal(sp, best.loc.segment, best.loc.t),
    index: -1,
    part: 'path',
  };
}

function setProfilePoint(draft: Document, nodeId: ID, index: number, patch: Partial<WidthPoint>): void {
  const n = draft.nodes[nodeId] as PathNode | undefined;
  if (!n || n.type !== 'path') return;
  const profile = n.stroke.widthProfile ? [...n.stroke.widthProfile] : [];
  const cur = profile[index];
  if (!cur) return;
  profile[index] = { ...cur, ...patch };
  n.stroke = { ...n.stroke, widthProfile: profile };
}

/** Width on both sides from the cursor position (local space). */
function widthsFromCursor(n: PathNode, subpath: number, offset: number, local: Vec, side: 'both' | 'left' | 'right', current: WidthPoint): { left: number; right: number } {
  const sp = n.subpaths[subpath] ?? n.subpaths[0];
  const loc = locationAtOffset(sp, offset);
  const nrm = { x: -loc.tangent.y, y: loc.tangent.x };
  const d = (local.x - loc.point.x) * nrm.x + (local.y - loc.point.y) * nrm.y;
  const dist = Math.max(0.1, Math.abs(d));
  const curLeft = current.left ?? current.width / 2;
  const curRight = current.right ?? current.width / 2;
  if (side === 'both') return { left: dist, right: dist };
  if (side === 'left') return { left: dist, right: curRight };
  return { left: curLeft, right: dist };
}

function commitGesture(ctx: ToolContext, label: string) {
  ctx.commit(label);
  gesture = null;
  ctx.requestOverlay();
}

export const tool: Tool = {
  id: 'width',
  name: 'Width Tool',
  shortcut: 'shift+w',
  icon: MoveHorizontal,
  group: 'edit',
  order: 632,
  cursor: 'crosshair',
  hint: 'Drag on a stroked path to add a width point. Drag its handles to change the width (Alt: one side), drag the point to slide it. Double-click to edit, Delete removes.',
  showSelectionOverlay: false,
  Options: WidthOptions,

  deactivate(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    hover = null;
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    const s = ctx.state;
    if (!gesture) {
      const h = findHover(ctx, e.world);
      const changed = JSON.stringify(h) !== JSON.stringify(hover);
      hover = h;
      if (changed) ctx.requestOverlay();
      ctx.setCursor(h ? (h.part === 'point' ? 'move' : h.part === 'path' ? 'crosshair' : 'ew-resize') : 'default');
      ctx.setStatus(h ? (h.part === 'path' ? 'Drag to add a width point' : h.part === 'point' ? 'Drag to slide the width point along the path' : 'Drag to change the width (Alt: this side only)') : 'Move over a stroked path');
      return;
    }
    const g = gesture;
    const n = s.doc.nodes[g.nodeId] as PathNode | undefined;
    if (!n) return;
    const m = invert(worldMatrix(s.doc, g.nodeId));
    const local = applyToPoint(m, e.world);
    if (g.kind === 'width') {
      const baseNode = g.base.nodes[g.nodeId] as PathNode;
      const cur = (baseNode.stroke.widthProfile ?? [])[g.index] ?? (n.stroke.widthProfile ?? [])[g.index];
      if (!cur) return;
      const side: 'both' | 'left' | 'right' = e.alt ? (g.side === 'both' ? 'left' : g.side) : 'both';
      let sideEff = side;
      if (e.alt && g.side !== 'both') sideEff = g.side;
      else if (e.alt) {
        // choose the side the cursor is on
        const sp = n.subpaths[g.subpath] ?? n.subpaths[0];
        const loc = locationAtOffset(sp, cur.offset);
        const nrm = { x: -loc.tangent.y, y: loc.tangent.x };
        const d = (local.x - loc.point.x) * nrm.x + (local.y - loc.point.y) * nrm.y;
        sideEff = d >= 0 ? 'left' : 'right';
      }
      const w = widthsFromCursor(n, g.subpath, cur.offset, local, sideEff, cur);
      s.updateDoc((d) => setProfilePoint(d, g.nodeId, g.index, { left: w.left, right: w.right, width: w.left + w.right }));
      const total = w.left + w.right;
      const scale = scaleFactor(worldMatrix(s.doc, g.nodeId));
      ctx.setStatus(`Width: ${formatLength(total * scale, s.prefs.units)}  (side 1: ${formatLength(w.left * scale, s.prefs.units)}, side 2: ${formatLength(w.right * scale, s.prefs.units)})`);
      ctx.requestOverlay();
      return;
    }
    if (g.kind === 'slide') {
      const loc = nearestPointOnPath(n.subpaths, local);
      if (!loc) return;
      const sp = n.subpaths[loc.subpath];
      const off = offsetOf(sp, loc.segment, loc.t);
      s.updateDoc((d) => setProfilePoint(d, g.nodeId, g.index, { offset: off }));
      ctx.requestOverlay();
    }
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const h = findHover(ctx, e.world);
    if (!h) {
      selected = null;
      ctx.requestOverlay();
      return;
    }
    const n = s.doc.nodes[h.nodeId] as PathNode;
    if (h.part === 'path') {
      // add a width point at the location with the current interpolated width
      const profile = n.stroke.widthProfile ?? [];
      const w = widthAt(profile, h.offset, n.stroke.width);
      const wp: WidthPoint = { offset: h.offset, width: w.left + w.right, left: w.left, right: w.right };
      let index = 0;
      s.updateDoc((d) => {
        const nn = d.nodes[h.nodeId] as PathNode;
        const list = [...(nn.stroke.widthProfile ?? []), wp].sort((a, b) => a.offset - b.offset);
        index = list.indexOf(wp);
        nn.stroke = { ...nn.stroke, widthProfile: list };
      });
      selected = { nodeId: h.nodeId, index };
      gesture = { kind: 'width', nodeId: h.nodeId, index, base: s.doc, side: 'both', subpath: h.subpath };
      s.setSelection([h.nodeId]);
      ctx.capture(e.pointerId);
      ctx.requestOverlay();
      return;
    }
    selected = { nodeId: h.nodeId, index: h.index };
    s.setSelection([h.nodeId]);
    if (h.part === 'point') {
      gesture = { kind: 'slide', nodeId: h.nodeId, index: h.index, base: s.doc, subpath: h.subpath };
    } else {
      gesture = { kind: 'width', nodeId: h.nodeId, index: h.index, base: s.doc, side: h.part, subpath: h.subpath };
    }
    ctx.capture(e.pointerId);
    ctx.requestOverlay();
  },

  onPointerUp(_e, ctx) {
    if (!gesture) return;
    const g = gesture;
    const s = ctx.state;
    if (g.kind === 'slide') {
      // keep the profile sorted after sliding
      s.updateDoc((d) => {
        const n = d.nodes[g.nodeId] as PathNode | undefined;
        if (!n || !n.stroke.widthProfile) return;
        const wp = n.stroke.widthProfile[g.index];
        const list = [...n.stroke.widthProfile].sort((a, b) => a.offset - b.offset);
        n.stroke = { ...n.stroke, widthProfile: list };
        if (selected && wp) selected = { nodeId: g.nodeId, index: list.indexOf(wp) };
      });
      commitGesture(ctx, 'Move Width Point');
      return;
    }
    commitGesture(ctx, 'Adjust Width');
  },

  onDoubleClick(e, ctx) {
    const h = findHover(ctx, e.world);
    if (h && h.index >= 0) {
      selected = { nodeId: h.nodeId, index: h.index };
      ctx.state.openDialog('widthPoint', { nodeId: h.nodeId, index: h.index });
    }
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape') {
      if (gesture) {
        this.cancel!(ctx);
        return true;
      }
      if (selected) {
        selected = null;
        ctx.requestOverlay();
        return true;
      }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !gesture) {
      removeWidthPoint(selected.nodeId, selected.index);
      selected = null;
      ctx.requestOverlay();
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const s = ctx.state;
    const ids = new Set<ID>();
    if (hover) ids.add(hover.nodeId);
    if (selected) ids.add(selected.nodeId);
    if (gesture) ids.add(gesture.nodeId);
    for (const id of s.selection) if ((s.doc.nodes[id] as PathNode | undefined)?.type === 'path') ids.add(id);
    const items: React.ReactNode[] = [];
    for (const id of ids) {
      const n = s.doc.nodes[id] as PathNode | undefined;
      if (!n || n.type !== 'path' || n.stroke.paint.type === 'none') continue;
      const m = worldMatrix(s.doc, id);
      const toScreen = (p: Vec) => ctx.worldToScreen(applyToPoint(m, p));
      const screenM: Matrix = { a: s.zoom, b: 0, c: 0, d: s.zoom, e: s.pan.x, f: s.pan.y };
      const profile = n.stroke.widthProfile ?? [];
      // outline preview
      if (profile.length) {
        const outline = variableWidthOutlines(n.subpaths, profile, n.stroke.width);
        const world = transformSubPaths(outline, m);
        const screen = transformSubPaths(world, screenM);
        items.push(<path key={`${id}-outline`} d={pathToSvgD(screen)} fill="none" stroke={HL} strokeWidth={1} strokeOpacity={0.9} pointerEvents="none" />);
      } else {
        const screen = transformSubPaths(transformSubPaths(n.subpaths, m), screenM);
        items.push(<path key={`${id}-center`} d={pathToSvgD(screen)} fill="none" stroke={HL} strokeWidth={1} strokeOpacity={0.5} pointerEvents="none" />);
      }
      profile.forEach((wp, i) => {
        const g = widthPointGeom(s.doc, n, wp);
        if (!g) return;
        const p = ctx.worldToScreen(g.point);
        const l = ctx.worldToScreen(g.left);
        const r = ctx.worldToScreen(g.right);
        const isSel = selected && selected.nodeId === id && selected.index === i;
        const isHover = hover && hover.nodeId === id && hover.index === i;
        items.push(
          <g key={`${id}-wp-${i}`} pointerEvents="none">
            <line x1={l.x} y1={l.y} x2={r.x} y2={r.y} stroke={HL} strokeWidth={1} />
            <circle cx={l.x} cy={l.y} r={HANDLE_R} fill={isHover && hover!.part === 'left' ? HL : '#fff'} stroke={HL} strokeWidth={1.2} />
            <circle cx={r.x} cy={r.y} r={HANDLE_R} fill={isHover && hover!.part === 'right' ? HL : '#fff'} stroke={HL} strokeWidth={1.2} />
            <rect x={p.x - 4.5} y={p.y - 4.5} width={9} height={9} transform={`rotate(45 ${p.x} ${p.y})`} fill={isSel || (isHover && hover!.part === 'point') ? HL : '#fff'} stroke={HL} strokeWidth={1.2} />
          </g>,
        );
      });
      void toScreen;
    }
    // hover marker on the path (new point preview)
    if (hover && hover.part === 'path' && !gesture) {
      const n = s.doc.nodes[hover.nodeId] as PathNode | undefined;
      if (n) {
        const m = worldMatrix(s.doc, hover.nodeId);
        const w = widthAt(n.stroke.widthProfile ?? [], hover.offset, n.stroke.width);
        const p = ctx.worldToScreen(applyToPoint(m, hover.point));
        const l = ctx.worldToScreen(applyToPoint(m, { x: hover.point.x + hover.normal.x * w.left, y: hover.point.y + hover.normal.y * w.left }));
        const r = ctx.worldToScreen(applyToPoint(m, { x: hover.point.x - hover.normal.x * w.right, y: hover.point.y - hover.normal.y * w.right }));
        items.push(
          <g key="hover" pointerEvents="none" opacity={0.85}>
            <line x1={l.x} y1={l.y} x2={r.x} y2={r.y} stroke={HL} strokeWidth={1} strokeDasharray="3 2" />
            <circle cx={l.x} cy={l.y} r={3} fill="none" stroke={HL} />
            <circle cx={r.x} cy={r.y} r={3} fill="none" stroke={HL} />
            <rect x={p.x - 4} y={p.y - 4} width={8} height={8} transform={`rotate(45 ${p.x} ${p.y})`} fill="none" stroke={HL} strokeWidth={1.2} />
          </g>,
        );
      }
    }
    return <g className="width-tool-overlay" data-testid="width-overlay">{items}</g>;
  },

  isBusy: () => !!gesture,
  cancel(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    ctx.requestOverlay();
  },
};

export function removeWidthPoint(nodeId: ID, index: number): void {
  getState().updateDoc((d) => {
    const n = d.nodes[nodeId] as PathNode | undefined;
    if (!n || !n.stroke.widthProfile) return;
    const list = n.stroke.widthProfile.filter((_, i) => i !== index);
    n.stroke = { ...n.stroke, widthProfile: list.length ? list : undefined };
  }, 'Delete Width Point');
}

export function clearWidthProfile(ids: ID[]): void {
  getState().updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id] as PathNode | undefined;
      if (!n || n.type !== 'path' || !n.stroke.widthProfile) continue;
      n.stroke = { ...n.stroke, widthProfile: undefined };
    }
  }, 'Clear Width Profile');
}

// ---------------------------------------------------------------------------
// Options bar
// ---------------------------------------------------------------------------

function useSelectedPoint(): { nodeId: ID; index: number; wp: WidthPoint; node: PathNode } | null {
  const doc = useStore((s) => s.doc);
  useStore((s) => s.overlayTick);
  if (!selected) return null;
  const n = doc.nodes[selected.nodeId] as PathNode | undefined;
  const wp = n?.stroke.widthProfile?.[selected.index];
  if (!n || !wp) return null;
  return { nodeId: selected.nodeId, index: selected.index, wp, node: n };
}

function WidthOptions() {
  const sel = useSelectedPoint();
  const units = useStore((s) => s.prefs.units);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const hasProfiles = selection.some((id) => ((doc.nodes[id] as PathNode | undefined)?.stroke?.widthProfile?.length ?? 0) > 0);
  const set = (patch: Partial<WidthPoint>, label: string) => {
    if (!sel) return;
    getState().updateDoc((d) => {
      const cur = (d.nodes[sel.nodeId] as PathNode).stroke.widthProfile?.[sel.index];
      if (!cur) return;
      const next = { ...cur, ...patch };
      next.width = (next.left ?? next.width / 2) + (next.right ?? next.width / 2);
      setProfilePoint(d, sel.nodeId, sel.index, next);
    }, label);
  };
  return (
    <Row gap={10}>
      {sel ? (
        <>
          <NumberField label="Side 1" value={sel.wp.left ?? sel.wp.width / 2} onChange={(v) => set({ left: Math.max(0, v) }, 'Width Point')} min={0} unit={units} width={100} data-testid="width-side1" />
          <NumberField label="Side 2" value={sel.wp.right ?? sel.wp.width / 2} onChange={(v) => set({ right: Math.max(0, v) }, 'Width Point')} min={0} unit={units} width={100} data-testid="width-side2" />
          <NumberField
            label="Total"
            value={sel.wp.width}
            onChange={(v) => set({ left: Math.max(0, v) / 2, right: Math.max(0, v) / 2 }, 'Width Point')}
            min={0}
            unit={units}
            width={100}
            data-testid="width-total"
          />
          <NumberField label="Position" value={sel.wp.offset * 100} onChange={(v) => set({ offset: Math.max(0, Math.min(100, v)) / 100 }, 'Move Width Point')} min={0} max={100} unit="%" width={100} />
          <IconButton
            icon={<Trash2 size={14} />}
            title="Delete width point"
            onClick={() => {
              removeWidthPoint(sel.nodeId, sel.index);
              selected = null;
              getState().requestOverlay();
            }}
            data-testid="width-delete"
          />
        </>
      ) : (
        <span className="muted small">Drag on a stroked path to add a width point; select a point to edit its values.</span>
      )}
      <Button small disabled={!hasProfiles} onClick={() => clearWidthProfile(selection)} title="Remove the width profile from the selected paths">
        <Eraser size={13} />
        Reset width
      </Button>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Dialog + commands
// ---------------------------------------------------------------------------

function WidthPointDialog({ props, close }: { props: { nodeId: ID; index: number }; close: () => void }) {
  const s = getState();
  const n = s.doc.nodes[props.nodeId] as PathNode | undefined;
  const wp = n?.stroke.widthProfile?.[props.index];
  const [left, setLeft] = useState(wp ? (wp.left ?? wp.width / 2) : 0);
  const [right, setRight] = useState(wp ? (wp.right ?? wp.width / 2) : 0);
  const [sym, setSym] = useState(wp ? Math.abs((wp.left ?? wp.width / 2) - (wp.right ?? wp.width / 2)) < 1e-6 : true);
  if (!n || !wp) return null;
  const ok = () => {
    getState().updateDoc((d) => setProfilePoint(d, props.nodeId, props.index, { left, right: sym ? left : right, width: left + (sym ? left : right) }), 'Width Point');
    close();
  };
  return (
    <DialogFrame
      title="Width Point Edit"
      onClose={close}
      width={360}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="width-dialog-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <NumberField label="Side 1" value={left} onChange={(v) => { setLeft(Math.max(0, v)); if (sym) setRight(Math.max(0, v)); }} min={0} unit={s.prefs.units} width={140} data-testid="width-dialog-side1" />
        <NumberField label="Side 2" value={sym ? left : right} onChange={(v) => { setRight(Math.max(0, v)); if (sym) setLeft(Math.max(0, v)); }} min={0} unit={s.prefs.units} width={140} data-testid="width-dialog-side2" />
      </Row>
      <Row gap={8}>
        <NumberField label="Total width" value={left + (sym ? left : right)} onChange={(v) => { setLeft(Math.max(0, v) / 2); setRight(Math.max(0, v) / 2); }} min={0} unit={s.prefs.units} width={140} />
        <Checkbox checked={sym} onChange={setSym} label="Symmetric" />
      </Row>
      <div className="dim small">Position: {(wp.offset * 100).toFixed(1)}% along the path.</div>
    </DialogFrame>
  );
}

registerDialog<{ nodeId: ID; index: number }>('widthPoint', WidthPointDialog);

registerCommands([
  {
    id: 'path.clearWidthProfile',
    label: 'Reset Width Profile',
    menu: 'Object/Path',
    order: 33,
    run: () => clearWidthProfile(getState().selection),
    enabled: (s) => s.selection.some((id) => ((s.doc.nodes[id] as PathNode | undefined)?.stroke?.widthProfile?.length ?? 0) > 0) && when.hasSelection(s),
  },
]);

void React;
