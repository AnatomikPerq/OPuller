/**
 * SVG renderer for the document. Used live on the canvas (fine-grained store
 * subscriptions) and statically for export (renderToStaticMarkup).
 */
import React, { createContext, memo, useContext } from 'react';
import type { Document, ID, Node, PathNode, TextNode, ImageNode, GroupNode, Paint, StrokeStyle, Effect, Rect, Arrowhead, SubPath } from '@/model/types';
import { pathToSvgD, pathBounds } from '@/geometry/path';
import { toSvgTransform, isIdentity, multiply, invert } from '@/geometry/matrix';
import { variableWidthOutlines } from '@/geometry/widthProfile';
import { effectiveSubPaths, isGeometryEffect, applyGeometryEffects, hasGeometryEffects } from './effectiveGeometry';
import { transformSubPaths } from '@/geometry/path';
import { localBounds } from '@/model/document';
import { extrudeFaces, revolveFaces, type Face3D } from '@/effects3d/geometry';
import { brushItems, type BrushItem } from '@/brushes/geometry';
import { rasterGradientTile, PAD as RASTER_PAD } from '@/gradients/raster';
import { layoutText } from '@/text/layout';
import { useStore } from '@/store/store';
import { isContainer } from '@/model/types';
import { patternCell } from '@/patterns/tile';

export interface RenderOptions {
  /** outline (wireframe) view */
  outline: boolean;
  /** export mode: no data attributes, no editor-only bits */
  exportMode: boolean;
  /** ids of nodes to hide (e.g. while editing text) */
  hidden?: Set<ID>;
  /** id prefix for defs to avoid collisions between multiple renders */
  prefix: string;
}

interface RenderCtx extends RenderOptions {
  doc: Document | null; // null = live (from store)
}

const Ctx = createContext<RenderCtx>({ doc: null, outline: false, exportMode: false, prefix: '' });

/**
 * Group-level geometry effects (warp, envelopes, 3D on a group): descendants
 * are rendered in the group's frame with their transforms folded into the
 * geometry so the nonlinear map applies to the whole group.
 */
interface GeomGroupCtx {
  effects: Effect[];
  frame: Rect;
  /** accumulated matrix from the current DOM parent space to the group frame */
  matrix: import('@/model/types').Matrix;
}
const GeomCtx = createContext<GeomGroupCtx | null>(null);

function has3D(effects: Effect[]): boolean {
  return effects.some((e) => e.enabled && (e.type === 'extrude' || e.type === 'revolve'));
}

function faces3D(sps: SubPath[], frame: Rect, effects: Effect[], fill: Paint, opacity: number): Face3D[] | null {
  const fillHex = fill.type === 'solid' ? fill.color : fill.type === 'linear' || fill.type === 'radial' ? fill.stops[0]?.color ?? '#808080' : fill.type === 'none' ? '#c0c0c0' : '#808080';
  const op = fill.type === 'solid' ? fill.opacity * opacity : opacity;
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.type === 'extrude') return extrudeFaces(sps, frame, e, fillHex, op);
    if (e.type === 'revolve') return revolveFaces(sps, frame, e, fillHex, op);
  }
  return null;
}

function FacesView({ faces, stroke, strokeRef, ctx }: { faces: Face3D[]; stroke: StrokeStyle; strokeRef: string; ctx: RenderCtx }) {
  const sa = strokeAttrs(stroke, strokeRef, ctx);
  return (
    <>
      {faces.map((f, i) => (
        <path key={i} d={f.rings.map((r) => r.map((p, k) => `${k ? 'L' : 'M'}${+p.x.toFixed(3)} ${+p.y.toFixed(3)}`).join('') + 'Z').join('')} fill={f.color} fillOpacity={f.opacity !== 1 ? f.opacity : undefined} fillRule="evenodd" {...(f.kind === 'front' ? sa : { stroke: 'none' })} strokeLinejoin="round" />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Paint helpers
// ---------------------------------------------------------------------------

export function paintRef(paint: Paint, id: string): string {
  switch (paint.type) {
    case 'none':
      return 'none';
    case 'solid':
      return paint.color;
    case 'linear':
    case 'radial':
    case 'pattern':
    case 'freeform':
    case 'mesh':
      return `url(#${id})`;
  }
}

/** Freeform / mesh gradients: a raster tile mapped onto the bounds (+ padding). */
function RasterGradientDef({ paint, id, bounds }: { paint: Paint; id: string; bounds: Rect }) {
  if (paint.type !== 'freeform' && paint.type !== 'mesh') return null;
  const w = Math.max(bounds.width, 1e-3);
  const h = Math.max(bounds.height, 1e-3);
  const tile = rasterGradientTile(paint, w / h);
  if (!tile) return null;
  const x = bounds.x - w * RASTER_PAD;
  const y = bounds.y - h * RASTER_PAD;
  const tw = w * (1 + RASTER_PAD * 2);
  const th = h * (1 + RASTER_PAD * 2);
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" x={x} y={y} width={tw} height={th}>
      <image href={tile.dataUrl} x={0} y={0} width={tw} height={th} preserveAspectRatio="none" />
    </pattern>
  );
}

export function paintOpacity(paint: Paint): number {
  return paint.type === 'solid' ? paint.opacity : 1;
}

function GradientDef({ paint, id, bounds }: { paint: Paint; id: string; bounds: Rect }) {
  if (paint.type !== 'linear' && paint.type !== 'radial') return null;
  const w = Math.max(bounds.width, 1e-3);
  const h = Math.max(bounds.height, 1e-3);
  const bx = bounds.x;
  const by = bounds.y;
  const stops = paint.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />);
  if (paint.type === 'linear') {
    return (
      <linearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        x1={bx + paint.x1 * w}
        y1={by + paint.y1 * h}
        x2={bx + paint.x2 * w}
        y2={by + paint.y2 * h}
        spreadMethod={paint.spread}
      >
        {stops}
      </linearGradient>
    );
  }
  // radial: r is relative to the larger dimension; use a gradientTransform to scale to the box
  const cx = bx + paint.cx * w;
  const cy = by + paint.cy * h;
  const fx = bx + (paint.fx ?? paint.cx) * w;
  const fy = by + (paint.fy ?? paint.cy) * h;
  const r = paint.r * Math.max(w, h);
  // ellipse: scale y relative to x so that the gradient follows the box aspect
  const sx = w >= h ? 1 : w / h;
  const sy = h >= w ? 1 : h / w;
  const gt = `translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`;
  return (
    <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} fx={fx} fy={fy} r={r} spreadMethod={paint.spread} gradientTransform={gt}>
      {stops}
    </radialGradient>
  );
}

function PatternDef({ paint, id, doc }: { paint: Paint; id: string; doc: Document }) {
  if (paint.type !== 'pattern') return null;
  const def = doc.patterns.find((p) => p.id === paint.patternId);
  if (!def) return null;
  const cell = patternCell(def);
  const t = `${paint.x || paint.y ? `translate(${paint.x ?? 0} ${paint.y ?? 0}) ` : ''}rotate(${paint.angle}) scale(${paint.scale})`;
  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width={cell.width}
      height={cell.height}
      patternTransform={t}
      dangerouslySetInnerHTML={{ __html: def.svg }}
    />
  );
}

// ---------------------------------------------------------------------------
// Effects → filters
// ---------------------------------------------------------------------------

function hasFilterEffects(effects: Effect[]): boolean {
  return effects.some((e) => e.enabled && !isGeometryEffect(e.type));
}

export function FilterDef({ id, effects }: { id: string; effects: Effect[] }) {
  const prims: React.ReactNode[] = [];
  let last = 'SourceGraphic';
  let k = 0;
  for (const e of effects) {
    if (!e.enabled) continue;
    const out = `r${k++}`;
    switch (e.type) {
      case 'blur':
        prims.push(<feGaussianBlur key={out} in={last} stdDeviation={e.radius} result={out} />);
        last = out;
        break;
      case 'dropShadow':
        prims.push(<feDropShadow key={out} in={last} dx={e.dx} dy={e.dy} stdDeviation={e.blur} floodColor={e.color} floodOpacity={e.opacity} result={out} />);
        last = out;
        break;
      case 'outerGlow':
        prims.push(<feDropShadow key={out} in={last} dx={0} dy={0} stdDeviation={e.blur} floodColor={e.color} floodOpacity={e.opacity} result={out} />);
        last = out;
        break;
      case 'innerShadow':
      case 'innerGlow': {
        const dx = e.type === 'innerShadow' ? e.dx : 0;
        const dy = e.type === 'innerShadow' ? e.dy : 0;
        prims.push(
          <React.Fragment key={out}>
            <feComponentTransfer in="SourceAlpha" result={`${out}inv`}>
              <feFuncA type="table" tableValues="1 0" />
            </feComponentTransfer>
            <feGaussianBlur in={`${out}inv`} stdDeviation={e.blur} result={`${out}blur`} />
            <feOffset in={`${out}blur`} dx={dx} dy={dy} result={`${out}off`} />
            <feFlood floodColor={e.color} floodOpacity={e.opacity} result={`${out}flood`} />
            <feComposite in={`${out}flood`} in2={`${out}off`} operator="in" result={`${out}shadow`} />
            <feComposite in={`${out}shadow`} in2="SourceAlpha" operator="in" result={`${out}clipped`} />
            <feMerge result={out}>
              <feMergeNode in={last} />
              <feMergeNode in={`${out}clipped`} />
            </feMerge>
          </React.Fragment>,
        );
        last = out;
        break;
      }
      case 'colorAdjust': {
        const b = e.brightness;
        const c = e.contrast;
        const ic = 0.5 - 0.5 * c;
        prims.push(
          <React.Fragment key={out}>
            <feComponentTransfer in={last} result={`${out}bc`}>
              <feFuncR type="linear" slope={b * c} intercept={ic} />
              <feFuncG type="linear" slope={b * c} intercept={ic} />
              <feFuncB type="linear" slope={b * c} intercept={ic} />
            </feComponentTransfer>
            <feColorMatrix in={`${out}bc`} type="saturate" values={String(Math.max(0, e.saturate * (1 - e.grayscale)))} result={`${out}sat`} />
            <feColorMatrix in={`${out}sat`} type="hueRotate" values={String(e.hueRotate)} result={`${out}hue`} />
            <feColorMatrix
              in={`${out}hue`}
              type="matrix"
              values={sepiaMatrix(e.sepia)}
              result={`${out}sep`}
            />
            <feComponentTransfer in={`${out}sep`} result={out}>
              <feFuncR type="table" tableValues={`${e.invert} ${1 - e.invert}`} />
              <feFuncG type="table" tableValues={`${e.invert} ${1 - e.invert}`} />
              <feFuncB type="table" tableValues={`${e.invert} ${1 - e.invert}`} />
            </feComponentTransfer>
          </React.Fragment>,
        );
        last = out;
        break;
      }
      default:
        break;
    }
  }
  if (!prims.length) return null;
  return (
    <filter id={id} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
      {prims}
    </filter>
  );
}

function sepiaMatrix(amount: number): string {
  const a = Math.max(0, Math.min(1, amount));
  const m = [
    0.393 + 0.607 * (1 - a), 0.769 - 0.769 * (1 - a), 0.189 - 0.189 * (1 - a), 0, 0,
    0.349 - 0.349 * (1 - a), 0.686 + 0.314 * (1 - a), 0.168 - 0.168 * (1 - a), 0, 0,
    0.272 - 0.272 * (1 - a), 0.534 - 0.534 * (1 - a), 0.131 + 0.869 * (1 - a), 0, 0,
    0, 0, 0, 1, 0,
  ];
  return m.map((v) => +v.toFixed(4)).join(' ');
}

// ---------------------------------------------------------------------------
// Markers (arrowheads)
// ---------------------------------------------------------------------------

const MARKER_SHAPES: Record<Exclude<Arrowhead, 'none'>, { d: string; refX: number; fill: boolean; width: number }> = {
  arrow: { d: 'M0 0 L10 5 L0 10 L3 5 Z', refX: 8, fill: true, width: 10 },
  triangle: { d: 'M0 0 L10 5 L0 10 Z', refX: 9, fill: true, width: 10 },
  'open-arrow': { d: 'M1 1 L9 5 L1 9', refX: 8, fill: false, width: 10 },
  circle: { d: 'M5 1 A4 4 0 1 0 5 9 A4 4 0 1 0 5 1 Z', refX: 5, fill: true, width: 10 },
  square: { d: 'M1.5 1.5 H8.5 V8.5 H1.5 Z', refX: 5, fill: true, width: 10 },
  bar: { d: 'M4.5 0 H5.5 V10 H4.5 Z', refX: 5, fill: true, width: 10 },
  diamond: { d: 'M5 0 L10 5 L5 10 L0 5 Z', refX: 5, fill: true, width: 10 },
};

function MarkerDef({ id, kind, stroke, start }: { id: string; kind: Arrowhead; stroke: StrokeStyle; start: boolean }) {
  if (kind === 'none') return null;
  const shape = MARKER_SHAPES[kind];
  const color = stroke.paint.type === 'solid' ? stroke.paint.color : '#000000';
  const size = 4 * (stroke.markerScale || 1);
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={shape.refX}
      refY={5}
      markerWidth={size}
      markerHeight={size}
      markerUnits="strokeWidth"
      orient={start ? 'auto-start-reverse' : 'auto'}
    >
      <path d={shape.d} fill={shape.fill ? color : 'none'} stroke={shape.fill ? 'none' : color} strokeWidth={shape.fill ? 0 : 1.5} strokeLinecap="round" strokeLinejoin="round" />
    </marker>
  );
}

// ---------------------------------------------------------------------------
// Node rendering
// ---------------------------------------------------------------------------

function useNode(id: ID, ctx: RenderCtx): Node | undefined {
  // Live mode subscribes to the store; static mode reads from the provided doc.
  // The mode is fixed per render tree, so the hook order is stable.
  const live = useStore((s) => (ctx.doc ? undefined : s.doc.nodes[id]));
  return ctx.doc ? ctx.doc.nodes[id] : live;
}

function useDoc(ctx: RenderCtx): Document {
  const live = useStore((s) => (ctx.doc ? null : s.doc));
  return (ctx.doc ?? live)!;
}

export const NodeView = memo(function NodeView({ id }: { id: ID }) {
  const ctx = useContext(Ctx);
  const gctx = useContext(GeomCtx);
  const node = useNode(id, ctx);
  const doc = useDoc(ctx);
  if (!node || !node.visible) return null;
  if (ctx.hidden?.has(id)) return null;
  return renderNode(node, doc, ctx, gctx);
});

function renderNode(node: Node, doc: Document, ctx: RenderCtx, gctx: GeomGroupCtx | null = null): React.ReactNode {
  const prefix = ctx.prefix;
  const filterId = `${prefix}f-${node.id}`;
  const useFilter = !ctx.outline && hasFilterEffects(node.effects);
  const style: React.CSSProperties = {};
  if (node.blendMode !== 'normal' && !ctx.outline) style.mixBlendMode = node.blendMode as any;
  // inside a group geometry context the transforms are folded into the geometry (paths) or accumulated (text/images)
  const folded = !!gctx && (node.type === 'path' || node.type === 'group');
  const accumulated = gctx ? multiply(gctx.matrix, node.transform) : node.transform;
  const common: React.SVGAttributes<SVGGElement> & { [k: string]: unknown } = {
    transform: folded ? undefined : isIdentity(accumulated) ? undefined : toSvgTransform(accumulated),
    opacity: node.opacity !== 1 && !ctx.outline ? node.opacity : undefined,
    filter: useFilter ? `url(#${filterId})` : undefined,
    style: Object.keys(style).length ? style : undefined,
  };
  if (!ctx.exportMode) common['data-id'] = node.id;
  if (ctx.exportMode && node.name) common['id'] = safeId(node.name, node.id);

  let content: React.ReactNode;
  let defs: React.ReactNode = null;
  switch (node.type) {
    case 'layer':
    case 'group': {
      const own = !ctx.outline && node.type === 'group' && (hasGeometryEffects(node.effects) || has3D(node.effects));
      if (own) {
        // this group starts a geometry context in its own local space
        const frame = localBounds(doc, node.id) ?? { x: 0, y: 0, width: 1, height: 1 };
        const inner: GeomGroupCtx = { effects: node.effects, frame, matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
        const outer = { ...common, transform: isIdentity(accumulated) ? undefined : toSvgTransform(accumulated) };
        return (
          <GeomCtx.Provider value={inner}>
            {useFilter && (
              <defs>
                <FilterDef id={filterId} effects={node.effects} />
              </defs>
            )}
            {renderGroup(node as GroupNode, doc, ctx, outer)}
          </GeomCtx.Provider>
        );
      }
      content = renderGroup(node as GroupNode, doc, ctx, common);
      if (useFilter) defs = <FilterDef id={filterId} effects={node.effects} />;
      if (gctx && node.type === 'group') {
        // nested group inside a context: accumulate its matrix for the descendants
        return (
          <GeomCtx.Provider value={{ ...gctx, matrix: accumulated }}>
            {defs && <defs>{defs}</defs>}
            {content}
          </GeomCtx.Provider>
        );
      }
      return (
        <>
          {defs && <defs>{defs}</defs>}
          {content}
        </>
      );
    }
    case 'path':
      return renderPath(node, doc, ctx, common, useFilter ? filterId : null, gctx);
    case 'text':
      return renderText(node, doc, ctx, common, useFilter ? filterId : null);
    case 'image':
      return renderImage(node, ctx, common, useFilter ? filterId : null);
  }
}

function safeId(name: string, id: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${s}_${id}`;
}

function renderGroup(node: GroupNode | (Node & { children: ID[] }), doc: Document, ctx: RenderCtx, common: Record<string, unknown>) {
  const g = node as GroupNode;
  const clipId = g.type === 'group' ? g.clipId : null;
  const clipNode = clipId ? doc.nodes[clipId] : undefined;
  const clipRef = clipNode && !ctx.outline ? `${ctx.prefix}clip-${g.id}` : null;
  const children = g.children.map((cid) => (cid === clipId && !ctx.outline ? null : <NodeView key={cid} id={cid} />));
  return (
    <g {...(common as any)} clipPath={clipRef ? `url(#${clipRef})` : undefined}>
      {clipRef && clipNode && (
        <defs>
          <clipPath id={clipRef} clipPathUnits="userSpaceOnUse">
            {renderClipContent(clipNode, doc)}
          </clipPath>
        </defs>
      )}
      {children}
    </g>
  );
}

function renderClipContent(n: Node, doc: Document): React.ReactNode {
  const t = isIdentity(n.transform) ? undefined : toSvgTransform(n.transform);
  if (n.type === 'path') return <path d={pathToSvgD(effectiveSubPaths(n))} fillRule={n.fillRule} clipRule={n.fillRule} transform={t} />;
  if (n.type === 'text') return <g transform={t}>{textElement(n, doc, {}, '', true)}</g>;
  if (n.type === 'group') {
    return (
      <g transform={t}>
        {n.children.map((c) => {
          const cn = doc.nodes[c];
          return cn ? <React.Fragment key={c}>{renderClipContent(cn, doc)}</React.Fragment> : null;
        })}
      </g>
    );
  }
  if (n.type === 'image') return <rect width={n.width} height={n.height} transform={t} />;
  return null;
}

export { effectiveSubPaths };

// brush stroke geometry is cached per node (nodes are immutable values)
const brushCache = new WeakMap<PathNode, { def: unknown; items: BrushItem[] }>();

function brushItemsFor(node: PathNode, doc: Document, sps: SubPath[]): BrushItem[] | null {
  const ref = node.stroke.brush;
  if (!ref) return null;
  const def = doc.brushes.find((b) => b.id === ref.id);
  if (!def) return null;
  const cached = brushCache.get(node);
  if (cached && cached.def === def) return cached.items;
  const items = brushItems(def, sps, node.stroke, node.id);
  brushCache.set(node, { def, items });
  return items;
}

function BrushStroke({ items, ctx, node }: { items: BrushItem[]; ctx: RenderCtx; node: PathNode }) {
  const defs: React.ReactNode[] = [];
  const els = items.map((it, i) => {
    const fid = `${ctx.prefix}bf-${node.id}-${i}`;
    const sid = `${ctx.prefix}bs-${node.id}-${i}`;
    const b = pathBounds(it.subpaths) ?? { x: 0, y: 0, width: 1, height: 1 };
    if (it.fill.type === 'linear' || it.fill.type === 'radial') defs.push(<GradientDef key={fid} id={fid} paint={it.fill} bounds={b} />);
    const strokeAttrs = it.stroke && it.stroke.paint.type !== 'none' && it.stroke.width > 0 ? { stroke: paintRef(it.stroke.paint, sid), strokeWidth: it.stroke.width, strokeLinecap: it.stroke.cap, strokeLinejoin: it.stroke.join, strokeOpacity: paintOpacity(it.stroke.paint) !== 1 ? paintOpacity(it.stroke.paint) : undefined } : { stroke: 'none' };
    if (it.stroke && (it.stroke.paint.type === 'linear' || it.stroke.paint.type === 'radial')) defs.push(<GradientDef key={sid} id={sid} paint={it.stroke.paint} bounds={b} />);
    return <path key={i} d={pathToSvgD(it.subpaths)} fill={paintRef(it.fill, fid)} fillOpacity={paintOpacity(it.fill) !== 1 ? paintOpacity(it.fill) : undefined} fillRule={it.fillRule} opacity={it.opacity !== 1 ? it.opacity : undefined} {...strokeAttrs} />;
  });
  return (
    <>
      {defs.length ? <defs>{defs}</defs> : null}
      {els}
    </>
  );
}

interface PaintDefs {
  fillRef: string;
  strokeRef: string;
  defs: React.ReactNode[];
}

function paintDefs(node: PathNode | TextNode, bounds: Rect | null, doc: Document, ctx: RenderCtx): PaintDefs {
  const defs: React.ReactNode[] = [];
  const fillId = `${ctx.prefix}pf-${node.id}`;
  const strokeId = `${ctx.prefix}ps-${node.id}`;
  const b = bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  if (node.fill.type === 'linear' || node.fill.type === 'radial') defs.push(<GradientDef key="f" id={fillId} paint={node.fill} bounds={b} />);
  else if (node.fill.type === 'pattern') defs.push(<PatternDef key="f" id={fillId} paint={node.fill} doc={doc} />);
  else if (node.fill.type === 'freeform' || node.fill.type === 'mesh') defs.push(<RasterGradientDef key="f" id={fillId} paint={node.fill} bounds={b} />);
  const sp = node.stroke.paint;
  if (sp.type === 'linear' || sp.type === 'radial') defs.push(<GradientDef key="s" id={strokeId} paint={sp} bounds={b} />);
  else if (sp.type === 'pattern') defs.push(<PatternDef key="s" id={strokeId} paint={sp} doc={doc} />);
  else if (sp.type === 'freeform' || sp.type === 'mesh') defs.push(<RasterGradientDef key="s" id={strokeId} paint={sp} bounds={b} />);
  return { fillRef: paintRef(node.fill, fillId), strokeRef: paintRef(sp, strokeId), defs };
}

function strokeAttrs(stroke: StrokeStyle, strokeRef: string, ctx: RenderCtx, widthMul = 1): Record<string, unknown> {
  if (ctx.outline) {
    return { stroke: '#8c8c8c', strokeWidth: 1, vectorEffect: 'non-scaling-stroke', fill: 'none' };
  }
  if (stroke.paint.type === 'none' || stroke.width <= 0) return { stroke: 'none' };
  return {
    stroke: strokeRef,
    strokeOpacity: paintOpacity(stroke.paint) !== 1 ? paintOpacity(stroke.paint) : undefined,
    strokeWidth: stroke.width * widthMul,
    strokeLinecap: stroke.cap,
    strokeLinejoin: stroke.join,
    strokeMiterlimit: stroke.miterLimit,
    strokeDasharray: stroke.dash.length ? stroke.dash.map((d) => d * widthMul).join(' ') : undefined,
    strokeDashoffset: stroke.dashOffset || undefined,
  };
}

function renderPath(node: PathNode, doc: Document, ctx: RenderCtx, common: Record<string, unknown>, filterId: string | null, gctx: GeomGroupCtx | null = null) {
  let sps = effectiveSubPaths(node);
  let faces: Face3D[] | null = null;
  if (gctx) {
    // fold the transform chain into the geometry and apply the group's geometry / 3D effects
    const m = multiply(gctx.matrix, node.transform);
    sps = isIdentity(m) ? sps : transformSubPaths(sps, m);
    if (!ctx.outline) {
      sps = applyGeometryEffects(sps, gctx.effects, gctx.frame);
      faces = faces3D(sps, gctx.frame, gctx.effects, node.fill, 1);
    }
  } else if (!ctx.outline && has3D(node.effects)) {
    faces = faces3D(sps, pathBounds(sps) ?? { x: 0, y: 0, width: 1, height: 1 }, node.effects, node.fill, 1);
  }
  const d = pathToSvgD(sps);
  const bounds = pathBounds(sps);
  const { fillRef, strokeRef, defs } = paintDefs(node, bounds, doc, ctx);
  const stroke = node.stroke;
  if (faces) {
    return (
      <g {...(common as any)}>
        {(defs.length || filterId) && (
          <defs>
            {defs}
            {filterId && <FilterDef id={filterId} effects={node.effects} />}
          </defs>
        )}
        <FacesView faces={faces} stroke={stroke} strokeRef={strokeRef} ctx={ctx} />
      </g>
    );
  }
  const markerStart = stroke.markerStart !== 'none' && stroke.paint.type !== 'none' ? `${ctx.prefix}mk-${node.id}-s` : null;
  const markerEnd = stroke.markerEnd !== 'none' && stroke.paint.type !== 'none' ? `${ctx.prefix}mk-${node.id}-e` : null;
  const fillAttrs = ctx.outline
    ? { fill: 'none' }
    : { fill: fillRef, fillOpacity: paintOpacity(node.fill) !== 1 ? paintOpacity(node.fill) : undefined, fillRule: node.fillRule };
  const markerAttrs = ctx.outline ? {} : { markerStart: markerStart ? `url(#${markerStart})` : undefined, markerEnd: markerEnd ? `url(#${markerEnd})` : undefined };
  const align = stroke.align;
  const needsDefs = defs.length || filterId || markerStart || markerEnd || (align !== 'center' && !ctx.outline);
  let body: React.ReactNode;
  const brush = !ctx.outline ? brushItemsFor(node, doc, sps) : null;
  if (brush) {
    body = (
      <>
        <path d={d} {...fillAttrs} stroke="none" />
        <BrushStroke items={brush} ctx={ctx} node={node} />
      </>
    );
  } else if (stroke.widthProfile && stroke.widthProfile.length && stroke.paint.type !== 'none' && !ctx.outline) {
    // variable width stroke: fill + outline rendered as a filled shape
    const outline = pathToSvgD(variableWidthOutlines(sps, stroke.widthProfile, stroke.width));
    body = (
      <>
        <path d={d} {...fillAttrs} stroke="none" />
        <path d={outline} fill={strokeRef} fillOpacity={paintOpacity(stroke.paint) !== 1 ? paintOpacity(stroke.paint) : undefined} fillRule="nonzero" stroke="none" />
      </>
    );
  } else if (align === 'center' || ctx.outline || stroke.paint.type === 'none') {
    body = <path d={d} {...fillAttrs} {...strokeAttrs(stroke, strokeRef, ctx)} {...markerAttrs} />;
  } else {
    const clipId = `${ctx.prefix}sa-${node.id}`;
    const strokeEl = <path d={d} fill="none" {...strokeAttrs(stroke, strokeRef, ctx, 2)} {...markerAttrs} clipPath={align === 'inside' ? `url(#${clipId})` : undefined} mask={align === 'outside' ? `url(#${clipId})` : undefined} />;
    body = (
      <>
        <path d={d} {...fillAttrs} stroke="none" />
        {strokeEl}
      </>
    );
    if (align === 'inside') defs.push(<clipPath key="sa" id={clipId} clipPathUnits="userSpaceOnUse"><path d={d} clipRule={node.fillRule} /></clipPath>);
    else
      defs.push(
        <mask key="sa" id={clipId} maskUnits="userSpaceOnUse" x={(bounds?.x ?? 0) - stroke.width * 2} y={(bounds?.y ?? 0) - stroke.width * 2} width={(bounds?.width ?? 1) + stroke.width * 4} height={(bounds?.height ?? 1) + stroke.width * 4}>
          <rect x={(bounds?.x ?? 0) - stroke.width * 2} y={(bounds?.y ?? 0) - stroke.width * 2} width={(bounds?.width ?? 1) + stroke.width * 4} height={(bounds?.height ?? 1) + stroke.width * 4} fill="#fff" />
          <path d={d} fill="#000" fillRule={node.fillRule} />
        </mask>,
      );
  }
  return (
    <g {...(common as any)}>
      {needsDefs ? (
        <defs>
          {defs}
          {filterId && <FilterDef id={filterId} effects={node.effects} />}
          {markerStart && <MarkerDef id={markerStart} kind={stroke.markerStart} stroke={stroke} start />}
          {markerEnd && <MarkerDef id={markerEnd} kind={stroke.markerEnd} stroke={stroke} start={false} />}
        </defs>
      ) : null}
      {body}
    </g>
  );
}

function textDecoration(n: TextNode): string | undefined {
  return n.style.textDecoration === 'none' ? undefined : n.style.textDecoration;
}

/** The <text> element (without wrapper). `asClip` renders black fill for clipPaths. */
export function textElement(n: TextNode, doc: Document, paintAttrs: Record<string, unknown>, prefix: string, asClip = false): React.ReactNode {
  const s = n.style;
  const base: Record<string, unknown> = {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fontStyle: s.fontStyle,
    letterSpacing: s.letterSpacing || undefined,
    textDecoration: textDecoration(n),
    xmlSpace: 'preserve',
    style: { whiteSpace: 'pre', userSelect: 'none' } as React.CSSProperties,
    ...(asClip ? { fill: '#000' } : paintAttrs),
  };
  if (n.kind === 'path' && n.pathId && doc.nodes[n.pathId]?.type === 'path') {
    const pathNode = doc.nodes[n.pathId] as PathNode;
    const rel = multiply(invert(n.transform), pathNode.transform);
    const d = pathToSvgD(pathNode.subpaths);
    const tpId = `${prefix}tp-${n.id}`;
    return (
      <>
        <defs>
          <path id={tpId} d={d} transform={isIdentity(rel) ? undefined : toSvgTransform(rel)} />
        </defs>
        <text {...base} textAnchor={s.textAlign === 'center' ? 'middle' : s.textAlign === 'right' ? 'end' : 'start'} dy={s.baselineShift ? -s.baselineShift : undefined}>
          <textPath href={`#${tpId}`} startOffset={`${((n.pathOffset ?? 0) * 100).toFixed(2)}%`}>
            {(n.runs && n.runs.length ? n.runs : [{ text: n.text }]).map((r, ri) => {
              const st = { ...s, ...(r.style ?? {}) };
              const override: Record<string, unknown> = {};
              if (st.fontFamily !== s.fontFamily) override.fontFamily = st.fontFamily;
              if (st.fontSize !== s.fontSize) override.fontSize = st.fontSize;
              if (st.fontWeight !== s.fontWeight) override.fontWeight = st.fontWeight;
              if (st.fontStyle !== s.fontStyle) override.fontStyle = st.fontStyle;
              if (st.letterSpacing !== s.letterSpacing) override.letterSpacing = st.letterSpacing;
              if (st.textDecoration !== s.textDecoration) override.textDecoration = st.textDecoration === 'none' ? 'none' : st.textDecoration;
              if (st.baselineShift !== s.baselineShift) override.dy = -(st.baselineShift - s.baselineShift);
              const txt = applyTransformText(r.text.replace(/\n/g, ' '), st.textTransform);
              return Object.keys(override).length ? (
                <tspan key={ri} {...override}>
                  {txt}
                </tspan>
              ) : (
                <React.Fragment key={ri}>{txt}</React.Fragment>
              );
            })}
          </textPath>
        </text>
      </>
    );
  }
  const layout = layoutText(n);
  return (
    <text {...base}>
      {layout.lines.map((line, li) => (
        <tspan key={li} x={line.x} y={line.y - s.baselineShift}>
          {line.runs.map((r, ri) => {
            const st = r.style;
            const override: Record<string, unknown> = {};
            if (st.fontFamily !== s.fontFamily) override.fontFamily = st.fontFamily;
            if (st.fontSize !== s.fontSize) override.fontSize = st.fontSize;
            if (st.fontWeight !== s.fontWeight) override.fontWeight = st.fontWeight;
            if (st.fontStyle !== s.fontStyle) override.fontStyle = st.fontStyle;
            if (st.letterSpacing !== s.letterSpacing) override.letterSpacing = st.letterSpacing;
            if (st.textDecoration !== s.textDecoration) override.textDecoration = st.textDecoration === 'none' ? 'none' : st.textDecoration;
            if (st.baselineShift !== s.baselineShift) override.dy = -(st.baselineShift - s.baselineShift);
            return (
              <tspan key={ri} x={line.x + r.x} {...override}>
                {r.text}
              </tspan>
            );
          })}
          {line.runs.length === 0 ? ' ' : null}
        </tspan>
      ))}
    </text>
  );
}

function applyTransformText(text: string, mode: TextNode['style']['textTransform']): string {
  switch (mode) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
    default:
      return text;
  }
}

function renderText(node: TextNode, doc: Document, ctx: RenderCtx, common: Record<string, unknown>, filterId: string | null) {
  const layout = node.kind === 'path' ? null : layoutText(node);
  const bounds = layout ? layout.bounds : { x: 0, y: -node.style.fontSize, width: node.style.fontSize * node.text.length * 0.6, height: node.style.fontSize * 1.2 };
  const { fillRef, strokeRef, defs } = paintDefs(node, bounds, doc, ctx);
  const paintAttrs = ctx.outline
    ? { fill: '#8c8c8c', fillOpacity: 0.6, stroke: 'none' }
    : {
        fill: fillRef,
        fillOpacity: paintOpacity(node.fill) !== 1 ? paintOpacity(node.fill) : undefined,
        ...strokeAttrs(node.stroke, strokeRef, ctx),
        paintOrder: 'stroke',
      };
  const showBox = ctx.outline && node.kind === 'area' && node.box;
  return (
    <g {...(common as any)}>
      {(defs.length || filterId) && (
        <defs>
          {defs}
          {filterId && <FilterDef id={filterId} effects={node.effects} />}
        </defs>
      )}
      {showBox && <rect x={0} y={0} width={node.box!.width} height={node.box!.height} fill="none" stroke="#8c8c8c" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      {textElement(node, doc, paintAttrs, ctx.prefix)}
    </g>
  );
}

function renderImage(node: ImageNode, ctx: RenderCtx, common: Record<string, unknown>, filterId: string | null) {
  if (ctx.outline) {
    return (
      <g {...(common as any)}>
        <rect width={node.width} height={node.height} fill="none" stroke="#8c8c8c" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={`M0 0 L${node.width} ${node.height} M${node.width} 0 L0 ${node.height}`} stroke="#8c8c8c" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </g>
    );
  }
  const crop = node.crop;
  let img: React.ReactNode;
  if (crop && node.naturalWidth && node.naturalHeight) {
    const sx = node.width / crop.width;
    const sy = node.height / crop.height;
    const clipId = `${ctx.prefix}ic-${node.id}`;
    img = (
      <>
        <defs>
          <clipPath id={clipId}>
            <rect width={node.width} height={node.height} />
          </clipPath>
        </defs>
        <image
          href={node.src}
          x={-crop.x * sx}
          y={-crop.y * sy}
          width={node.naturalWidth * sx}
          height={node.naturalHeight * sy}
          preserveAspectRatio="none"
          clipPath={`url(#${clipId})`}
          style={{ imageRendering: node.smoothing === false ? 'pixelated' : undefined }}
        />
      </>
    );
  } else {
    img = <image href={node.src} width={node.width} height={node.height} preserveAspectRatio="none" style={{ imageRendering: node.smoothing === false ? 'pixelated' : undefined }} />;
  }
  return (
    <g {...(common as any)}>
      {filterId && (
        <defs>
          <FilterDef id={filterId} effects={node.effects} />
        </defs>
      )}
      {img}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/** Live document content (subscribes to the store). Place inside an <svg>. */
export function LiveDocument({ outline, hidden, prefix = '' }: { outline: boolean; hidden?: Set<ID>; prefix?: string }) {
  const layers = useStore((s) => s.doc.layers);
  const ctx = React.useMemo<RenderCtx>(() => ({ doc: null, outline, exportMode: false, hidden, prefix }), [outline, hidden, prefix]);
  return (
    <Ctx.Provider value={ctx}>
      {layers.map((id) => (
        <NodeView key={id} id={id} />
      ))}
    </Ctx.Provider>
  );
}

/** Static content for a given document (export / thumbnails). */
export function StaticDocument({ doc, ids, outline = false, prefix = '', exportMode = true }: { doc: Document; ids?: ID[]; outline?: boolean; prefix?: string; exportMode?: boolean }) {
  const ctx: RenderCtx = { doc, outline, exportMode, prefix };
  const roots = ids ?? doc.layers;
  return (
    <Ctx.Provider value={ctx}>
      {roots.map((id) => (
        <StaticNode key={id} id={id} />
      ))}
    </Ctx.Provider>
  );
}

function StaticNode({ id }: { id: ID }) {
  const ctx = useContext(Ctx);
  const node = ctx.doc!.nodes[id];
  if (!node || !node.visible) return null;
  return renderStatic(node, ctx.doc!, ctx);
}

function renderStatic(node: Node, doc: Document, ctx: RenderCtx): React.ReactNode {
  // NodeView is used for children via the same context; in static mode NodeView
  // reads from ctx.doc, so we can reuse renderNode directly.
  if (isContainer(node)) return renderNode(node, doc, ctx);
  return renderNode(node, doc, ctx);
}

export { Ctx as RenderContext };
