/**
 * Upload Font dialog: adds TTF/OTF/WOFF/WOFF2 files to the font registry
 * (persisted in IndexedDB) and optionally applies the family to the selection.
 */
import React, { useRef, useState } from 'react';
import { Upload, Trash2 } from 'lucide-react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, IconButton } from '@/ui/widgets';
import { getState } from '@/store/store';
import { uploadFont, removeUploadedFont, uploadedFonts, useFontRegistry, faceLabel, type UploadedFont } from '@/text/fonts';
import { applyTextStyle, selectedTextIds } from '@/tools/text/textStyle';
import { isEditing } from '@/tools/text/session';

function FontUploadDialog({ props, close }: { props: { applyToSelection?: boolean }; close: () => void }) {
  useFontRegistry();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const canApply = selectedTextIds().length > 0 || isEditing();
  const [apply, setApply] = useState(props.applyToSelection ?? canApply);
  const fonts = uploadedFonts();

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(true);
    setError(null);
    const added: UploadedFont[] = [];
    for (const f of list) {
      try {
        added.push(await uploadFont(f));
      } catch (err: any) {
        setError(String(err?.message ?? err));
      }
    }
    setBusy(false);
    if (added.length) {
      const first = added[0];
      getState().toast(`Added font "${first.family}" (${faceLabel(first.weight, first.style)})`, 'success');
      if (apply && canApply) applyTextStyle({ fontFamily: first.family, fontWeight: first.weight, fontStyle: first.style });
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <DialogFrame title="Upload Font" onClose={close} width={440} footer={<Button onClick={close}>Close</Button>}>
      <div
        className={`font-dropzone ${dragOver ? 'over' : ''}`}
        style={{
          border: `1px dashed ${dragOver ? 'var(--accent-strong)' : 'var(--border-strong)'}`,
          borderRadius: 6,
          padding: '18px 12px',
          textAlign: 'center',
          background: dragOver ? 'var(--accent-soft)' : 'var(--bg-panel-alt)',
          cursor: 'pointer',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
        data-testid="font-dropzone"
      >
        <Upload size={20} style={{ color: 'var(--text-muted)' }} />
        <div style={{ marginTop: 6 }}>Drop font files here or click to choose</div>
        <div className="muted small" style={{ marginTop: 2 }}>TTF, OTF, WOFF or WOFF2 · stored in this browser</div>
        <input ref={inputRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" multiple style={{ display: 'none' }} data-testid="font-file-input" onChange={(e) => e.target.files && void handleFiles(e.target.files)} />
      </div>
      {busy && <div className="muted">Loading…</div>}
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      {canApply && <Checkbox checked={apply} onChange={setApply} label="Apply to the selected text" />}
      <div className="muted small">Outlines (Type › Create Outlines) are available for TTF, OTF and WOFF fonts. WOFF2 fonts render but cannot be outlined.</div>
      {fonts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="section-title">Uploaded fonts</div>
          {fonts.map((f) => (
            <div key={f.id} className="row" style={{ gap: 6 }} data-testid="uploaded-font-row" data-family={f.family}>
              <span style={{ fontFamily: `"${f.family}"`, fontWeight: f.weight, fontStyle: f.style, fontSize: 14, flex: 1 }}>{f.family}</span>
              <span className="muted small">{faceLabel(f.weight, f.style)}</span>
              {!f.parsable && (
                <span className="dim small" title="WOFF2 — outlines not available">
                  no outlines
                </span>
              )}
              <IconButton icon={<Trash2 size={14} />} title="Remove font" onClick={() => void removeUploadedFont(f.id)} />
            </div>
          ))}
        </div>
      )}
    </DialogFrame>
  );
}

registerDialog<{ applyToSelection?: boolean }>('fontUpload', FontUploadDialog);
void React;
