/**
 * Opening / placing PDF, AI and EPS files: detects the format (PDF-compatible
 * AI files are PDFs; classic AI and EPS are PostScript), shows the import
 * options dialog for multi-page documents and converts the result into a new
 * document or placed artwork.
 */
import React, { useEffect, useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Row, Segmented, Checkbox } from '@/ui/widgets';
import { getState } from '@/store/store';
import type { Document } from '@/model/types';
import { createDocument } from '@/model/nodes';
import { extensionOf, baseName } from '@/util/files';
import { importPdf, pdfOffset, pdfPageCount, type PdfImportOptions } from './pdfImport';
import { importAi, looksLikeAiOrEps } from './aiImport';
import { itemsToLayers, type ImportedItem } from './svgImport';
import { loadDocument, placeItems } from './fileOps';

export type VectorKind = 'pdf' | 'ai-pdf' | 'ai-ps' | 'eps';

export function isVectorDocFile(file: File): boolean {
  const ext = extensionOf(file.name);
  return ext === 'pdf' || ext === 'ai' || ext === 'eps' || file.type === 'application/pdf' || file.type === 'application/postscript' || file.type === 'application/illustrator';
}

/** Detect the kind of a vector document from its bytes and name. */
export function detectVectorKind(bytes: Uint8Array, name: string): VectorKind | null {
  const ext = extensionOf(name);
  const pdfAt = pdfOffset(bytes);
  if (pdfAt >= 0) return ext === 'ai' ? 'ai-pdf' : 'pdf';
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 4000));
  if (looksLikeAiOrEps(head)) return ext === 'ai' ? 'ai-ps' : 'eps';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'ai') return 'ai-ps';
  if (ext === 'eps') return 'eps';
  return null;
}

export interface VectorImportOptions extends PdfImportOptions {
  /** 'open' → new document, 'place' → into the current document */
  action: 'open' | 'place';
}

export interface VectorImportResult {
  items: ImportedItem[];
  width: number;
  height: number;
  warnings: string[];
  pages: number;
  kind: VectorKind;
}

/** Convert the bytes of a PDF / AI / EPS into import items. */
export async function importVector(bytes: ArrayBuffer, name: string, opts: PdfImportOptions = {}): Promise<VectorImportResult> {
  const u8 = new Uint8Array(bytes);
  const kind = detectVectorKind(u8, name);
  if (!kind) throw new Error(`"${name}" is not a PDF, AI or EPS file.`);
  if (kind === 'pdf' || kind === 'ai-pdf') {
    const off = pdfOffset(u8);
    const data = off > 0 ? bytes.slice(off) : bytes;
    const r = await importPdf(data, { ...opts, name: opts.name ?? baseName(name) });
    return { items: r.items, width: r.width, height: r.height, warnings: r.warnings, pages: r.pages, kind };
  }
  const text = new TextDecoder('latin1').decode(u8);
  const r = importAi(text, { name: opts.name ?? baseName(name) });
  return { items: r.items, width: r.width, height: r.height, warnings: r.warnings, pages: 1, kind };
}

function documentFromItems(items: ImportedItem[], name: string, width: number, height: number): Document {
  const doc = createDocument({ name, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
  const layers = itemsToLayers(items);
  doc.nodes = {};
  doc.layers = [];
  for (const item of layers) {
    for (const n of item.nodes) doc.nodes[n.id] = n;
    item.root.parent = null;
    doc.layers.push(item.root.id);
  }
  return doc;
}

/** Run an import with options and apply it (open as a document or place). */
export async function applyVectorImport(bytes: ArrayBuffer, name: string, opts: VectorImportOptions): Promise<VectorImportResult> {
  const s = getState();
  s.setStatus('Importing…');
  const r = await importVector(bytes, name, opts);
  if (opts.action === 'open') {
    const doc = documentFromItems(r.items, baseName(name), r.width, r.height);
    loadDocument(doc, { fileName: null, handle: null, dirty: true });
  } else if (r.items.length) placeItems(r.items, { name: baseName(name), label: 'Place' });
  const st = getState();
  st.setStatus('');
  if (!r.items.length) st.toast(`Nothing importable found in "${name}"`, 'error');
  else if (r.warnings.length) st.toast(`${name}: ${r.warnings[0]}`, 'info');
  return r;
}

/**
 * Entry point for the file pipeline: multi-page PDFs (and any PDF, so the
 * user can choose "as image") open the import options dialog; PostScript
 * files import directly.
 */
export async function openVectorFile(file: File, action: 'open' | 'place'): Promise<void> {
  const bytes = await file.arrayBuffer();
  const kind = detectVectorKind(new Uint8Array(bytes), file.name);
  if (!kind) throw new Error(`Cannot open "${file.name}": not a PDF, AI or EPS file.`);
  if (kind === 'pdf' || kind === 'ai-pdf') {
    let pages = 1;
    try {
      const off = pdfOffset(new Uint8Array(bytes));
      pages = await pdfPageCount(off > 0 ? bytes.slice(off) : bytes);
    } catch (err) {
      throw new Error(`Cannot read "${file.name}": ${(err as Error)?.message ?? err}`);
    }
    getState().openDialog('vectorImport', { bytes, name: file.name, action, pages, kind });
    return;
  }
  await applyVectorImport(bytes, file.name, { action });
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

let lastMode: 'objects' | 'image' = 'objects';
let lastText = true;

function VectorImportDialog({ props, close }: { props: { bytes: ArrayBuffer; name: string; action: 'open' | 'place'; pages: number; kind: VectorKind }; close: () => void }) {
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<'objects' | 'image'>(lastMode);
  const [text, setText] = useState(lastText);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const off = pdfOffset(new Uint8Array(props.bytes));
        const r = await importPdf(off > 0 ? props.bytes.slice(off) : props.bytes, { page, mode: 'image', scale: 0.4, name: 'preview' });
        const img = r.items[0]?.root;
        if (!cancelled && img && img.type === 'image') setPreview(img.src);
      } catch {
        if (!cancelled) setPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, props.bytes]);
  const ok = async () => {
    setBusy(true);
    lastMode = mode;
    lastText = text;
    try {
      await applyVectorImport(props.bytes, props.name, { action: props.action, page, mode, text });
      close();
    } catch (err) {
      getState().toast(String((err as Error)?.message ?? err), 'error');
      setBusy(false);
    }
  };
  const label = props.kind === 'ai-pdf' ? 'Illustrator (PDF compatible)' : 'PDF';
  return (
    <DialogFrame
      title={`${props.action === 'open' ? 'Open' : 'Place'} ${label}`}
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} disabled={busy} data-testid="vector-import-ok">
            {busy ? 'Importing…' : 'OK'}
          </Button>
        </>
      }
    >
      <div className="io-export">
        <div className="io-export-form">
          <div className="io-form-row">
            <span className="io-form-label">File</span>
            <span>{props.name}</span>
          </div>
          <div className="io-form-row">
            <span className="io-form-label">Page</span>
            <Row gap={8}>
              <NumberField value={page} min={1} max={props.pages} decimals={0} onChange={(v) => setPage(Math.max(1, Math.min(props.pages, Math.round(v))))} width={90} data-testid="vector-import-page" />
              <span className="io-hint">of {props.pages}</span>
            </Row>
          </div>
          <div className="io-form-row">
            <span className="io-form-label">Import as</span>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'objects', label: 'Editable objects', title: 'Paths, images and text become editable objects' },
                { value: 'image', label: 'Image', title: 'The page is rasterised' },
              ]}
            />
          </div>
          {mode === 'objects' && (
            <div className="io-form-row">
              <span className="io-form-label" />
              <Checkbox checked={text} onChange={setText} label="Import text as editable text (fonts are substituted)" />
            </div>
          )}
          <div className="io-hint">Vector paths, fills, strokes, clipping and images are converted. Gradients, patterns and transparency groups are simplified.</div>
        </div>
        <div className="io-export-preview">{preview ? <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: 220, border: '1px solid var(--border)' }} /> : <span className="io-hint">Rendering preview…</span>}</div>
      </div>
    </DialogFrame>
  );
}

registerDialog('vectorImport', VectorImportDialog as any);

void React;
