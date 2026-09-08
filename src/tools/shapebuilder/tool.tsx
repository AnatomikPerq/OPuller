/**
 * Shape Builder tool (Shift+M): the selected paths are split into their planar
 * regions (faces). Hovering highlights a face, a click extracts it as a new
 * path, dragging across several faces unites them into one path, Alt deletes
 * faces, Shift+drag selects faces with a marquee. Untouched parts of the
 * involved objects are rebuilt from their remaining faces; everything else is
 * left alone. One history step per click / drag.
 */
import React, { useMemo } from 'react';
import { Combine } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { ID, Vec, Rect, Paint, StrokeStyle } from '@/model/types';
import { getState, useStore, type EditorState } from '@/store/store';
import { computeFaceSet, faceAt, facesAlong, facesInRect, applyShapeBuilder, type FaceSet, type Face } from '@/pathops/faces';
import { selectionTargets, commitChange } from '@/pathops/apply';
import { pathToSvgD, transformSubPaths } from '@/geometry/path';
import { rectFromPoints } from '@/geometry/vec';
import { clonePaint, cloneStroke } from '@/model/nodes';
import { useToolOptions, toolContext } from '@/canvas/toolContext';
import { Segmented, Checkbox } from '@/ui/widgets';
import { paintCss } from '@/ui/ColorPicker';
import './shapebuilder.css';

export type ShapeBuilderOptions = {
  /** where the merged shape takes its appearance from */
  pickFrom: 'artwork' | 'appearance';
  /** highlight the hovered face */
  highlight: boolean;
};

const DEFAULTS: ShapeBuilderOptions = { pickFrom: 'artwork', highlight: true };

type Gesture =
  | { kind: 'drag'; faces: number[]; points: Vec[]; last: Vec; alt: boolean; start: Vec }
  | { kind: 'marquee'; start: Vec; current: Vec; alt: boolean; faces: number[] }
  | null;

let cache: { key: string; set: FaceSet } | null = null;
let screenCache: { key: string; d: Map<number, string> } = { key: '', d: new Map() };
let gesture: Gesture = null;
let hoverIndex = -1;
let altDown = false;

const MERGE_FILL = 'rgba(74,144,226,0.35)';
const MERGE_STROKE = '#4a90e2';
const DELETE_FILL = 'rgba(229,72,77,0.35)';
const DELETE_STROKE = '#e5484d';

function faceKey(s: EditorState): string {
  return `${s.docVersion}|${s.isolationId ?? ''}|${s.selection.join(',')}`;
}

function statusFor(set: FaceSet): string {
  if (set.ids.length < 2) return 'Shape Builder: select two or more overlapping paths';
  if (!set.faces.length) return 'Shape Builder: no regions found in the selection';
  return `Shape Builder: ${set.faces.length} regions · click or drag to merge · Alt: delete · Shift+drag: marquee`;
}

/** Faces of the current selection (recomputed when the document or selection changes). */
export function ensureFaces(state: EditorState = getState()): FaceSet {
  const key = faceKey(state);
  if (cache && cache.key === key) return cache.set;
  const ids = selectionTargets(state).ids;
  let set: FaceSet;
  try {
    set = computeFaceSet(state.doc, ids);
  } catch (err) {
    console.error(err);
    set = { ids, geoms: [], faces: [] };
  }
  cache = { key, set };
  screenCache = { key: '', d: new Map() };
  hoverIndex = -1;
  const text = statusFor(set);
  setTimeout(() => {
    const s = getState();
    if ((s.temporaryTool ?? s.activeTool) === 'shapebuilder') s.setStatus(text);
  }, 0);
  return set;
}

function screenD(ctx: ToolContext, set: FaceSet, index: number): string {
  const s = ctx.state;
  const key = `${s.zoom}|${s.pan.x}|${s.pan.y}`;
  if (screenCache.key !== key) screenCache = { key, d: new Map() };
  let d = screenCache.d.get(index);
  if (d === undefined) {
    const f = set.faces[index];
    d = f ? pathToSvgD(transformSubPaths(f.subpaths, { a: s.zoom, b: 0, c: 0, d: s.zoom, e: s.pan.x, f: s.pan.y })) : '';
    screenCache.d.set(index, d);
  }
  return d;
}

function updateCursor(ctx: ToolContext, e?: { alt: boolean }) {
  const alt = e ? e.alt : altDown;
  ctx.setCursor(alt ? 'var(--cursor-sb-minus)' : 'var(--cursor-sb)');
}

function currentOptions(): ShapeBuilderOptions {
  return { ...DEFAULTS, ...(getState().toolOptions.shapebuilder ?? {}) } as ShapeBuilderOptions;
}

/** Appearance for the merged shape: the artwork under the cursor or the current appearance. */
function pickAppearance(set: FaceSet, at: Vec, face: Face | null): { fill: Paint; stroke: StrokeStyle } {
  const s = getState();
  const opts = currentOptions();
  if (opts.pickFrom === 'artwork') {
    const f = face ?? faceAt(set, at);
    const src = f ? s.doc.nodes[f.source] : undefined;
    if (src && src.type === 'path') return { fill: clonePaint(src.fill), stroke: cloneStroke(src.stroke) };
  }
  return { fill: clonePaint(s.appearance.fill), stroke: cloneStroke(s.appearance.stroke) };
}

function finish(ctx: ToolContext, faces: number[], alt: boolean, at: Vec) {
  const s = ctx.state;
  const set = ensureFaces(s);
  const unique = Array.from(new Set(faces)).filter((i) => set.faces[i]);
  if (!unique.length) return;
  const first = set.faces[unique[0]];
  const appearance = pickAppearance(set, at, first);
  const before = s.selection;
  let res = { created: [] as ID[], removed: [] as ID[], modified: [] as ID[] };
  commitChange((d) => {
    res = applyShapeBuilder(d, set, { mode: alt ? 'delete' : 'merge', faces: unique, fill: appearance.fill, stroke: appearance.stroke });
  }, alt ? 'Shape Builder Delete' : unique.length > 1 ? 'Shape Builder Merge' : 'Shape Builder Extract');
  const st = getState();
  const next = before.filter((id) => !!st.doc.nodes[id]).concat(res.created);
  st.setSelection(next);
  hoverIndex = -1;
  ctx.requestOverlay();
}

export const shapeBuilderTool: Tool = {
  id: 'shapebuilder',
  name: 'Shape Builder Tool',
  shortcut: 'shift+m',
  icon: Combine,
  group: 'edit',
  order: 600,
  cursor: 'var(--cursor-sb)',
  hint: 'Click or drag across regions of the selected paths to merge them. Alt: delete regions. Shift+drag: marquee.',
  defaults: DEFAULTS as unknown as Record<string, unknown>,
  Options: ShapeBuilderOptionsBar,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    hoverIndex = -1;
    altDown = false;
    cache = null;
    ensureFaces(ctx.state);
    updateCursor(ctx);
  },
  deactivate(ctx) {
    gesture = null;
    hoverIndex = -1;
    cache = null;
    ctx.setStatus('');
  },
  isBusy: () => !!gesture,
  cancel(ctx) {
    gesture = null;
    ctx.requestOverlay();
    updateCursor(ctx);
  },

  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const set = ensureFaces(ctx.state);
    if (set.ids.length < 2) {
      ctx.setStatus('Shape Builder: select two or more overlapping paths first');
      return;
    }
    if (e.shift) {
      gesture = { kind: 'marquee', start: e.world, current: e.world, alt: e.alt, faces: [] };
    } else {
      const f = faceAt(set, e.world);
      gesture = { kind: 'drag', faces: f ? [f.index] : [], points: [e.world], last: e.world, alt: e.alt, start: e.world };
    }
    updateCursor(ctx, e);
    ctx.requestOverlay();
  },

  onPointerMove(e, ctx) {
    const set = ensureFaces(ctx.state);
    updateCursor(ctx, e);
    const g = gesture;
    if (!g) {
      const f = faceAt(set, e.world);
      const idx = f ? f.index : -1;
      if (idx !== hoverIndex) {
        hoverIndex = idx;
        ctx.requestOverlay();
      }
      return;
    }
    if (g.kind === 'marquee') {
      g.current = e.world;
      g.faces = facesInRect(set, rectFromPoints(g.start, g.current));
      ctx.requestOverlay();
      return;
    }
    // sample the segment from the previous position so fast moves still cross every face
    const step = 3 / ctx.zoom;
    for (const idx of facesAlong(set, g.last, e.world, step)) if (!g.faces.includes(idx)) g.faces.push(idx);
    g.points.push(e.world);
    g.last = e.world;
    ctx.requestOverlay();
  },

  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    updateCursor(ctx, e);
    if (g.kind === 'marquee') {
      const set = ensureFaces(ctx.state);
      const faces = facesInRect(set, rectFromPoints(g.start, e.world));
      if (!faces.length) {
        ctx.requestOverlay();
        return;
      }
      finish(ctx, faces, g.alt || e.alt, g.start);
      return;
    }
    if (!g.faces.length) {
      ctx.requestOverlay();
      return;
    }
    finish(ctx, g.faces, g.alt || e.alt, g.start);
  },

  onModifiers(e, ctx) {
    altDown = e.alt;
    updateCursor(ctx, e);
    ctx.requestOverlay();
  },

  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture) {
      this.cancel!(ctx);
      return true;
    }
    return false;
  },

  renderOverlay(ctx) {
    const s = ctx.state;
    const set = ensureFaces(s);
    if (!set.faces.length) return null;
    const opts = currentOptions();
    const g = gesture;
    const deleting = g ? g.alt || altDown : altDown;
    const highlighted: number[] = g ? g.faces : opts.highlight && hoverIndex >= 0 ? [hoverIndex] : [];
    const fill = deleting ? DELETE_FILL : MERGE_FILL;
    const stroke = deleting ? DELETE_STROKE : MERGE_STROKE;
    const view = { a: s.zoom, b: 0, c: 0, d: s.zoom, e: s.pan.x, f: s.pan.y };
    let line: React.ReactNode = null;
    if (g && g.kind === 'drag' && g.points.length > 1) {
      const pts = g.points.map((p) => `${(p.x * view.a + view.e).toFixed(1)},${(p.y * view.d + view.f).toFixed(1)}`).join(' ');
      line = (
        <>
          <polyline points={pts} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={pts} fill="none" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </>
      );
    }
    let marquee: React.ReactNode = null;
    if (g && g.kind === 'marquee') {
      const r: Rect = rectFromPoints(g.start, g.current);
      marquee = <rect x={r.x * view.a + view.e} y={r.y * view.d + view.f} width={r.width * view.a} height={r.height * view.d} fill="rgba(74,144,226,0.08)" stroke={stroke} strokeWidth={1} strokeDasharray="4 3" />;
    }
    return (
      <g className="sb-overlay" pointerEvents="none" data-testid="shapebuilder-overlay" data-faces={highlighted.length}>
        <defs>
          <pattern id="sb-hatch" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={6} stroke="#fff" strokeWidth={1.5} strokeOpacity={0.55} />
          </pattern>
        </defs>
        {highlighted.map((i) => {
          const d = screenD(ctx, set, i);
          return (
            <g key={i}>
              <path d={d} fill={fill} fillRule="evenodd" stroke="none" />
              <path d={d} fill="url(#sb-hatch)" fillRule="evenodd" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
            </g>
          );
        })}
        {marquee}
        {line}
      </g>
    );
  },
};

function ShapeBuilderOptionsBar() {
  const [opts, set] = useToolOptions<ShapeBuilderOptions>('shapebuilder');
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  const appearance = useStore((s) => s.appearance);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const faces = useMemo(() => ensureFaces(getState()), [selection, docVersion]);
  const count = faces.ids.length;
  const text = count < 2 ? 'Select two or more overlapping paths' : faces.faces.length ? `${faces.faces.length} regions from ${count} paths` : 'No regions';
  void toolContext;
  return (
    <div className="sb-options" data-testid="shapebuilder-options">
      <span className="sb-count" data-testid="shapebuilder-count">
        {text}
      </span>
      <span className="field-label">Pick color from</span>
      <Segmented<ShapeBuilderOptions['pickFrom']>
        value={opts.pickFrom}
        onChange={(v) => set({ pickFrom: v })}
        options={[
          { value: 'artwork', label: 'Artwork', title: 'The merged shape takes the appearance of the object under the cursor' },
          { value: 'appearance', label: 'Current appearance', title: 'The merged shape takes the current fill and stroke' },
        ]}
      />
      {opts.pickFrom === 'appearance' && <span className="sb-swatch" style={{ background: paintCss(appearance.fill) }} title="Current fill" />}
      <Checkbox checked={opts.highlight} onChange={(v) => set({ highlight: v })} label="Highlight" title="Highlight the region under the cursor" />
      <span className="sb-hint">Alt: delete · Shift+drag: marquee · Esc: cancel</span>
    </div>
  );
}

export const tool = shapeBuilderTool;
void React;
