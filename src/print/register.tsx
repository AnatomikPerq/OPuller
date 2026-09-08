/**
 * Print module: document colour mode (File > Document Color Mode), bleed
 * guides on the canvas (View > Show Bleed) and helpers exposed for tests.
 */
import React from 'react';
import { registerCommands } from '@/commands/registry';
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { useStore, getState } from '@/store/store';
import type { ColorMode } from '@/model/types';
import { usePrintStore } from './store';
import { printerMarksSvg, marksMargin, expandByBleed, anyMarks, bleedIsZero, DEFAULT_MARKS, NO_MARKS } from './marks';
import { hexToCmyk, cmykToHex, roundToInks } from '@/color/globals';
import './print.css';

export function setDocumentColorMode(mode: ColorMode): void {
  const s = getState();
  if (s.doc.colorMode === mode) return;
  s.updateDoc((d) => {
    d.colorMode = mode;
    if (mode === 'cmyk') {
      // remember ink values for solid swatches so they show clean numbers
      for (const sw of d.swatches) if (sw.paint.type === 'solid' && !sw.cmyk) sw.cmyk = hexToCmyk(sw.paint.color);
    }
  }, mode === 'cmyk' ? 'Convert to CMYK' : 'Convert to RGB');
  s.toast(mode === 'cmyk' ? 'Document colour mode: CMYK (colours are edited as inks)' : 'Document colour mode: RGB', 'info');
}

registerCommands([
  { id: 'file.colorMode.rgb', label: 'RGB Color', menu: 'File/Document Color Mode', order: 41, run: () => setDocumentColorMode('rgb'), checked: (s) => s.doc.colorMode === 'rgb' },
  { id: 'file.colorMode.cmyk', label: 'CMYK Color', menu: 'File/Document Color Mode', order: 41.1, run: () => setDocumentColorMode('cmyk'), checked: (s) => s.doc.colorMode === 'cmyk' },
  {
    id: 'view.showBleed',
    label: 'Show Bleed',
    menu: 'View',
    order: 66,
    run: () => usePrintStore.getState().setShowBleed(!usePrintStore.getState().showBleed),
    checked: () => usePrintStore.getState().showBleed,
    enabled: (s) => !bleedIsZero(s.doc.bleed),
  },
]);

/** Red bleed guides around every artboard (screen space overlay). */
function BleedOverlay() {
  const artboards = useStore((s) => s.doc.artboards);
  const bleed = useStore((s) => s.doc.bleed);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const showArtboards = useStore((s) => s.view.showArtboards);
  const show = usePrintStore((s) => s.showBleed);
  if (!show || !showArtboards || bleedIsZero(bleed)) return null;
  return (
    <g className="bleed-guides" pointerEvents="none" data-testid="bleed-guides">
      {artboards.map((a) => {
        const r = expandByBleed(a, bleed);
        return <rect key={a.id} x={r.x * zoom + pan.x + 0.5} y={r.y * zoom + pan.y + 0.5} width={r.width * zoom} height={r.height * zoom} fill="none" stroke="#e5484d" strokeWidth={1} strokeDasharray="4 3" />;
      })}
    </g>
  );
}

registerViewportSlot('overlay', 'print-bleed', BleedOverlay);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  print: { printerMarksSvg, marksMargin, expandByBleed, anyMarks, bleedIsZero, DEFAULT_MARKS, NO_MARKS, setDocumentColorMode, hexToCmyk, cmykToHex, roundToInks, store: usePrintStore },
};

void React;
