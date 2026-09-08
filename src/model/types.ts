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
  /** linked global/spot swatch (the colour follows the swatch) */
  swatchId?: ID;
  /** tint of the linked swatch, 0..100 (100 = full colour) */
  tint?: number;
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
  /** linked global/spot swatch: the colour follows the swatch (see color/swatches.ts) */
  swatchId?: ID;
  /** tint of the linked swatch, 0..100 (100 = full colour, mixed with white below) */
  tint?: number;
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
  /** tile offset in px (moves the pattern inside the object) */
  x?: number;
  y?: number;
}

/** A colour point of a freeform gradient (object bounding box units). */
export interface FreeformPoint {
  x: number;
  y: number;
  color: HexColor;
  opacity: number;
  /** how far the colour reaches, in bbox units (0.05 .. 2) */
  spread: number;
}

/**
 * Freeform gradient (Illustrator's Freeform): colour points blended smoothly
 * (points mode) or connected into lines (lines mode: `lines` lists point
 * indices forming polylines). Rendered through a raster tile (gradients/raster.ts).
 */
export interface FreeformGradientPaint {
  type: 'freeform';
  mode: 'points' | 'lines';
  points: FreeformPoint[];
  lines?: number[][];
}

/** A gradient mesh node: position, colour and the four tangent handles (relative offsets, bbox units). */
export interface MeshNode {
  x: number;
  y: number;
  color: HexColor;
  opacity: number;
  /** handle towards the row above */
  up?: Vec | null;
  down?: Vec | null;
  left?: Vec | null;
  right?: Vec | null;
}

/**
 * Gradient mesh: (rows+1) × (cols+1) nodes in row-major order forming
 * rows × cols Coons patches with bilinear colours. Coordinates are object
 * bounding box units so the mesh follows transforms of the object.
 */
export interface MeshGradientPaint {
  type: 'mesh';
  rows: number;
  cols: number;
  nodes: MeshNode[];
}

export type Paint = NoPaint | SolidPaint | LinearGradientPaint | RadialGradientPaint | PatternPaint | FreeformGradientPaint | MeshGradientPaint;
export type GradientPaint = LinearGradientPaint | RadialGradientPaint;
export type RasterGradientPaint = FreeformGradientPaint | MeshGradientPaint;

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
  /** brush applied to the stroke (calligraphic / scatter / art / pattern); see brushes/geometry.ts */
  brush?: StrokeBrush;
}

/** Reference from a stroke to a brush definition with per-stroke overrides. */
export interface StrokeBrush {
  id: ID;
  /** extra scale (1 = as defined); the stroke width multiplies it too */
  scale?: number;
  flipAlong?: boolean;
  flipAcross?: boolean;
  colorization?: BrushColorization;
}

export type BrushColorization = 'none' | 'tints' | 'tintsShades' | 'hue';

/** Artwork used by scatter / art / pattern brushes (a group `root` and its descendants, in brush space). */
export interface BrushArtwork {
  nodes: Record<ID, Node>;
  root: ID;
}

export interface BrushBase {
  id: ID;
  name: string;
}

export interface CalligraphicBrush extends BrushBase {
  kind: 'calligraphic';
  /** degrees, counter-clockwise */
  angle: number;
  /** 0..100 (100 = round) */
  roundness: number;
  /** diameter in px */
  size: number;
  /** random variation (± value) */
  angleVariation?: number;
  roundnessVariation?: number;
  sizeVariation?: number;
}

export interface ScatterBrush extends BrushBase {
  kind: 'scatter';
  art: BrushArtwork;
  /** [min, max] percent */
  size: [number, number];
  /** [min, max] percent of the artwork width */
  spacing: [number, number];
  /** [min, max] percent of the artwork width, perpendicular offset */
  scatter: [number, number];
  /** [min, max] degrees */
  rotation: [number, number];
  rotationRelativeTo: 'page' | 'path';
  colorization: BrushColorization;
}

export interface ArtBrush extends BrushBase {
  kind: 'art';
  art: BrushArtwork;
  /** percent of the artwork height */
  width: number;
  /** stretch the artwork to the path length or scale it proportionally */
  stretch: 'stretch' | 'proportional';
  flipAlong?: boolean;
  flipAcross?: boolean;
  colorization: BrushColorization;
}

export interface PatternBrush extends BrushBase {
  kind: 'pattern';
  side: BrushArtwork;
  start?: BrushArtwork;
  end?: BrushArtwork;
  /** percent */
  scale: number;
  /** percent of the tile width */
  spacing: number;
  fit: 'stretch' | 'space' | 'approximate';
  flipAlong?: boolean;
  flipAcross?: boolean;
  colorization: BrushColorization;
}

export type BrushDef = CalligraphicBrush | ScatterBrush | ArtBrush | PatternBrush;

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
  /** Module-specific serializable data (e.g. blend parameters). */
  data?: Record<string, unknown>;
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

/** process = plain colour; global = objects follow swatch edits; spot = named ink (also global). */
export type SwatchKind = 'process' | 'global' | 'spot';

/** Ink percentages 0..100. */
export interface CMYK {
  c: number;
  m: number;
  y: number;
  k: number;
}

export interface Swatch {
  id: ID;
  name: string;
  paint: Paint;
  kind?: SwatchKind;
  /** authored CMYK values (kept exact instead of round-tripping through RGB) */
  cmyk?: CMYK;
}

export type ColorMode = 'rgb' | 'cmyk';

/** Bleed around every artboard in px. */
export interface Bleed {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type PatternLayout = 'grid' | 'brick-row' | 'brick-col' | 'hex-row' | 'hex-col';

export interface PatternDef {
  id: ID;
  name: string;
  /** tile size (px) */
  width: number;
  height: number;
  /**
   * SVG markup of one pattern *cell* (children of an <svg> with viewBox
   * 0 0 cellWidth cellHeight, see patterns/tile.ts). Regenerated from the
   * artwork whenever the pattern is edited; library patterns may only have this.
   */
  svg: string;
  /** editable tile artwork: a group `root` and its descendants, in tile space (0,0 = tile origin) */
  nodes?: Record<ID, Node>;
  root?: ID;
  layout?: PatternLayout;
  /** brick offset as a fraction of the tile (0.5 = half a tile) */
  offset?: number;
  /** gap between tiles (px; negative = overlap) */
  spacing?: { x: number; y: number };
  /** tile background colour (null/undefined = transparent) */
  background?: HexColor | null;
}

/** Reusable artwork placed as linked instances (a group with `data.symbol`). */
export interface SymbolDef {
  id: ID;
  name: string;
  /** artwork nodes keyed by id; `root` is a group whose children form the symbol, in symbol space (registration point at 0,0) */
  nodes: Record<ID, Node>;
  root: ID;
  /** bumped on every redefinition; instances store the version they were built from */
  version: number;
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
  symbols: SymbolDef[];
  brushes: BrushDef[];
  grid: GridSettings;
  /** document colour mode: how colours are edited/displayed (values are always stored as sRGB hex) */
  colorMode: ColorMode;
  /** print bleed around artboards */
  bleed: Bleed;
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
