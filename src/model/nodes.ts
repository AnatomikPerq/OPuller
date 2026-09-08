import { nanoid } from 'nanoid';
import type {
  ID,
  Node,
  PathNode,
  GroupNode,
  LayerNode,
  TextNode,
  ImageNode,
  SubPath,
  LiveShape,
  Paint,
  StrokeStyle,
  TextStyle,
  Matrix,
  Document,
  Artboard,
  Effect,
} from './types';
import { identity } from '@/geometry/matrix';
import { liveShapeSubPaths } from '@/geometry/shapes';
import { DEFAULT_FILL, defaultStroke, defaultTextStyle, defaultGrid, defaultSwatches, LAYER_COLORS } from './defaults';

export const newId = (): ID => nanoid(10);

interface BaseOpts {
  id?: ID;
  name?: string;
  transform?: Matrix;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  effects?: Effect[];
  blendMode?: Node['blendMode'];
}

function base(type: Node['type'], defaultName: string, o: BaseOpts) {
  return {
    id: o.id ?? newId(),
    type,
    name: o.name ?? defaultName,
    parent: null as ID | null,
    visible: o.visible ?? true,
    locked: o.locked ?? false,
    opacity: o.opacity ?? 1,
    blendMode: o.blendMode ?? ('normal' as const),
    transform: o.transform ? { ...o.transform } : identity(),
    effects: o.effects ? o.effects.map((e) => ({ ...e })) : [],
  };
}

export interface PathOpts extends BaseOpts {
  fill?: Paint;
  stroke?: StrokeStyle;
  fillRule?: PathNode['fillRule'];
  shape?: LiveShape;
}

export function makePath(subpaths: SubPath[], o: PathOpts = {}): PathNode {
  return {
    ...base('path', 'Path', o),
    type: 'path',
    subpaths,
    fillRule: o.fillRule ?? 'nonzero',
    fill: o.fill ? clonePaint(o.fill) : { ...DEFAULT_FILL },
    stroke: o.stroke ? cloneStroke(o.stroke) : defaultStroke(),
    shape: o.shape,
  };
}

export function makeShape(shape: LiveShape, o: PathOpts = {}): PathNode {
  const names: Record<LiveShape['kind'], string> = {
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    polygon: 'Polygon',
    star: 'Star',
    line: 'Line',
    spiral: 'Spiral',
    arc: 'Arc',
  };
  const node = makePath(liveShapeSubPaths(shape), { ...o, shape, name: o.name ?? names[shape.kind] });
  if (shape.kind === 'line' || shape.kind === 'spiral' || (shape.kind === 'arc' && !shape.pie)) {
    if (!o.fill) node.fill = { type: 'none' };
  }
  return node;
}

export function makeGroup(children: ID[] = [], o: BaseOpts & { clipId?: ID | null } = {}): GroupNode {
  return { ...base('group', 'Group', o), type: 'group', children: [...children], clipId: o.clipId ?? null, expanded: false };
}

export function makeLayer(o: BaseOpts & { color?: string; children?: ID[] } = {}, index = 0): LayerNode {
  return {
    ...base('layer', `Layer ${index + 1}`, o),
    type: 'layer',
    children: o.children ? [...o.children] : [],
    color: o.color ?? LAYER_COLORS[index % LAYER_COLORS.length],
    expanded: true,
  };
}

export interface TextOpts extends BaseOpts {
  kind?: TextNode['kind'];
  style?: Partial<TextStyle>;
  fill?: Paint;
  stroke?: StrokeStyle;
  box?: { width: number; height: number };
  pathId?: ID | null;
}

export function makeText(text: string, o: TextOpts = {}): TextNode {
  return {
    ...base('text', text.split('\n')[0].slice(0, 24) || 'Text', o),
    type: 'text',
    kind: o.kind ?? 'point',
    text,
    runs: [{ text }],
    style: defaultTextStyle(o.style),
    box: o.box,
    pathId: o.pathId ?? null,
    pathOffset: 0,
    fill: o.fill ? clonePaint(o.fill) : { type: 'solid', color: '#000000', opacity: 1 },
    stroke: o.stroke ? cloneStroke(o.stroke) : defaultStroke({ paint: { type: 'none' } }),
  };
}

export interface ImageOpts extends BaseOpts {
  width?: number;
  height?: number;
}

export function makeImage(src: string, naturalWidth: number, naturalHeight: number, o: ImageOpts = {}): ImageNode {
  return {
    ...base('image', 'Image', o),
    type: 'image',
    src,
    naturalWidth,
    naturalHeight,
    width: o.width ?? naturalWidth,
    height: o.height ?? naturalHeight,
    smoothing: true,
  };
}

export function clonePaint(p: Paint): Paint {
  switch (p.type) {
    case 'none':
      return { type: 'none' };
    case 'solid':
      return { ...p };
    case 'linear':
    case 'radial':
      return { ...p, stops: p.stops.map((s) => ({ ...s })) };
    case 'pattern':
      return { ...p };
    case 'freeform':
      return { ...p, points: p.points.map((pt) => ({ ...pt })), lines: p.lines ? p.lines.map((l) => [...l]) : undefined };
    case 'mesh':
      return { ...p, nodes: p.nodes.map((n) => ({ ...n, up: n.up ? { ...n.up } : n.up, down: n.down ? { ...n.down } : n.down, left: n.left ? { ...n.left } : n.left, right: n.right ? { ...n.right } : n.right })) };
  }
}

export function cloneStroke(s: StrokeStyle): StrokeStyle {
  return { ...s, paint: clonePaint(s.paint), dash: [...s.dash] };
}

export function makeArtboard(o: Partial<Artboard> = {}, index = 0): Artboard {
  return {
    id: o.id ?? newId(),
    name: o.name ?? `Artboard ${index + 1}`,
    x: o.x ?? 0,
    y: o.y ?? 0,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    background: o.background ?? '#ffffff',
    transparent: o.transparent ?? false,
  };
}

export interface NewDocumentOptions {
  name?: string;
  width?: number;
  height?: number;
  units?: Document['units'];
  artboards?: number;
  background?: string;
  transparent?: boolean;
  colorMode?: Document['colorMode'];
  bleed?: Document['bleed'];
}

export const NO_BLEED: Document['bleed'] = { top: 0, right: 0, bottom: 0, left: 0 };

export function createDocument(o: NewDocumentOptions = {}): Document {
  const width = o.width ?? 1920;
  const height = o.height ?? 1080;
  const count = Math.max(1, o.artboards ?? 1);
  const artboards: Artboard[] = [];
  const gap = 100;
  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    artboards.push(
      makeArtboard(
        {
          x: col * (width + gap),
          y: row * (height + gap),
          width,
          height,
          background: o.background ?? '#ffffff',
          transparent: o.transparent ?? false,
        },
        i,
      ),
    );
  }
  const layer = makeLayer({}, 0);
  const now = new Date().toISOString();
  return {
    id: newId(),
    name: o.name ?? 'Untitled',
    units: o.units ?? 'px',
    artboards,
    layers: [layer.id],
    nodes: { [layer.id]: layer },
    guides: [],
    swatches: defaultSwatches(),
    patterns: [],
    symbols: [],
    brushes: [],
    grid: defaultGrid(),
    colorMode: o.colorMode ?? 'rgb',
    bleed: o.bleed ? { ...o.bleed } : { ...NO_BLEED },
    meta: { created: now, modified: now, generator: 'OPuller', version: 1 },
  };
}
