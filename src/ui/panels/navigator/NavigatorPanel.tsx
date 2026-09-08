/**
 * Navigator: thumbnail of all artboards & artwork with the current viewport
 * outlined in red; drag the rectangle or click to pan; zoom controls.
 */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { Document, Rect } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { StaticDocument } from '@/canvas/Renderer';
import { worldBounds } from '@/model/document';
import { rectUnion } from '@/geometry/vec';
import { IconButton, NumberField } from '@/ui/widgets';
import { zoomIn, zoomOut, fitAll } from '@/commands/viewCommands';
import './navigator.css';

const THROTTLE_MS = 250;
const MIN_LOG = Math.log2(0.01);
const MAX_LOG = Math.log2(64);

/** The document, updated at most 4 times per second. */
function useThrottledDoc(): Document {
  const docVersion = useStore((s) => s.docVersion);
  const [shown, setShown] = useState<Document>(() => getState().doc);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    const elapsed = now - last.current;
    const flush = () => {
      last.current = performance.now();
      timer.current = null;
      setShown(getState().doc);
    };
    if (elapsed >= THROTTLE_MS) flush();
    else if (timer.current === null) timer.current = window.setTimeout(flush, THROTTLE_MS - elapsed);
  }, [docVersion]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return shown;
}

function contentBounds(doc: Document): Rect {
  let r: Rect | null = null;
  for (const a of doc.artboards) r = rectUnion(r, { x: a.x, y: a.y, width: a.width, height: a.height });
  for (const l of doc.layers) r = rectUnion(r, worldBounds(doc, l));
  if (!r || !(r.width > 0 || r.height > 0)) r = { x: 0, y: 0, width: 1000, height: 1000 };
  const pad = Math.max(r.width, r.height) * 0.05;
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

const NavArtwork = memo(function NavArtwork({ doc }: { doc: Document }) {
  return (
    <g>
      {doc.artboards.map((a) => (
        <rect key={a.id} x={a.x} y={a.y} width={a.width} height={a.height} fill={a.transparent ? '#ffffff' : a.background} stroke="#00000055" vectorEffect="non-scaling-stroke" />
      ))}
      <StaticDocument doc={doc} prefix="nav-" exportMode={false} />
    </g>
  );
});

export function NavigatorPanel() {
  const doc = useThrottledDoc();
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const vsize = useStore((s) => s.viewportSize);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ offset: { x: number; y: number } } | null>(null);
  const vb = useMemo(() => contentBounds(doc), [doc]);

  const view: Rect = { x: -pan.x / zoom, y: -pan.y / zoom, width: vsize.width / zoom, height: vsize.height / zoom };

  const toWorld = (clientX: number, clientY: number) => {
    const el = svgRef.current!;
    const r = el.getBoundingClientRect();
    const scale = Math.min(r.width / vb.width, r.height / vb.height);
    const ox = (r.width - vb.width * scale) / 2;
    const oy = (r.height - vb.height * scale) / 2;
    return { x: vb.x + (clientX - r.left - ox) / scale, y: vb.y + (clientY - r.top - oy) / scale };
  };

  const centerOn = (cx: number, cy: number) => {
    const s = getState();
    s.setPan({ x: s.viewportSize.width / 2 - cx * s.zoom, y: s.viewportSize.height / 2 - cy * s.zoom });
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    const inside = p.x >= view.x && p.x <= view.x + view.width && p.y >= view.y && p.y <= view.y + view.height;
    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    if (inside) dragRef.current = { offset: { x: p.x - cx, y: p.y - cy } };
    else {
      dragRef.current = { offset: { x: 0, y: 0 } };
      centerOn(p.x, p.y);
    }
    svgRef.current?.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toWorld(e.clientX, e.clientY);
    centerOn(p.x - d.offset.x, p.y - d.offset.y);
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setDragging(false);
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const logZoom = Math.max(MIN_LOG, Math.min(MAX_LOG, Math.log2(zoom)));

  return (
    <div className="navigator-panel" data-testid="navigator-panel">
      <div className={`nav-thumb ${dragging ? 'dragging' : ''}`} data-testid="navigator-thumb">
        <svg
          ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
          preserveAspectRatio="xMidYMid meet"
          xmlns="http://www.w3.org/2000/svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => fitAll()}
        >
          <NavArtwork doc={doc} />
          <rect className="nav-view" x={view.x} y={view.y} width={view.width} height={view.height} data-testid="navigator-view" />
        </svg>
      </div>
      <div className="nav-controls">
        <IconButton icon={<ZoomOut size={14} />} title="Zoom out (Ctrl+-)" onClick={() => zoomOut()} data-testid="nav-zoom-out" />
        <input
          type="range"
          min={MIN_LOG}
          max={MAX_LOG}
          step={0.01}
          value={logZoom}
          onChange={(e) => getState().setZoom(Math.pow(2, Number(e.target.value)))}
          onKeyDown={(e) => e.stopPropagation()}
          title="Zoom"
          data-testid="nav-zoom-slider"
        />
        <IconButton icon={<ZoomIn size={14} />} title="Zoom in (Ctrl+=)" onClick={() => zoomIn()} data-testid="nav-zoom-in" />
        <NumberField value={Math.round(zoom * 1000) / 10} onChange={(v) => getState().setZoom(Math.max(1, Math.min(6400, v)) / 100)} min={1} max={6400} unit="%" decimals={0} width={72} scrub={false} data-testid="nav-zoom" />
        <IconButton icon={<Maximize2 size={13} />} title="Fit all in window (Ctrl+Alt+0)" onClick={() => fitAll()} />
      </div>
      <div className="nav-info">
        <span>
          {doc.artboards.length} artboard{doc.artboards.length === 1 ? '' : 's'}
        </span>
        <span>Drag the red frame or click to pan</span>
      </div>
    </div>
  );
}
