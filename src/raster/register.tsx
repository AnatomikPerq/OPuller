/**
 * Raster module wiring: Object > Image commands (Image Trace, Rasterize, Crop,
 * Reset Crop, Export Image) and their dialogs.
 */
import React, { useState, useEffect } from 'react';
import type { ID, ImageNode, Rect } from '@/model/types';
import { useStore, getState, type EditorState } from '@/store/store';
import { registerCommands, when } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Select, Checkbox, Row, Segmented, Slider } from '@/ui/widgets';
import { topmostOf, worldBounds } from '@/model/document';
import { downloadDataUrl } from '@/util/files';
import { traceToSvg, applyTrace, countTraced, DEFAULT_TRACE, TRACE_PRESETS, type TraceOptions, type TraceMode } from './trace';
import { rasterizeSelection, cropImageToRect, setImageCrop, DEFAULT_RASTERIZE, type RasterizeOptions } from './rasterize';
import './raster.css';

function selectedImages(s: EditorState = getState()): ID[] {
  return s.selection.filter((id) => s.doc.nodes[id]?.type === 'image');
}

const hasImage = (s: EditorState) => selectedImages(s).length > 0;
const singleImage = (s: EditorState) => selectedImages(s).length === 1;

let lastTrace: TraceOptions = { ...DEFAULT_TRACE };
let lastRasterize: RasterizeOptions = { ...DEFAULT_RASTERIZE };

export async function traceImages(ids: ID[], opts: TraceOptions): Promise<ID[]> {
  const s = getState();
  const traced: Array<{ id: ID; res: Awaited<ReturnType<typeof traceToSvg>> }> = [];
  for (const id of ids) {
    const n = s.doc.nodes[id] as ImageNode | undefined;
    if (!n || n.type !== 'image') continue;
    traced.push({ id, res: await traceToSvg(n, opts) });
  }
  const out: ID[] = [];
  getState().updateDoc((d) => {
    for (const t of traced) {
      const gid = applyTrace(d, t.id, t.res, opts);
      if (gid) out.push(gid);
    }
  }, 'Image Trace');
  if (out.length) {
    const st = getState();
    st.setSelection(out);
    const count = out.reduce((a, g) => a + countTraced(st.doc, g), 0);
    st.toast(`Traced ${count} path${count === 1 ? '' : 's'}`, 'success');
  } else getState().toast('Nothing could be traced from this image.', 'info');
  return out;
}

function cropCommand(): void {
  const s = getState();
  const imgs = selectedImages(s);
  if (imgs.length !== 1) return;
  const roots = topmostOf(s.doc, s.selection).filter((id) => id !== imgs[0]);
  const shape = roots.find((id) => s.doc.nodes[id]?.type === 'path');
  if (shape) {
    const b = worldBounds(s.doc, shape);
    if (!b) return;
    let ok = false;
    s.updateDoc((d) => {
      ok = cropImageToRect(d, imgs[0], b);
      if (ok) {
        const n = d.nodes[shape];
        if (n && n.parent) {
          const p = d.nodes[n.parent];
          if (p && (p.type === 'group' || p.type === 'layer')) p.children = p.children.filter((c) => c !== shape);
          delete d.nodes[shape];
        }
      }
    }, 'Crop Image');
    if (ok) getState().setSelection([imgs[0]]);
    else s.toast('The shape does not overlap the image.', 'info');
    return;
  }
  s.openDialog('cropImage', { id: imgs[0] });
}

registerCommands([
  { id: 'image.trace', label: 'Image Trace…', menu: 'Object/Image', order: 600, run: () => getState().openDialog('imageTrace', {}), enabled: hasImage },
  { id: 'image.traceLast', label: 'Trace with Last Settings', menu: 'Object/Image', order: 601, run: () => void traceImages(selectedImages(), lastTrace), enabled: hasImage },
  { id: 'object.rasterize', label: 'Rasterize…', menu: 'Object', order: 161, run: () => getState().openDialog('rasterize', {}), enabled: (s) => when.hasSelection(s) },
  { id: 'image.crop', label: 'Crop Image', menu: 'Object/Image', order: 610, separatorBefore: true, run: cropCommand, enabled: singleImage },
  {
    id: 'image.resetCrop',
    label: 'Reset Crop',
    menu: 'Object/Image',
    order: 611,
    run: () => {
      const ids = selectedImages();
      getState().updateDoc((d) => {
        for (const id of ids) setImageCrop(d, id, null);
      }, 'Reset Crop');
    },
    enabled: (s) => selectedImages(s).some((id) => !!(s.doc.nodes[id] as ImageNode).crop),
  },
  {
    id: 'image.resetSize',
    label: 'Reset to Natural Size',
    menu: 'Object/Image',
    order: 612,
    run: () => {
      const ids = selectedImages();
      getState().updateDoc((d) => {
        for (const id of ids) {
          const n = d.nodes[id] as ImageNode;
          const crop = n.crop ?? { width: n.naturalWidth, height: n.naturalHeight };
          n.width = crop.width;
          n.height = crop.height;
        }
      }, 'Reset Image Size');
    },
    enabled: hasImage,
  },
  {
    id: 'image.export',
    label: 'Export Original Image…',
    menu: 'Object/Image',
    order: 620,
    separatorBefore: true,
    run: () => {
      const s = getState();
      for (const id of selectedImages(s)) {
        const n = s.doc.nodes[id] as ImageNode;
        const ext = /^data:image\/(\w+)/.exec(n.src)?.[1] ?? 'png';
        downloadDataUrl(n.src, `${n.name || 'image'}.${ext === 'jpeg' ? 'jpg' : ext}`);
      }
    },
    enabled: hasImage,
  },
  { id: 'tool.pixelBrush', label: 'Paint on Image (Pixel Brush)', menu: 'Object/Image', order: 630, separatorBefore: true, run: () => getState().setTool('pixelbrush') },
]);

// ---------------------------------------------------------------------------
// Image Trace dialog
// ---------------------------------------------------------------------------

function ImageTraceDialog({ close }: { close: () => void }) {
  const [opts, setOpts] = useState<TraceOptions>({ ...lastTrace });
  const [preset, setPreset] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ svg: string; w: number; h: number; anchors: number } | null>(null);
  const ids = selectedImages();
  const first = getState().doc.nodes[ids[0]] as ImageNode | undefined;

  useEffect(() => {
    let cancelled = false;
    if (!first) return;
    const t = setTimeout(async () => {
      try {
        const res = await traceToSvg(first, { ...opts, maxSize: Math.min(opts.maxSize, 400) });
        if (cancelled) return;
        const anchors = (res.svg.match(/[LQC]\s/g) ?? []).length;
        setPreview({ svg: res.svg, w: res.width, h: res.height, anchors });
      } catch {
        if (!cancelled) setPreview(null);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [opts, first]);

  const set = (patch: Partial<TraceOptions>) => {
    setOpts((o) => ({ ...o, ...patch }));
    setPreset('');
  };
  const ok = async () => {
    setBusy(true);
    lastTrace = { ...opts };
    try {
      await traceImages(ids, opts);
    } finally {
      setBusy(false);
      close();
    }
  };
  return (
    <DialogFrame
      title="Image Trace"
      onClose={close}
      width={620}
      className="trace-dialog"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} disabled={busy || !ids.length} data-testid="trace-ok">
            {busy ? 'Tracing…' : 'Trace'}
          </Button>
        </>
      }
    >
      <div className="trace-layout">
        <div className="trace-preview" data-testid="trace-preview">
          {preview ? <div className="trace-svg" dangerouslySetInnerHTML={{ __html: preview.svg }} /> : <span className="muted small">Preview…</span>}
        </div>
        <div className="trace-controls">
          <Select
            label="Preset"
            value={preset}
            options={[{ value: '', label: 'Custom' }, ...TRACE_PRESETS.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => {
              const p = TRACE_PRESETS.find((q) => q.id === v);
              if (p) {
                setOpts({ ...DEFAULT_TRACE, ...p.opts, source: opts.source });
                setPreset(v);
              }
            }}
            width={220}
            id="trace-preset"
          />
          <Row gap={8}>
            <span className="field-label">Mode</span>
            <Segmented<TraceMode>
              value={opts.mode}
              options={[
                { value: 'bw', label: 'Black & White' },
                { value: 'gray', label: 'Grayscale' },
                { value: 'color', label: 'Color' },
              ]}
              onChange={(v) => set({ mode: v })}
            />
          </Row>
          {opts.mode !== 'bw' && <Slider label="Colors" value={opts.colors} min={2} max={64} step={1} onChange={(v) => set({ colors: v })} width={220} />}
          <Slider label="Smoothness" value={opts.smoothness} min={0} max={10} step={1} onChange={(v) => set({ smoothness: v })} width={220} />
          <Slider label="Ignore areas below" value={opts.minArea} min={0} max={100} step={1} unit="px" onChange={(v) => set({ minArea: v })} width={220} />
          <Slider label="Blur" value={opts.blur} min={0} max={5} step={1} onChange={(v) => set({ blur: v })} width={220} />
          <Checkbox checked={opts.ignoreWhite} onChange={(v) => set({ ignoreWhite: v })} label="Ignore white" />
          <Checkbox checked={opts.strokes} onChange={(v) => set({ strokes: v })} label="Add hairline strokes (close gaps)" />
          <Row gap={8}>
            <span className="field-label">Source image</span>
            <Select
              value={opts.source}
              options={[
                { value: 'replace', label: 'Replace with paths' },
                { value: 'keep', label: 'Keep' },
                { value: 'hide', label: 'Hide' },
              ]}
              onChange={(v) => set({ source: v as TraceOptions['source'] })}
              width={170}
            />
          </Row>
          <NumberField label="Max trace size" value={opts.maxSize} onChange={(v) => set({ maxSize: Math.max(64, Math.round(v)) })} min={64} max={4096} unit="px" width={180} title="The bitmap is downscaled to this size before tracing (speed vs detail)" />
          <div className="dim small">
            {ids.length} image{ids.length === 1 ? '' : 's'} selected{preview ? ` · preview ${preview.w}×${preview.h}px, ~${preview.anchors} segments` : ''}
          </div>
        </div>
      </div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Rasterize dialog
// ---------------------------------------------------------------------------

function RasterizeDialog({ close }: { close: () => void }) {
  const [opts, setOpts] = useState<RasterizeOptions>({ ...lastRasterize });
  const [busy, setBusy] = useState(false);
  const count = useStore((s) => s.selection.length);
  const ok = async () => {
    setBusy(true);
    lastRasterize = { ...opts };
    try {
      const id = await rasterizeSelection(opts);
      if (!id) getState().toast('Nothing to rasterize.', 'info');
    } catch (err: any) {
      getState().toast(String(err?.message ?? err), 'error');
    } finally {
      setBusy(false);
      close();
    }
  };
  const ppiPreset = [72, 150, 300].includes(opts.ppi) ? String(opts.ppi) : 'other';
  return (
    <DialogFrame
      title="Rasterize"
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} disabled={busy} data-testid="rasterize-ok">
            {busy ? 'Rendering…' : 'OK'}
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <Select
          label="Resolution"
          value={ppiPreset}
          options={[
            { value: '72', label: 'Screen (72 ppi)' },
            { value: '150', label: 'Medium (150 ppi)' },
            { value: '300', label: 'High (300 ppi)' },
            { value: 'other', label: 'Other' },
          ]}
          onChange={(v) => setOpts({ ...opts, ppi: v === 'other' ? opts.ppi : Number(v) })}
          width={170}
        />
        <NumberField label="ppi" value={opts.ppi} onChange={(v) => setOpts({ ...opts, ppi: Math.max(10, Math.min(1200, Math.round(v))) })} min={10} max={1200} width={100} data-testid="rasterize-ppi" />
      </Row>
      <Row gap={8}>
        <span className="field-label">Background</span>
        <Segmented<'white' | 'transparent'>
          value={opts.background}
          options={[
            { value: 'white', label: 'White' },
            { value: 'transparent', label: 'Transparent' },
          ]}
          onChange={(v) => setOpts({ ...opts, background: v })}
        />
      </Row>
      <NumberField label="Padding" value={opts.margin} onChange={(v) => setOpts({ ...opts, margin: Math.max(0, v) })} min={0} unit={getState().prefs.units} width={140} />
      <Checkbox checked={opts.keepOriginal} onChange={(v) => setOpts({ ...opts, keepOriginal: v })} label="Keep the vector originals" />
      <div className="dim small">
        {count} object{count === 1 ? '' : 's'} will be rendered into one image ({(opts.ppi / 96).toFixed(2)} px per unit).
      </div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Crop dialog (numeric)
// ---------------------------------------------------------------------------

function CropImageDialog({ props, close }: { props: { id: ID }; close: () => void }) {
  const s = getState();
  const n = s.doc.nodes[props.id] as ImageNode | undefined;
  const base = n?.crop ?? { x: 0, y: 0, width: n?.naturalWidth ?? 0, height: n?.naturalHeight ?? 0 };
  const [crop, setCrop] = useState<Rect>({ ...base });
  if (!n) return null;
  const apply = (c: Rect) => {
    setCrop(c);
    getState().updateDoc((d) => setImageCrop(d, props.id, c));
  };
  const ok = () => {
    getState().commit('Crop Image');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  return (
    <DialogFrame
      title="Crop Image"
      onClose={cancel}
      width={380}
      footer={
        <>
          <Button onClick={() => apply({ x: 0, y: 0, width: n.naturalWidth, height: n.naturalHeight })}>Reset</Button>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="crop-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="muted small">Values in image pixels ({n.naturalWidth} × {n.naturalHeight}). The preview updates live; draw a rectangle over the image and run Crop Image to crop visually.</div>
      <Row gap={8}>
        <NumberField label="Left" value={crop.x} onChange={(v) => apply({ ...crop, x: Math.max(0, Math.min(n.naturalWidth - 1, v)) })} min={0} width={130} data-testid="crop-x" />
        <NumberField label="Top" value={crop.y} onChange={(v) => apply({ ...crop, y: Math.max(0, Math.min(n.naturalHeight - 1, v)) })} min={0} width={130} data-testid="crop-y" />
      </Row>
      <Row gap={8}>
        <NumberField label="Width" value={crop.width} onChange={(v) => apply({ ...crop, width: Math.max(1, v) })} min={1} width={130} data-testid="crop-w" />
        <NumberField label="Height" value={crop.height} onChange={(v) => apply({ ...crop, height: Math.max(1, v) })} min={1} width={130} data-testid="crop-h" />
      </Row>
    </DialogFrame>
  );
}

registerDialog('imageTrace', ({ close }) => <ImageTraceDialog close={close} />);
registerDialog('rasterize', ({ close }) => <RasterizeDialog close={close} />);
registerDialog<{ id: ID }>('cropImage', CropImageDialog);

void React;
