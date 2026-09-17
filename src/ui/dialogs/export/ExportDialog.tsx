/**
 * Export dialog: SVG / PNG / JPEG / WebP / PDF / EPS / AI with scope, size,
 * background and format options, a live preview and Export / Copy SVG actions.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Segmented, Select, Slider, Tabs, TextField, PopoverButton } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { getState, useStore } from '@/store/store';
import type { Document, ID } from '@/model/types';
import { formatLength } from '@/util/units';
import { saveFile, hasFSAccess } from '@/util/files';
import { exportRegions, renderRegion, withTextOutlines, safeFileName, type ExportScope, type ExportRegion, type SvgExportOptions } from '@/io/svgExport';
import { rasterizeRegion, canvasToBlob, canvasToDataUrl, pixelSize, dpiToScale, MIME, EXT, type RasterFormat } from '@/io/raster';
import { exportPdf } from '@/io/pdf';
import { exportEps, prepareEpsImages } from '@/io/epsExport';
import { exportAiAll } from '@/io/aiExport';
import { prepareDocumentForAi, type AiTextMode } from '@/io/aiPrepare';
import { fontFaceCss } from '@/io/fontEmbed';
import { writeTextToClipboard } from '@/io/clipboard';
import { bleedIsZero, type PrinterMarks } from '@/print/marks';

export type ExportFormat = 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'eps' | 'ai';
type AiFlavor = 'legacy' | 'pdf';
type SizeMode = 'scale' | 'dpi' | 'width';
type Background = 'transparent' | 'white' | 'artboard' | 'custom';

export interface ExportDialogProps {
  scope?: ExportScope;
}

interface ExportSettings {
  format: ExportFormat;
  scope: ExportScope;
  sizeMode: SizeMode;
  scale: number;
  dpi: number;
  width: number;
  background: Background;
  customColor: string;
  quality: number;
  pretty: boolean;
  responsive: boolean;
  precision: number;
  includeHidden: boolean;
  outlineText: boolean;
  embedFonts: boolean;
  margin: number;
  fileName: string;
  /** include the document bleed around artboards */
  bleed: boolean;
  /** EPS colours as CMYK */
  epsCmyk: boolean;
  /** AI: Illustrator 8 native file or a PDF-compatible .ai */
  aiFormat: AiFlavor;
  /** AI: how text is written (see aiPrepare) */
  aiText: AiTextMode;
  aiEncoding: 'latin1' | 'cp1251';
  /** AI: process colours as CMYK inks; null = follow the document colour mode */
  aiCmyk: boolean | null;
  /** printer's marks */
  marks: boolean;
  trimMarks: boolean;
  registrationMarks: boolean;
  colorBars: boolean;
  pageInfo: boolean;
}

const DEFAULTS: ExportSettings = {
  format: 'png',
  scope: 'artboard',
  sizeMode: 'scale',
  scale: 1,
  dpi: 72,
  width: 1920,
  background: 'artboard',
  customColor: '#ffffff',
  quality: 0.9,
  pretty: true,
  responsive: false,
  precision: 3,
  includeHidden: false,
  outlineText: false,
  embedFonts: false,
  margin: 0,
  fileName: '',
  bleed: false,
  epsCmyk: false,
  aiFormat: 'legacy',
  aiText: 'auto',
  aiEncoding: 'latin1',
  aiCmyk: null,
  marks: false,
  trimMarks: true,
  registrationMarks: true,
  colorBars: true,
  pageInfo: true,
};

function marksFor(st: ExportSettings): PrinterMarks | undefined {
  if (!st.marks) return undefined;
  return { trimMarks: st.trimMarks, registrationMarks: st.registrationMarks, colorBars: st.colorBars, pageInfo: st.pageInfo };
}

/** Settings persist while the app is open (like Illustrator's export dialogs). */
let lastSettings: ExportSettings = { ...DEFAULTS };

const SCALE_PRESETS = [0.5, 1, 2, 3, 4];
const DPI_PRESETS = [72, 150, 300];

function backgroundColor(bg: Background, custom: string, region: ExportRegion | null): string | null {
  switch (bg) {
    case 'transparent':
      return null;
    case 'white':
      return '#ffffff';
    case 'custom':
      return custom;
    case 'artboard':
      return region?.background ?? null;
  }
}

/** Build the SVG export options from the settings. */
function svgOptions(st: ExportSettings, ids: ID[], artboardId: ID | null, region: ExportRegion | null): SvgExportOptions {
  return {
    scope: st.scope,
    ids,
    artboardId,
    includeHidden: st.includeHidden,
    pretty: st.pretty,
    responsive: st.responsive,
    precision: st.precision,
    margin: st.scope === 'selection' || st.scope === 'document' ? st.margin : 0,
    backgroundColor: backgroundColor(st.background, st.customColor, region),
    xmlDeclaration: true,
    bleed: st.bleed ? true : undefined,
    marks: marksFor(st),
  };
}

async function documentForExport(doc: Document, st: ExportSettings, ids: ID[]): Promise<{ doc: Document; failed: string[]; warnings?: string[] }> {
  if (st.format === 'ai' && st.aiFormat === 'legacy') {
    const r = await prepareDocumentForAi(doc, { ids: st.scope === 'selection' ? ids : undefined, textMode: st.aiText, encoding: st.aiEncoding });
    return { doc: r.doc, failed: r.failed, warnings: r.warnings };
  }
  if (st.format !== 'svg' && st.format !== 'pdf' && st.format !== 'eps' && st.format !== 'ai') return { doc, failed: [] };
  if (!st.outlineText && st.format !== 'eps') return { doc, failed: [] };
  // EPS has no font embedding: text is always outlined
  return withTextOutlines(doc, st.scope === 'selection' ? ids : undefined);
}

function fileNameFor(st: ExportSettings, region: ExportRegion, regions: ExportRegion[], ext: string): string {
  const base = st.fileName.trim() ? safeFileName(st.fileName.trim().replace(/\.[a-z0-9]+$/i, '')) : region.name;
  if (regions.length > 1 && st.fileName.trim()) {
    const ab = getState().doc.artboards.find((a) => a.id === region.artboardId);
    return `${base}-${safeFileName(ab?.name ?? String(regions.indexOf(region) + 1))}${ext}`;
  }
  return `${base}${ext}`;
}

function extFor(format: ExportFormat): string {
  if (format === 'svg') return '.svg';
  if (format === 'pdf') return '.pdf';
  if (format === 'eps') return '.eps';
  if (format === 'ai') return '.ai';
  return EXT[format];
}

function mimeFor(format: ExportFormat): string {
  if (format === 'svg') return 'image/svg+xml';
  if (format === 'pdf') return 'application/pdf';
  if (format === 'eps') return 'application/postscript';
  if (format === 'ai') return 'application/illustrator';
  return MIME[format];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AI files are byte strings (Latin-1 / Windows-1251): write one byte per character. */
function latin1Bytes(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function ExportDialog({ props, close }: { props: ExportDialogProps; close: () => void }) {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const activeArtboardId = useStore((s) => s.activeArtboardId);
  const units = useStore((s) => s.prefs.units);
  const [st, setSt] = useState<ExportSettings>(() => ({ ...lastSettings, scope: props.scope ?? (selection.length && lastSettings.scope === 'selection' ? 'selection' : lastSettings.scope === 'selection' ? 'artboard' : lastSettings.scope) }));
  const patch = useCallback((p: Partial<ExportSettings>) => setSt((s) => ({ ...s, ...p })), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; pixelW: number; pixelH: number; pages: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fontWarning, setFontWarning] = useState<string[]>([]);
  const previewSeq = useRef(0);

  useEffect(() => {
    lastSettings = st;
  }, [st]);

  const ids = useMemo(() => selection, [selection]);
  const isRaster = st.format === 'png' || st.format === 'jpeg' || st.format === 'webp';
  const regions = useMemo(
    () => exportRegions(doc, { scope: st.scope, ids, artboardId: activeArtboardId, margin: st.scope === 'selection' || st.scope === 'document' ? st.margin : 0, bleed: st.bleed ? true : undefined, marks: marksFor(st) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, st.scope, ids, activeArtboardId, st.margin, st.bleed, st.marks, st.trimMarks, st.registrationMarks, st.colorBars, st.pageInfo],
  );
  const artboardScope = (st.scope === 'artboard' || st.scope === 'artboards') && !(st.format === 'ai' && st.aiFormat === 'legacy');
  const hasBleed = !bleedIsZero(doc.bleed);
  const region = regions[0] ?? null;
  const rasterOpts = useMemo(() => {
    if (st.sizeMode === 'scale') return { scale: st.scale };
    if (st.sizeMode === 'dpi') return { scale: dpiToScale(st.dpi) };
    return { width: st.width };
  }, [st.sizeMode, st.scale, st.dpi, st.width]);
  const px = region ? pixelSize(region.rect, rasterOpts) : null;
  const hasText = useMemo(() => Object.values(doc.nodes).some((n) => n.type === 'text' && n.visible), [doc]);

  // --- live preview ------------------------------------------------------
  useEffect(() => {
    const seq = ++previewSeq.current;
    if (!region) {
      setPreview(null);
      setPreviewError(st.scope === 'selection' ? 'Select something to export.' : 'Nothing to export.');
      return;
    }
    setPreviewError(null);
    const t = setTimeout(async () => {
      try {
        const bg = backgroundColor(st.background, st.customColor, region);
        const fit = Math.min(240 / region.rect.width, 180 / region.rect.height, 2);
        const d = st.outlineText && (st.format === 'svg' || st.format === 'pdf') ? (await withTextOutlines(doc, st.scope === 'selection' ? ids : undefined)).doc : doc;
        const r = await rasterizeRegion(d, region, { scale: fit, format: st.format === 'jpeg' ? 'jpeg' : 'png', backgroundColor: st.format === 'jpeg' && !bg ? '#ffffff' : bg, includeHidden: st.includeHidden, embedFonts: true, bleed: st.bleed ? true : undefined, marks: marksFor(st) });
        if (seq !== previewSeq.current) return;
        setPreview({ url: canvasToDataUrl(r.canvas, 'png'), width: region.rect.width, height: region.rect.height, pixelW: px?.width ?? 0, pixelH: px?.height ?? 0, pages: regions.length });
      } catch (e: any) {
        if (seq !== previewSeq.current) return;
        setPreview(null);
        setPreviewError(String(e?.message ?? e));
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, region, st.background, st.customColor, st.format, st.outlineText, st.includeHidden, regions.length, px?.width, px?.height]);

  // fonts that cannot be embedded (system fonts) — informational
  useEffect(() => {
    if (!hasText) {
      setFontWarning([]);
      return;
    }
    let cancelled = false;
    void fontFaceCss(doc).then((r) => {
      if (!cancelled) setFontWarning(r.missing);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, hasText]);

  // --- actions -----------------------------------------------------------
  const doExport = async () => {
    if (!region) return;
    setBusy('Exporting…');
    const s = getState();
    try {
      const { doc: d, failed, warnings: prepWarnings } = await documentForExport(doc, st, ids);
      if (failed.length) s.toast(`Some text could not be outlined: ${failed[0]}`, 'info');
      const ext = extFor(st.format);
      const mime = mimeFor(st.format);
      let count = 0;
      const aiPdf = st.format === 'ai' && st.aiFormat === 'pdf';
      if (st.format === 'ai' && !aiPdf) {
        const results = exportAiAll(d, { ...svgOptions(st, ids, activeArtboardId, region), cmyk: st.aiCmyk ?? doc.colorMode === 'cmyk', encoding: st.aiEncoding });
        const notes = Array.from(new Set([...(prepWarnings ?? []), ...results.flatMap((r) => r.warnings)]));
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const rg = regions[i] ?? region;
          const blob = new Blob([latin1Bytes(r.ai)], { type: mime });
          const name = fileNameFor(st, rg, regions, ext);
          const handle = await saveFile(blob, { suggestedName: name, mime, extension: ext, description: 'Adobe Illustrator (legacy)' });
          if (handle || !hasFSAccess) count++;
          else break;
          if (!hasFSAccess && i < results.length - 1) await sleep(400);
        }
        if (count && notes.length) s.toast(`AI export notes: ${notes[0]}${notes.length > 1 ? ` (+${notes.length - 1} more)` : ''}`, 'info');
      } else if (aiPdf) {
        const res = await exportPdf(d, { ...svgOptions(st, ids, activeArtboardId, region), pretty: false });
        const name = fileNameFor(st, region, [region], ext);
        const handle = await saveFile(res.blob, { suggestedName: name, mime, extension: ext, description: 'Adobe Illustrator (PDF compatible)' });
        if (handle || !hasFSAccess) count = 1;
        if (res.rasterPages.length) s.toast(`Page${res.rasterPages.length > 1 ? 's' : ''} ${res.rasterPages.join(', ')} embedded as raster (vector conversion failed).`, 'info');
      } else if (st.format === 'eps') {
        await prepareEpsImages(d, st.scope === 'selection' ? ids : undefined);
        const res = exportEps(d, { ...svgOptions(st, ids, activeArtboardId, region), cmyk: st.epsCmyk });
        const blob = new Blob([res.eps], { type: 'application/postscript' });
        const name = fileNameFor(st, region, [region], ext);
        const handle = await saveFile(blob, { suggestedName: name, mime, extension: ext, description: 'EPS (PostScript)' });
        if (handle || !hasFSAccess) count = 1;
      } else if (st.format === 'pdf') {
        const res = await exportPdf(d, { ...svgOptions(st, ids, activeArtboardId, region), pretty: false });
        const name = fileNameFor(st, region, [region], ext);
        const handle = await saveFile(res.blob, { suggestedName: name, mime, extension: ext, description: 'PDF document' });
        if (handle || !hasFSAccess) count = 1;
        if (res.rasterPages.length) s.toast(`Page${res.rasterPages.length > 1 ? 's' : ''} ${res.rasterPages.join(', ')} embedded as raster (vector conversion failed).`, 'info');
      } else {
        const css = st.format === 'svg' && st.embedFonts ? (await fontFaceCss(d, st.scope === 'selection' ? ids : undefined)).css : '';
        for (let i = 0; i < regions.length; i++) {
          const rg = regions[i];
          let blob: Blob;
          if (st.format === 'svg') {
            const out = renderRegion(d, rg, { ...svgOptions(st, ids, activeArtboardId, rg), css: css || undefined, prefix: i ? `a${i}-` : '' });
            blob = new Blob([out.svg], { type: 'image/svg+xml;charset=utf-8' });
          } else {
            const r = await rasterizeRegion(d, rg, { ...rasterOpts, format: st.format as RasterFormat, quality: st.quality, backgroundColor: backgroundColor(st.background, st.customColor, rg), includeHidden: st.includeHidden, bleed: st.bleed ? true : undefined, marks: marksFor(st) });
            blob = await canvasToBlob(r.canvas, st.format as RasterFormat, st.quality);
          }
          const name = fileNameFor(st, rg, regions, ext);
          const handle = await saveFile(blob, { suggestedName: name, mime, extension: ext, description: `${st.format.toUpperCase()} image` });
          if (handle || !hasFSAccess) count++;
          else break; // cancelled
          if (!hasFSAccess && i < regions.length - 1) await sleep(400);
        }
      }
      if (count) {
        s.toast(count > 1 ? `Exported ${count} files` : `Exported ${fileNameFor(st, region, regions, ext)}`, 'success');
        close();
      }
    } catch (e: any) {
      s.toast(String(e?.message ?? e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copySvg = async () => {
    if (!region) return;
    setBusy('Copying…');
    try {
      const { doc: d } = await documentForExport(doc, { ...st, format: 'svg' }, ids);
      const css = st.embedFonts ? (await fontFaceCss(d, st.scope === 'selection' ? ids : undefined)).css : '';
      const out = renderRegion(d, region, { ...svgOptions(st, ids, activeArtboardId, region), css: css || undefined, xmlDeclaration: false });
      const ok = await writeTextToClipboard(out.svg, 'image/svg+xml');
      getState().toast(ok ? 'SVG copied to the clipboard' : 'Clipboard access was denied', ok ? 'success' : 'error');
    } catch (e: any) {
      getState().toast(String(e?.message ?? e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const scopeOptions = [
    { value: 'artboard' as ExportScope, label: doc.artboards.length > 1 ? 'Active artboard' : 'Artboard' },
    ...(doc.artboards.length > 1 ? [{ value: 'artboards' as ExportScope, label: `All artboards (${doc.artboards.length})` }] : []),
    { value: 'selection' as ExportScope, label: selection.length ? `Selection (${selection.length})` : 'Selection', disabled: !selection.length },
    { value: 'document' as ExportScope, label: 'Entire document' },
  ];

  const tabs: Array<{ id: ExportFormat; label: string }> = [
    { id: 'svg', label: 'SVG' },
    { id: 'png', label: 'PNG' },
    { id: 'jpeg', label: 'JPEG' },
    { id: 'webp', label: 'WebP' },
    { id: 'pdf', label: 'PDF' },
    { id: 'eps', label: 'EPS' },
    { id: 'ai', label: 'AI' },
  ];

  const ext = extFor(st.format);
  const namePreview = region ? fileNameFor(st, region, regions, ext) : '';

  return (
    <DialogFrame
      title="Export"
      onClose={close}
      width={700}
      className="io-export-dialog"
      footer={
        <>
          <Button onClick={copySvg} disabled={!region || !!busy} title="Copy the export as SVG markup">
            <Copy size={13} /> Copy SVG
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={doExport} disabled={!region || !!busy} data-testid="export-run">
            <Download size={13} /> {busy ?? (regions.length > 1 && st.format !== 'pdf' && !(st.format === 'ai' && st.aiFormat === 'pdf') ? `Export ${regions.length} files` : 'Export')}
          </Button>
        </>
      }
    >
      <Tabs value={st.format} tabs={tabs} onChange={(f) => patch({ format: f })} className="io-tabs-fill" />
      <div className="io-export">
        <div className="io-export-form">
          <div className="io-form-row">
            <span className="io-form-label">Export</span>
            <Select value={st.scope} options={scopeOptions} onChange={(v) => patch({ scope: v })} width="100%" id="export-scope" />
          </div>
          {(st.scope === 'selection' || st.scope === 'document') && (
            <div className="io-form-row">
              <span className="io-form-label">Margin</span>
              <NumberField value={st.margin} unit={units} min={0} max={10000} onChange={(v) => patch({ margin: v })} width={130} />
            </div>
          )}
          {isRaster && (
            <>
              <div className="io-form-row">
                <span className="io-form-label">Size</span>
                <Row gap={8} wrap>
                  <Segmented
                    value={st.sizeMode}
                    onChange={(v) => patch({ sizeMode: v })}
                    options={[
                      { value: 'scale', label: 'Scale' },
                      { value: 'dpi', label: 'DPI' },
                      { value: 'width', label: 'Width' },
                    ]}
                  />
                  {st.sizeMode === 'scale' && (
                    <Row gap={4}>
                      <Segmented value={String(st.scale)} onChange={(v) => patch({ scale: Number(v) })} options={SCALE_PRESETS.map((s) => ({ value: String(s), label: `${s}x` }))} />
                      <NumberField value={st.scale} min={0.05} max={16} step={0.5} decimals={2} suffix="x" onChange={(v) => patch({ scale: v })} width={70} />
                    </Row>
                  )}
                  {st.sizeMode === 'dpi' && (
                    <Row gap={4}>
                      <Segmented value={String(st.dpi)} onChange={(v) => patch({ dpi: Number(v) })} options={DPI_PRESETS.map((d) => ({ value: String(d), label: String(d) }))} />
                      <NumberField value={st.dpi} min={10} max={1200} step={10} decimals={0} suffix="dpi" onChange={(v) => patch({ dpi: v })} width={80} />
                    </Row>
                  )}
                  {st.sizeMode === 'width' && <NumberField value={st.width} min={1} max={8192} decimals={0} suffix="px" onChange={(v) => patch({ width: v })} width={90} data-testid="export-width" />}
                </Row>
              </div>
              {px && (
                <div className="io-form-row">
                  <span className="io-form-label" />
                  <span className="io-hint">
                    {px.width} × {px.height} px{regions.length > 1 ? ' (first artboard)' : ''}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="io-form-row">
            <span className="io-form-label">Background</span>
            <Row gap={8}>
              <Select
                value={st.background}
                onChange={(v) => patch({ background: v })}
                width={150}
                options={[
                  { value: 'artboard', label: 'Artboard colour' },
                  { value: 'transparent', label: st.format === 'jpeg' ? 'Transparent (white)' : 'Transparent' },
                  { value: 'white', label: 'White' },
                  { value: 'custom', label: 'Custom…' },
                ]}
              />
              {st.background === 'custom' && (
                <PopoverButton button={({ toggle, ref }) => <button type="button" ref={ref} className="io-color-swatch" style={{ background: st.customColor }} onClick={toggle} title="Background colour" />}>
                  <ColorPicker paint={{ type: 'solid', color: st.customColor, opacity: 1 }} onChange={(p) => p.type === 'solid' && patch({ customColor: p.color })} allowNone={false} allowGradient={false} />
                </PopoverButton>
              )}
            </Row>
          </div>
          {(st.format === 'jpeg' || st.format === 'webp') && (
            <div className="io-form-row">
              <span className="io-form-label">Quality</span>
              <Slider value={Math.round(st.quality * 100)} min={1} max={100} onChange={(v) => patch({ quality: v / 100 })} unit="%" />
            </div>
          )}
          {st.format === 'svg' && (
            <div className="io-form-row" style={{ alignItems: 'start' }}>
              <span className="io-form-label">SVG options</span>
              <div className="io-options">
                <Checkbox checked={st.pretty} onChange={(v) => patch({ pretty: v })} label="Pretty print" />
                <Checkbox checked={st.responsive} onChange={(v) => patch({ responsive: v })} label="Responsive (no width/height)" title="Omit the width and height attributes so the SVG scales to its container" />
                <Checkbox checked={st.includeHidden} onChange={(v) => patch({ includeHidden: v })} label="Include hidden objects" />
                <Checkbox checked={st.embedFonts} onChange={(v) => patch({ embedFonts: v })} label="Embed fonts" title="Embed the used web fonts as @font-face data URLs" />
                <Checkbox checked={st.outlineText} onChange={(v) => patch({ outlineText: v })} label="Convert text to outlines" disabled={!hasText} />
                <NumberField label="Precision" value={st.precision} min={0} max={8} decimals={0} onChange={(v) => patch({ precision: Math.round(v) })} width={110} title="Decimal places for coordinates" />
              </div>
            </div>
          )}
          {st.format === 'eps' && (
            <div className="io-form-row" style={{ alignItems: 'start' }}>
              <span className="io-form-label">EPS options</span>
              <div className="io-options">
                <Checkbox checked={st.epsCmyk} onChange={(v) => patch({ epsCmyk: v })} label="CMYK colours (setcmykcolor)" title="Write colours as process inks for print workflows" />
                <Checkbox checked={st.includeHidden} onChange={(v) => patch({ includeHidden: v })} label="Include hidden objects" />
                <span className="io-hint">PostScript Level 3: paths, clipping, gradients (shfill), images; text is converted to outlines.</span>
              </div>
            </div>
          )}
          {st.format === 'ai' && (
            <div className="io-form-row" style={{ alignItems: 'start' }}>
              <span className="io-form-label">AI options</span>
              <div className="io-options">
                <Segmented
                  value={st.aiFormat}
                  onChange={(v) => patch({ aiFormat: v })}
                  options={[
                    { value: 'legacy', label: 'Illustrator 8 (editable)', title: 'Native Illustrator format: layers, groups, compound paths, text, gradients and spot colours stay editable in Illustrator and CorelDRAW' },
                    { value: 'pdf', label: 'PDF compatible', title: 'A PDF with the .ai extension: transparency and embedded fonts, opened by Illustrator as PDF content (layers are flattened)' },
                  ]}
                />
                {st.aiFormat === 'legacy' ? (
                  <>
                    <Row gap={6}>
                      <span className="io-hint">Text</span>
                      <Select
                        value={st.aiText}
                        onChange={(v) => patch({ aiText: v })}
                        width={250}
                        options={[
                          { value: 'auto', label: 'Editable (Latin), outline the rest' },
                          { value: 'editable', label: 'Editable (all, Windows-1251 for Cyrillic)' },
                          { value: 'outlines', label: 'Convert all text to outlines' },
                        ]}
                        id="export-ai-text"
                      />
                    </Row>
                    <Checkbox checked={st.aiCmyk ?? doc.colorMode === 'cmyk'} onChange={(v) => patch({ aiCmyk: v })} label="CMYK colours (k / K)" title="Write process colours as inks; spot swatches are always written as named custom colours" />
                    <Checkbox checked={st.includeHidden} onChange={(v) => patch({ includeHidden: v })} label="Include hidden objects" />
                    <span className="io-hint">Brushes, patterns, effects and variable-width strokes are expanded; opacity and blend modes are not part of the format. One file per artboard.</span>
                  </>
                ) : (
                  <>
                    <Checkbox checked={st.outlineText} onChange={(v) => patch({ outlineText: v })} label="Convert text to outlines" disabled={!hasText} />
                    <Checkbox checked={st.includeHidden} onChange={(v) => patch({ includeHidden: v })} label="Include hidden objects" />
                    <span className="io-hint">Illustrator opens the file as PDF content: appearance is preserved, layers are flattened.</span>
                  </>
                )}
              </div>
            </div>
          )}
          {st.format === 'pdf' && (
            <div className="io-form-row" style={{ alignItems: 'start' }}>
              <span className="io-form-label">PDF options</span>
              <div className="io-options">
                <Checkbox checked={st.outlineText} onChange={(v) => patch({ outlineText: v })} label="Convert text to outlines" disabled={!hasText} title="Recommended: PDF viewers substitute fonts that are not installed" />
                <Checkbox checked={st.includeHidden} onChange={(v) => patch({ includeHidden: v })} label="Include hidden objects" />
              </div>
            </div>
          )}
          {isRaster && (
            <div className="io-form-row">
              <span className="io-form-label" />
              <Checkbox checked={st.includeHidden} onChange={(v) => patch({ includeHidden: v })} label="Include hidden objects" />
            </div>
          )}
          {artboardScope && (
            <div className="io-form-row" style={{ alignItems: 'start' }}>
              <span className="io-form-label">Print</span>
              <div className="io-options io-marks-options">
                <Checkbox checked={st.bleed} onChange={(v) => patch({ bleed: v })} label={hasBleed ? 'Use document bleed' : 'Use document bleed (none set — File > Document Setup)'} disabled={!hasBleed} title="Export the bleed area around the artboard" />
                <Checkbox checked={st.marks} onChange={(v) => patch({ marks: v })} label="Printer's marks" title="Trim marks, registration marks, colour bars and page information outside the bleed" />
                {st.marks && (
                  <div className="io-marks-sub">
                    <Checkbox checked={st.trimMarks} onChange={(v) => patch({ trimMarks: v })} label="Trim marks" />
                    <Checkbox checked={st.registrationMarks} onChange={(v) => patch({ registrationMarks: v })} label="Registration marks" />
                    <Checkbox checked={st.colorBars} onChange={(v) => patch({ colorBars: v })} label="Color bars" />
                    <Checkbox checked={st.pageInfo} onChange={(v) => patch({ pageInfo: v })} label="Page information" />
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="io-form-row">
            <span className="io-form-label">File name</span>
            <Row gap={6}>
              <TextField value={st.fileName} placeholder={region?.name ?? 'untitled'} onChange={(v) => patch({ fileName: v })} onCommit={(v) => patch({ fileName: v })} id="export-filename" />
              <span className="io-hint">{ext}</span>
            </Row>
          </div>
          {fontWarning.length > 0 && (st.format === 'svg' || st.format === 'pdf') && !st.outlineText && <div className="io-warning">Fonts not embeddable (system fonts): {fontWarning.join(', ')}. Convert text to outlines for identical output.</div>}
          {(st.format === 'pdf' || (st.format === 'ai' && st.aiFormat === 'pdf')) && regions.length > 1 && <div className="io-hint">{regions.length} pages, one per artboard.</div>}
        </div>
        <div className="io-export-preview">
          <div className="io-preview-box" data-testid="export-preview">
            {preview && <img src={preview.url} alt="Export preview" />}
            {!preview && <div className="io-preview-msg">{previewError ?? 'Rendering preview…'}</div>}
          </div>
          {region && (
            <div className="io-preview-info">
              <span>
                {formatLength(region.rect.width, units)} × {formatLength(region.rect.height, units)}
              </span>
              {isRaster && px && (
                <span>
                  {px.width} × {px.height} px
                </span>
              )}
              {st.format === 'pdf' && (
                <span>
                  {(region.rect.width * 0.75).toFixed(1)} × {(region.rect.height * 0.75).toFixed(1)} pt · {regions.length} page{regions.length > 1 ? 's' : ''}
                </span>
              )}
              {regions.length > 1 && st.format !== 'pdf' && !(st.format === 'ai' && st.aiFormat === 'pdf') && <span>{regions.length} files</span>}
              <span title={namePreview}>{namePreview}</span>
            </div>
          )}
        </div>
      </div>
    </DialogFrame>
  );
}
