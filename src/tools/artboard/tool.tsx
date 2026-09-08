/**
 * Artboard tool (Shift+O): drag on empty canvas to create an artboard, drag an
 * artboard to move it (with its artwork), drag the handles of the active
 * artboard to resize it. Alt-drag duplicates, Shift constrains proportions,
 * Delete removes the active artboard, Escape/Enter return to the previous tool.
 */
import React from 'react';
import { Frame, Plus, Copy, Trash2, Maximize, Settings2, RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { produce } from 'immer';
import type { Tool, ToolPointerEvent, ToolContext } from '../types';
import type { Artboard, Document, ID, Vec, Rect } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { newId } from '@/model/nodes';
import type { SnapSession } from '@/canvas/snap';
import { useOverlayStore } from '@/canvas/overlayStore';
import { HANDLE_KINDS, handlePoint, oppositeHandle, type HandleKind } from '@/canvas/selectionHandles';
import { formatLength } from '@/util/units';
import { NumberField, TextField, Select, Checkbox, Button, IconButton, Row, Segmented } from '@/ui/widgets';
import { useToolOptions } from '@/canvas/toolContext';
import { runCommand } from '@/commands/registry';
import { addArtboard, artworkOnArtboard, duplicateArtboard, getArtboard, moveArtboard, ARTBOARD_PRESETS, presetFor, uniqueArtboardName, artboardRect } from '@/artboards/ops';

interface ArtboardToolOptions extends Record<string, unknown> {
  moveArtwork: boolean;
  showHandles: boolean;
}

type Gesture =
  | { kind: 'create'; start: Vec; snap: SnapSession; id: ID | null; base: Document; moved: boolean }
  | { kind: 'move'; id: ID; start: Vec; base: Document; snap: SnapSession; artwork: ID[]; moved: boolean; duplicated: boolean }
  | { kind: 'resize'; id: ID; handle: HandleKind; base: Document; snap: SnapSession; orig: Artboard };

let gesture: Gesture | null = null;
let hoverHandle: HandleKind | null = null;

const CURSORS: Record<HandleKind, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

function activeArtboard(ctx: ToolContext): Artboard | undefined {
  const s = ctx.state;
  return getArtboard(s.doc, s.activeArtboardId) ?? s.doc.artboards[0];
}

/** Which handle of the active artboard is under the screen point. */
function handleAt(ctx: ToolContext, screen: Vec): HandleKind | null {
  const ab = activeArtboard(ctx);
  if (!ab) return null;
  const size = ctx.state.prefs.handleSize / 2 + 3;
  const r = artboardRect(ab);
  // corners first
  for (const kind of HANDLE_KINDS) {
    if (kind.length !== 2) continue;
    const p = ctx.worldToScreen(handlePoint(r, kind));
    if (Math.abs(p.x - screen.x) <= size && Math.abs(p.y - screen.y) <= size) return kind;
  }
  for (const kind of HANDLE_KINDS) {
    if (kind.length !== 1) continue;
    const p = ctx.worldToScreen(handlePoint(r, kind));
    if (Math.abs(p.x - screen.x) <= size && Math.abs(p.y - screen.y) <= size) return kind;
  }
  return null;
}

/** Top-most artboard containing the world point (later artboards win). */
function artboardAtPoint(doc: Document, p: Vec): Artboard | undefined {
  for (let i = doc.artboards.length - 1; i >= 0; i--) {
    const a = doc.artboards[i];
    if (p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height) return a;
  }
  return undefined;
}

/** Snap session whose candidates are the other artboards + grid/guides (never the dragged one). */
function makeSnap(ctx: ToolContext, excludeArtboard: ID | null, excludeNodes: ID[] = []): SnapSession {
  const doc = ctx.doc;
  const extra: Vec[] = [];
  for (const a of doc.artboards) {
    if (a.id === excludeArtboard) continue;
    extra.push({ x: a.x, y: a.y }, { x: a.x + a.width, y: a.y + a.height }, { x: a.x + a.width / 2, y: a.y + a.height / 2 });
  }
  return ctx.beginSnap({ artboards: false, extraPoints: extra, exclude: excludeNodes, anchors: false });
}

function setHud(e: ToolPointerEvent, r: Rect, units: string) {
  useOverlayStore.getState().setHud({
    screen: { x: e.screen.x + 16, y: e.screen.y + 16 },
    text: `X: ${formatLength(r.x, units as any)}  Y: ${formatLength(r.y, units as any)}\nW: ${formatLength(r.width, units as any)}  H: ${formatLength(r.height, units as any)}`,
  });
}

function rectFromDrag(start: Vec, cur: Vec, shift: boolean, alt: boolean): Rect {
  let dx = cur.x - start.x;
  let dy = cur.y - start.y;
  if (shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  let x = start.x;
  let y = start.y;
  let w = dx;
  let h = dy;
  if (alt) {
    x = start.x - dx;
    y = start.y - dy;
    w = dx * 2;
    h = dy * 2;
  }
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { x, y, width: w, height: h };
}

function resizeRect(orig: Artboard, handle: HandleKind, p: Vec, shift: boolean, alt: boolean): Rect {
  const r = artboardRect(orig);
  const opp = handlePoint(r, oppositeHandle(handle));
  const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  const anchor = alt ? center : opp;
  let nx = handle.includes('w') || handle.includes('e') ? p.x : handle.includes('n') || handle.includes('s') ? undefined : p.x;
  let ny = handle.includes('n') || handle.includes('s') ? p.y : undefined;
  if (handle === 'n' || handle === 's') nx = undefined;
  let x1 = anchor.x;
  let y1 = anchor.y;
  let x2 = nx ?? (handle.includes('w') ? r.x : r.x + r.width);
  let y2 = ny ?? (handle.includes('n') ? r.y : r.y + r.height);
  if (nx === undefined) {
    // vertical-only resize keeps the horizontal extent
    x1 = alt ? center.x - r.width / 2 : r.x;
    x2 = alt ? center.x + r.width / 2 : r.x + r.width;
  }
  if (ny === undefined) {
    y1 = alt ? center.y - r.height / 2 : r.y;
    y2 = alt ? center.y + r.height / 2 : r.y + r.height;
  }
  let w = x2 - x1;
  let h = y2 - y1;
  if (alt) {
    w = (x2 - anchor.x) * 2;
    h = (y2 - anchor.y) * 2;
    x1 = anchor.x - w / 2;
    y1 = anchor.y - h / 2;
    if (nx === undefined) {
      w = r.width;
      x1 = r.x;
    }
    if (ny === undefined) {
      h = r.height;
      y1 = r.y;
    }
  }
  if (shift && nx !== undefined && ny !== undefined && r.width > 0 && r.height > 0) {
    const ratio = r.width / r.height;
    if (Math.abs(w) / ratio > Math.abs(h)) h = Math.sign(h || 1) * (Math.abs(w) / ratio);
    else w = Math.sign(w || 1) * Math.abs(h) * ratio;
    if (!alt) {
      x1 = handle.includes('w') ? anchor.x - Math.abs(w) : anchor.x;
      y1 = handle.includes('n') ? anchor.y - Math.abs(h) : anchor.y;
      w = Math.abs(w);
      h = Math.abs(h);
    } else {
      x1 = anchor.x - Math.abs(w) / 2;
      y1 = anchor.y - Math.abs(h) / 2;
      w = Math.abs(w);
      h = Math.abs(h);
    }
  }
  let x = x1;
  let y = y1;
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { x, y, width: Math.max(1, w), height: Math.max(1, h) };
}

function finishGesture(ctx: ToolContext) {
  ctx.setSnapGuides(null);
  useOverlayStore.getState().setHud(null);
  gesture = null;
  ctx.requestOverlay();
}

export const tool: Tool = {
  id: 'artboard',
  name: 'Artboard Tool',
  shortcut: 'shift+o',
  icon: Frame,
  group: 'artboard',
  order: 800,
  cursor: 'crosshair',
  hint: 'Drag to create an artboard. Drag an artboard to move it, drag its handles to resize. Alt-drag duplicates. Delete removes the active artboard. Esc exits.',
  showSelectionOverlay: false,
  defaults: { moveArtwork: true, showHandles: true } satisfies ArtboardToolOptions,
  Options: ArtboardOptions,

  activate(ctx) {
    ctx.state.clearSelection();
    ctx.requestOverlay();
  },
  deactivate(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    ctx.setSnapGuides(null);
    useOverlayStore.getState().setHud(null);
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const s = ctx.state;
    const opts = ctx.options<ArtboardToolOptions>();
    const handle = handleAt(ctx, e.screen);
    const ab = activeArtboard(ctx);
    if (handle && ab) {
      gesture = { kind: 'resize', id: ab.id, handle, base: s.doc, snap: makeSnap(ctx, ab.id), orig: { ...ab } };
      ctx.setCursor(CURSORS[handle]);
      return;
    }
    const hit = artboardAtPoint(s.doc, e.world);
    if (hit) {
      s.setActiveArtboard(hit.id);
      let id = hit.id;
      let base = s.doc;
      let duplicated = false;
      if (e.alt) {
        // duplicate (copy + its artwork land at the free spot), then bring the copy over the original
        let copyId: ID | null = null;
        s.updateDoc((d) => {
          const c = duplicateArtboard(d, hit.id, opts.moveArtwork);
          if (!c) return;
          copyId = c.id;
          moveArtboard(d, c.id, hit.x - c.x, hit.y - c.y, opts.moveArtwork);
          // keep the copy above the original in the list so it is hit first
        });
        if (copyId) {
          id = copyId;
          s.setActiveArtboard(copyId);
          duplicated = true;
          base = getState().doc;
        }
      }
      const doc = getState().doc;
      const target = getArtboard(doc, id)!;
      const artwork = opts.moveArtwork ? artworkOnArtboard(doc, target) : [];
      gesture = { kind: 'move', id, start: e.world, base, snap: makeSnap(ctx, id, artwork), artwork, moved: false, duplicated };
      ctx.setCursor('move');
      return;
    }
    // empty canvas: create
    const snap = makeSnap(ctx, null);
    const sr = e.primary ? null : snap.snap(e.world);
    gesture = { kind: 'create', start: sr ? sr.point : e.world, snap, id: null, base: s.doc, moved: false };
  },

  onPointerMove(e, ctx) {
    const s = ctx.state;
    const g = gesture;
    if (!g) {
      const h = handleAt(ctx, e.screen);
      hoverHandle = h;
      if (h) ctx.setCursor(CURSORS[h]);
      else ctx.setCursor(artboardAtPoint(s.doc, e.world) ? 'move' : 'crosshair');
      return;
    }
    if (g.kind === 'create') {
      let p = e.world;
      if (!e.primary) {
        const sr = g.snap.snap(p);
        p = sr.point;
        ctx.setSnapGuides(sr);
      }
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) < 3 / s.zoom && !g.moved) return;
      g.moved = true;
      const r = rectFromDrag(g.start, p, e.shift, e.alt);
      if (!g.id) g.id = newId();
      const id = g.id;
      s.replaceDoc(
        produce(g.base, (d) => {
          addArtboard(d, { id, x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height) });
        }),
      );
      if (s.activeArtboardId !== id) s.setActiveArtboard(id);
      setHud(e, r, s.prefs.units);
      ctx.requestOverlay();
      return;
    }
    if (g.kind === 'move') {
      const abBase = getArtboard(g.base, g.id);
      if (!abBase) return;
      let dx = e.world.x - g.start.x;
      let dy = e.world.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < 3 / s.zoom) return;
      g.moved = true;
      if (e.shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (!e.primary) {
        const sr = g.snap.snapRect({ x: abBase.x + dx, y: abBase.y + dy, width: abBase.width, height: abBase.height });
        dx += sr.dx;
        dy += sr.dy;
        ctx.setSnapGuides({ point: e.world, snappedX: sr.dx !== 0, snappedY: sr.dy !== 0, snappedPoint: false, lines: sr.lines, points: [] });
      }
      const opts = ctx.options<ArtboardToolOptions>();
      s.replaceDoc(
        produce(g.base, (d) => {
          moveArtboard(d, g.id, dx, dy, opts.moveArtwork, g.artwork);
        }),
      );
      setHud(e, { x: abBase.x + dx, y: abBase.y + dy, width: abBase.width, height: abBase.height }, s.prefs.units);
      ctx.requestOverlay();
      return;
    }
    if (g.kind === 'resize') {
      let p = e.world;
      if (!e.primary) {
        const sr = g.snap.snap(p);
        p = sr.point;
        ctx.setSnapGuides(sr);
      }
      const r = resizeRect(g.orig, g.handle, p, e.shift, e.alt);
      s.replaceDoc(
        produce(g.base, (d) => {
          const ab = getArtboard(d, g.id);
          if (!ab) return;
          ab.x = r.x;
          ab.y = r.y;
          ab.width = r.width;
          ab.height = r.height;
        }),
      );
      setHud(e, r, s.prefs.units);
      ctx.requestOverlay();
    }
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    if (!g) return;
    const s = ctx.state;
    if (g.kind === 'create') {
      if (!g.moved || !g.id) {
        // plain click on empty canvas: nothing to do
        s.revert();
        finishGesture(ctx);
        return;
      }
      const ab = getArtboard(s.doc, g.id);
      if (ab && (ab.width < 2 || ab.height < 2)) {
        s.revert();
        finishGesture(ctx);
        return;
      }
      ctx.commit('Create Artboard');
      finishGesture(ctx);
      return;
    }
    if (g.kind === 'move') {
      if (!g.moved && !g.duplicated) {
        finishGesture(ctx);
        return;
      }
      ctx.commit(g.duplicated ? 'Duplicate Artboard' : 'Move Artboard');
      finishGesture(ctx);
      return;
    }
    ctx.commit('Resize Artboard');
    finishGesture(ctx);
    void e;
  },

  onDoubleClick(e, ctx) {
    const hit = artboardAtPoint(ctx.doc, e.world);
    if (hit) {
      ctx.state.setActiveArtboard(hit.id);
      ctx.state.openDialog('artboardOptions', { id: hit.id });
    }
  },

  onKeyDown(e, ctx) {
    const s = ctx.state;
    if (e.key === 'Escape') {
      if (gesture) {
        this.cancel!(ctx);
        return true;
      }
      ctx.setTool(s.previousTool && s.previousTool !== 'artboard' ? s.previousTool : 'select');
      return true;
    }
    if (e.key === 'Enter') {
      ctx.setTool(s.previousTool && s.previousTool !== 'artboard' ? s.previousTool : 'select');
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !gesture) {
      runCommand('artboard.delete');
      return true;
    }
    if (e.key.startsWith('Arrow') && !gesture) {
      const ab = activeArtboard(ctx);
      if (!ab) return false;
      const step = e.shift ? s.prefs.bigNudge : s.prefs.nudge;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const opts = ctx.options<ArtboardToolOptions>();
      s.updateDoc((d) => moveArtboard(d, ab.id, dx, dy, opts.moveArtwork), 'Move Artboard');
      ctx.requestOverlay();
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const s = ctx.state;
    const active = s.activeArtboardId;
    const opts = ctx.options<ArtboardToolOptions>();
    const hs = s.prefs.handleSize;
    return (
      <g className="artboard-tool-overlay" data-testid="artboard-overlay">
        {s.doc.artboards.map((a) => {
          const tl = ctx.worldToScreen({ x: a.x, y: a.y });
          const w = a.width * s.zoom;
          const h = a.height * s.zoom;
          const isActive = a.id === active;
          const r = artboardRect(a);
          return (
            <g key={a.id}>
              <rect x={tl.x + 0.5} y={tl.y + 0.5} width={w} height={h} fill="none" stroke={isActive ? 'var(--accent)' : 'rgba(150,150,160,0.8)'} strokeWidth={isActive ? 1.5 : 1} strokeDasharray={isActive ? undefined : '4 3'} pointerEvents="none" />
              {isActive && opts.showHandles && HANDLE_KINDS.map((kind) => {
                const p = ctx.worldToScreen(handlePoint(r, kind));
                return <rect key={kind} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} fill="#fff" stroke="var(--accent)" strokeWidth={1} pointerEvents="none" data-handle={kind} />;
              })}
              {isActive && (
                <text x={tl.x + w} y={tl.y + h + 14} textAnchor="end" fontSize={11} fill="var(--accent)" fontFamily="Inter, system-ui, sans-serif" pointerEvents="none">
                  {formatLength(a.width, s.prefs.units)} × {formatLength(a.height, s.prefs.units)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    );
  },

  isBusy: () => !!gesture,
  cancel(ctx) {
    if (gesture) {
      ctx.state.revert();
      gesture = null;
    }
    ctx.setSnapGuides(null);
    useOverlayStore.getState().setHud(null);
    ctx.requestOverlay();
  },
  getCursor() {
    return hoverHandle ? CURSORS[hoverHandle] : 'crosshair';
  },
};

// ---------------------------------------------------------------------------
// Options bar
// ---------------------------------------------------------------------------

function ArtboardOptions() {
  const [opts, set] = useToolOptions<ArtboardToolOptions>('artboard');
  const units = useStore((s) => s.prefs.units);
  const artboards = useStore((s) => s.doc.artboards);
  const activeId = useStore((s) => s.activeArtboardId);
  const ab = artboards.find((a) => a.id === activeId) ?? artboards[0];
  if (!ab) return null;
  const preset = presetFor(ab.width, ab.height);
  const orientation = ab.width >= ab.height ? 'landscape' : 'portrait';
  const update = (patch: Partial<Artboard>, label: string) => {
    getState().updateDoc((d) => {
      const a = getArtboard(d, ab.id);
      if (!a) return;
      if (patch.name !== undefined) patch.name = uniqueArtboardName(d, patch.name, a.id);
      Object.assign(a, patch);
    }, label);
  };
  return (
    <Row gap={8}>
      <Select
        label="Preset"
        value={preset ? preset.name : ''}
        options={[{ value: '', label: 'Custom' }, ...ARTBOARD_PRESETS.map((p) => ({ value: p.name, label: `${p.group} · ${p.name}` }))]}
        onChange={(v) => {
          if (!v) return;
          const pr = ARTBOARD_PRESETS.find((q) => q.name === v);
          if (!pr) return;
          const [w, h] = [pr.width, pr.height];
          const landscape = ab.width >= ab.height;
          const pw = landscape ? Math.max(w, h) : Math.min(w, h);
          const ph = landscape ? Math.min(w, h) : Math.max(w, h);
          update({ width: pw, height: ph }, 'Artboard Preset');
        }}
        width={170}
        id="artboard-preset"
      />
      <Segmented
        value={orientation}
        options={[
          { value: 'portrait', icon: <RectangleVertical size={13} />, title: 'Portrait' },
          { value: 'landscape', icon: <RectangleHorizontal size={13} />, title: 'Landscape' },
        ]}
        onChange={(v) => {
          if (v === orientation) return;
          update({ width: ab.height, height: ab.width }, 'Artboard Orientation');
        }}
      />
      <TextField label="Name" value={ab.name} onChange={() => undefined} onCommit={(v) => v.trim() && update({ name: v.trim() }, 'Rename Artboard')} width={130} id="artboard-name" />
      <NumberField label="W" value={ab.width} onChange={(v) => update({ width: Math.max(1, v) }, 'Resize Artboard')} min={1} unit={units} width={96} data-testid="artboard-w" />
      <NumberField label="H" value={ab.height} onChange={(v) => update({ height: Math.max(1, v) }, 'Resize Artboard')} min={1} unit={units} width={96} data-testid="artboard-h" />
      <Checkbox checked={!!opts.moveArtwork} onChange={(v) => set({ moveArtwork: v })} label="Move artwork with artboard" />
      <IconButton icon={<Plus size={14} />} title="New Artboard" onClick={() => runCommand('artboard.new')} data-testid="artboard-new" />
      <IconButton icon={<Copy size={14} />} title="Duplicate Artboard" onClick={() => runCommand('artboard.duplicate')} data-testid="artboard-duplicate" />
      <IconButton icon={<Trash2 size={14} />} title="Delete Artboard" disabled={artboards.length <= 1} onClick={() => runCommand('artboard.delete')} data-testid="artboard-delete" />
      <IconButton icon={<Maximize size={14} />} title="Fit to Artwork Bounds" onClick={() => runCommand('artboard.fitToArtwork')} />
      <Button small onClick={() => getState().openDialog('artboardOptions', { id: ab.id })} title="Artboard Options">
        <Settings2 size={13} />
        Options…
      </Button>
      <span className="muted small">
        {artboards.length} artboard{artboards.length === 1 ? '' : 's'}
      </span>
    </Row>
  );
}

void React;
