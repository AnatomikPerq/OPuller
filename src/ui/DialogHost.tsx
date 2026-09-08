import React, { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useStore } from '@/store/store';
import { getDialog, onDialogsChanged, dialogCount } from './dialogs/registry';
import { ErrorBoundary } from './Dock';

/** Generic dialog frame used by all dialogs. */
export function DialogFrame({ title, children, footer, onClose, width, className }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${className ?? ''}`} style={{ width }} role="dialog" aria-modal data-keyboard-scope data-testid="dialog">
        <div className="dialog-header">
          <span>{title}</span>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const close = useStore((s) => s.closeDialog);
  useSyncExternalStore(onDialogsChanged, dialogCount, () => 0);
  if (!dialog) return null;
  const Comp = getDialog(dialog.type);
  if (!Comp) {
    return createPortal(
      <DialogFrame title="Not available" onClose={close}>
        <div className="muted">Dialog "{dialog.type}" is not registered.</div>
      </DialogFrame>,
      document.body,
    );
  }
  return createPortal(
    <ErrorBoundary>
      <Comp props={dialog.props ?? {}} close={close} />
    </ErrorBoundary>,
    document.body,
  );
}
