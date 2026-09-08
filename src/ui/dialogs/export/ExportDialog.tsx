/**
 * Export dialog: SVG / PNG / JPEG / WebP / PDF with scope, size, background and
 * format options, a live preview and Export / Copy SVG actions.
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
import { fontFaceCss } from '@/io/fontEmbed';
import { writeTextToClipboard } from '@/io/clipboard';

export type ExportFormat = 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf';
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
};

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
  };
}

async function documentForExport(doc: Document, st: ExportSettings, ids: ID[]): Promise<{ doc: Document; failed: string[] }> {
  if (st.format !== 'svg' && st.format !== 'pdf') return { doc, failed: [] };
  if (!st.outlineText) return { doc, failed: [] };
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
  return EXT[format];
}

function mimeFor(format: ExportFormat): string {
  if (format === 'svg') return 'image/svg+xml';
  if (format === 'pdf') return 'application/pdf';
  return MIME[format];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const regions = useMemo(() => exportRegions(doc, { scope: st.scope, ids, artboardId: activeArtboardId, margin: st.scope === 'selection' || st.scope === 'document' ? st.margin : 0 }), [doc, st.scope, ids, activeArtboardId, st.margin]);
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
        const r = await rasterizeRegion(d, region, { scale: fit, format: st.format === 'jpeg' ? 'jpeg' : 'png', backgroundColor: st.format === 'jpeg' && !bg ? '#ffffff' : bg, includeHidden: st.includeHidden, embedFonts: true });
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
      const { doc: d, failed } = await documentForExport(doc, st, ids);
      if (failed.length) s.toast(`Some text could not be outlined: ${failed[0]}`, 'info');
      const ext = extFor(st.format);
      const mime = mimeFor(st.format);
      let count = 0;
      if (st.format === 'pdf') {
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
            const r = await rasterizeRegion(d, rg, { ...rasterOpts, format: st.format as RasterFormat, quality: st.quality, backgroundColor: backgroundColor(st.background, st.customColor, rg), includeHidden: st.includeHidden });
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
            <Download size={13} /> {busy ?? (regions.length > 1 && st.format !== 'pdf' ? `Export ${regions.length} files` : 'Export')}
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
          <div className="io-form-row">
            <span className="io-form-label">File name</span>
            <Row gap={6}>
              <TextField value={st.fileName} placeholder={region?.name ?? 'untitled'} onChange={(v) => patch({ fileName: v })} onCommit={(v) => patch({ fileName: v })} id="export-filename" />
              <span className="io-hint">{ext}</span>
            </Row>
          </div>
          {fontWarning.length > 0 && (st.format === 'svg' || st.format === 'pdf') && !st.outlineText && <div className="io-warning">Fonts not embeddable (system fonts): {fontWarning.join(', ')}. Convert text to outlines for identical output.</div>}
          {st.format === 'pdf' && regions.length > 1 && <div className="io-hint">{regions.length} pages, one per artboard.</div>}
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
              {regions.length > 1 && st.format !== 'pdf' && <span>{regions.length} files</span>}
              <span title={namePreview}>{namePreview}</span>
            </div>
          )}
        </div>
      </div>
    </DialogFrame>
  );
}
