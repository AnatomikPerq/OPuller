/**
 * Gradient module wiring: Object > Create Gradient Mesh… (dialog with live
 * preview), Object > Gradient Mesh > Release / Expand, and the scripting API.
 */
import React, { useState } from 'react';
import { registerCommands, when, type Command } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Row, Select, Slider } from '@/ui/widgets';
import { getState, useStore, type EditorState } from '@/store/store';
import { appearanceTargets, setFillPaint } from '@/commands/appearance';
import type { MeshGradientPaint, Paint } from '@/model/types';
import { createMeshOnSelection } from '@/tools/mesh/tool';
import * as mesh from './mesh';
import * as freeform from './freeform';
import { rasterGradientTile, clearRasterCache } from './raster';
import { DEFAULT_MESH, type MeshAppearance, type MeshOptions } from './mesh';

const hasMesh = (s: EditorState) => appearanceTargets(s.selection).some((id) => {
  const n = s.doc.nodes[id];
  return n && (n.type === 'path' || n.type === 'text') && n.fill.type === 'mesh';
});

/** Replace the mesh fill by its average colour (release). */
export function releaseMesh(): number {
  const s = getState();
  const targets = appearanceTargets(s.selection);
  let n = 0;
  s.updateDoc((d) => {
    for (const id of targets) {
      const node = d.nodes[id];
      if (!node || (node.type !== 'path' && node.type !== 'text') || node.fill.type !== 'mesh') continue;
      const m = node.fill;
      const c = mesh.patchColorHex(m, Math.floor(m.rows / 2), Math.floor(m.cols / 2), 0.5, 0.5);
      node.fill = { type: 'solid', color: c, opacity: 1 };
      n++;
    }
  }, 'Release Gradient Mesh');
  return n;
}

const commands: Command[] = [
  { id: 'object.createMesh', label: 'Create Gradient Mesh…', menu: 'Object', order: 162, run: () => getState().openDialog('gradientMesh', {}), enabled: (s) => appearanceTargets(s.selection).length > 0 },
  { id: 'object.releaseMesh', label: 'Release Gradient Mesh', menu: 'Object', order: 163, run: () => releaseMesh(), enabled: hasMesh },
];
registerCommands(commands);

function MeshDialog({ close }: { close: () => void }) {
  const [opts, setOpts] = useState<MeshOptions>({ ...DEFAULT_MESH, ...((getState().toolOptions.mesh as Partial<MeshOptions>) ?? {}) });
  const selection = useStore((s) => s.selection);
  const targets = React.useMemo(() => appearanceTargets(selection), [selection]);
  const preview = (o: MeshOptions) => {
    const s = getState();
    s.revert();
    s.setToolOptions('mesh', o as unknown as Record<string, unknown>);
    createMeshOnSelection({ ...o }, false);
  };
  const update = (p: Partial<MeshOptions>) => {
    const next = { ...opts, ...p };
    setOpts(next);
    preview(next);
  };
  React.useEffect(() => {
    preview(opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ok = () => {
    getState().commit('Create Gradient Mesh');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  return (
    <DialogFrame
      title="Create Gradient Mesh"
      onClose={cancel}
      width={380}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="mesh-dialog-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <NumberField label="Rows" value={opts.rows} min={1} max={50} decimals={0} onChange={(v) => update({ rows: Math.max(1, Math.min(50, Math.round(v))) })} width={100} data-testid="mesh-dialog-rows" />
        <NumberField label="Columns" value={opts.cols} min={1} max={50} decimals={0} onChange={(v) => update({ cols: Math.max(1, Math.min(50, Math.round(v))) })} width={110} data-testid="mesh-dialog-cols" />
      </Row>
      <Select label="Appearance" value={opts.appearance} options={[{ value: 'flat', label: 'Flat' }, { value: 'toCenter', label: 'To Center' }, { value: 'toEdge', label: 'To Edge' }]} onChange={(v) => update({ appearance: v as MeshAppearance })} width={200} id="mesh-dialog-appearance" />
      <Slider label="Highlight" value={opts.highlight} min={0} max={100} unit="%" onChange={(v) => update({ highlight: v })} />
      <div className="dim small">{targets.length} object{targets.length === 1 ? '' : 's'}: the fill becomes an editable mesh (Mesh tool, U). Changes preview live.</div>
    </DialogFrame>
  );
}

registerDialog('gradientMesh', ({ close }) => <MeshDialog close={close} />);

/** Scripting helpers. */
export function applyFreeform(points: Array<{ x: number; y: number; color: string; opacity?: number; spread?: number }>, mode: 'points' | 'lines' = 'points'): Paint {
  const paint: Paint = { type: 'freeform', mode, points: points.map((p) => ({ x: p.x, y: p.y, color: p.color, opacity: p.opacity ?? 1, spread: p.spread ?? 0.5 })), lines: mode === 'lines' ? [points.map((_, i) => i)] : undefined };
  setFillPaint(paint, true);
  return paint;
}

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  gradients: { ...mesh, ...freeform, rasterGradientTile, clearRasterCache, createMeshOnSelection, releaseMesh, applyFreeform },
};

export { createMeshOnSelection };
export type { MeshGradientPaint };
void when;
