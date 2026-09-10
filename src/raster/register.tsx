/**
 * Raster module wiring: Object > Image commands (Image Trace, Rasterize, Crop,
 * Reset Crop, Export Image) and their dialogs.
 */
import React, { useState, useEffect, useRef } from 'react';
import type { ID, ImageNode, Rect } from '@/model/types';
import { useStore, getState, type EditorState } from '@/store/store';
import { registerCommands, when } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Select, Checkbox, Row, Segmented, Slider, Section } from '@/ui/widgets';
import { topmostOf, worldBounds } from '@/model/document';
import { downloadDataUrl } from '@/util/files';
import { traceImage, traceSvg, applyTrace, countTraced, DEFAULT_TRACE, TRACE_PRESETS, type TraceOptions, type TraceMode, type TraceMethod, type TraceResult } from './trace';
import { rasterizeSelection, cropImageToRect, setImageCrop, DEFAULT_RASTERIZE, type RasterizeOptions } from './rasterize';
import * as quantize from './quantize';
import * as vectorizeMod from './vectorize';
import { traceBitmap } from './potrace';
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
  const traced: Array<{ id: ID; res: TraceResult }> = [];
  for (const id of ids) {
    const n = s.doc.nodes[id] as ImageNode | undefined;
    if (!n || n.type !== 'image') continue;
    traced.push({ id, res: await traceImage(n, opts) });
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
  ...TRACE_PRESETS.map((p, i) => ({ id: `image.tracePreset.${p.id}`, label: p.name, menu: 'Object/Image/Trace with Preset', order: 602 + i, run: () => void traceImages(selectedImages(), { ...DEFAULT_TRACE, ...p.opts, source: lastTrace.source }), enabled: hasImage })),
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

const PREVIEW_SIZE = 480;

interface Preview {
  svg: string;
  w: number;
  h: number;
  paths: number;
  anchors: number;
  colors: number;
  ms: number;
}

/** Preset whose values match the options (ignoring source / max size), or ''. */
function presetOf(opts: TraceOptions): string {
  for (const p of TRACE_PRESETS) {
    if (Object.entries(p.opts).every(([k, v]) => (k === 'maxSize' ? true : (opts as unknown as Record<string, unknown>)[k] === v))) return p.id;
  }
  return '';
}

/** Trace previews use the pure worker pipeline; only the newest request is shown. */
function usePreview(first: ImageNode | undefined, opts: TraceOptions): { preview: Preview | null; busy: boolean; error: string | null } {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const queued = useRef<TraceOptions | null>(null);
  const alive = useRef(true);
  const run = useRef<(o: TraceOptions) => void>(() => {});
  run.current = (o: TraceOptions) => {
    if (!first) return;
    if (running.current) {
      queued.current = o;
      return;
    }
    running.current = true;
    setBusy(true);
    const t0 = performance.now();
    traceImage(first, { ...o, maxSize: Math.min(o.maxSize, PREVIEW_SIZE) })
      .then((res) => {
        if (!alive.current) return;
        setPreview({ svg: traceSvg(res), w: res.width, h: res.height, paths: res.layers.reduce((a, l) => a + l.subpaths.length + l.strokes.length, 0), anchors: res.anchors, colors: res.layers.length, ms: performance.now() - t0 });
        setError(null);
      })
      .catch((err) => {
        if (alive.current) setError(String(err?.message ?? err));
      })
      .finally(() => {
        running.current = false;
        if (!alive.current) return;
        const next = queued.current;
        queued.current = null;
        if (next) run.current(next);
        else setBusy(false);
      });
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => run.current(opts), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.mode, opts.threshold, opts.colors, opts.grays, opts.paths, opts.corners, opts.noise, opts.method, opts.ignoreWhite, opts.snapLines, opts.fills, opts.strokes, opts.maxStrokeWeight, opts.minStrokeLength, opts.maxSize, first]);
  return { preview, busy, error };
}

function ImageTraceDialog({ close }: { close: () => void }) {
  const [opts, setOpts] = useState<TraceOptions>({ ...lastTrace });
  const [busy, setBusy] = useState(false);
  const ids = selectedImages();
  const first = getState().doc.nodes[ids[0]] as ImageNode | undefined;
  const { preview, busy: previewing, error } = usePreview(first, opts);
  const preset = presetOf(opts);

  const set = (patch: Partial<TraceOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const ok = async () => {
    if (!opts.fills && !opts.strokes) {
      getState().toast('Enable Fills or Strokes to trace something.', 'info');
      return;
    }
    setBusy(true);
    lastTrace = { ...opts };
    try {
      await traceImages(ids, opts);
    } catch (err: any) {
      getState().toast(String(err?.message ?? err), 'error');
    } finally {
      setBusy(false);
      close();
    }
  };
  const colorSlider =
    opts.mode === 'bw' ? (
      <Slider label="Threshold" value={opts.threshold} min={1} max={255} step={1} onChange={(v) => set({ threshold: v })} width={240} />
    ) : opts.mode === 'gray' ? (
      <Slider label="Grays" value={opts.grays} min={2} max={64} step={1} onChange={(v) => set({ grays: v })} width={240} />
    ) : (
      <Slider label="Colors" value={opts.colors} min={2} max={64} step={1} onChange={(v) => set({ colors: v })} width={240} />
    );
  return (
    <DialogFrame
      title="Image Trace"
      onClose={close}
      width={700}
      className="trace-dialog"
      footer={
        <>
          <span className="dim small trace-footer-info" data-testid="trace-info">
            {ids.length} image{ids.length === 1 ? '' : 's'}
            {preview ? ` · preview ${preview.w}×${preview.h} px: ${preview.colors} colour${preview.colors === 1 ? '' : 's'}, ${preview.paths} path${preview.paths === 1 ? '' : 's'}, ${preview.anchors} anchors (${Math.round(preview.ms)} ms)` : ''}
            {error ? ` · ${error}` : ''}
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} disabled={busy || !ids.length} data-testid="trace-ok">
            {busy ? 'Tracing…' : 'Trace'}
          </Button>
        </>
      }
    >
      <div className="trace-layout">
        <div className={`trace-preview ${previewing ? 'busy' : ''}`} data-testid="trace-preview">
          {preview ? <div className="trace-svg" dangerouslySetInnerHTML={{ __html: preview.svg }} /> : <span className="muted small">{error ?? 'Preview…'}</span>}
          {previewing && <span className="trace-spinner">Tracing…</span>}
        </div>
        <div className="trace-controls">
          <Select
            label="Preset"
            value={preset}
            options={[{ value: '', label: 'Custom' }, ...TRACE_PRESETS.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => {
              const p = TRACE_PRESETS.find((q) => q.id === v);
              if (p) setOpts({ ...DEFAULT_TRACE, ...p.opts, source: opts.source, maxSize: p.opts.maxSize ?? opts.maxSize });
            }}
            width={240}
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
          {colorSlider}
          <Section title="Advanced" collapsible defaultOpen>
            <Slider label="Paths" value={opts.paths} min={0} max={100} step={1} unit="%" onChange={(v) => set({ paths: v })} width={240} className="trace-slider" />
            <Slider label="Corners" value={opts.corners} min={0} max={100} step={1} unit="%" onChange={(v) => set({ corners: v })} width={240} className="trace-slider" />
            <Slider label="Noise" value={opts.noise} min={1} max={100} step={1} unit="px" onChange={(v) => set({ noise: v })} width={240} className="trace-slider" />
            <Row gap={8}>
              <span className="field-label">Method</span>
              <Segmented<TraceMethod>
                value={opts.method}
                options={[
                  { value: 'abutting', label: 'Abutting', title: 'Cut-out regions that share their edges' },
                  { value: 'overlapping', label: 'Overlapping', title: 'Stacked shapes: every colour also covers the colours above it (no gaps)' },
                ]}
                onChange={(v) => set({ method: v })}
              />
            </Row>
            <Row gap={14}>
              <Checkbox checked={opts.fills} onChange={(v) => set({ fills: v })} label="Fills" title="Trace filled regions" />
              <Checkbox checked={opts.strokes} onChange={(v) => set({ strokes: v })} label="Strokes" title="Trace thin features as stroked centerlines" />
            </Row>
            {opts.strokes && (
              <Row gap={8}>
                <NumberField label="Max stroke" value={opts.maxStrokeWeight} onChange={(v) => set({ maxStrokeWeight: Math.max(1, Math.min(200, v)) })} min={1} max={200} unit="px" width={130} title="Features wider than this become fills" data-testid="trace-max-stroke" />
                <NumberField label="Min length" value={opts.minStrokeLength} onChange={(v) => set({ minStrokeLength: Math.max(0, Math.min(500, v)) })} min={0} max={500} unit="px" width={130} title="Shorter strokes are dropped" data-testid="trace-min-length" />
              </Row>
            )}
            <Checkbox checked={opts.snapLines} onChange={(v) => set({ snapLines: v })} label="Snap curves to lines" />
            <Checkbox checked={opts.ignoreWhite} onChange={(v) => set({ ignoreWhite: v })} label="Ignore white" />
          </Section>
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
            <NumberField label="Max size" value={opts.maxSize} onChange={(v) => set({ maxSize: Math.max(64, Math.min(4096, Math.round(v))) })} min={64} max={4096} unit="px" width={150} title="The bitmap is downscaled to this size before tracing (speed vs detail)" data-testid="trace-maxsize" />
          </Row>
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

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  raster: { ...quantize, ...vectorizeMod, traceBitmap, traceImages, traceImage, traceSvg, applyTraceToDraft: applyTrace, TRACE_PRESETS, DEFAULT_TRACE },
};
registerDialog('rasterize', ({ close }) => <RasterizeDialog close={close} />);
registerDialog<{ id: ID }>('cropImage', CropImageDialog);

void React;
