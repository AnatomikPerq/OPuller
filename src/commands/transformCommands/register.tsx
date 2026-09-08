/**
 * Object > Transform and Object > Align commands.
 */
import { registerCommands, when } from '@/commands/registry';
import { getState, type EditorState } from '@/store/store';
import { selectionBounds } from '@/model/document';
import { refPointOf } from '@/transform/refPoint';
import { rotationAbout, reflectAbout } from '@/transform/matrices';
import { applyTransform, transformTargets, resetBoundingBox } from '@/transform/apply';
import { recordMatrixTransform, transformAgain } from '@/transform/again';
import { getTransformState } from '@/transform/store';
import { alignSelection, canAlign, centerOnArtboard, type AlignKind } from '@/transform/align';

/** Apply a linear transform about the Transform panel's reference point of the selection. */
export function transformAboutRef(label: string, build: (pivot: { x: number; y: number }) => ReturnType<typeof rotationAbout>): void {
  const s = getState();
  const ids = transformTargets(s);
  if (!ids.length) return;
  const bounds = selectionBounds(s.doc, ids);
  if (!bounds) return;
  const ref = getTransformState().refPoint;
  const pivot = refPointOf(bounds, ref);
  const m = build(pivot);
  applyTransform(m, { label, ids });
  recordMatrixTransform(label, m, { kind: 'ref', ref }, false, bounds);
}

export function rotateSelection(angleCcw: number, label = 'Rotate'): void {
  transformAboutRef(label, (p) => rotationAbout(angleCcw, p));
}

export function flipSelection(axis: 'h' | 'v'): void {
  // Flip Horizontal mirrors left↔right = reflection across the vertical axis
  transformAboutRef(axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical', (p) => reflectAbout(axis === 'h' ? 90 : 0, p));
}

const hasTargets = (s: EditorState) => transformTargets(s).length > 0;
const canAgain = (s: EditorState) => !!getTransformState().lastTransform && hasTargets(s);

const open = (type: string) => () => {
  const s = getState();
  if (!transformTargets(s).length) return;
  s.openDialog(type, {});
};

registerCommands([
  { id: 'object.transformAgain', label: 'Transform Again', menu: 'Object/Transform', shortcut: 'mod+d', order: 150, run: () => transformAgain(), enabled: canAgain },
  { id: 'object.moveDialog', label: 'Move…', menu: 'Object/Transform', shortcut: 'mod+shift+m', order: 151, separatorBefore: true, run: open('transform.move'), enabled: hasTargets },
  { id: 'object.rotateDialog', label: 'Rotate…', menu: 'Object/Transform', order: 152, run: open('transform.rotate'), enabled: hasTargets },
  { id: 'object.reflectDialog', label: 'Reflect…', menu: 'Object/Transform', order: 153, run: open('transform.reflect'), enabled: hasTargets },
  { id: 'object.scaleDialog', label: 'Scale…', menu: 'Object/Transform', order: 154, run: open('transform.scale'), enabled: hasTargets },
  { id: 'object.shearDialog', label: 'Shear…', menu: 'Object/Transform', order: 155, run: open('transform.shear'), enabled: hasTargets },
  { id: 'object.transformEach', label: 'Transform Each…', menu: 'Object/Transform', shortcut: 'mod+alt+shift+d', order: 156, run: open('transform.each'), enabled: hasTargets },
  { id: 'object.transformDialog', label: 'Transform…', menu: 'Object/Transform', order: 157, run: () => { const s = getState(); if (transformTargets(s).length) s.openDialog('transform', { tab: 'move', tabs: true }); }, enabled: hasTargets },
  { id: 'object.rotate90cw', label: 'Rotate 90° CW', menu: 'Object/Transform', order: 160, separatorBefore: true, run: () => rotateSelection(-90, 'Rotate 90° CW'), enabled: hasTargets },
  { id: 'object.rotate90ccw', label: 'Rotate 90° CCW', menu: 'Object/Transform', order: 161, run: () => rotateSelection(90, 'Rotate 90° CCW'), enabled: hasTargets },
  { id: 'object.flipH', label: 'Flip Horizontal', menu: 'Object/Transform', order: 162, run: () => flipSelection('h'), enabled: hasTargets },
  { id: 'object.flipV', label: 'Flip Vertical', menu: 'Object/Transform', order: 163, run: () => flipSelection('v'), enabled: hasTargets },
  { id: 'object.resetTransform', label: 'Reset Bounding Box', menu: 'Object/Transform', order: 164, separatorBefore: true, run: () => resetBoundingBox(), enabled: hasTargets },
]);

const alignEnabled = (s: EditorState) => canAlign(getTransformState().alignTo, transformTargets(s).length);
const ALIGN_MENU_LABELS: Record<AlignKind, string> = { left: 'Left', hcenter: 'Horizontal Center', right: 'Right', top: 'Top', vcenter: 'Vertical Center', bottom: 'Bottom' };
const alignCmd = (id: string, kind: AlignKind, order: number, shortcut?: string) => ({
  id,
  label: ALIGN_MENU_LABELS[kind],
  menu: 'Object/Align',
  order,
  shortcut,
  run: () => alignSelection(kind),
  enabled: alignEnabled,
});

registerCommands([
  alignCmd('align.left', 'left', 170),
  alignCmd('align.hcenter', 'hcenter', 171),
  alignCmd('align.right', 'right', 172),
  alignCmd('align.top', 'top', 173),
  alignCmd('align.vcenter', 'vcenter', 174),
  alignCmd('align.bottom', 'bottom', 175),
  {
    id: 'align.toArtboardCenter',
    label: 'Center on Artboard',
    menu: 'Object/Align',
    order: 176,
    separatorBefore: true,
    run: () => centerOnArtboard(),
    enabled: hasTargets,
  },
]);

void when;
