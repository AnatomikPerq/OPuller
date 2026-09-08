/**
 * Simplify dialog: curve-fitting tolerance with live preview and anchor
 * counts before / after. OK commits one history step, Cancel reverts.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, Slider, Row } from '@/ui/widgets';
import { getState } from '@/store/store';
import { selectionTargets } from '@/pathops/apply';
import { simplifyNodes, anchorTotal } from '@/pathops/pathEdit';

let lastTolerance = 2.5;

function SimplifyDialog({ close }: { close: () => void }) {
  const [tolerance, setTolerance] = useState(lastTolerance);
  const [preview, setPreview] = useState(true);
  const [counts, setCounts] = useState<{ before: number; after: number } | null>(null);
  const committed = useRef(false);
  const tolRef = useRef(tolerance);
  tolRef.current = tolerance;

  const session = useMemo(() => {
    const s = getState();
    if (s.doc !== s.historyBase) s.commit('Edit');
    const st = getState();
    const ids = selectionTargets(st).ids;
    return { base: st.doc, ids, before: anchorTotal(st.doc, ids) };
  }, []);
  const { base, ids, before } = session;

  const previewKey = JSON.stringify({ tolerance, preview });
  useEffect(() => {
    const s = getState();
    if (!ids.length) return;
    let result = { before, after: before };
    const doc = produce(base, (d) => {
      result = simplifyNodes(d, ids, tolRef.current);
    });
    setCounts(result);
    if (!preview) {
      s.revert();
      return;
    }
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
    lastTolerance = tolRef.current;
    if (ids.length) {
      s.updateDoc((d) => {
        simplifyNodes(d, ids, tolRef.current);
      }, 'Simplify');
      getState().setSelectedAnchors([]);
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
      if (t && t.closest?.('.simplify-dialog')) setTimeout(ok, 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ok]);

  const after = counts?.after ?? before;
  const pct = before ? Math.round((after / before) * 100) : 100;

  return (
    <DialogFrame
      title="Simplify"
      onClose={cancel}
      width={400}
      className="simplify-dialog"
      footer={
        <>
          <Button onClick={cancel} data-testid="simplify-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} disabled={!ids.length} data-testid="simplify-ok">
            OK
          </Button>
        </>
      }
    >
      {!ids.length && <div className="muted">Select one or more paths.</div>}
      <Slider label="Tolerance" value={tolerance} onChange={(v) => setTolerance(Math.max(0.1, v))} min={0.1} max={50} step={0.1} unit="px" decimals={1} />
      <div className="dim small">Higher tolerance removes more anchor points (curves are refitted).</div>
      <Row gap={14}>
        <span className="muted">
          Anchors: <b data-testid="simplify-before">{before}</b> → <b data-testid="simplify-after">{after}</b> <span className="dim">({pct}%)</span>
        </span>
        <Checkbox checked={preview} onChange={setPreview} label="Preview" />
      </Row>
    </DialogFrame>
  );
}

registerDialog('simplify', ({ close }) => <SimplifyDialog close={close} />);
