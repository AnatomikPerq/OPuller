/**
 * OPuller document model.
 *
 * The document is a normalized tree: every node lives in `doc.nodes` keyed by id,
 * containers keep an ordered `children: ID[]` list (index 0 = bottom-most / painted first,
 * last = top-most). `doc.layers` lists top-level layer ids in the same order.
 *
 * All geometry of a node is expressed in the node's *local* coordinate system; the
 * node's `transform` maps local coordinates into the parent's coordinate system.
 * World space == the coordinate system of the document (artboards live there too).
 * Units are CSS px (1/96 in); display units are a preference.
 */

export type ID = string;

export interface Vec {
  x: number;
  y: number;
}

/** Affine matrix: [a c e; b d f; 0 0 1] — same convention as SVG/Canvas. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/** Hex colour "#rrggbb" (always 6 digits, lowercase). */
export type HexColor = string;

export interface GradientStop {
  /** 0..1 */
  offset: number;
  color: HexColor;
  /** 0..1 */
  opacity: number;
}

export type SpreadMethod = 'pad' | 'reflect' | 'repeat';

export interface NoPaint {
  type: 'none';
}

export interface SolidPaint {
  type: 'solid';
  color: HexColor;
  /** 0..1 */
  opacity: number;
}

/**
 * Gradients are defined in *object bounding box* units (0..1 across the geometry
 * bounds of the node), which keeps them stable under any transform.
 */
export interface LinearGradientPaint {
  type: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
  spread: SpreadMethod;
}

export interface RadialGradientPaint {
  type: 'radial';
  cx: number;
  cy: number;
  r: number;
  /** focal point (defaults to cx/cy) */
  fx?: number;
  fy?: number;
  stops: GradientStop[];
  spread: SpreadMethod;
}

export interface PatternPaint {
  type: 'pattern';
  /** id of a pattern definition in doc.patterns */
  patternId: ID;
  scale: number;
  angle: number;
}

export type Paint = NoPaint | SolidPaint | LinearGradientPaint | RadialGradientPaint | PatternPaint;
export type GradientPaint = LinearGradientPaint | RadialGradientPaint;

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';
export type StrokeAlign = 'center' | 'inside' | 'outside';
export type Arrowhead =
  | 'none'
  | 'arrow'
  | 'triangle'
  | 'circle'
  | 'square'
  | 'bar'
  | 'diamond'
  | 'open-arrow';

export interface StrokeStyle {
  paint: Paint;
  width: number;
  cap: LineCap;
  join: LineJoin;
  miterLimit: number;
  /** dash pattern in px; empty array = solid */
  dash: number[];
  dashOffset: number;
  align: StrokeAlign;
  markerStart: Arrowhead;
  markerEnd: Arrowhead;
  /** scale of arrowheads relative to stroke width (1 = default) */
  markerScale: number;
  /**
   * Variable width profile (Width tool). Points along the path (offset 0..1 of
   * the total length) with a width multiplier or absolute width. When present the
   * stroke is rendered as a filled outline (see geometry/widthProfile.ts).
   */
  widthProfile?: WidthPoint[];
}

export interface WidthPoint {
  /** 0..1 along the whole path */
  offset: number;
  /** absolute width at this point (px) */
  width: number;
  /** optional asymmetric widths (left/right of the path direction) */
  left?: number;
  right?: number;
}

// ---------------------------------------------------------------------------
// Effects (appearance)
// ---------------------------------------------------------------------------

export interface DropShadowEffect {
  type: 'dropShadow';
  enabled: boolean;
  dx: number;
  dy: number;
  blur: number;
  color: HexColor;
  opacity: number;
}
export interface InnerShadowEffect {
  type: 'innerShadow';
  enabled: boolean;
  dx: number;
  dy: number;
  blur: number;
  color: HexColor;
  opacity: number;
}
export interface BlurEffect {
  type: 'blur';
  enabled: boolean;
  radius: number;
}
export interface GlowEffect {
  type: 'outerGlow' | 'innerGlow';
  enabled: boolean;
  blur: number;
  color: HexColor;
  opacity: number;
}
export interface ColorAdjustEffect {
  type: 'colorAdjust';
  enabled: boolean;
  brightness: number; // 1 = neutral
  contrast: number; // 1 = neutral
  saturate: number; // 1 = neutral
  hueRotate: number; // degrees
  grayscale: number; // 0..1
  invert: number; // 0..1
  sepia: number; // 0..1
}
export interface RoundCornersEffect {
  type: 'roundCorners';
  enabled: boolean;
  radius: number;
}

export type Effect =
  | DropShadowEffect
  | InnerShadowEffect
  | BlurEffect
  | GlowEffect
  | ColorAdjustEffect
  | RoundCornersEffect;

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * A Bezier anchor. `handleIn`/`handleOut` are offsets *relative* to `point`.
 * `null` means "no handle" (a straight segment on that side).
 */
export interface Anchor {
  point: Vec;
  handleIn: Vec | null;
  handleOut: Vec | null;
  /** corner (independent handles) vs smooth (handles collinear) */
  kind: 'corner' | 'smooth';
}

export interface SubPath {
  anchors: Anchor[];
  closed: boolean;
}

export type FillRule = 'nonzero' | 'evenodd';

/** Parametric "live" shapes that regenerate their geometry from parameters. */
export type LiveShape =
  | { kind: 'rect'; width: number; height: number; radii: [number, number, number, number] }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'polygon'; sides: number; radius: number }
  | { kind: 'star'; points: number; outerRadius: number; innerRadius: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'spiral'; radius: number; decay: number; segments: number; clockwise: boolean }
  | { kind: 'arc'; rx: number; ry: number; startAngle: number; endAngle: number; pie: boolean };

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number; // 100..900
  fontStyle: 'normal' | 'italic';
  /** multiplier of fontSize (1.2 = 120%) */
  lineHeight: number;
  /** px */
  letterSpacing: number;
  textAlign: TextAlign;
  textDecoration: 'none' | 'underline' | 'line-through';
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** baseline shift in px */
  baselineShift: number;
  /** paragraph spacing in px */
  paragraphSpacing: number;
}

/** A styled run of text: `style` overrides the node's base style for this run. */
export interface TextRun {
  text: string;
  style?: Partial<TextStyle>;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeType = 'layer' | 'group' | 'path' | 'text' | 'image';

export interface NodeBase {
  id: ID;
  type: NodeType;
  name: string;
  parent: ID | null;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  transform: Matrix;
  effects: Effect[];
}

export interface LayerNode extends NodeBase {
  type: 'layer';
  children: ID[];
  /** UI colour for selection highlight and layer panel */
  color: HexColor;
  expanded?: boolean;
}

export interface GroupNode extends NodeBase {
  type: 'group';
  children: ID[];
  /**
   * When set, this group is a clipping group: the child with this id acts as the
   * clipping mask (its own fill/stroke are not painted).
   */
  clipId: ID | null;
  expanded?: boolean;
}

export interface PathNode extends NodeBase {
  type: 'path';
  subpaths: SubPath[];
  fillRule: FillRule;
  fill: Paint;
  stroke: StrokeStyle;
  /** live shape parameters, if this path is still a parametric shape */
  shape?: LiveShape;
}

export interface TextNode extends NodeBase {
  type: 'text';
  kind: 'point' | 'area' | 'path';
  /** Plain text of the whole object (paragraphs separated by \n). Kept in sync with runs. */
  text: string;
  /** Rich text runs; concatenation of run texts equals `text`. */
  runs: TextRun[];
  style: TextStyle;
  /** Area text box size (local units) — used when kind === 'area'. */
  box?: { width: number; height: number };
  /** Text-on-path: the id of a path node (must be a sibling; its geometry is hidden). */
  pathId?: ID | null;
  /** offset along the path (0..1) for text-on-path */
  pathOffset?: number;
  fill: Paint;
  stroke: StrokeStyle;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  /** data: URL or blob: URL */
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** displayed size in local units */
  width: number;
  height: number;
  /** optional crop rect in natural-pixel units */
  crop?: Rect;
  smoothing?: boolean;
}

export type Node = LayerNode | GroupNode | PathNode | TextNode | ImageNode;
export type ContainerNode = LayerNode | GroupNode;
export type ShapeNode = PathNode | TextNode;

export function isContainer(n: Node | undefined | null): n is ContainerNode {
  return !!n && (n.type === 'layer' || n.type === 'group');
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface Artboard {
  id: ID;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** background colour shown on canvas & used for export when not transparent */
  background: HexColor;
  transparent: boolean;
}

export interface Guide {
  id: ID;
  axis: 'x' | 'y';
  /** world position */
  position: number;
  locked?: boolean;
}

export interface Swatch {
  id: ID;
  name: string;
  paint: Paint;
}

export interface PatternDef {
  id: ID;
  name: string;
  width: number;
  height: number;
  /** SVG markup of a tile (children of an <svg> with viewBox = 0 0 width height) */
  svg: string;
}

export interface GridSettings {
  size: number;
  subdivisions: number;
  color: HexColor;
  style: 'lines' | 'dots';
}

export type Units = 'px' | 'pt' | 'mm' | 'cm' | 'in';

export interface Document {
  id: ID;
  name: string;
  units: Units;
  artboards: Artboard[];
  /** top-level layer ids, bottom to top */
  layers: ID[];
  nodes: Record<ID, Node>;
  guides: Guide[];
  swatches: Swatch[];
  patterns: PatternDef[];
  grid: GridSettings;
  meta: {
    created: string;
    modified: string;
    generator: string;
    version: number;
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface AnchorRef {
  nodeId: ID;
  subpath: number;
  index: number;
}

export type HandleSide = 'in' | 'out';

export interface HandleRef extends AnchorRef {
  side: HandleSide;
}
