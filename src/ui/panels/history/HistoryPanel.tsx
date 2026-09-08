/**
 * History panel: undo states, the current state and redo-able states (greyed).
 * Clicking a state jumps to it by undoing / redoing the required number of steps.
 */
import React, { useEffect, useRef } from 'react';
import { FileText, Undo2, Redo2, Check, Pencil } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { IconButton } from '@/ui/widgets';
import './history.css';

interface Row {
  index: number;
  label: string;
  kind: 'past' | 'current' | 'future' | 'pending';
}

export function HistoryPanel() {
  const past = useStore((s) => s.past);
  const future = useStore((s) => s.future);
  const pending = useStore((s) => s.doc !== s.historyBase);
  const listRef = useRef<HTMLDivElement>(null);

  const rows: Row[] = [];
  rows.push({ index: 0, label: past.length ? 'Original' : 'Original', kind: past.length ? 'past' : 'current' });
  past.forEach((p, i) => rows.push({ index: i + 1, label: p.label, kind: i === past.length - 1 ? 'current' : 'past' }));
  for (let k = future.length - 1; k >= 0; k--) rows.push({ index: past.length + (future.length - k), label: future[k].label, kind: 'future' });
  if (pending) rows.push({ index: -1, label: 'Editing…', kind: 'pending' });

  const jump = (index: number) => {
    const s = getState();
    const cur = s.past.length;
    if (index < cur) for (let i = 0; i < cur - index; i++) getState().undo();
    else if (index > cur) for (let i = 0; i < index - cur; i++) getState().redo();
  };

  useEffect(() => {
    const el = listRef.current?.querySelector('.hist-row.current') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [past.length, future.length]);

  return (
    <div className="history-panel" data-testid="history-panel">
      <div className="history-header">
        <span data-testid="history-count">
          {past.length} undo · {future.length} redo
        </span>
        <span className="grow" />
        <IconButton icon={<Undo2 size={13} />} title="Undo (Ctrl+Z)" disabled={!past.length && !pending} onClick={() => getState().undo()} data-testid="history-undo" />
        <IconButton icon={<Redo2 size={13} />} title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={() => getState().redo()} data-testid="history-redo" />
      </div>
      <div className="history-list" ref={listRef}>
        {rows.map((r) => (
          <div
            key={r.kind === 'pending' ? 'pending' : r.index}
            className={`hist-row ${r.kind}`}
            data-testid={r.kind === 'pending' ? 'history-pending' : `history-row-${r.index}`}
            onClick={() => r.kind !== 'pending' && r.kind !== 'current' && jump(r.index)}
            title={r.kind === 'future' ? 'Redo to this state' : r.kind === 'past' ? 'Undo to this state' : r.kind === 'pending' ? 'Uncommitted changes' : 'Current state'}
          >
            <span className="hist-index">{r.index >= 0 ? r.index : ''}</span>
            <span className="hist-icon">{r.kind === 'current' ? <Check size={12} /> : r.kind === 'future' ? <Redo2 size={12} /> : r.kind === 'pending' ? <Pencil size={12} /> : r.index === 0 ? <FileText size={12} /> : <Undo2 size={12} />}</span>
            <span className="hist-label">{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
