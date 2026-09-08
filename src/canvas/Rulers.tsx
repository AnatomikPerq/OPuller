import React, { useEffect, useRef } from 'react';
import { useStore, getState } from '@/store/store';
import { rulerStep, pxToUnit, trimZeros } from '@/util/units';
import { useOverlayStore } from './overlayStore';
import { newId } from '@/model/nodes';

export const RULER_SIZE = 20;

interface Props {
  orientation: 'h' | 'v';
  /** ref to the viewport inner element for converting pointer coords */
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

export function Ruler({ orientation, viewportRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const size = useStore((s) => s.viewportSize);
  const units = useStore((s) => s.prefs.units);
  const theme = useStore((s) => s.prefs.theme);
  const activeArtboardId = useStore((s) => s.activeArtboardId);
  const artboards = useStore((s) => s.doc.artboards);
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const length = orientation === 'h' ? size.width : size.height;
    canvas.width = Math.max(1, Math.round(length * dpr));
    canvas.height = Math.round(RULER_SIZE * dpr);
    canvas.style.width = `${length}px`;
    canvas.style.height = `${RULER_SIZE}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = theme === 'dark';
    ctx.fillStyle = dark ? '#2b2b2e' : '#f0f0f2';
    ctx.fillRect(0, 0, length, RULER_SIZE);
    // origin = active artboard top-left (Illustrator style)
    const ab = artboards.find((a) => a.id === activeArtboardId) ?? artboards[0];
    const origin = ab ? (orientation === 'h' ? ab.x : ab.y) : 0;
    const panV = orientation === 'h' ? pan.x : pan.y;
    const { major, minor } = rulerStep(zoom, units);
    const worldStart = (0 - panV) / zoom - origin;
    const worldEnd = (length - panV) / zoom - origin;
    // selection highlight
    if (selection.length) {
      const st = getState();
      const b = st.selection.length ? require_selection_bounds(st) : null;
      if (b) {
        const a = orientation === 'h' ? b.x : b.y;
        const bb = orientation === 'h' ? b.x + b.width : b.y + b.height;
        const sa = a * zoom + panV;
        const sb = bb * zoom + panV;
        ctx.fillStyle = dark ? 'rgba(122,31,61,0.55)' : 'rgba(122,31,61,0.25)';
        if (orientation === 'h') ctx.fillRect(sa, 0, sb - sa, RULER_SIZE);
        else ctx.fillRect(0, sa, RULER_SIZE, sb - sa);
      }
    }
    ctx.strokeStyle = dark ? '#8a8a90' : '#666';
    ctx.fillStyle = dark ? '#c9c9cf' : '#333';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    const first = Math.floor(worldStart / minor) * minor;
    ctx.beginPath();
    for (let w = first; w <= worldEnd; w += minor) {
      const isMajor = Math.abs(w / major - Math.round(w / major)) < 1e-6;
      const isMid = !isMajor && Math.abs((w / minor) % 5) < 1e-6 && minor * 5 < major;
      const s = Math.round((w + origin) * zoom + panV) + 0.5;
      const len = isMajor ? RULER_SIZE : isMid ? 8 : 5;
      if (orientation === 'h') {
        ctx.moveTo(s, RULER_SIZE);
        ctx.lineTo(s, RULER_SIZE - len);
      } else {
        ctx.moveTo(RULER_SIZE, s);
        ctx.lineTo(RULER_SIZE - len, s);
      }
      if (isMajor) {
        const label = trimZeros(pxToUnit(w, units).toFixed(2));
        if (orientation === 'h') ctx.fillText(label, s + 3, 2);
        else {
          ctx.save();
          ctx.translate(2, s + 3);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = 'right';
          ctx.fillText(label, 0, 0);
          ctx.restore();
        }
      }
    }
    ctx.stroke();
    // bottom/right edge line
    ctx.strokeStyle = dark ? '#3c3c40' : '#c8c8cc';
    ctx.beginPath();
    if (orientation === 'h') {
      ctx.moveTo(0, RULER_SIZE - 0.5);
      ctx.lineTo(length, RULER_SIZE - 0.5);
    } else {
      ctx.moveTo(RULER_SIZE - 0.5, 0);
      ctx.lineTo(RULER_SIZE - 0.5, length);
    }
    ctx.stroke();
  }, [zoom, pan, size, units, theme, orientation, activeArtboardId, artboards, selection, docVersion]);

  // Drag from the ruler to create a guide
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = getState();
    if (st.view.lockGuides) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const axis = orientation === 'h' ? 'y' : 'x';
    const move = (ev: PointerEvent) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const r = vp.getBoundingClientRect();
      const s = getState();
      const pos = axis === 'y' ? (ev.clientY - r.top - s.pan.y) / s.zoom : (ev.clientX - r.left - s.pan.x) / s.zoom;
      const inside = axis === 'y' ? ev.clientY > r.top : ev.clientX > r.left;
      useOverlayStore.getState().setDragGuide(inside ? { axis, position: s.view.snapToPixel ? Math.round(pos) : pos } : null);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const g = useOverlayStore.getState().dragGuide;
      useOverlayStore.getState().setDragGuide(null);
      if (g) {
        const s = getState();
        s.updateDoc((d) => {
          d.guides.push({ id: newId(), axis: g.axis, position: g.position });
        }, 'Add Guide');
        if (!s.view.guides) s.setView({ guides: true });
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onDoubleClick = () => {
    // double-click a ruler: toggle units
    const st = getState();
    const order: Array<typeof st.prefs.units> = ['px', 'pt', 'mm', 'cm', 'in'];
    st.setPrefs({ units: order[(order.indexOf(st.prefs.units) + 1) % order.length] });
  };

  return (
    <canvas
      ref={canvasRef}
      className={`ruler ruler-${orientation}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title="Drag to create a guide. Double-click to change units."
    />
  );
}

// Lazy import to avoid a circular dependency at module init
import { selectionBounds } from '@/model/document';
function require_selection_bounds(st: ReturnType<typeof getState>) {
  return selectionBounds(st.doc, st.selection);
}
