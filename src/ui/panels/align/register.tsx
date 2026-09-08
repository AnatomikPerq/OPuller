/**
 * Align panel: align / distribute objects, distribute spacing, align-to mode
 * (selection, key object, artboard). In key-object mode, clicking a selected
 * object on the canvas makes it the key object (drawn with a thick outline).
 */
import React, { useEffect, useMemo } from 'react';
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignVerticalDistributeStart,
  AlignVerticalDistributeCenter,
  AlignVerticalDistributeEnd,
  AlignHorizontalDistributeStart,
  AlignHorizontalDistributeCenter,
  AlignHorizontalDistributeEnd,
  AlignHorizontalSpaceBetween,
  AlignVerticalSpaceBetween,
} from 'lucide-react';
import { registerPanel } from '@/ui/panels/registry';
import { registerViewportSlot } from '@/canvas/viewportSlots';
import { useStore, getState, screenToWorld } from '@/store/store';
import { IconButton, NumberField, Row, Select } from '@/ui/widgets';
import { nodeScreenOutline } from '@/canvas/SelectionOverlay';
import { hitTest } from '@/canvas/hitTest';
import { useTransformStore } from '@/transform/store';
import { transformTargets } from '@/transform/apply';
import {
  alignSelection,
  distributeSelection,
  distributeSpacingSelection,
  canAlign,
  canDistribute,
  canDistributeSpacing,
  effectiveKeyObject,
  alignItems,
  ALIGN_LABELS,
  DISTRIBUTE_LABELS,
  type AlignKind,
  type DistributeKind,
} from '@/transform/align';
import '@/transform/transform.css';

const ALIGN_ICONS: Array<{ kind: AlignKind; icon: React.ReactNode }> = [
  { kind: 'left', icon: <AlignStartVertical size={15} /> },
  { kind: 'hcenter', icon: <AlignCenterVertical size={15} /> },
  { kind: 'right', icon: <AlignEndVertical size={15} /> },
  { kind: 'top', icon: <AlignStartHorizontal size={15} /> },
  { kind: 'vcenter', icon: <AlignCenterHorizontal size={15} /> },
  { kind: 'bottom', icon: <AlignEndHorizontal size={15} /> },
];

const DISTRIBUTE_ICONS: Array<{ kind: DistributeKind; icon: React.ReactNode }> = [
  { kind: 'top', icon: <AlignVerticalDistributeStart size={15} /> },
  { kind: 'vcenter', icon: <AlignVerticalDistributeCenter size={15} /> },
  { kind: 'bottom', icon: <AlignVerticalDistributeEnd size={15} /> },
  { kind: 'left', icon: <AlignHorizontalDistributeStart size={15} /> },
  { kind: 'hcenter', icon: <AlignHorizontalDistributeCenter size={15} /> },
  { kind: 'right', icon: <AlignHorizontalDistributeEnd size={15} /> },
];

export function AlignPanel() {
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  const units = useStore((s) => s.prefs.units);
  const alignTo = useTransformStore((s) => s.alignTo);
  const setAlignTo = useTransformStore((s) => s.setAlignTo);
  const spacing = useTransformStore((s) => s.spacing);
  const setSpacing = useTransformStore((s) => s.setSpacing);
  const keyObject = useTransformStore((s) => s.keyObject);
  const count = useMemo(() => transformTargets(getState(), selection).length, [selection, docVersion]);
  const keyName = useMemo(() => {
    const s = getState();
    if (alignTo !== 'key') return null;
    const key = effectiveKeyObject(s, alignItems(s));
    return key ? (s.doc.nodes[key]?.name ?? key) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignTo, keyObject, selection, docVersion]);

  const alignOk = canAlign(alignTo, count);
  const distOk = canDistribute(alignTo, count);
  const spaceOk = canDistributeSpacing(count);

  return (
    <div className="align-panel" data-testid="align-panel">
      <div>
        <div className="align-title">Align objects</div>
        <div className="align-row">
          {ALIGN_ICONS.map((a, i) => (
            <React.Fragment key={a.kind}>
              {i === 3 && <span className="sep" />}
              <IconButton icon={a.icon} title={ALIGN_LABELS[a.kind]} disabled={!alignOk} onClick={() => alignSelection(a.kind)} data-testid={`align-${a.kind}`} />
            </React.Fragment>
          ))}
        </div>
      </div>
      <div>
        <div className="align-title">Distribute objects</div>
        <div className="align-row">
          {DISTRIBUTE_ICONS.map((a, i) => (
            <React.Fragment key={a.kind}>
              {i === 3 && <span className="sep" />}
              <IconButton icon={a.icon} title={DISTRIBUTE_LABELS[a.kind]} disabled={!distOk} onClick={() => distributeSelection(a.kind)} data-testid={`distribute-${a.kind}`} />
            </React.Fragment>
          ))}
        </div>
      </div>
      <div>
        <div className="align-title">Distribute spacing</div>
        <Row gap={6}>
          <IconButton icon={<AlignHorizontalSpaceBetween size={15} />} title="Horizontal distribute space" disabled={!spaceOk} onClick={() => distributeSpacingSelection('h')} data-testid="space-h" />
          <IconButton icon={<AlignVerticalSpaceBetween size={15} />} title="Vertical distribute space" disabled={!spaceOk} onClick={() => distributeSpacingSelection('v')} data-testid="space-v" />
          <Select
            value={spacing === null ? 'auto' : 'value'}
            onChange={(v) => setSpacing(v === 'auto' ? null : (spacing ?? 0))}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'value', label: 'Value' },
            ]}
            width={76}
            title="Auto: even gaps between the outer objects. Value: fixed gap from the key object."
          />
          {spacing !== null && <NumberField value={spacing} onChange={setSpacing} unit={units} width={90} title="Spacing between objects" data-testid="space-value" />}
        </Row>
      </div>
      <div>
        <div className="align-title">Align to</div>
        <Row gap={6}>
          <Select
            value={alignTo}
            onChange={setAlignTo}
            options={[
              { value: 'selection', label: 'Selection' },
              { value: 'key', label: 'Key object' },
              { value: 'artboard', label: 'Artboard' },
            ]}
            width={130}
            title="What objects are aligned to"
          />
          {alignTo === 'key' && <span className="align-hint">{keyName ? `Key: ${keyName}` : 'Click a selected object'}</span>}
        </Row>
        {alignTo === 'key' && <div className="align-hint" style={{ marginTop: 4 }}>Click any selected object on the canvas to make it the key object.</div>}
      </div>
    </div>
  );
}

/** Viewport overlay: outlines the key object and captures clicks that pick it. */
function KeyObjectOverlay() {
  const alignTo = useTransformStore((s) => s.alignTo);
  const hasSelection = useStore((s) => s.selection.length > 0);
  if (alignTo !== 'key' || !hasSelection) return null;
  return <KeyObjectOverlayActive />;
}

function KeyObjectOverlayActive() {
  const setKeyObject = useTransformStore((s) => s.setKeyObject);
  useTransformStore((s) => s.keyObject);
  const state = useStore((s) => s);

  useEffect(() => {
    const el = document.querySelector('[data-testid="viewport"]') as HTMLElement | null;
    if (!el) return;
    // A click on a selected object picks the key object. The pointerdown is held
    // back from the selection tool (which would reduce the selection to the
    // clicked object); when the pointer moves it is replayed so drags still work.
    let pending: { id: string; x: number; y: number; ev: PointerEvent } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e as PointerEvent & { __replayed?: boolean }).__replayed) return;
      const s = getState();
      if (!s.selection.length) return;
      const r = el.getBoundingClientRect();
      const world = screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }, s);
      const hit = hitTest(s.doc, world, { tolerance: s.prefs.snapTolerance / s.zoom, isolation: s.isolationId });
      if (!hit || !s.selection.includes(hit.target)) return;
      pending = { id: hit.target, x: e.clientX, y: e.clientY, ev: e };
      e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      if (!pending) return;
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 3) return;
      const src = pending.ev;
      pending = null;
      const replay = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: src.clientX,
        clientY: src.clientY,
        button: 0,
        buttons: 1,
        pointerId: src.pointerId,
        pointerType: src.pointerType,
        isPrimary: true,
        shiftKey: src.shiftKey,
        altKey: src.altKey,
        ctrlKey: src.ctrlKey,
        metaKey: src.metaKey,
      });
      (replay as PointerEvent & { __replayed?: boolean }).__replayed = true;
      el.dispatchEvent(replay);
    };
    const onUp = () => {
      if (!pending) return;
      setKeyObject(pending.id);
      pending = null;
    };
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointermove', onMove, true);
    el.addEventListener('pointerup', onUp, true);
    el.addEventListener('pointercancel', onUp, true);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointermove', onMove, true);
      el.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('pointercancel', onUp, true);
    };
  }, [setKeyObject]);

  const key = effectiveKeyObject(state, alignItems(state));
  if (!key || !state.doc.nodes[key]) return null;
  const d = nodeScreenOutline(state, key);
  if (!d) return null;
  return (
    <g className="align-key-object" pointerEvents="none" data-key-object={key}>
      <path d={d} fill="none" stroke="#fff" strokeWidth={4} opacity={0.6} />
      <path d={d} fill="none" stroke="#a33660" strokeWidth={2} />
    </g>
  );
}

registerPanel({ id: 'align', title: 'Align', component: AlignPanel, order: 21, defaultVisible: true, shortcut: 'shift+f7' });
registerViewportSlot('overlay', 'align-key-object', KeyObjectOverlay);

