/**
 * 3D effects wiring: the shared Extrude & Bevel / Revolve / Rotate dialog with
 * position presets and lighting, and the expander that turns extrusions into
 * plain shaded paths (Object > Expand Appearance).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Segmented, Select, Slider } from '@/ui/widgets';
import { getState } from '@/store/store';
import type { Document, Effect, ID, Extrude3DEffect, Revolve3DEffect, Rotate3DEffect, Shading3D } from '@/model/types';
import { registerExpander } from '@/appearance/expand';
import { applyEffect, initialEffect, rememberEffect, cloneEffect, effectDef, type ApplyMode } from '@/commands/effectCommands/effects';
import { effectTargets } from '@/commands/effectCommands/register';
import { makeGroup, makePath } from '@/model/nodes';
import { addNode, removeNode, indexInParent, localBounds, descendants, worldMatrix, worldSubPaths } from '@/model/document';
import { pathBounds, transformSubPaths, polylineSubPath } from '@/geometry/path';
import { multiply, invert } from '@/geometry/matrix';
import { noStroke } from '@/model/defaults';
import { applyGeometryEffects } from '@/canvas/effectiveGeometry';
import { extrudeFaces, revolveFaces, POSITION_PRESETS, type Face3D } from './geometry';
import * as geometry from './geometry';

type Any3D = Extrude3DEffect | Revolve3DEffect | Rotate3DEffect;

// ---------------------------------------------------------------------------
// Expander: extrude / revolve → group of shaded paths
// ---------------------------------------------------------------------------

function facesFor(sps: import('@/model/types').SubPath[], frame: import('@/model/types').Rect, effects: Effect[], fill: import('@/model/types').Paint): Face3D[] | null {
  const hex = fill.type === 'solid' ? fill.color : fill.type === 'linear' || fill.type === 'radial' ? fill.stops[0]?.color ?? '#808080' : '#c0c0c0';
  const op = fill.type === 'solid' ? fill.opacity : 1;
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.type === 'extrude') return extrudeFaces(sps, frame, e, hex, op);
    if (e.type === 'revolve') return revolveFaces(sps, frame, e, hex, op);
  }
  return null;
}

function facesToNodes(doc: Document, faces: Face3D[], parent: ID, name: string, stroke: import('@/model/types').StrokeStyle): void {
  faces.forEach((f, i) => {
    const sps = f.rings.map((r) => polylineSubPath(r, true));
    const p = makePath(sps, { name: `${name} ${f.kind} ${i + 1}`, fill: { type: 'solid', color: f.color, opacity: f.opacity }, stroke: f.kind === 'front' ? { ...stroke } : noStroke(), fillRule: 'evenodd' });
    addNode(doc, p, parent);
  });
}

/** Expand 3D extrusions/revolves of a node into a group of shaded paths. */
export function expand3D(doc: Document, id: ID): ID | null {
  const n = doc.nodes[id];
  if (!n) return null;
  const has = n.effects.some((e) => e.enabled && (e.type === 'extrude' || e.type === 'revolve'));
  if (!has) return null;
  const parent = n.parent;
  const index = indexInParent(doc, id);
  const g = makeGroup([], { name: `${n.name} (3D)`, transform: n.transform, opacity: n.opacity, blendMode: n.blendMode, effects: n.effects.filter((e) => e.type !== 'extrude' && e.type !== 'revolve') });
  addNode(doc, g, parent, index + 1);
  if (n.type === 'path') {
    const sps = applyGeometryEffects(n.subpaths, n.effects.filter((e) => e.type !== 'extrude' && e.type !== 'revolve'), null);
    const faces = facesFor(sps, pathBounds(sps) ?? { x: 0, y: 0, width: 1, height: 1 }, n.effects, n.fill);
    if (faces) facesToNodes(doc, faces, g.id, n.name, n.stroke);
  } else if (n.type === 'group') {
    const frame = localBounds(doc, id) ?? { x: 0, y: 0, width: 1, height: 1 };
    const gm = worldMatrix(doc, id);
    const inv = invert(gm);
    for (const d of descendants(doc, id)) {
      const c = doc.nodes[d];
      if (!c || c.type !== 'path') continue;
      const sps = transformSubPaths(applyGeometryEffects(c.subpaths, c.effects, null), multiply(inv, worldMatrix(doc, d)));
      const faces = facesFor(sps, frame, n.effects, c.fill);
      if (faces) facesToNodes(doc, faces, g.id, c.name, c.stroke);
    }
  } else return null;
  removeNode(doc, id);
  return g.id;
}

registerExpander('3d', (doc, id) => {
  const g = expand3D(doc, id);
  return g ? [g] : null;
});

// ---------------------------------------------------------------------------
// Dialog (shared)
// ---------------------------------------------------------------------------

function useSession(type: Any3D['type'], index?: number) {
  const setup = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    const ids: ID[] = effectTargets(s);
    const first = ids[0] ? s.doc.nodes[ids[0]] : undefined;
    let existing: Effect | undefined;
    let mode: ApplyMode = { kind: 'replaceType' };
    if (index !== undefined && first && first.effects[index]?.type === type) {
      existing = first.effects[index];
      mode = { kind: 'index', index };
    } else if (first) existing = first.effects.find((e) => e.type === type);
    const initial = existing ? { ...cloneEffect(existing), enabled: true } : initialEffect(type);
    return { ids, initial, mode, editing: !!existing };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [effect, setEffect] = useState<Any3D>(setup.initial as Any3D);
  const ref = useRef(effect);
  ref.current = effect;
  useEffect(() => {
    if (setup.ids.length) applyEffect(ref.current, setup.ids, setup.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (p: Partial<Any3D>) => {
    const next = { ...effect, ...p } as Any3D;
    setEffect(next);
    if (setup.ids.length) applyEffect(next, setup.ids, setup.mode);
  };
  return { effect, update, setup };
}

function ThreeDDialog({ props, close }: { props: { type: Any3D['type']; index?: number }; close: () => void }) {
  const type: Any3D['type'] = props.type === 'revolve' || props.type === 'rotate3d' ? props.type : 'extrude';
  const { effect, update, setup } = useSession(type, props.index);
  const title = type === 'extrude' ? '3D Extrude & Bevel Options' : type === 'revolve' ? '3D Revolve Options' : '3D Rotate Options';
  const ok = () => {
    rememberEffect(effect);
    getState().commit(setup.editing ? `Edit ${effectDef(type).label}` : effectDef(type).label);
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  const preset = POSITION_PRESETS.find((p) => p.rot[0] === effect.rotX && p.rot[1] === effect.rotY && p.rot[2] === effect.rotZ)?.id ?? 'custom';
  const shading = (effect as Extrude3DEffect).shading as Shading3D | undefined;
  return (
    <DialogFrame
      title={title}
      onClose={cancel}
      width={520}
      className="three-d-dialog"
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="three-d-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="section-title">Position</div>
      <Row gap={8}>
        <Select
          value={preset}
          options={[{ value: 'custom', label: 'Custom Rotation' }, ...POSITION_PRESETS.map((p) => ({ value: p.id, label: p.label }))]}
          onChange={(v) => {
            const p = POSITION_PRESETS.find((x) => x.id === v);
            if (p) update({ rotX: p.rot[0], rotY: p.rot[1], rotZ: p.rot[2] } as Partial<Any3D>);
          }}
          width={180}
          id="three-d-preset"
        />
        <NumberField label="X" value={Math.round(effect.rotX)} unit="deg" decimals={0} min={-180} max={180} onChange={(v) => update({ rotX: v } as Partial<Any3D>)} width={92} data-testid="three-d-rotx" />
        <NumberField label="Y" value={Math.round(effect.rotY)} unit="deg" decimals={0} min={-180} max={180} onChange={(v) => update({ rotY: v } as Partial<Any3D>)} width={92} data-testid="three-d-roty" />
        <NumberField label="Z" value={Math.round(effect.rotZ)} unit="deg" decimals={0} min={-180} max={180} onChange={(v) => update({ rotZ: v } as Partial<Any3D>)} width={92} data-testid="three-d-rotz" />
      </Row>
      <Slider label="Perspective" value={Math.round(effect.perspective)} min={0} max={160} unit="deg" onChange={(v) => update({ perspective: v } as Partial<Any3D>)} />
      {type === 'extrude' && (
        <>
          <div className="section-title">Extrude &amp; Bevel</div>
          <Row gap={8}>
            <NumberField label="Extrude depth" value={(effect as Extrude3DEffect).depth} min={0} max={2000} unit="px" onChange={(v) => update({ depth: Math.max(0, v) } as Partial<Any3D>)} width={150} data-testid="three-d-depth" />
            <Checkbox checked={(effect as Extrude3DEffect).capped !== false} onChange={(v) => update({ capped: v } as Partial<Any3D>)} label="Cap" title="Solid (capped) or hollow extrusion" />
          </Row>
          <Row gap={8}>
            <Select label="Bevel" value={(effect as Extrude3DEffect).bevel} options={[{ value: 'none', label: 'None' }, { value: 'classic', label: 'Classic' }, { value: 'round', label: 'Round' }]} onChange={(v) => update({ bevel: v } as Partial<Any3D>)} width={130} />
            <NumberField label="Height" value={(effect as Extrude3DEffect).bevelHeight} min={0} max={500} unit="px" onChange={(v) => update({ bevelHeight: Math.max(0, v) } as Partial<Any3D>)} width={110} />
          </Row>
        </>
      )}
      {type === 'revolve' && (
        <>
          <div className="section-title">Revolve</div>
          <Row gap={8}>
            <Slider label="Angle" value={Math.round((effect as Revolve3DEffect).angle)} min={1} max={360} unit="deg" onChange={(v) => update({ angle: v } as Partial<Any3D>)} />
          </Row>
          <Row gap={8}>
            <NumberField label="Offset" value={(effect as Revolve3DEffect).offset} min={0} max={2000} unit="px" onChange={(v) => update({ offset: Math.max(0, v) } as Partial<Any3D>)} width={120} />
            <Segmented value={(effect as Revolve3DEffect).axis} onChange={(v) => update({ axis: v } as Partial<Any3D>)} options={[{ value: 'left', label: 'Left edge' }, { value: 'right', label: 'Right edge' }]} />
            <NumberField label="Steps" value={(effect as Revolve3DEffect).steps} min={6} max={120} decimals={0} onChange={(v) => update({ steps: Math.round(v) } as Partial<Any3D>)} width={90} />
          </Row>
        </>
      )}
      {type !== 'rotate3d' && (
        <>
          <div className="section-title">Surface</div>
          <Row gap={8}>
            <Select label="Shading" value={shading ?? 'plastic'} options={[{ value: 'none', label: 'No Shading' }, { value: 'flat', label: 'Diffuse' }, { value: 'plastic', label: 'Plastic Shading' }]} onChange={(v) => update({ shading: v } as Partial<Any3D>)} width={160} />
            <NumberField label="Light angle" value={Math.round((effect as Extrude3DEffect).lightAngle)} unit="deg" decimals={0} onChange={(v) => update({ lightAngle: v } as Partial<Any3D>)} width={110} />
            <NumberField label="Altitude" value={Math.round((effect as Extrude3DEffect).lightAltitude)} unit="deg" decimals={0} min={-89} max={89} onChange={(v) => update({ lightAltitude: v } as Partial<Any3D>)} width={100} />
          </Row>
          <Slider label="Ambient light" value={Math.round((effect as Extrude3DEffect).ambient)} min={0} max={100} unit="%" onChange={(v) => update({ ambient: v } as Partial<Any3D>)} />
        </>
      )}
      <div className="dim small">Live effect on {setup.ids.length} object{setup.ids.length === 1 ? '' : 's'}; Object &gt; Expand Appearance converts it to shaded paths.</div>
    </DialogFrame>
  );
}

registerDialog('effect.3d', ThreeDDialog as any);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  effects3d: { ...geometry, expand3D },
};

void worldSubPaths;
