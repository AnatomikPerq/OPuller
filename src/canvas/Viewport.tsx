/**
 * The canvas viewport: renders the document, artboards, grid, guides and the
 * screen-space overlay; routes pointer events to the active tool.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useStore, getState, screenToWorld } from '@/store/store';
import { LiveDocument } from './Renderer';
import { SelectionOverlay } from './SelectionOverlay';
import { Ruler, RULER_SIZE } from './Rulers';
import { useOverlayStore } from './overlayStore';
import { toolContext, setCaptureImpl } from './toolContext';
import { getTool } from '@/tools/registry';
import type { Tool, ToolPointerEvent } from '@/tools/types';
import { IS_MAC } from '@/util/keys';
import { getViewportSlots, onSlotsChanged, buildContextMenu } from './viewportSlots';
import type { ID } from '@/model/types';

function makePointerEvent(e: PointerEvent | React.PointerEvent, el: HTMLElement): ToolPointerEvent {
  const r = el.getBoundingClientRect();
  const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
  const native = ('nativeEvent' in e ? e.nativeEvent : e) as PointerEvent;
  return {
    world: screenToWorld(screen),
    screen,
    button: e.button,
    buttons: e.buttons,
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    primary: IS_MAC ? e.metaKey : e.ctrlKey,
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    pressure: (e as PointerEvent).pressure ?? 0.5,
    native,
  };
}

export function currentTool(): Tool | undefined {
  const s = getState();
  return getTool(s.temporaryTool ?? s.activeTool);
}

export function Viewport() {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const size = useStore((s) => s.viewportSize);
  const view = useStore((s) => s.view);
  const cursor = useStore((s) => s.cursor);
  const canvasColor = useStore((s) => s.prefs.canvasColor);
  const rulers = view.rulers;
  const activeToolId = useStore((s) => s.temporaryTool ?? s.activeTool);
  const editingTextId = useStore((s) => s.editingTextId);
  const setViewportSize = useStore((s) => s.setViewportSize);

  // --- sizing -------------------------------------------------------------
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setViewportSize(Math.round(r.width), Math.round(r.height));
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setViewportSize(Math.round(r.width), Math.round(r.height));
    return () => ro.disconnect();
  }, [setViewportSize]);

  // --- pointer capture impl ----------------------------------------------
  useEffect(() => {
    setCaptureImpl((pointerId) => {
      try {
        innerRef.current?.setPointerCapture(pointerId);
      } catch {
        /* ignore */
      }
    });
    return () => setCaptureImpl(null);
  }, []);

  // --- tool activation / cursor -------------------------------------------
  useEffect(() => {
    const tool = getTool(activeToolId);
    getState().setCursor(tool?.getCursor?.(toolContext) ?? tool?.cursor ?? 'default');
    tool?.activate?.(toolContext);
    return () => {
      tool?.deactivate?.(toolContext);
      useOverlayStore.getState().setSnap(null);
      useOverlayStore.getState().setMarquee(null);
      useOverlayStore.getState().setHud(null);
    };
  }, [activeToolId]);

  // --- wheel: zoom / pan --------------------------------------------------
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = getState();
      const r = el.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        dx *= r.width;
        dy *= r.height;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const factor = Math.exp(-dy * (e.ctrlKey && !e.altKey ? 0.01 : 0.002));
        s.setZoom(s.zoom * factor, screen);
      } else if (e.shiftKey && Math.abs(dx) < 1) {
        s.panBy(-dy, 0);
      } else {
        s.panBy(-dx, -dy);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- pointer handling ---------------------------------------------------
  const drag = useRef<{ kind: 'pan' | 'guide' | 'tool'; pointerId: number; last: { x: number; y: number }; guideId?: ID; startPos?: number } | null>(null);

  const guideNear = useCallback((screen: { x: number; y: number }): ID | null => {
    const s = getState();
    if (!s.view.guides || s.view.lockGuides) return null;
    for (const g of s.doc.guides) {
      if (g.locked) continue;
      const sp = g.axis === 'x' ? g.position * s.zoom + s.pan.x : g.position * s.zoom + s.pan.y;
      const d = g.axis === 'x' ? Math.abs(screen.x - sp) : Math.abs(screen.y - sp);
      if (d <= 4) return g.id;
    }
    return null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const el = innerRef.current;
      if (!el) return;
      // ignore events from HTML overlays (e.g. text editor)
      if ((e.target as HTMLElement).closest?.('[data-viewport-html]')) return;
      el.focus({ preventScroll: true });
      const ev = makePointerEvent(e, el);
      const s = getState();
      if (e.button === 1 || (s.temporaryTool === 'hand' && e.button === 0)) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        drag.current = { kind: 'pan', pointerId: e.pointerId, last: ev.screen };
        s.setCursor('grabbing');
        return;
      }
      if (e.button === 2) return; // context menu
      const toolId = s.temporaryTool ?? s.activeTool;
      if (e.button === 0 && (toolId === 'select' || toolId === 'direct') && !s.editingTextId) {
        const gid = guideNear(ev.screen);
        if (gid) {
          el.setPointerCapture(e.pointerId);
          const g = s.doc.guides.find((x) => x.id === gid)!;
          drag.current = { kind: 'guide', pointerId: e.pointerId, last: ev.screen, guideId: gid, startPos: g.position };
          return;
        }
      }
      const tool = getTool(toolId);
      drag.current = { kind: 'tool', pointerId: e.pointerId, last: ev.screen };
      el.setPointerCapture(e.pointerId);
      tool?.onPointerDown?.(ev, toolContext);
    },
    [guideNear],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const el = innerRef.current;
      if (!el) return;
      if ((e.target as HTMLElement).closest?.('[data-viewport-html]') && !drag.current) return;
      const ev = makePointerEvent(e, el);
      const s = getState();
      const d = drag.current;
      if (d && d.kind === 'pan') {
        s.panBy(ev.screen.x - d.last.x, ev.screen.y - d.last.y);
        d.last = ev.screen;
        return;
      }
      if (d && d.kind === 'guide') {
        const g = s.doc.guides.find((x) => x.id === d.guideId);
        if (g) {
          const pos = g.axis === 'x' ? ev.world.x : ev.world.y;
          const snapped = s.view.snapToPixel ? Math.round(pos) : pos;
          s.updateDoc((doc) => {
            const gg = doc.guides.find((x) => x.id === d.guideId);
            if (gg) gg.position = snapped;
          });
        }
        return;
      }
      const tool = getTool(s.temporaryTool ?? s.activeTool);
      if (!d && (s.activeTool === 'select' || s.activeTool === 'direct') && !s.temporaryTool) {
        const gid = guideNear(ev.screen);
        if (gid) {
          const g = s.doc.guides.find((x) => x.id === gid)!;
          s.setCursor(g.axis === 'x' ? 'ew-resize' : 'ns-resize');
          return;
        }
      }
      tool?.onPointerMove?.(ev, toolContext);
    },
    [guideNear],
  );

  const endGesture = useCallback((e: React.PointerEvent | PointerEvent, cancelled = false) => {
    const el = innerRef.current;
    if (!el) return;
    const d = drag.current;
    const ev = makePointerEvent(e, el);
    const s = getState();
    if (d && d.kind === 'pan') {
      drag.current = null;
      const tool = getTool(s.temporaryTool ?? s.activeTool);
      s.setCursor(s.temporaryTool === 'hand' ? 'grab' : (tool?.getCursor?.(toolContext) ?? tool?.cursor ?? 'default'));
      return;
    }
    if (d && d.kind === 'guide') {
      drag.current = null;
      const outside = ev.screen.x < 0 || ev.screen.y < 0;
      if (outside) {
        s.updateDoc((doc) => {
          doc.guides = doc.guides.filter((g) => g.id !== d.guideId);
        }, 'Delete Guide');
      } else s.commit('Move Guide');
      return;
    }
    drag.current = null;
    const tool = getTool(s.temporaryTool ?? s.activeTool);
    if (cancelled) tool?.cancel?.(toolContext);
    tool?.onPointerUp?.(ev, toolContext);
    try {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.button === 2 && !drag.current) return;
    endGesture(e);
  }, [endGesture]);

  const onPointerCancel = useCallback((e: React.PointerEvent) => endGesture(e, true), [endGesture]);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const el = innerRef.current;
    if (!el) return;
    if ((e.target as HTMLElement).closest?.('[data-viewport-html]')) return;
    const tool = currentTool();
    const pe = e as unknown as React.PointerEvent;
    const ev = makePointerEvent({ ...pe, pointerId: 0, pointerType: 'mouse', pressure: 0.5, nativeEvent: e.nativeEvent } as unknown as React.PointerEvent, el);
    tool?.onDoubleClick?.(ev, toolContext);
  }, []);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = innerRef.current;
    if (!el) return;
    if ((e.target as HTMLElement).closest?.('[data-viewport-html]')) return;
    const r = el.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world = screenToWorld(screen);
    const s = getState();
    const hit = toolContext.hitTest(world);
    if (hit && !s.selection.includes(hit.target)) s.setSelection([hit.target]);
    const items = buildContextMenu(hit, world);
    if (items.length) s.openContextMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  // --- derived visuals ----------------------------------------------------
  const worldTransform = `matrix(${zoom} 0 0 ${zoom} ${pan.x} ${pan.y})`;
  // nodes hidden from the live render (modules may hide nodes they draw themselves)
  const hiddenIds = useOverlayStore((s) => s.hiddenNodes);
  const hidden = useMemo(() => (hiddenIds && hiddenIds.length ? new Set(hiddenIds) : undefined), [hiddenIds]);
  void editingTextId;

  const slots = useSyncExternalStore(onSlotsChanged, () => getViewportSlots('overlay'), () => getViewportSlots('overlay'));
  const htmlSlots = useSyncExternalStore(onSlotsChanged, () => getViewportSlots('html'), () => getViewportSlots('html'));

  return (
    <div className={`viewport ${rulers ? 'with-rulers' : ''}`} ref={outerRef} style={{ background: canvasColor }}>
      {rulers && (
        <>
          <div className="ruler-corner" title="Rulers origin" onDoubleClick={() => getState().setPrefs({ units: 'px' })} />
          <div className="ruler-h-wrap">
            <Ruler orientation="h" viewportRef={innerRef} />
          </div>
          <div className="ruler-v-wrap">
            <Ruler orientation="v" viewportRef={innerRef} />
          </div>
        </>
      )}
      <div
        className="viewport-inner"
        ref={innerRef}
        tabIndex={0}
        style={{ cursor, left: rulers ? RULER_SIZE : 0, top: rulers ? RULER_SIZE : 0 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={(e) => {
          if (drag.current && drag.current.pointerId === e.pointerId) endGesture(e, false);
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        data-testid="viewport"
      >
        <svg className="canvas-svg" width={size.width} height={size.height} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="vp-checker" width={16} height={16} patternUnits="userSpaceOnUse">
              <rect width={16} height={16} fill="#ffffff" />
              <rect width={8} height={8} fill="#d8d8d8" />
              <rect x={8} y={8} width={8} height={8} fill="#d8d8d8" />
            </pattern>
          </defs>
          <ArtboardBackgrounds />
          {view.grid && <GridLayer />}
          <g transform={worldTransform} className="document-layer">
            <LiveDocument outline={view.outline} hidden={hidden} />
          </g>
          <ArtboardOutlines />
        </svg>
        <svg className="overlay-svg" width={size.width} height={size.height} xmlns="http://www.w3.org/2000/svg">
          <GuidesLayer />
          <ArtboardLabels />
          <SelectionOverlay />
          <ToolOverlay />
          <SnapOverlay />
          <MarqueeOverlay />
          {slots.map((s) => (
            <s.component key={s.id} />
          ))}
          <HudOverlay />
        </svg>
        {htmlSlots.map((s) => (
          <s.component key={s.id} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub layers
// ---------------------------------------------------------------------------

function ArtboardBackgrounds() {
  const artboards = useStore((s) => s.doc.artboards);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const showArtboards = useStore((s) => s.view.showArtboards);
  const transparencyGrid = useStore((s) => s.view.transparencyGrid);
  const outline = useStore((s) => s.view.outline);
  if (!showArtboards) return null;
  return (
    <g className="artboards">
      {artboards.map((a) => {
        const x = a.x * zoom + pan.x;
        const y = a.y * zoom + pan.y;
        const w = a.width * zoom;
        const h = a.height * zoom;
        const useChecker = a.transparent && transparencyGrid;
        return (
          <g key={a.id}>
            {!outline && <rect x={x + 3} y={y + 3} width={w} height={h} fill="rgba(0,0,0,0.35)" />}
            <rect x={x} y={y} width={w} height={h} fill={outline ? '#ffffff' : useChecker ? 'url(#vp-checker)' : a.transparent ? '#ffffff' : a.background} />
          </g>
        );
      })}
    </g>
  );
}

function ArtboardOutlines() {
  const artboards = useStore((s) => s.doc.artboards);
  const active = useStore((s) => s.activeArtboardId);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const showArtboards = useStore((s) => s.view.showArtboards);
  if (!showArtboards) return null;
  return (
    <g className="artboard-outlines" pointerEvents="none">
      {artboards.map((a) => (
        <rect
          key={a.id}
          x={a.x * zoom + pan.x + 0.5}
          y={a.y * zoom + pan.y + 0.5}
          width={a.width * zoom}
          height={a.height * zoom}
          fill="none"
          stroke={a.id === active ? '#7a1f3d' : '#5a5a60'}
          strokeWidth={a.id === active ? 1.5 : 1}
        />
      ))}
    </g>
  );
}

function ArtboardLabels() {
  const artboards = useStore((s) => s.doc.artboards);
  const active = useStore((s) => s.activeArtboardId);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const showArtboards = useStore((s) => s.view.showArtboards);
  if (!showArtboards) return null;
  return (
    <g className="artboard-labels">
      {artboards.map((a, i) => (
        <text
          key={a.id}
          x={a.x * zoom + pan.x}
          y={a.y * zoom + pan.y - 6}
          fill={a.id === active ? '#c9a0b0' : '#9a9aa0'}
          fontSize={11}
          fontFamily="Inter, system-ui, sans-serif"
          style={{ cursor: 'pointer', userSelect: 'none' }}
          pointerEvents="all"
          onPointerDown={(e) => {
            e.stopPropagation();
            getState().setActiveArtboard(a.id);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            getState().zoomToRect(a);
          }}
        >
          {i + 1}. {a.name}
        </text>
      ))}
    </g>
  );
}

function GridLayer() {
  const grid = useStore((s) => s.doc.grid);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const size = useStore((s) => s.viewportSize);
  const major = grid.size * zoom;
  if (major < 4) return null;
  const minor = major / Math.max(1, grid.subdivisions);
  const showMinor = minor >= 5;
  const ox = ((pan.x % major) + major) % major;
  const oy = ((pan.y % major) + major) % major;
  const lines: React.ReactNode[] = [];
  if (showMinor) {
    const d: string[] = [];
    for (let x = ox - major; x < size.width + major; x += minor) d.push(`M${Math.round(x) + 0.5} 0V${size.height}`);
    for (let y = oy - major; y < size.height + major; y += minor) d.push(`M0 ${Math.round(y) + 0.5}H${size.width}`);
    lines.push(<path key="minor" d={d.join('')} stroke={grid.color} strokeOpacity={0.18} strokeWidth={1} />);
  }
  const dM: string[] = [];
  for (let x = ox - major; x < size.width + major; x += major) dM.push(`M${Math.round(x) + 0.5} 0V${size.height}`);
  for (let y = oy - major; y < size.height + major; y += major) dM.push(`M0 ${Math.round(y) + 0.5}H${size.width}`);
  lines.push(<path key="major" d={dM.join('')} stroke={grid.color} strokeOpacity={0.4} strokeWidth={1} />);
  if (grid.style === 'dots') {
    return (
      <g className="grid" pointerEvents="none">
        {dM.length > 0 && <path d={dM.join('')} stroke={grid.color} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="1 4" />}
      </g>
    );
  }
  return (
    <g className="grid" pointerEvents="none">
      {lines}
    </g>
  );
}

function GuidesLayer() {
  const guides = useStore((s) => s.doc.guides);
  const show = useStore((s) => s.view.guides);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const size = useStore((s) => s.viewportSize);
  const dragGuide = useOverlayStore((s) => s.dragGuide);
  if (!show && !dragGuide) return null;
  const render = (axis: 'x' | 'y', position: number, key: string, color: string) => {
    if (axis === 'x') {
      const x = Math.round(position * zoom + pan.x) + 0.5;
      return <line key={key} x1={x} y1={0} x2={x} y2={size.height} stroke={color} strokeWidth={1} />;
    }
    const y = Math.round(position * zoom + pan.y) + 0.5;
    return <line key={key} x1={0} y1={y} x2={size.width} y2={y} stroke={color} strokeWidth={1} />;
  };
  return (
    <g className="guides" pointerEvents="none">
      {show && guides.map((g) => render(g.axis, g.position, g.id, '#00c8ff'))}
      {dragGuide && render(dragGuide.axis, dragGuide.position, 'drag', '#ff9d00')}
    </g>
  );
}

function SnapOverlay() {
  const snap = useOverlayStore((s) => s.snap);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const size = useStore((s) => s.viewportSize);
  if (!snap) return null;
  const toS = (v: number, axis: 'x' | 'y') => v * zoom + (axis === 'x' ? pan.x : pan.y);
  return (
    <g className="snap" pointerEvents="none">
      {snap.lines.map((l, i) => {
        if (l.kind === 'v') {
          const x = Math.round(toS(l.position, 'x')) + 0.5;
          return <line key={i} x1={x} y1={Math.max(0, toS(l.from, 'y') - 20)} x2={x} y2={Math.min(size.height, toS(l.to, 'y') + 20)} stroke="#ff2ea6" strokeWidth={1} />;
        }
        const y = Math.round(toS(l.position, 'y')) + 0.5;
        return <line key={i} x1={Math.max(0, toS(l.from, 'x') - 20)} y1={y} x2={Math.min(size.width, toS(l.to, 'x') + 20)} y2={y} stroke="#ff2ea6" strokeWidth={1} />;
      })}
      {snap.points.map((p, i) => (
        <g key={'p' + i}>
          <circle cx={toS(p.x, 'x')} cy={toS(p.y, 'y')} r={4} fill="none" stroke="#ff2ea6" strokeWidth={1.5} />
        </g>
      ))}
      {snap.label && (
        <text x={toS(snap.point.x, 'x') + 10} y={toS(snap.point.y, 'y') - 8} fontSize={10} fill="#ff2ea6" fontFamily="Inter, system-ui, sans-serif">
          {snap.label}
        </text>
      )}
    </g>
  );
}

function MarqueeOverlay() {
  const m = useOverlayStore((s) => s.marquee);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  if (!m) return null;
  return (
    <rect
      x={m.x * zoom + pan.x}
      y={m.y * zoom + pan.y}
      width={m.width * zoom}
      height={m.height * zoom}
      fill="rgba(74,144,226,0.12)"
      stroke="#4a90e2"
      strokeWidth={1}
      pointerEvents="none"
    />
  );
}

function HudOverlay() {
  const hud = useOverlayStore((s) => s.hud);
  if (!hud) return null;
  const lines = hud.text.split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * 6.4 + 12;
  return (
    <g transform={`translate(${hud.screen.x + 14} ${hud.screen.y + 14})`} pointerEvents="none">
      <rect x={0} y={0} width={w} height={lines.length * 14 + 6} rx={3} fill="rgba(20,20,22,0.9)" stroke="#555" />
      {lines.map((l, i) => (
        <text key={i} x={6} y={13 + i * 14} fontSize={11} fill="#eee" fontFamily="Inter, system-ui, sans-serif">
          {l}
        </text>
      ))}
    </g>
  );
}

function ToolOverlay() {
  // re-render on any relevant change
  useStore((s) => s.overlayTick);
  useStore((s) => s.zoom);
  useStore((s) => s.pan);
  useStore((s) => s.docVersion);
  useStore((s) => s.selection);
  useStore((s) => s.selectedAnchors);
  const toolId = useStore((s) => s.temporaryTool ?? s.activeTool);
  const tool = getTool(toolId);
  const [, force] = useState(0);
  useEffect(() => {
    force((n) => n + 1);
  }, [toolId]);
  if (!tool?.renderOverlay) return null;
  return <g className="tool-overlay">{tool.renderOverlay(toolContext)}</g>;
}
