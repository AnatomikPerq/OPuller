/**
 * SVG renderer for the document. Used live on the canvas (fine-grained store
 * subscriptions) and statically for export (renderToStaticMarkup).
 */
import React, { createContext, memo, useContext } from 'react';
import type { Document, ID, Node, PathNode, TextNode, ImageNode, GroupNode, Paint, StrokeStyle, Effect, Rect, Arrowhead, SubPath } from '@/model/types';
import { pathToSvgD, pathBounds } from '@/geometry/path';
import { toSvgTransform, isIdentity, multiply, invert } from '@/geometry/matrix';
import { roundCorners } from '@/geometry/shapes';
import { variableWidthOutlines } from '@/geometry/widthProfile';
import { layoutText } from '@/text/layout';
import { useStore } from '@/store/store';
import { isContainer } from '@/model/types';

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
      return `url(#${id})`;
  }
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
  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width={def.width}
      height={def.height}
      patternTransform={`rotate(${paint.angle}) scale(${paint.scale})`}
      dangerouslySetInnerHTML={{ __html: def.svg }}
    />
  );
}

// ---------------------------------------------------------------------------
// Effects → filters
// ---------------------------------------------------------------------------

function hasFilterEffects(effects: Effect[]): boolean {
  return effects.some((e) => e.enabled && e.type !== 'roundCorners');
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
  const node = useNode(id, ctx);
  const doc = useDoc(ctx);
  if (!node || !node.visible) return null;
  if (ctx.hidden?.has(id)) return null;
  return renderNode(node, doc, ctx);
});

function renderNode(node: Node, doc: Document, ctx: RenderCtx): React.ReactNode {
  const prefix = ctx.prefix;
  const filterId = `${prefix}f-${node.id}`;
  const useFilter = !ctx.outline && hasFilterEffects(node.effects);
  const style: React.CSSProperties = {};
  if (node.blendMode !== 'normal' && !ctx.outline) style.mixBlendMode = node.blendMode as any;
  const common: React.SVGAttributes<SVGGElement> & { [k: string]: unknown } = {
    transform: isIdentity(node.transform) ? undefined : toSvgTransform(node.transform),
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
    case 'group':
      content = renderGroup(node as GroupNode, doc, ctx, common);
      if (useFilter) defs = <FilterDef id={filterId} effects={node.effects} />;
      return (
        <>
          {defs && <defs>{defs}</defs>}
          {content}
        </>
      );
    case 'path':
      return renderPath(node, doc, ctx, common, useFilter ? filterId : null);
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

/** Path geometry after geometry effects (round corners). */
export function effectiveSubPaths(n: PathNode): SubPath[] {
  let sps = n.subpaths;
  for (const e of n.effects) {
    if (e.enabled && e.type === 'roundCorners' && e.radius > 0) sps = sps.map((sp) => roundCorners(sp, e.radius));
  }
  return sps;
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
  const sp = node.stroke.paint;
  if (sp.type === 'linear' || sp.type === 'radial') defs.push(<GradientDef key="s" id={strokeId} paint={sp} bounds={b} />);
  else if (sp.type === 'pattern') defs.push(<PatternDef key="s" id={strokeId} paint={sp} doc={doc} />);
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

function renderPath(node: PathNode, doc: Document, ctx: RenderCtx, common: Record<string, unknown>, filterId: string | null) {
  const sps = effectiveSubPaths(node);
  const d = pathToSvgD(sps);
  const bounds = pathBounds(sps);
  const { fillRef, strokeRef, defs } = paintDefs(node, bounds, doc, ctx);
  const stroke = node.stroke;
  const markerStart = stroke.markerStart !== 'none' && stroke.paint.type !== 'none' ? `${ctx.prefix}mk-${node.id}-s` : null;
  const markerEnd = stroke.markerEnd !== 'none' && stroke.paint.type !== 'none' ? `${ctx.prefix}mk-${node.id}-e` : null;
  const fillAttrs = ctx.outline
    ? { fill: 'none' }
    : { fill: fillRef, fillOpacity: paintOpacity(node.fill) !== 1 ? paintOpacity(node.fill) : undefined, fillRule: node.fillRule };
  const markerAttrs = ctx.outline ? {} : { markerStart: markerStart ? `url(#${markerStart})` : undefined, markerEnd: markerEnd ? `url(#${markerEnd})` : undefined };
  const align = stroke.align;
  const needsDefs = defs.length || filterId || markerStart || markerEnd || (align !== 'center' && !ctx.outline);
  let body: React.ReactNode;
  if (stroke.widthProfile && stroke.widthProfile.length && stroke.paint.type !== 'none' && !ctx.outline) {
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
