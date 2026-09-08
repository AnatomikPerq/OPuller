import { getState } from '@/store/store';
import { registerCommands } from './registry';
import { selectionBounds, worldBounds } from '@/model/document';
import { rectUnion } from '@/geometry/vec';
import { newId } from '@/model/nodes';

export function fitArtboard(): void {
  const s = getState();
  const ab = s.doc.artboards.find((a) => a.id === s.activeArtboardId) ?? s.doc.artboards[0];
  if (ab) s.zoomToRect(ab, 40);
}

export function fitAll(): void {
  const s = getState();
  let r: ReturnType<typeof selectionBounds> = null;
  for (const a of s.doc.artboards) r = rectUnion(r, a);
  for (const l of s.doc.layers) r = rectUnion(r, worldBounds(s.doc, l));
  if (r) s.zoomToRect(r, 40);
}

export function fitSelection(): void {
  const s = getState();
  const b = selectionBounds(s.doc, s.selection);
  if (b) s.zoomToRect(b, 80);
}

const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.66, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64];

export function zoomIn(): void {
  const s = getState();
  const next = ZOOM_STEPS.find((z) => z > s.zoom + 1e-6) ?? 64;
  s.setZoom(next);
}

export function zoomOut(): void {
  const s = getState();
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < s.zoom - 1e-6) ?? 0.05;
  s.setZoom(prev);
}

registerCommands([
  { id: 'view.zoomIn', label: 'Zoom In', menu: 'View', shortcut: ['mod+=', 'mod+shift+='], order: 10, run: zoomIn },
  { id: 'view.zoomOut', label: 'Zoom Out', menu: 'View', shortcut: 'mod+-', order: 11, run: zoomOut },
  { id: 'view.fitArtboard', label: 'Fit Artboard in Window', menu: 'View', shortcut: 'mod+0', order: 12, run: fitArtboard },
  { id: 'view.fitAll', label: 'Fit All in Window', menu: 'View', shortcut: 'mod+alt+0', order: 13, run: fitAll },
  { id: 'view.fitSelection', label: 'Fit Selection in Window', menu: 'View', shortcut: 'mod+shift+0', order: 14, run: fitSelection, enabled: (s) => s.selection.length > 0 },
  { id: 'view.actualSize', label: 'Actual Size (100%)', menu: 'View', shortcut: 'mod+1', order: 15, run: () => getState().setZoom(1) },
  {
    id: 'view.outline',
    label: 'Outline Mode',
    menu: 'View',
    shortcut: 'mod+y',
    order: 30,
    separatorBefore: true,
    run: () => getState().setView({ outline: !getState().view.outline }),
    checked: (s) => s.view.outline,
  },
  {
    id: 'view.rulers',
    label: 'Show Rulers',
    menu: 'View',
    shortcut: 'mod+r',
    order: 40,
    separatorBefore: true,
    run: () => getState().setView({ rulers: !getState().view.rulers }),
    checked: (s) => s.view.rulers,
  },
  {
    id: 'view.grid',
    label: 'Show Grid',
    menu: 'View',
    shortcut: "mod+'",
    order: 41,
    run: () => getState().setView({ grid: !getState().view.grid }),
    checked: (s) => s.view.grid,
  },
  {
    id: 'view.snapGrid',
    label: 'Snap to Grid',
    menu: 'View',
    shortcut: "mod+shift+'",
    order: 42,
    run: () => getState().setView({ snapToGrid: !getState().view.snapToGrid }),
    checked: (s) => s.view.snapToGrid,
  },
  {
    id: 'view.guides',
    label: 'Show Guides',
    menu: 'View',
    shortcut: 'mod+;',
    order: 50,
    separatorBefore: true,
    run: () => getState().setView({ guides: !getState().view.guides }),
    checked: (s) => s.view.guides,
  },
  {
    id: 'view.lockGuides',
    label: 'Lock Guides',
    menu: 'View',
    shortcut: 'mod+alt+;',
    order: 51,
    run: () => getState().setView({ lockGuides: !getState().view.lockGuides }),
    checked: (s) => s.view.lockGuides,
  },
  {
    id: 'view.clearGuides',
    label: 'Clear Guides',
    menu: 'View',
    order: 52,
    run: () =>
      getState().updateDoc((d) => {
        d.guides = [];
      }, 'Clear Guides'),
    enabled: (s) => s.doc.guides.length > 0,
  },
  {
    id: 'view.guidesFromSelection',
    label: 'Make Guides from Selection',
    menu: 'View',
    order: 53,
    run: () => {
      const s = getState();
      const b = selectionBounds(s.doc, s.selection);
      if (!b) return;
      s.updateDoc((d) => {
        d.guides.push({ id: newId(), axis: 'x', position: b.x }, { id: newId(), axis: 'x', position: b.x + b.width }, { id: newId(), axis: 'y', position: b.y }, { id: newId(), axis: 'y', position: b.y + b.height });
      }, 'Make Guides');
    },
    enabled: (s) => s.selection.length > 0,
  },
  {
    id: 'view.smartGuides',
    label: 'Smart Guides',
    menu: 'View',
    shortcut: 'mod+u',
    order: 60,
    separatorBefore: true,
    run: () => getState().setView({ smartGuides: !getState().view.smartGuides }),
    checked: (s) => s.view.smartGuides,
  },
  {
    id: 'view.snapPoint',
    label: 'Snap to Point',
    menu: 'View',
    shortcut: 'mod+alt+"',
    order: 61,
    run: () => getState().setView({ snapToPoint: !getState().view.snapToPoint }),
    checked: (s) => s.view.snapToPoint,
  },
  {
    id: 'view.snapPixel',
    label: 'Snap to Pixel',
    menu: 'View',
    order: 62,
    run: () => getState().setView({ snapToPixel: !getState().view.snapToPixel }),
    checked: (s) => s.view.snapToPixel,
  },
  {
    id: 'view.showBounds',
    label: 'Show Bounding Box',
    menu: 'View',
    shortcut: 'mod+shift+b',
    order: 70,
    separatorBefore: true,
    run: () => getState().setView({ showBounds: !getState().view.showBounds }),
    checked: (s) => s.view.showBounds,
  },
  {
    id: 'view.showAnchors',
    label: 'Show Anchor Points',
    menu: 'View',
    order: 71,
    run: () => getState().setView({ showAnchors: !getState().view.showAnchors }),
    checked: (s) => s.view.showAnchors,
  },
  {
    id: 'view.showArtboards',
    label: 'Show Artboards',
    menu: 'View',
    shortcut: 'mod+shift+h',
    order: 72,
    run: () => getState().setView({ showArtboards: !getState().view.showArtboards }),
    checked: (s) => s.view.showArtboards,
  },
  {
    id: 'view.transparencyGrid',
    label: 'Show Transparency Grid',
    menu: 'View',
    shortcut: 'mod+shift+d',
    order: 73,
    run: () => getState().setView({ transparencyGrid: !getState().view.transparencyGrid }),
    checked: (s) => s.view.transparencyGrid,
  },
]);
