/**
 * Gradient tool viewport slot: the stop colour popover opened by double-clicking
 * a stop marker on the annotator.
 */
import React, { useEffect, useState } from 'react';
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { useStore, getState } from '@/store/store';
import { useCurrentAppearance, setActivePaint } from '@/commands/appearance';
import { activeSolid, withActiveColor } from '@/color/paint';
import { SolidColorPopover } from '@/ui/panels/color/shared';
import { useGradientToolStore } from './state';
import './gradient-tool.css';

function GradientStopPopover() {
  const popover = useGradientToolStore((s) => s.popover);
  const setPopover = useGradientToolStore((s) => s.setPopover);
  const activeTool = useStore((s) => s.activeTool);
  const target = useStore((s) => s.activePaintTarget);
  const app = useCurrentAppearance();
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeTool !== 'gradient' && popover) setPopover(null);
  }, [activeTool, popover, setPopover]);
  if (!popover || activeTool !== 'gradient') return null;
  const paint = target === 'fill' ? app.fill : app.stroke.paint;
  if (paint.type !== 'linear' && paint.type !== 'radial' && paint.type !== 'freeform' && paint.type !== 'mesh') return null;
  const stop = activeSolid(paint, popover.index);
  const what = paint.type === 'freeform' ? 'Freeform point' : paint.type === 'mesh' ? 'Mesh node' : 'Gradient stop';
  return (
    <>
      <div ref={setAnchor} className="gradient-stop-anchor" style={{ left: popover.screen.x, top: popover.screen.y }} data-viewport-html />
      {anchor && (
        <SolidColorPopover
          open
          anchor={anchor}
          color={{ type: 'solid', color: stop.color, opacity: stop.opacity }}
          title={`${what} ${popover.index + 1}`}
          onClose={() => setPopover(null)}
          onChange={(c) => setActivePaint(withActiveColor(paint, popover.index, { color: c.color, opacity: c.opacity }), false)}
          onCommit={() => getState().commit(target === 'fill' ? 'Gradient Fill' : 'Gradient Stroke')}
        />
      )}
    </>
  );
}

registerViewportSlot('html', 'gradient-stop-popover', GradientStopPopover);
