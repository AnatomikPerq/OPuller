import React, { useRef, useState } from 'react';
import { useStore, getState } from '@/store/store';
import { ColorPicker, paintCss } from './ColorPicker';
import { Popover, Tooltip } from './widgets';
import { useCurrentAppearance, setFillPaint, setStrokePaint, swapFillStroke, defaultFillStroke, setActivePaint } from '@/commands/appearance';
import { ArrowLeftRight, RotateCcw } from 'lucide-react';
import type { Paint } from '@/model/types';

function PaintPreview({ paint, stroke }: { paint: Paint; stroke?: boolean }) {
  if (paint.type === 'none') return <div className="none-mark" />;
  return <div className="paint-preview" style={{ background: paintCss(paint), opacity: paint.type === 'solid' ? paint.opacity : 1 }} />;
}

export function PaintIndicator({ compact }: { compact?: boolean }) {
  const app = useCurrentAppearance();
  const target = useStore((s) => s.activePaintTarget);
  const setTarget = useStore((s) => s.setActivePaintTarget);
  const [open, setOpen] = useState<'fill' | 'stroke' | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const strokeRef = useRef<HTMLDivElement>(null);
  const paint = target === 'fill' ? app.fill : app.stroke.paint;

  const onClick = (which: 'fill' | 'stroke') => {
    if (target === which && open === null) setOpen(which);
    else if (target === which) setOpen(null);
    else {
      setTarget(which);
      setOpen(null);
    }
  };
  const onDouble = (which: 'fill' | 'stroke') => {
    setTarget(which);
    setOpen(which);
  };

  return (
    <div className={`paint-indicator-wrap ${compact ? 'compact' : ''}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div className="paint-indicator" data-testid="paint-indicator">
        <div ref={fillRef} className={`swatch fill ${target === 'fill' ? 'active' : ''}`} title="Fill (X to toggle, double-click to edit)" onClick={() => onClick('fill')} onDoubleClick={() => onDouble('fill')} data-testid="fill-swatch">
          <PaintPreview paint={app.fill} />
          {app.mixedFill && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 10, color: '#fff', textShadow: '0 0 2px #000' }}>?</span>}
        </div>
        <div ref={strokeRef} className={`swatch stroke ${target === 'stroke' ? 'active' : ''}`} title="Stroke (X to toggle, double-click to edit)" onClick={() => onClick('stroke')} onDoubleClick={() => onDouble('stroke')} data-testid="stroke-swatch">
          <PaintPreview paint={app.stroke.paint} stroke />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <Tooltip text="Swap fill & stroke" shortcut="Shift+X">
          <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={swapFillStroke}>
            <ArrowLeftRight size={12} />
          </button>
        </Tooltip>
        <Tooltip text="Default fill & stroke" shortcut="D">
          <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={defaultFillStroke}>
            <RotateCcw size={12} />
          </button>
        </Tooltip>
      </div>
      <div className="paint-mini">
        <button className="color" title="Color (,)" onClick={() => setActivePaint(paint.type === 'solid' ? paint : { type: 'solid', color: paint.type === 'linear' || paint.type === 'radial' ? paint.stops[0].color : '#7a1f3d', opacity: 1 })} />
        <button className="gradient" title="Gradient (.)" onClick={() => paint.type !== 'linear' && paint.type !== 'radial' && setActivePaint({ type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, spread: 'pad', stops: [{ offset: 0, color: paint.type === 'solid' ? paint.color : '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] })} />
        <button className="none" title="None (/)" onClick={() => setActivePaint({ type: 'none' })} />
      </div>
      <Popover open={open !== null} onClose={() => setOpen(null)} anchor={open === 'fill' ? fillRef.current : strokeRef.current} placement="right">
        <div className="section-title">{open === 'fill' ? 'Fill' : 'Stroke'}</div>
        <ColorPicker
          paint={open === 'fill' ? app.fill : app.stroke.paint}
          onChange={(p) => (open === 'fill' ? setFillPaint(p, false) : setStrokePaint(p, false))}
          onCommit={() => getState().commit(open === 'fill' ? 'Fill' : 'Stroke')}
        />
      </Popover>
    </div>
  );
}
