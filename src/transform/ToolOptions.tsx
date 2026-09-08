/**
 * Shared control-bar pieces for the transform tools.
 */
import React from 'react';
import { Crosshair, SlidersHorizontal } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { Button, IconButton } from '@/ui/widgets';
import { selectionBounds } from '@/model/document';
import { useTransformStore } from './store';
import { transformTargets } from './apply';
import { currentPivot, resetToolPivot, selectionKey } from './gesture';
import { formatLength } from '@/util/units';
import type { Vec } from '@/model/types';

/** Reactive pivot of the transform tools for the current selection. */
export function useToolPivot(): { pivot: Vec | null; custom: boolean; ids: string[] } {
  const selection = useStore((s) => s.selection);
  useStore((s) => s.docVersion);
  const toolPivot = useTransformStore((s) => s.toolPivot);
  const s = getState();
  const ids = transformTargets(s, selection);
  const pivot = currentPivot(s, ids);
  const custom = !!toolPivot && toolPivot.selectionKey === selectionKey(ids);
  void selectionBounds;
  return { pivot, custom, ids };
}

export function PivotInfo({ dialog }: { dialog: string }) {
  const { pivot, custom, ids } = useToolPivot();
  const units = useStore((s) => s.prefs.units);
  const openDialog = useStore((s) => s.openDialog);
  return (
    <>
      <span className="muted" title="Reference point (click on the canvas to move it)" data-testid="pivot-info">
        {pivot ? `Ref: ${formatLength(pivot.x, units)}, ${formatLength(pivot.y, units)}` : 'No selection'}
      </span>
      <IconButton icon={<Crosshair size={14} />} title="Reset reference point to the selection center" disabled={!custom} onClick={() => resetToolPivot()} data-testid="pivot-reset" />
      <Button small disabled={!ids.length} onClick={() => openDialog(dialog, pivot ? { pivot } : {})} title="Open the dialog (Enter / Alt-click)" data-testid="tool-dialog-btn">
        <SlidersHorizontal size={12} /> Options…
      </Button>
    </>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span className="hint dim small" style={{ whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}
