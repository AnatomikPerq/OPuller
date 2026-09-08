/**
 * Perspective grid module: View > Perspective Grid commands (show / hide,
 * one / two / three point presets, define, active plane), Object > Perspective
 * (attach to active plane, release with perspective, remove perspective), the
 * grid overlay + plane widget in the viewport, the Define Grid dialog and the
 * automatic attachment of shapes drawn while the grid is shown.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { registerCommands, type Command } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Row, Segmented, Slider } from '@/ui/widgets';
import { getState, useStore, type EditorState } from '@/store/store';
import type { Document, ID, PerspectiveGrid, PerspectivePlane, Rect } from '@/model/types';
import { topmostOf, sortByPaintOrder } from '@/model/document';
import { bakeGeometryEffects } from '@/distort/register';
import { createOutlines } from '@/commands/typeCommands/register';
import { usePerspectiveStore } from './store';
import { defaultGrid, planeLines, withType, PLANES, PLANE_COLORS, PLANE_LABELS } from './grid';
import { attachToPlane, attachmentOf, removePerspective, forgetAttachment, canAttach, isAttached, flatRectOf, moveAttached, attachedNodes } from './ops';
import * as grid from './grid';
import './perspective.css';

// ---------------------------------------------------------------------------
// Grid access
// ---------------------------------------------------------------------------

function activeArtboardRect(s: EditorState = getState()): Rect | null {
  const ab = s.doc.artboards.find((a) => a.id === s.activeArtboardId) ?? s.doc.artboards[0];
  return ab ? { x: ab.x, y: ab.y, width: ab.width, height: ab.height } : null;
}

/** The document grid, created with defaults when missing (one undo step). */
export function ensureGrid(type?: 1 | 2 | 3): PerspectiveGrid {
  const s = getState();
  if (s.doc.perspective && (type === undefined || s.doc.perspective.type === type)) return s.doc.perspective;
  const g = s.doc.perspective && type !== undefined ? withType(s.doc.perspective, type) : defaultGrid(activeArtboardRect(s), type ?? 2);
  s.updateDoc((d) => {
    d.perspective = g;
  }, 'Define Perspective Grid');
  return g;
}

export function showGrid(visible: boolean): void {
  if (visible) ensureGrid();
  usePerspectiveStore.getState().setVisible(visible);
}

export function setPreset(type: 1 | 2 | 3): void {
  const s = getState();
  s.updateDoc((d) => {
    d.perspective = defaultGrid(activeArtboardRect(s), type);
  }, `${['One', 'Two', 'Three'][type - 1]} Point Perspective`);
  usePerspectiveStore.getState().setVisible(true);
}

export function updateGrid(patch: Partial<PerspectiveGrid>, label: string | null = 'Edit Perspective Grid'): void {
  const s = getState();
  s.updateDoc((d) => {
    d.perspective = { ...(d.perspective ?? defaultGrid(activeArtboardRect(s))), ...patch };
  }, label ?? undefined);
}

export function setActivePlane(plane: PerspectivePlane): void {
  usePerspectiveStore.getState().setActivePlane(plane);
  getState().requestOverlay();
}

// ---------------------------------------------------------------------------
// Attach / release
// ---------------------------------------------------------------------------

function targets(s: EditorState = getState()): ID[] {
  return sortByPaintOrder(s.doc, topmostOf(s.doc, s.selection)).filter((id) => s.doc.nodes[id] && s.doc.nodes[id].type !== 'layer');
}

/** Attach the selection (or the given ids) to the active plane; text is outlined first. */
export async function attachSelection(ids?: ID[], plane?: PerspectivePlane): Promise<ID[]> {
  let s = getState();
  let list = ids ?? targets(s);
  if (!list.length) return [];
  const g = ensureGrid();
  usePerspectiveStore.getState().setVisible(true);
  const texts = list.filter((id) => s.doc.nodes[id]?.type === 'text');
  if (texts.length) {
    const rest = list.filter((id) => !texts.includes(id));
    s.setSelection(texts);
    await createOutlines();
    s = getState();
    list = [...rest, ...s.selection];
  }
  const p = plane ?? usePerspectiveStore.getState().activePlane;
  const done: ID[] = [];
  const skipped: ID[] = [];
  s.updateDoc((d) => {
    for (const id of list) {
      const n = d.nodes[id];
      if (!n || !canAttach(n)) {
        if (n) skipped.push(id);
        continue;
      }
      if (attachToPlane(d, id, g, p)) done.push(id);
    }
  }, 'Attach to Active Plane');
  if (skipped.length) getState().toast('Images cannot be attached to a perspective plane', 'info');
  getState().setSelection([...done, ...skipped]);
  return done;
}

/** Release with Perspective: the objects keep their perspective look as plain geometry. */
export function releaseSelection(ids?: ID[]): ID[] {
  const s = getState();
  const list = (ids ?? targets(s)).filter((id) => isAttached(s.doc, id));
  if (!list.length) return [];
  s.updateDoc((d) => {
    for (const id of list) {
      bakeGeometryEffects(d, id);
      forgetAttachment(d, id);
    }
  }, 'Release with Perspective');
  return list;
}

/** Remove Perspective: the objects return to their flat geometry. */
export function removeSelection(ids?: ID[]): ID[] {
  const s = getState();
  const list = (ids ?? targets(s)).filter((id) => isAttached(s.doc, id));
  if (!list.length) return [];
  s.updateDoc((d) => {
    for (const id of list) removePerspective(d, id);
  }, 'Remove Perspective');
  return list;
}

/** Move the active plane's origin so the plane passes through the selected object's flat rectangle. */
export function movePlaneToObject(): boolean {
  const s = getState();
  const id = targets(s).find((i) => isAttached(s.doc, i));
  if (!id) return false;
  const a = attachmentOf(s.doc, id)!;
  const g = s.doc.perspective;
  if (!g) return false;
  // shift the grid so the object's flat rectangle sits at the corner / ground line, re-projecting it
  const dx = a.plane === 'floor' ? 0 : a.plane === 'right' ? a.rect.x - g.corner : a.rect.x + a.rect.width - g.corner;
  const dy = a.plane === 'floor' ? a.rect.y + a.rect.height - g.ground : 0;
  if (!dx && !dy) return false;
  s.updateDoc((d) => {
    const gg = d.perspective!;
    gg.corner += dx;
    gg.vpLeft += dx;
    gg.vpRight += dx;
    gg.ground += dy;
    gg.horizon += dy;
    if (gg.vpVertical !== undefined) gg.vpVertical += dy;
    for (const n of attachedNodes(d)) {
      const at = attachmentOf(d, n)!;
      attachToPlane(d, n, gg, at.plane, at.rect);
    }
  }, 'Move Plane to Match Object');
  return true;
}

// ---------------------------------------------------------------------------
// Automatic attachment of newly drawn shapes
// ---------------------------------------------------------------------------

const seenDocs = new WeakSet<Document>();

useStore.subscribe(
  (s) => s.past,
  (past, prev) => {
    if (past.length !== prev.length + 1) return;
    const ui = usePerspectiveStore.getState();
    if (!ui.visible || !ui.drawOnPlane) return;
    const label = past[past.length - 1]?.label ?? '';
    if (!label.startsWith('Create ') || label === 'Create Artboard' || label === 'Create Outlines') return;
    const s = getState();
    if (seenDocs.has(s.doc) || s.future.length) return;
    seenDocs.add(s.doc);
    const g = s.doc.perspective;
    if (!g || s.selection.length !== 1) return;
    const id = s.selection[0];
    const n = s.doc.nodes[id] as import('@/model/types').Node | undefined;
    if (!n || n.type !== 'path' || isAttached(s.doc, id)) return;
    queueMicrotask(() => {
      const cur = getState();
      if (cur.doc !== s.doc || cur.selection[0] !== id) return;
      cur.updateDoc((d) => {
        attachToPlane(d, id, g, ui.activePlane);
      }, 'Attach to Active Plane');
      seenDocs.add(getState().doc);
    });
  },
);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const hasAttached = (s: EditorState) => s.selection.some((id) => isAttached(s.doc, id));
const attachable = (s: EditorState) => s.selection.some((id) => canAttach(s.doc.nodes[id]) || s.doc.nodes[id]?.type === 'text');
const gridType = (t: number) => (s: EditorState) => usePerspectiveStore.getState().visible && s.doc.perspective?.type === t;

const commands: Command[] = [
  { id: 'view.perspective.toggle', label: 'Show Perspective Grid', menu: 'View/Perspective Grid', shortcut: 'mod+shift+i', order: 70, run: () => showGrid(!usePerspectiveStore.getState().visible), checked: () => usePerspectiveStore.getState().visible },
  { id: 'view.perspective.onePoint', label: 'One Point Perspective', menu: 'View/Perspective Grid', order: 70.1, separatorBefore: true, run: () => setPreset(1), checked: gridType(1) },
  { id: 'view.perspective.twoPoint', label: 'Two Point Perspective', menu: 'View/Perspective Grid', order: 70.2, run: () => setPreset(2), checked: gridType(2) },
  { id: 'view.perspective.threePoint', label: 'Three Point Perspective', menu: 'View/Perspective Grid', order: 70.3, run: () => setPreset(3), checked: gridType(3) },
  { id: 'view.perspective.define', label: 'Define Grid…', menu: 'View/Perspective Grid', order: 70.4, separatorBefore: true, run: () => { ensureGrid(); usePerspectiveStore.getState().setVisible(true); getState().openDialog('perspective.define', {}); } },
  { id: 'view.perspective.planeLeft', label: 'Left Plane Active', menu: 'View/Perspective Grid', order: 70.5, separatorBefore: true, run: () => setActivePlane('left'), checked: () => usePerspectiveStore.getState().activePlane === 'left' },
  { id: 'view.perspective.planeFloor', label: 'Horizontal Plane Active', menu: 'View/Perspective Grid', order: 70.6, run: () => setActivePlane('floor'), checked: () => usePerspectiveStore.getState().activePlane === 'floor' },
  { id: 'view.perspective.planeRight', label: 'Right Plane Active', menu: 'View/Perspective Grid', order: 70.7, run: () => setActivePlane('right'), checked: () => usePerspectiveStore.getState().activePlane === 'right' },
  { id: 'view.perspective.drawOn', label: 'Draw New Shapes on Active Plane', menu: 'View/Perspective Grid', order: 70.8, separatorBefore: true, run: () => usePerspectiveStore.getState().setDrawOnPlane(!usePerspectiveStore.getState().drawOnPlane), checked: () => usePerspectiveStore.getState().drawOnPlane },
  { id: 'perspective.attach', label: 'Attach to Active Plane', menu: 'Object/Perspective', order: 750, run: () => void attachSelection(), enabled: attachable },
  { id: 'perspective.release', label: 'Release with Perspective', menu: 'Object/Perspective', order: 751, run: () => releaseSelection(), enabled: hasAttached },
  { id: 'perspective.remove', label: 'Remove Perspective', menu: 'Object/Perspective', order: 752, run: () => removeSelection(), enabled: hasAttached },
  { id: 'perspective.movePlane', label: 'Move Plane to Match Object', menu: 'Object/Perspective', order: 753, separatorBefore: true, run: () => movePlaneToObject(), enabled: hasAttached },
  { id: 'perspective.editGrid', label: 'Edit Grid (Perspective Grid Tool)', menu: 'Object/Perspective', order: 754, run: () => getState().setTool('perspectiveGrid') },
];
registerCommands(commands);

// ---------------------------------------------------------------------------
// Viewport overlay: the grid
// ---------------------------------------------------------------------------

function screenPath(pts: Array<{ x: number; y: number }>, zoom: number, pan: { x: number; y: number }, close = false): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x * zoom + pan.x).toFixed(1)} ${(p.y * zoom + pan.y).toFixed(1)}`).join(' ') + (close ? 'Z' : '');
}

export function GridOverlay() {
  const g = useStore((s) => s.doc.perspective);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const size = useStore((s) => s.viewportSize);
  const visible = usePerspectiveStore((s) => s.visible);
  const active = usePerspectiveStore((s) => s.activePlane);
  const planes = useMemo(() => (g && visible ? PLANES.map((p) => ({ id: p, ...planeLines(g, p) })) : []), [g, visible]);
  if (!g || !visible) return null;
  const op = g.opacity ?? 0.55;
  const hy = g.horizon * zoom + pan.y;
  const gy = g.ground * zoom + pan.y;
  const cx = g.corner * zoom + pan.x;
  return (
    <g className="perspective-grid" data-testid="perspective-grid" data-type={g.type} data-active-plane={active}>
      {planes.map((p) => (
        <g key={p.id} className={`pg-plane ${p.id} ${p.id === active ? 'active' : ''}`} data-plane={p.id} opacity={p.id === active ? Math.min(1, op + 0.3) : op}>
          {p.lines.map((ln, i) => (
            <path key={i} className="pg-line" d={screenPath(ln, zoom, pan)} stroke={PLANE_COLORS[p.id]} />
          ))}
          <path className="pg-outline" d={screenPath(p.outline, zoom, pan, true)} stroke={PLANE_COLORS[p.id]} />
        </g>
      ))}
      <line className="pg-horizon" x1={0} x2={size.width} y1={hy + 0.5} y2={hy + 0.5} />
      <line className="pg-ground" x1={(g.type === 1 ? g.corner - g.extent : g.vpLeft) * zoom + pan.x} x2={(g.type === 1 ? g.corner + g.extent : g.vpRight) * zoom + pan.x} y1={gy + 0.5} y2={gy + 0.5} />
      <line className="pg-corner" x1={cx + 0.5} x2={cx + 0.5} y1={gy} y2={(g.ground - g.height) * zoom + pan.y} />
      {(g.type === 1 ? [g.vpRight] : [g.vpLeft, g.vpRight]).map((x, i) => (
        <circle key={i} className="pg-vp" cx={x * zoom + pan.x} cy={hy} r={4} />
      ))}
      {g.type === 3 && g.vpVertical !== undefined && <circle className="pg-vp" cx={cx} cy={g.vpVertical * zoom + pan.y} r={4} />}
      <text className="pg-label" x={8} y={hy - 4}>
        horizon
      </text>
    </g>
  );
}

registerViewportSlot('overlay', 'perspective-grid', GridOverlay);

/** Illustrator-style plane switcher in the top-left corner of the viewport. */
function PlaneWidget() {
  const visible = usePerspectiveStore((s) => s.visible);
  const active = usePerspectiveStore((s) => s.activePlane);
  const has = useStore((s) => !!s.doc.perspective);
  if (!visible || !has) return null;
  return (
    <div
      className="perspective-plane-widget"
      data-testid="perspective-plane-widget"
      title="Active perspective plane (1 = left, 2 = horizontal, 3 = right)"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {PLANES.map((p) => (
        <button key={p} type="button" className={p === active ? 'active' : ''} onClick={() => setActivePlane(p)} title={PLANE_LABELS[p]} data-testid={`perspective-plane-${p}`}>
          <svg width={18} height={16} viewBox="0 0 18 16">
            {p === 'left' && <path d="M2 4 L9 1 L9 15 L2 12 Z" fill={PLANE_COLORS.left} />}
            {p === 'right' && <path d="M16 4 L9 1 L9 15 L16 12 Z" fill={PLANE_COLORS.right} />}
            {p === 'floor' && <path d="M2 10 L9 7 L16 10 L9 13 Z" fill={PLANE_COLORS.floor} />}
            {p !== 'left' && <path d="M2 4 L9 1 L9 15 L2 12 Z" fill="none" stroke="#777" strokeWidth={0.8} />}
            {p !== 'right' && <path d="M16 4 L9 1 L9 15 L16 12 Z" fill="none" stroke="#777" strokeWidth={0.8} />}
          </svg>
        </button>
      ))}
    </div>
  );
}

registerViewportSlot('html', 'perspective-plane-widget', PlaneWidget);

// ---------------------------------------------------------------------------
// Define Grid dialog (live preview, cancel reverts)
// ---------------------------------------------------------------------------

function DefineGridDialog({ close }: { close: () => void }) {
  const initial = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    return s.doc.perspective ?? ensureGrid();
  }, []);
  const [g, setG] = useState<PerspectiveGrid>(initial);
  const ref = useRef(g);
  ref.current = g;
  useEffect(() => () => undefined, []);
  const set = (patch: Partial<PerspectiveGrid>) => {
    const next = { ...ref.current, ...patch };
    setG(next);
    updateGrid(next, null);
  };
  const setType = (t: 1 | 2 | 3) => {
    const next = withType(ref.current, t);
    setG(next);
    updateGrid(next, null);
  };
  const ok = () => {
    getState().commit('Define Perspective Grid');
    usePerspectiveStore.getState().setVisible(true);
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  return (
    <DialogFrame
      title="Define Perspective Grid"
      onClose={cancel}
      width={440}
      footer={
        <>
          <Button onClick={() => set(defaultGrid(activeArtboardRect(), ref.current.type))}>Reset</Button>
          <div style={{ flex: 1 }} />
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="perspective-define-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <span className="field-label">Type</span>
        <Segmented value={String(g.type)} onChange={(v) => setType(Number(v) as 1 | 2 | 3)} options={[{ value: '1', label: 'One point' }, { value: '2', label: 'Two point' }, { value: '3', label: 'Three point' }]} />
      </Row>
      <div className="section-title">Vanishing points</div>
      <Row gap={8}>
        {g.type !== 1 && <NumberField label="Left X" value={Math.round(g.vpLeft)} onChange={(v) => set({ vpLeft: v })} width={110} data-testid="perspective-vp-left" />}
        <NumberField label={g.type === 1 ? 'VP X' : 'Right X'} value={Math.round(g.vpRight)} onChange={(v) => set(g.type === 1 ? { vpLeft: v, vpRight: v } : { vpRight: v })} width={110} data-testid="perspective-vp-right" />
        <NumberField label="Horizon Y" value={Math.round(g.horizon)} onChange={(v) => set({ horizon: v })} width={110} data-testid="perspective-horizon" />
        {g.type === 3 && <NumberField label="Vertical Y" value={Math.round(g.vpVertical ?? 0)} onChange={(v) => set({ vpVertical: v })} width={110} data-testid="perspective-vp-vertical" />}
      </Row>
      <div className="section-title">Grid</div>
      <Row gap={8}>
        <NumberField label="Corner X" value={Math.round(g.corner)} onChange={(v) => set({ corner: v })} width={110} data-testid="perspective-corner" />
        <NumberField label="Ground Y" value={Math.round(g.ground)} onChange={(v) => set({ ground: v })} width={110} data-testid="perspective-ground" />
        <NumberField label="Extent" value={Math.round(g.extent)} min={10} onChange={(v) => set({ extent: Math.max(10, v) })} width={100} data-testid="perspective-extent" />
        <NumberField label="Height" value={Math.round(g.height)} min={10} onChange={(v) => set({ height: Math.max(10, v) })} width={100} data-testid="perspective-height" />
      </Row>
      <Row gap={8}>
        <NumberField label="Cell size" value={Math.round(g.cell)} min={1} onChange={(v) => set({ cell: Math.max(1, v) })} width={100} data-testid="perspective-cell" />
        <Slider label="Opacity" value={Math.round((g.opacity ?? 0.55) * 100)} min={10} max={100} unit="%" onChange={(v) => set({ opacity: v / 100 })} />
      </Row>
      <div className="dim small">Coordinates are world units. Drag the handles with the Perspective Grid tool (Shift+P) to edit the grid on the canvas.</div>
    </DialogFrame>
  );
}

registerDialog('perspective.define', ({ close }) => <DefineGridDialog close={close} />);

// ---------------------------------------------------------------------------
// Scripting / tests
// ---------------------------------------------------------------------------

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  perspective: {
    ...grid,
    store: usePerspectiveStore,
    ensureGrid,
    showGrid,
    setPreset,
    updateGrid,
    setActivePlane,
    attachSelection,
    releaseSelection,
    removeSelection,
    movePlaneToObject,
    attachmentOf: (id: ID) => attachmentOf(getState().doc, id),
    flatRectOf: (id: ID) => flatRectOf(getState().doc, id),
    moveAttached,
    attachedNodes: (ids?: ID[]) => attachedNodes(getState().doc, ids),
  },
};

void React;
