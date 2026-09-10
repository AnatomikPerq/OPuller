/**
 * In-app confirmation dialog (replaces window.confirm): a message, a
 * cancel button and a (possibly destructive) confirm button. Use
 * `confirmDialog(...)` to get a promise, or open the 'confirm' dialog with an
 * onConfirm callback.
 */
import React, { useEffect, useRef } from 'react';
import { registerDialog } from '../registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button } from '@/ui/widgets';
import { getState } from '@/store/store';
import './confirm.css';

export interface ConfirmProps {
  title?: string;
  message: string;
  /** smaller secondary line under the message */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** red confirm button for destructive actions */
  danger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

function ConfirmDialog({ props, close }: { props: ConfirmProps; close: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const finish = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    close();
    if (ok) props.onConfirm?.();
    else props.onCancel?.();
  };
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <DialogFrame
      title={props.title ?? 'Confirm'}
      onClose={() => finish(false)}
      width={400}
      className="confirm-dialog"
      footer={
        <>
          <Button onClick={() => finish(false)} data-testid="confirm-cancel">
            {props.cancelLabel ?? 'Cancel'}
          </Button>
          <span ref={okRef as unknown as React.RefObject<HTMLSpanElement>} tabIndex={-1} className="confirm-ok-wrap">
            <Button primary={!props.danger} danger={props.danger} onClick={() => finish(true)} data-testid="confirm-ok">
              {props.confirmLabel ?? 'OK'}
            </Button>
          </span>
        </>
      }
    >
      <div className="confirm-message" data-testid="confirm-message">
        {props.message}
      </div>
      {props.detail && <div className="dim small confirm-detail">{props.detail}</div>}
    </DialogFrame>
  );
}

registerDialog<ConfirmProps>('confirm', ConfirmDialog);

/** Ask the user to confirm an action; resolves with true when confirmed. */
export function confirmDialog(message: string, opts: Omit<ConfirmProps, 'message' | 'onConfirm' | 'onCancel'> = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    getState().openDialog('confirm', { ...opts, message, onConfirm: () => resolve(true), onCancel: () => resolve(false) } as unknown as Record<string, unknown>);
  });
}
