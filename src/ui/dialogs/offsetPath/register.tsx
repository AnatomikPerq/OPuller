/**
 * Offset Path dialog: offset distance, joins, miter limit, live preview and
 * "create new path / replace" mode. Preview edits are uncommitted; OK commits
 * one history step, Cancel / Escape reverts.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import type { ID } from '@/model/types';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Select, Segmented, Row } from '@/ui/widgets';
import { getState, useStore } from '@/store/store';
import { selectionTargets } from '@/pathops/apply';
import { offsetNodes, type OffsetParams } from '@/pathops/pathEdit';

let last: OffsetParams = { offset: 10, join: 'miter', miterLimit: 4, mode: 'new' };

function OffsetPathDialog({ close }: { close: () => void }) {
  const units = useStore((s) => s.prefs.units);
  const [params, setParams] = useState<OffsetParams>(last);
  const [preview, setPreview] = useState(true);
  const committed = useRef(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const session = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    const st = getState();
    return { base: st.doc, ids: selectionTargets(st).ids };
  }, []);
  const { base, ids } = session;

  const previewKey = JSON.stringify({ params, preview });
  useEffect(() => {
    const s = getState();
    if (!preview || !ids.length) {
      s.revert();
      return;
    }
    const doc = produce(base, (d) => {
      offsetNodes(d, ids, paramsRef.current);
    });
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
    last = paramsRef.current;
    if (ids.length) {
      let created: ID[] = [];
      s.updateDoc((d) => {
        created = offsetNodes(d, ids, paramsRef.current);
      }, 'Offset Path');
      const st = getState();
      if (created.length) st.setSelection(created);
      else st.toast('Offset produced no geometry.', 'info');
    }
    close();
  }, [ids, close]);

  const cancel = useCallback(() => {
    getState().revert();
    committed.current = true;
    close();
  }, [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.('.offset-dialog')) setTimeout(ok, 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ok]);

  return (
    <DialogFrame
      title="Offset Path"
      onClose={cancel}
      width={380}
      className="offset-dialog"
      footer={
        <>
          <Button onClick={cancel} data-testid="offset-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} disabled={!ids.length} data-testid="offset-ok">
            OK
          </Button>
        </>
      }
    >
      {!ids.length && <div className="muted">Select one or more paths.</div>}
      <Row gap={10}>
        <NumberField label="Offset" value={params.offset} onChange={(v) => setParams({ ...params, offset: v })} unit={units} step={1} width={170} data-testid="offset-value" title="Positive values grow the shape, negative values shrink it" />
        <Select<OffsetParams['join']>
          label="Joins"
          value={params.join}
          onChange={(v) => setParams({ ...params, join: v })}
          options={[
            { value: 'miter', label: 'Miter' },
            { value: 'round', label: 'Round' },
            { value: 'bevel', label: 'Bevel' },
          ]}
          width={150}
          id="offset-join"
        />
      </Row>
      <Row gap={10}>
        <NumberField label="Miter limit" value={params.miterLimit} onChange={(v) => setParams({ ...params, miterLimit: v })} min={1} max={100} step={1} width={170} disabled={params.join !== 'miter'} data-testid="offset-miter" />
        <Checkbox checked={preview} onChange={setPreview} label="Preview" />
      </Row>
      <Row gap={8}>
        <span className="field-label">Result</span>
        <Segmented<OffsetParams['mode']>
          value={params.mode}
          onChange={(v) => setParams({ ...params, mode: v })}
          options={[
            { value: 'new', label: 'New path', title: 'Create the offset as a new path above the original' },
            { value: 'replace', label: 'Replace', title: 'Replace the original geometry' },
          ]}
        />
      </Row>
    </DialogFrame>
  );
}

registerDialog('offsetPath', ({ close }) => <OffsetPathDialog close={close} />);
