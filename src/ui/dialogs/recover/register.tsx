/**
 * Safety dialogs: Recover (autosave found on startup) and Unsaved Changes
 * (Save / Don't Save / Cancel before New, Open, Open Recent, Revert).
 */
import React, { useRef } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button } from '@/ui/widgets';
import type { Document } from '@/model/types';
import { loadDocument, type DiscardChoice } from '@/io/fileOps';
import { clearAutosave } from '@/io/autosave';

interface RecoverProps {
  record: { time: number; name: string; fileName: string | null };
  doc: Document;
}

function RecoverDialog({ props, close }: { props: RecoverProps; close: () => void }) {
  const { record, doc } = props;
  const when = new Date(record.time).toLocaleString();
  const recover = () => {
    loadDocument(doc, { fileName: record.fileName, dirty: true, remember: false });
    void clearAutosave();
    close();
  };
  const discard = () => {
    void clearAutosave();
    close();
  };
  return (
    <DialogFrame
      title="Recover Document"
      onClose={discard}
      width={440}
      footer={
        <>
          <Button onClick={discard} data-testid="recover-discard">
            Discard
          </Button>
          <Button primary onClick={recover} data-testid="recover-open">
            Recover
          </Button>
        </>
      }
    >
      <div>
        OPuller closed with unsaved changes in <b>{record.fileName ?? record.name}</b>.
      </div>
      <div className="muted small">Autosaved {when}. Recover the document or discard the autosaved copy.</div>
    </DialogFrame>
  );
}

interface UnsavedProps {
  action: string;
  name: string;
  onChoice: (choice: DiscardChoice) => void;
}

function UnsavedChangesDialog({ props, close }: { props: UnsavedProps; close: () => void }) {
  const answered = useRef(false);
  const choose = (c: DiscardChoice) => {
    if (answered.current) return;
    answered.current = true;
    close();
    props.onChoice(c);
  };
  return (
    <DialogFrame
      title="Unsaved Changes"
      onClose={() => choose('cancel')}
      width={420}
      footer={
        <>
          <Button onClick={() => choose('cancel')} data-testid="unsaved-cancel">
            Cancel
          </Button>
          <Button danger onClick={() => choose('discard')} data-testid="unsaved-discard">
            Don't Save
          </Button>
          <Button primary onClick={() => choose('save')} data-testid="unsaved-save">
            Save
          </Button>
        </>
      }
    >
      <div>
        Save changes to <b>{props.name}</b> before you {props.action}?
      </div>
      <div className="muted small">Your changes will be lost if you don't save them.</div>
    </DialogFrame>
  );
}

registerDialog<RecoverProps>('io.recover', RecoverDialog);
registerDialog<UnsavedProps>('io.unsavedChanges', UnsavedChangesDialog);

void React;
