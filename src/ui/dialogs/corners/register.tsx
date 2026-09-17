/**
 * Corners dialog (double-click a corner widget, or Object > Path > Corners…): one radius for
 * the chosen corners — the selected anchors, or every corner of the selected paths. Live
 * preview; OK commits one history step, Cancel / Escape reverts.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import type { AnchorRef, ID } from '@/model/types';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row } from '@/ui/widgets';
import { getState, useStore } from '@/store/store';
import { registerCommands } from '@/commands/registry';
import { editablePathIds } from '@/tools/pathEditing/anchors';
import { setCornerRadii, setCornerRadiusWorld, commonCornerRadius, type CornerTarget } from '@/tools/pathEditing/corners';
import { worldMatrix } from '@/model/document';
import { scaleFactor } from '@/geometry/matrix';

export interface CornersDialogProps {
  /** explicit corners (from a widget); otherwise the selection decides */
  targets?: Array<{ nodeId: ID; target: CornerTarget }>;
  /** radius to start from, world units (a widget's current value) */
  radius?: number;
}

let lastRadius = 10;

function CornersDialog({ props, close }: { props: CornersDialogProps; close: () => void }) {
  const units = useStore((s) => s.prefs.units);
  const session = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    const st = getState();
    const ids = editablePathIds(st.doc, st.selection);
    const anchors: AnchorRef[] = st.selectedAnchors.slice();
    const common = commonCornerRadius(st.doc, ids, anchors);
    return { base: st.doc, ids, anchors, common };
  }, []);
  const { base, ids, anchors, common } = session;
  const explicit = props.targets && props.targets.length ? props.targets : null;
  const [radius, setRadius] = useState<number>(props.radius !== undefined ? props.radius : common.radius ?? lastRadius);
  const [preview, setPreview] = useState(true);
  const committed = useRef(false);
  const radiusRef = useRef(radius);
  radiusRef.current = radius;

  const apply = useCallback(
    (d: typeof base) => {
      const r = Math.max(0, radiusRef.current);
      if (explicit) {
        for (const t of explicit) {
          // widget radii are world units: convert per node
          const k = scaleFactor(worldMatrix(d, t.nodeId)) || 1;
          setCornerRadiusWorld(d, t.nodeId, t.target, r * (props.radius !== undefined ? 1 : k));
        }
        return;
      }
      setCornerRadii(d, ids, r, anchors);
    },
    [explicit, ids, anchors, props.radius],
  );

  const previewKey = `${radius}/${preview}`;
  useEffect(() => {
    const s = getState();
    if (!preview) {
      s.revert();
      return;
    }
    const doc = produce(base, (d) => apply(d));
    if (doc !== s.doc) s.replaceDoc(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  useEffect(
    () => () => {
      if (!committed.current) getState().revert();
    },
    [],
  );

  const ok = useCallback(() => {
    const s = getState();
    s.revert();
    committed.current = true;
    lastRadius = radiusRef.current;
    s.updateDoc((d) => apply(d), 'Round Corners');
    close();
  }, [apply, close]);

  const cancel = useCallback(() => {
    getState().revert();
    committed.current = true;
    close();
  }, [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.('.corners-dialog')) setTimeout(ok, 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ok]);

  const count = explicit ? explicit.length : common.corners;
  return (
    <DialogFrame
      title="Corners"
      onClose={cancel}
      width={340}
      className="corners-dialog"
      footer={
        <>
          <Button onClick={cancel} data-testid="corners-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} disabled={!count} data-testid="corners-ok">
            OK
          </Button>
        </>
      }
    >
      {!count && <div className="muted">Select a path or some of its corner anchors.</div>}
      <Row gap={10}>
        <NumberField label="Radius" value={radius} onChange={(v) => setRadius(Math.max(0, v))} unit={units} min={0} step={1} width={170} data-testid="corners-radius" title="Live corner radius; the corner stays editable as a sharp anchor" />
        <Checkbox checked={preview} onChange={setPreview} label="Preview" />
      </Row>
      <div className="muted small">
        {count} corner{count === 1 ? '' : 's'}
        {anchors.length && !explicit ? ' (selected anchors)' : ''}. Radii that do not fit are reduced to the room the neighbouring corners leave.
      </div>
    </DialogFrame>
  );
}

registerDialog<CornersDialogProps>('corners', ({ props, close }) => <CornersDialog props={props ?? {}} close={close} />);

registerCommands([
  {
    id: 'path.corners',
    label: 'Corners…',
    menu: 'Object/Path',
    order: 23,
    run: () => getState().openDialog('corners', {}),
    enabled: (s) => editablePathIds(s.doc, s.selection).length > 0,
  },
]);
