/**
 * Distort module wiring: registers the geometry effects (warp, free distort,
 * envelope mesh, envelope path, 3D rotate), the Warp / Free Distort / Envelope
 * Mesh dialogs, Object > Envelope Distort commands and the expanders that bake
 * live geometry into plain paths.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { registerCommands, when, type Command } from '@/commands/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Segmented, Select, Slider } from '@/ui/widgets';
import { getState, useStore, type EditorState } from '@/store/store';
import type { Document, Effect, ID, WarpEffect, WarpStyle, FreeDistortEffect, MeshDistortEffect, CoonsDistortEffect, Rect, Vec } from '@/model/types';
import { isContainer } from '@/model/types';
import { registerGeometryEffect, applyGeometryEffects, hasGeometryEffects } from '@/canvas/effectiveGeometry';
import { registerExpander } from '@/appearance/expand';
import { applyEffect, initialEffect, rememberEffect, cloneEffect, effectDef, type ApplyMode } from '@/commands/effectCommands/effects';
import { effectTargets } from '@/commands/effectCommands/register';
import { makeGroup } from '@/model/nodes';
import { addNode, removeNode, groupNodes, ungroupNode, localBounds, worldSubPaths, sortByPaintOrder, topmostOf, descendants, worldMatrix, setWorldSubPaths } from '@/model/document';
import { transformSubPaths } from '@/geometry/path';
import { multiply, invert } from '@/geometry/matrix';
import { warpSubPaths, WARP_STYLES } from './warp';
import { freeDistortSubPaths, meshDistortSubPaths, coonsSubPaths, makeMeshDistort, coonsFromPath, IDENTITY_CORNERS, squareToQuad, applyHomography } from './envelope';
import { rotate3dSubPaths } from '@/effects3d/geometry';
import * as warp from './warp';
import * as envelope from './envelope';

registerGeometryEffect('warp', (sps, e, frame) => warpSubPaths(sps, e as WarpEffect, frame));
registerGeometryEffect('freeDistort', (sps, e, frame) => freeDistortSubPaths(sps, e as FreeDistortEffect, frame));
registerGeometryEffect('meshDistort', (sps, e, frame) => {
  const m = e as MeshDistortEffect;
  return m.points.length === (m.rows + 1) * (m.cols + 1) ? meshDistortSubPaths(sps, m, frame) : sps;
});
registerGeometryEffect('coonsDistort', (sps, e, frame) => coonsSubPaths(sps, e as CoonsDistortEffect, frame));
registerGeometryEffect('rotate3d', (sps, e, frame) => rotate3dSubPaths(sps, e as never, frame));

// ---------------------------------------------------------------------------
// Expanders: bake geometry effects into plain geometry
// ---------------------------------------------------------------------------

function geometryEffectsOf(effects: Effect[]): Effect[] {
  return effects.filter((e) => e.enabled && (e.type === 'warp' || e.type === 'freeDistort' || e.type === 'meshDistort' || e.type === 'coonsDistort' || e.type === 'rotate3d' || e.type === 'roundCorners'));
}

/** Bake the geometry effects of a node (path: own geometry; group: descendants in the group frame). */
export function bakeGeometryEffects(doc: Document, id: ID): boolean {
  const n = doc.nodes[id];
  if (!n) return false;
  const geo = geometryEffectsOf(n.effects);
  if (!geo.length) return false;
  if (n.type === 'path') {
    n.subpaths = applyGeometryEffects(n.subpaths, n.effects, null);
    n.shape = undefined;
    n.effects = n.effects.filter((e) => !geo.includes(e));
    return true;
  }
  if (n.type !== 'group') return false;
  const frame = localBounds(doc, id);
  if (!frame) return false;
  const gm = worldMatrix(doc, id);
  const inv = invert(gm);
  for (const d of descendants(doc, id)) {
    const c = doc.nodes[d];
    if (!c || c.type !== 'path') continue;
    // path geometry in the group frame (own effects baked first)
    const own = applyGeometryEffects(c.subpaths, c.effects, null);
    const wm = worldMatrix(doc, d);
    const inGroup = transformSubPaths(own, multiply(inv, wm));
    const mapped = applyGeometryEffects(inGroup, geo, frame);
    // back to world, then into the path's own parent space
    setWorldSubPaths(doc, d, transformSubPaths(mapped, gm));
    c.effects = c.effects.filter((e) => !geometryEffectsOf([e]).length);
  }
  n.effects = n.effects.filter((e) => !geo.includes(e));
  return true;
}

registerExpander('geometry', (doc, id) => (bakeGeometryEffects(doc, id) ? [id] : null));

// ---------------------------------------------------------------------------
// Envelope Distort commands
// ---------------------------------------------------------------------------

const ENVELOPE = 'envelope';

function isEnvelope(doc: Document, id: ID): boolean {
  const n = doc.nodes[id];
  return !!n && n.type === 'group' && !!n.data && !!(n.data as Record<string, unknown>)[ENVELOPE];
}

/** Wrap the selection into an envelope group carrying the effect. Returns the group id. */
function wrapSelection(doc: Document, ids: ID[], effect: Effect, kind: string): ID | null {
  const members = sortByPaintOrder(doc, topmostOf(doc, ids)).filter((id) => doc.nodes[id] && doc.nodes[id].type !== 'layer');
  if (!members.length) return null;
  const g = makeGroup([], { name: 'Envelope' });
  g.data = { [ENVELOPE]: kind };
  const gid = groupNodes(doc, members, g);
  if (!gid) return null;
  doc.nodes[gid].effects = [effect];
  return gid;
}

function makeEnvelope(effect: Effect, kind: string, label: string): ID | null {
  const s = getState();
  if (!s.selection.length) return null;
  let gid: ID | null = null;
  s.updateDoc((d) => {
    gid = wrapSelection(d, s.selection, effect, kind);
  }, label);
  if (gid) getState().setSelection([gid]);
  return gid;
}

export function makeWithWarp(): void {
  const gid = makeEnvelope(initialEffect('warp'), 'warp', 'Make Envelope with Warp');
  if (gid) getState().openDialog('effect.warp', { type: 'warp', index: 0 });
}

export function makeWithMesh(rows = 4, cols = 4): ID | null {
  return makeEnvelope(makeMeshDistort(rows, cols), 'mesh', 'Make Envelope with Mesh');
}

/** The topmost selected path becomes the envelope of the other selected objects. */
export function makeWithTopObject(): boolean {
  const s = getState();
  const ids = sortByPaintOrder(s.doc, topmostOf(s.doc, s.selection));
  if (ids.length < 2) {
    s.toast('Select the envelope path on top of the artwork to distort', 'info');
    return false;
  }
  const topId = ids[ids.length - 1];
  const top = s.doc.nodes[topId];
  if (!top || top.type !== 'path' || !top.subpaths.length) {
    s.toast('The topmost object must be a closed path', 'info');
    return false;
  }
  const contents = ids.slice(0, -1);
  let gid: ID | null = null;
  s.updateDoc((d) => {
    const g = makeGroup([], { name: 'Envelope' });
    g.data = { [ENVELOPE]: 'top' };
    const id = groupNodes(d, contents, g);
    if (!id) return;
    const frame = localBounds(d, id);
    if (!frame) return;
    const gm = worldMatrix(d, id);
    // envelope path in the group's local space
    const local = transformSubPaths(worldSubPaths(d, topId), invert(gm));
    const outline = local.find((sp) => sp.anchors.length >= 3) ?? local[0];
    const eff = coonsFromPath(outline, frame);
    if (!eff) return;
    d.nodes[id].effects = [eff];
    removeNode(d, topId);
    gid = id;
  }, 'Make Envelope with Top Object');
  if (gid) getState().setSelection([gid]);
  return !!gid;
}

export function releaseEnvelope(): number {
  const s = getState();
  const targets = s.selection.filter((id) => isEnvelope(s.doc, id));
  if (!targets.length) return 0;
  const out: ID[] = [];
  s.updateDoc((d) => {
    for (const id of targets) {
      const g = d.nodes[id];
      if (!g || g.type !== 'group') continue;
      g.effects = [];
      out.push(...ungroupNode(d, id));
    }
  }, 'Release Envelope');
  getState().setSelection(out);
  return targets.length;
}

export function expandEnvelope(): number {
  const s = getState();
  const targets = s.selection.filter((id) => isEnvelope(s.doc, id) || hasGeometryEffects(s.doc.nodes[id]?.effects ?? []));
  if (!targets.length) return 0;
  const out: ID[] = [];
  s.updateDoc((d) => {
    for (const id of targets) {
      bakeGeometryEffects(d, id);
      const g = d.nodes[id];
      if (g && g.type === 'group' && isEnvelope(d, id)) {
        delete g.data;
        out.push(...ungroupNode(d, id));
      } else out.push(id);
    }
  }, 'Expand Envelope');
  getState().setSelection(out);
  return targets.length;
}

const hasEnvelope = (s: EditorState) => s.selection.some((id) => isEnvelope(s.doc, id));

const commands: Command[] = [
  { id: 'envelope.warp', label: 'Make with Warp…', menu: 'Object/Envelope Distort', shortcut: 'mod+alt+shift+w', order: 740, run: () => makeWithWarp(), enabled: when.hasSelection },
  { id: 'envelope.mesh', label: 'Make with Mesh…', menu: 'Object/Envelope Distort', shortcut: 'mod+alt+m', order: 741, run: () => getState().openDialog('envelope.mesh', {}), enabled: when.hasSelection },
  { id: 'envelope.top', label: 'Make with Top Object', menu: 'Object/Envelope Distort', shortcut: 'mod+alt+c', order: 742, run: () => makeWithTopObject(), enabled: (s) => s.selection.length >= 2 },
  { id: 'envelope.release', label: 'Release', menu: 'Object/Envelope Distort', order: 743, separatorBefore: true, run: () => releaseEnvelope(), enabled: hasEnvelope },
  { id: 'envelope.expand', label: 'Expand', menu: 'Object/Envelope Distort', order: 744, run: () => expandEnvelope(), enabled: (s) => hasEnvelope(s) || s.selection.some((id) => hasGeometryEffects(s.doc.nodes[id]?.effects ?? [])) },
  { id: 'envelope.editContents', label: 'Edit Contents', menu: 'Object/Envelope Distort', order: 745, separatorBefore: true, run: () => { const s = getState(); const g = s.selection.find((id) => isEnvelope(s.doc, id)); if (g) s.setIsolation(g); }, enabled: hasEnvelope },
];
registerCommands(commands);

// ---------------------------------------------------------------------------
// Dialog scaffolding shared by the custom effect dialogs (live preview, cancel reverts)
// ---------------------------------------------------------------------------

interface EffectDialogProps {
  type: Effect['type'];
  index?: number;
}

function useEffectSession(props: EffectDialogProps) {
  const setup = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    const ids: ID[] = effectTargets(s);
    const first = ids[0] ? s.doc.nodes[ids[0]] : undefined;
    let existing: Effect | undefined;
    let mode: ApplyMode = { kind: 'replaceType' };
    if (props.index !== undefined && first && first.effects[props.index]?.type === props.type) {
      existing = first.effects[props.index];
      mode = { kind: 'index', index: props.index };
    } else if (first) existing = first.effects.find((e) => e.type === props.type);
    const initial = existing ? { ...cloneEffect(existing), enabled: true } : initialEffect(props.type);
    return { ids, initial, mode, editing: !!existing };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [effect, setEffect] = useState<Effect>(setup.initial);
  const ref = useRef(effect);
  ref.current = effect;
  useEffect(() => {
    if (setup.ids.length) applyEffect(ref.current, setup.ids, setup.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (e: Effect) => {
    setEffect(e);
    if (setup.ids.length) applyEffect(e, setup.ids, setup.mode);
  };
  const ok = (close: () => void) => {
    rememberEffect(ref.current);
    getState().commit(setup.editing ? `Edit ${effectDef(props.type).label}` : effectDef(props.type).label);
    close();
  };
  const cancel = (close: () => void) => {
    getState().revert();
    close();
  };
  return { effect, update, ok, cancel, setup };
}

// ---------------------------------------------------------------------------
// Warp dialog
// ---------------------------------------------------------------------------

function WarpDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'warp' });
  const e = effect as WarpEffect;
  const set = (p: Partial<WarpEffect>) => update({ ...e, ...p });
  return (
    <DialogFrame
      title="Warp Options"
      onClose={() => cancel(close)}
      width={420}
      footer={
        <>
          <Button onClick={() => cancel(close)}>Cancel</Button>
          <Button primary onClick={() => ok(close)} data-testid="warp-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <Select label="Style" value={e.style} options={WARP_STYLES.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => set({ style: v as WarpStyle })} width={180} id="warp-style" />
        <Segmented value={e.horizontal ? 'h' : 'v'} onChange={(v) => set({ horizontal: v === 'h' })} options={[{ value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }]} />
      </Row>
      <Slider label="Bend" value={Math.round(e.bend)} min={-100} max={100} unit="%" onChange={(v) => set({ bend: v })} className="warp-slider" />
      <div className="section-title">Distortion</div>
      <Slider label="Horizontal" value={Math.round(e.hDistort)} min={-100} max={100} unit="%" onChange={(v) => set({ hDistort: v })} />
      <Slider label="Vertical" value={Math.round(e.vDistort)} min={-100} max={100} unit="%" onChange={(v) => set({ vDistort: v })} />
      <div className="dim small">Live effect: the geometry stays editable. Object &gt; Expand Appearance bakes it.</div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Free Distort dialog (numeric corners; the Mesh tool drags them on the canvas)
// ---------------------------------------------------------------------------

function FreeDistortDialog({ props, close }: { props: EffectDialogProps; close: () => void }) {
  const { effect, update, ok, cancel } = useEffectSession({ ...props, type: 'freeDistort' });
  const e = effect as FreeDistortEffect;
  const setCorner = (i: number, k: 'x' | 'y', v: number) => {
    const corners = e.corners.map((c, j) => (j === i ? { ...c, [k]: v / 100 } : c)) as FreeDistortEffect['corners'];
    update({ ...e, corners });
  };
  const labels = ['Top left', 'Top right', 'Bottom right', 'Bottom left'];
  return (
    <DialogFrame
      title="Free Distort"
      onClose={() => cancel(close)}
      width={400}
      footer={
        <>
          <Button onClick={() => update({ ...e, corners: IDENTITY_CORNERS.map((c) => ({ ...c })) as FreeDistortEffect['corners'] })}>Reset</Button>
          <div style={{ flex: 1 }} />
          <Button onClick={() => cancel(close)}>Cancel</Button>
          <Button primary onClick={() => ok(close)} data-testid="free-distort-ok">
            OK
          </Button>
        </>
      }
    >
      {e.corners.map((c, i) => (
        <Row key={i} gap={6}>
          <span className="field-label" style={{ width: 90 }}>
            {labels[i]}
          </span>
          <NumberField label="X" value={Math.round(c.x * 100)} unit="%" decimals={0} onChange={(v) => setCorner(i, 'x', v)} width={96} data-testid={`free-distort-x-${i}`} />
          <NumberField label="Y" value={Math.round(c.y * 100)} unit="%" decimals={0} onChange={(v) => setCorner(i, 'y', v)} width={96} data-testid={`free-distort-y-${i}`} />
        </Row>
      ))}
      <div className="dim small">Corner positions in percent of the bounding box. Drag the corners on the canvas with the Mesh tool (U).</div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Envelope Mesh dialog (rows / columns)
// ---------------------------------------------------------------------------

function EnvelopeMeshDialog({ close, asEffect }: { close: () => void; asEffect?: boolean }) {
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(4);
  const ok = () => {
    if (asEffect) {
      const ids = effectTargets();
      applyEffect(makeMeshDistort(rows, cols), ids, { kind: 'replaceType' }, 'Envelope Mesh');
    } else makeWithMesh(rows, cols);
    close();
  };
  return (
    <DialogFrame
      title="Envelope Mesh"
      onClose={close}
      width={320}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="envelope-mesh-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <NumberField label="Rows" value={rows} min={1} max={30} decimals={0} onChange={(v) => setRows(Math.max(1, Math.min(30, Math.round(v))))} width={100} data-testid="envelope-rows" />
        <NumberField label="Columns" value={cols} min={1} max={30} decimals={0} onChange={(v) => setCols(Math.max(1, Math.min(30, Math.round(v))))} width={110} data-testid="envelope-cols" />
      </Row>
      <div className="dim small">Drag the mesh points with the Mesh tool (U) to deform the artwork.</div>
    </DialogFrame>
  );
}

registerDialog('effect.warp', WarpDialog as any);
registerDialog('effect.freeDistort', FreeDistortDialog as any);
registerDialog('effect.meshDistort', ({ close }) => <EnvelopeMeshDialog close={close} asEffect />);
registerDialog('envelope.mesh', ({ close }) => <EnvelopeMeshDialog close={close} />);

/** Effect list entry: quick "Envelope mesh" needs the effect to be created with points */
void isContainer;
void addNode;
void Checkbox;
void useStore;
void squareToQuad;
void applyHomography;

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  distort: { ...warp, ...envelope, bakeGeometryEffects, makeWithWarp, makeWithMesh, makeWithTopObject, releaseEnvelope, expandEnvelope, isEnvelope: (id: ID) => isEnvelope(getState().doc, id) },
};

export type { Rect, Vec };
