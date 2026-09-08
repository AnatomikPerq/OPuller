/**
 * OPuller project file format (".opuller"): a JSON envelope around the document.
 *
 *   { "format": "opuller", "version": 1, "document": { ...Document } }
 *
 * Images are embedded as data URLs (blob: URLs created by paste/place are
 * converted before saving). Parsing validates and normalises the document so
 * that files written by older versions (migrations) or hand-edited files still
 * load without crashing the editor.
 */
import type { Document, Node, Artboard, Paint, StrokeStyle, TextStyle, Effect, SubPath, Anchor, Matrix, ID } from '@/model/types';
import { createDocument, makeLayer, makeArtboard, newId } from '@/model/nodes';
import { defaultStroke, defaultTextStyle, defaultGrid, defaultSwatches, DEFAULT_FILL } from '@/model/defaults';
import { liveShapeSubPaths } from '@/geometry/shapes';

export const PROJECT_FORMAT = 'opuller';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.opuller';
export const PROJECT_MIME = 'application/json';

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  document: Document;
  /** informational */
  generator?: string;
  savedAt?: string;
}

export class ProjectError extends Error {}

// ---------------------------------------------------------------------------
// Migrations: version n → n+1. Add an entry when PROJECT_VERSION is bumped.
// ---------------------------------------------------------------------------

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, Migration> = {
  // 0 → 1: pre-release files stored the document at the top level
  0: (data) => ({ format: PROJECT_FORMAT, version: 1, document: data.document ?? data }),
};

/** Hook for modules that need to migrate their own node `data` payloads. */
const documentMigrations: Array<(doc: Document) => void> = [];
export function registerDocumentMigration(fn: (doc: Document) => void): void {
  documentMigrations.push(fn);
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/** Convert blob: image sources into data URLs so that the file is self-contained. */
export async function embedImages(doc: Document): Promise<Document> {
  const blobs = Object.values(doc.nodes).filter((n): n is Extract<Node, { type: 'image' }> => n.type === 'image' && typeof n.src === 'string' && n.src.startsWith('blob:'));
  if (!blobs.length) return doc;
  const nodes = { ...doc.nodes };
  for (const n of blobs) {
    try {
      const res = await fetch(n.src);
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      nodes[n.id] = { ...n, src: dataUrl };
    } catch {
      /* keep the blob URL; the image will be missing when reopened */
    }
  }
  return { ...doc, nodes };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function projectEnvelope(doc: Document): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    generator: 'OPuller',
    savedAt: new Date().toISOString(),
    document: { ...doc, meta: { ...doc.meta, generator: 'OPuller', version: PROJECT_VERSION, modified: new Date().toISOString() } },
  };
}

/** Synchronous serialisation (images must already be data URLs). */
export function serializeProjectSync(doc: Document, pretty = false): string {
  return JSON.stringify(projectEnvelope(doc), null, pretty ? 2 : undefined);
}

/** Serialise a document to project JSON; embeds blob images first. */
export async function serializeProject(doc: Document, pretty = false): Promise<string> {
  const embedded = await embedImages(doc);
  return serializeProjectSync(embedded, pretty);
}

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------

/** Quick check whether a text looks like an OPuller project file. */
export function isProjectJson(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith('{')) return false;
  return /"format"\s*:\s*"opuller"/.test(t.slice(0, 400)) || /"nodes"\s*:/.test(t);
}

export function parseProject(text: string): Document {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new ProjectError(`Not a valid OPuller file: ${e?.message ?? 'invalid JSON'}`);
  }
  return projectFromObject(raw);
}

export function projectFromObject(raw: unknown): Document {
  if (!raw || typeof raw !== 'object') throw new ProjectError('Not a valid OPuller file.');
  let data = raw as Record<string, unknown>;
  if (data.format !== undefined && data.format !== PROJECT_FORMAT) throw new ProjectError(`Unknown file format "${String(data.format)}".`);
  let version = typeof data.version === 'number' ? data.version : data.format === PROJECT_FORMAT ? 1 : 0;
  if (version > PROJECT_VERSION) throw new ProjectError(`This file was saved by a newer version of OPuller (format ${version}).`);
  while (version < PROJECT_VERSION) {
    const m = MIGRATIONS[version];
    if (!m) throw new ProjectError(`Cannot migrate project version ${version}.`);
    data = m(data);
    version++;
  }
  const doc = validateDocument(data.document ?? data);
  for (const fn of documentMigrations) fn(doc);
  return doc;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function validMatrix(v: unknown): Matrix {
  const m = obj(v);
  const out = { a: num(m.a, 1), b: num(m.b, 0), c: num(m.c, 0), d: num(m.d, 1), e: num(m.e, 0), f: num(m.f, 0) };
  return out;
}

function validHex(v: unknown, d: string): string {
  if (typeof v !== 'string') return d;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  return d;
}

function validPaint(v: unknown, d: Paint): Paint {
  const p = obj(v);
  switch (p.type) {
    case 'none':
      return { type: 'none' };
    case 'solid': {
      const sp: Paint = { type: 'solid', color: validHex(p.color, '#000000'), opacity: clamp01(num(p.opacity, 1)) };
      if (typeof p.swatchId === 'string') {
        sp.swatchId = p.swatchId;
        sp.tint = Math.max(0, Math.min(100, num(p.tint, 100)));
      }
      return sp;
    }
    case 'linear':
    case 'radial': {
      const stops = (Array.isArray(p.stops) ? p.stops : []).map((s) => {
        const so = obj(s);
        const stop: import('@/model/types').GradientStop = { offset: clamp01(num(so.offset, 0)), color: validHex(so.color, '#000000'), opacity: clamp01(num(so.opacity, 1)) };
        if (typeof so.swatchId === 'string') {
          stop.swatchId = so.swatchId;
          stop.tint = Math.max(0, Math.min(100, num(so.tint, 100)));
        }
        return stop;
      });
      if (stops.length < 2) {
        if (!stops.length) stops.push({ offset: 0, color: '#000000', opacity: 1 });
        stops.push({ offset: 1, color: stops[0].color, opacity: stops[0].opacity });
      }
      const spread = p.spread === 'reflect' || p.spread === 'repeat' ? p.spread : 'pad';
      if (p.type === 'linear') return { type: 'linear', x1: num(p.x1, 0), y1: num(p.y1, 0), x2: num(p.x2, 1), y2: num(p.y2, 0), stops, spread };
      return { type: 'radial', cx: num(p.cx, 0.5), cy: num(p.cy, 0.5), r: num(p.r, 0.5), fx: typeof p.fx === 'number' ? p.fx : undefined, fy: typeof p.fy === 'number' ? p.fy : undefined, stops, spread };
    }
    case 'freeform': {
      const points = (Array.isArray(p.points) ? p.points : []).map((pt) => {
        const o = obj(pt);
        return { x: num(o.x, 0.5), y: num(o.y, 0.5), color: validHex(o.color, '#000000'), opacity: clamp01(num(o.opacity, 1)), spread: Math.max(0.02, num(o.spread, 0.5)) };
      });
      if (!points.length) return d;
      const fp: Paint = { type: 'freeform', mode: p.mode === 'lines' ? 'lines' : 'points', points };
      if (Array.isArray(p.lines)) fp.lines = p.lines.filter((l): l is number[] => Array.isArray(l) && l.every((i) => typeof i === 'number' && i >= 0 && i < points.length));
      return fp;
    }
    case 'mesh': {
      const rows = Math.max(1, Math.round(num(p.rows, 1)));
      const cols = Math.max(1, Math.round(num(p.cols, 1)));
      const vec = (v: unknown): { x: number; y: number } | null => {
        const o = obj(v);
        return typeof o.x === 'number' && typeof o.y === 'number' ? { x: o.x, y: o.y } : null;
      };
      const nodes = (Array.isArray(p.nodes) ? p.nodes : []).map((n) => {
        const o = obj(n);
        const out: import('@/model/types').MeshNode = { x: num(o.x, 0), y: num(o.y, 0), color: validHex(o.color, '#000000'), opacity: clamp01(num(o.opacity, 1)) };
        for (const k of ['up', 'down', 'left', 'right'] as const) {
          const h = vec(o[k]);
          if (h) out[k] = h;
        }
        return out;
      });
      if (nodes.length !== (rows + 1) * (cols + 1)) return d;
      return { type: 'mesh', rows, cols, nodes };
    }
    case 'pattern': {
      const pp: Paint = { type: 'pattern', patternId: str(p.patternId, ''), scale: num(p.scale, 1), angle: num(p.angle, 0) };
      if (typeof p.x === 'number' || typeof p.y === 'number') {
        pp.x = num(p.x, 0);
        pp.y = num(p.y, 0);
      }
      return pp;
    }
    default:
      return d;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function validStroke(v: unknown): StrokeStyle {
  const s = obj(v);
  const base = defaultStroke();
  const cap = s.cap === 'round' || s.cap === 'square' ? s.cap : 'butt';
  const join = s.join === 'round' || s.join === 'bevel' ? s.join : 'miter';
  const align = s.align === 'inside' || s.align === 'outside' ? s.align : 'center';
  const marker = (m: unknown): StrokeStyle['markerStart'] => (typeof m === 'string' && ['none', 'arrow', 'triangle', 'circle', 'square', 'bar', 'diamond', 'open-arrow'].includes(m) ? (m as StrokeStyle['markerStart']) : 'none');
  const out: StrokeStyle = {
    ...base,
    paint: validPaint(s.paint, base.paint),
    width: Math.max(0, num(s.width, 1)),
    cap,
    join,
    miterLimit: num(s.miterLimit, 10),
    dash: Array.isArray(s.dash) ? s.dash.filter((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0) : [],
    dashOffset: num(s.dashOffset, 0),
    align,
    markerStart: marker(s.markerStart),
    markerEnd: marker(s.markerEnd),
    markerScale: num(s.markerScale, 1),
  };
  const br = obj(s.brush);
  if (typeof br.id === 'string') {
    out.brush = { id: br.id };
    if (typeof br.scale === 'number') out.brush.scale = Math.max(0.01, br.scale);
    if (typeof br.flipAlong === 'boolean') out.brush.flipAlong = br.flipAlong;
    if (typeof br.flipAcross === 'boolean') out.brush.flipAcross = br.flipAcross;
    if (br.colorization === 'none' || br.colorization === 'tints' || br.colorization === 'tintsShades' || br.colorization === 'hue') out.brush.colorization = br.colorization;
  }
  if (Array.isArray(s.widthProfile) && s.widthProfile.length) {
    out.widthProfile = s.widthProfile.map((w) => {
      const wo = obj(w);
      const wp: NonNullable<StrokeStyle['widthProfile']>[number] = { offset: clamp01(num(wo.offset, 0)), width: Math.max(0, num(wo.width, 1)) };
      if (typeof wo.left === 'number') wp.left = wo.left;
      if (typeof wo.right === 'number') wp.right = wo.right;
      return wp;
    });
  }
  return out;
}

function validTextStyle(v: unknown, base?: TextStyle): TextStyle {
  const s = obj(v);
  const d = base ?? defaultTextStyle();
  return {
    fontFamily: str(s.fontFamily, d.fontFamily),
    fontSize: Math.max(0.1, num(s.fontSize, d.fontSize)),
    fontWeight: num(s.fontWeight, d.fontWeight),
    fontStyle: s.fontStyle === 'italic' ? 'italic' : 'normal',
    lineHeight: num(s.lineHeight, d.lineHeight),
    letterSpacing: num(s.letterSpacing, d.letterSpacing),
    textAlign: s.textAlign === 'center' || s.textAlign === 'right' || s.textAlign === 'justify' ? s.textAlign : 'left',
    textDecoration: s.textDecoration === 'underline' || s.textDecoration === 'line-through' ? s.textDecoration : 'none',
    textTransform: s.textTransform === 'uppercase' || s.textTransform === 'lowercase' || s.textTransform === 'capitalize' ? s.textTransform : 'none',
    baselineShift: num(s.baselineShift, d.baselineShift),
    paragraphSpacing: num(s.paragraphSpacing, d.paragraphSpacing),
  };
}

function partialTextStyle(v: unknown): Partial<TextStyle> | undefined {
  const s = obj(v);
  if (!Object.keys(s).length) return undefined;
  const full = validTextStyle(s);
  const out: Partial<TextStyle> = {};
  for (const k of Object.keys(s) as Array<keyof TextStyle>) if (k in full) (out as any)[k] = full[k];
  return Object.keys(out).length ? out : undefined;
}

function validAnchor(v: unknown): Anchor | null {
  const a = obj(v);
  const p = obj(a.point);
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const vec = (h: unknown) => {
    const o = obj(h);
    return typeof o.x === 'number' && typeof o.y === 'number' && Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: o.x, y: o.y } : null;
  };
  return { point: { x: p.x, y: p.y }, handleIn: vec(a.handleIn), handleOut: vec(a.handleOut), kind: a.kind === 'smooth' ? 'smooth' : 'corner' };
}

function validSubPaths(v: unknown): SubPath[] {
  if (!Array.isArray(v)) return [];
  const out: SubPath[] = [];
  for (const sp of v) {
    const so = obj(sp);
    const anchors = (Array.isArray(so.anchors) ? so.anchors : []).map(validAnchor).filter((a): a is Anchor => !!a);
    if (anchors.length) out.push({ anchors, closed: bool(so.closed, false) });
  }
  return out;
}

const EFFECT_TYPES = new Set(['dropShadow', 'innerShadow', 'blur', 'outerGlow', 'innerGlow', 'colorAdjust', 'roundCorners', 'warp', 'freeDistort', 'meshDistort', 'coonsDistort', 'extrude', 'revolve', 'rotate3d']);
function validEffects(v: unknown): Effect[] {
  if (!Array.isArray(v)) return [];
  const out: Effect[] = [];
  for (const e of v) {
    const eo = obj(e);
    if (typeof eo.type !== 'string' || !EFFECT_TYPES.has(eo.type)) continue;
    out.push({ ...eo, enabled: bool(eo.enabled, true) } as Effect);
  }
  return out;
}

const BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

function validNode(id: ID, v: unknown): Node | null {
  const n = obj(v);
  const type = n.type;
  if (type !== 'layer' && type !== 'group' && type !== 'path' && type !== 'text' && type !== 'image') return null;
  const base = {
    id,
    name: str(n.name, type === 'layer' ? 'Layer' : type === 'group' ? 'Group' : type === 'path' ? 'Path' : type === 'text' ? 'Text' : 'Image'),
    parent: typeof n.parent === 'string' ? n.parent : null,
    visible: bool(n.visible, true),
    locked: bool(n.locked, false),
    opacity: clamp01(num(n.opacity, 1)),
    blendMode: (typeof n.blendMode === 'string' && BLEND_MODES.has(n.blendMode) ? n.blendMode : 'normal') as Node['blendMode'],
    transform: validMatrix(n.transform),
    effects: validEffects(n.effects),
    data: n.data && typeof n.data === 'object' ? (n.data as Record<string, unknown>) : undefined,
  };
  if (base.data === undefined) delete (base as any).data;
  const children = Array.isArray(n.children) ? n.children.filter((c): c is string => typeof c === 'string') : [];
  switch (type) {
    case 'layer':
      return { ...base, type: 'layer', children, color: validHex(n.color, '#3b82f6'), expanded: bool(n.expanded, true) };
    case 'group':
      return { ...base, type: 'group', children, clipId: typeof n.clipId === 'string' ? n.clipId : null, expanded: bool(n.expanded, false) };
    case 'path': {
      const shape = obj(n.shape);
      let subpaths = validSubPaths(n.subpaths);
      let live: Node & { type: 'path' };
      live = {
        ...base,
        type: 'path',
        subpaths,
        fillRule: n.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
        fill: validPaint(n.fill, { ...DEFAULT_FILL }),
        stroke: validStroke(n.stroke),
      };
      if (typeof shape.kind === 'string') {
        try {
          const regenerated = liveShapeSubPaths(shape as any);
          if (regenerated.length) {
            live.shape = shape as any;
            if (!subpaths.length) live.subpaths = regenerated;
          }
        } catch {
          /* invalid live shape: keep the geometry only */
        }
      }
      return live;
    }
    case 'text': {
      const style = validTextStyle(n.style);
      const text = str(n.text, '');
      let runs = Array.isArray(n.runs)
        ? n.runs.map((r) => {
            const ro = obj(r);
            const run: { text: string; style?: Partial<TextStyle> } = { text: str(ro.text, '') };
            const ps = partialTextStyle(ro.style);
            if (ps) run.style = ps;
            return run;
          })
        : [];
      if (runs.map((r) => r.text).join('') !== text) runs = [{ text }];
      const box = obj(n.box);
      const out: Node & { type: 'text' } = {
        ...base,
        type: 'text',
        kind: n.kind === 'area' || n.kind === 'path' ? n.kind : 'point',
        text,
        runs,
        style,
        pathId: typeof n.pathId === 'string' ? n.pathId : null,
        pathOffset: num(n.pathOffset, 0),
        fill: validPaint(n.fill, { type: 'solid', color: '#000000', opacity: 1 }),
        stroke: validStroke(n.stroke ?? { paint: { type: 'none' } }),
      };
      if (typeof box.width === 'number' && typeof box.height === 'number') out.box = { width: box.width, height: box.height };
      if (out.kind === 'area' && !out.box) out.box = { width: 200, height: 100 };
      return out;
    }
    case 'image': {
      const w = Math.max(0, num(n.width, num(n.naturalWidth, 100)));
      const h = Math.max(0, num(n.height, num(n.naturalHeight, 100)));
      const out: Node & { type: 'image' } = {
        ...base,
        type: 'image',
        src: str(n.src, ''),
        naturalWidth: Math.max(1, num(n.naturalWidth, w || 1)),
        naturalHeight: Math.max(1, num(n.naturalHeight, h || 1)),
        width: w,
        height: h,
        smoothing: bool(n.smoothing, true),
      };
      const crop = obj(n.crop);
      if (typeof crop.width === 'number' && typeof crop.height === 'number') out.crop = { x: num(crop.x, 0), y: num(crop.y, 0), width: crop.width, height: crop.height };
      return out;
    }
  }
  return null;
}

function validArtboard(v: unknown, i: number): Artboard | null {
  const a = obj(v);
  const w = num(a.width, NaN);
  const h = num(a.height, NaN);
  if (!(w > 0) || !(h > 0)) return null;
  return makeArtboard({ id: str(a.id, newId()), name: str(a.name, `Artboard ${i + 1}`), x: num(a.x, 0), y: num(a.y, 0), width: w, height: h, background: validHex(a.background, '#ffffff'), transparent: bool(a.transparent, false) }, i);
}

/**
 * Validate a map of nodes forming a subtree under `root` (symbol / pattern /
 * brush artwork). Returns null when the root is missing or not a group.
 */
export function validateNodeMap(rawNodes: unknown, rawRoot: unknown): { nodes: Record<ID, Node>; root: ID } | null {
  if (!rawNodes || typeof rawNodes !== 'object' || typeof rawRoot !== 'string') return null;
  const nodes: Record<ID, Node> = {};
  for (const [id, v] of Object.entries(rawNodes as Record<string, unknown>)) {
    const n = validNode(id, v);
    if (n) nodes[id] = n;
  }
  const root = nodes[rawRoot];
  if (!root || root.type !== 'group') return null;
  root.parent = null;
  const reachable = new Set<ID>();
  const visit = (id: ID, parent: ID | null) => {
    const n = nodes[id];
    if (!n || reachable.has(id)) return;
    reachable.add(id);
    n.parent = parent;
    if (n.type === 'layer' || n.type === 'group') {
      n.children = n.children.filter((c) => nodes[c] && c !== id && !reachable.has(c));
      for (const c of n.children) visit(c, id);
    }
  };
  visit(rawRoot, null);
  for (const id of Object.keys(nodes)) if (!reachable.has(id)) delete nodes[id];
  return { nodes, root: rawRoot };
}

function validArt(v: unknown): import('@/model/types').BrushArtwork | null {
  const o = obj(v);
  return validateNodeMap(o.nodes, o.root);
}

function validBrush(v: unknown): import('@/model/types').BrushDef | null {
  const b = obj(v);
  if (typeof b.id !== 'string') return null;
  const name = str(b.name, 'Brush');
  const colorization = (c: unknown): import('@/model/types').BrushColorization => (c === 'tints' || c === 'tintsShades' || c === 'hue' ? c : 'none');
  const pair = (p: unknown, d: [number, number]): [number, number] => (Array.isArray(p) && p.length === 2 ? [num(p[0], d[0]), num(p[1], d[1])] : d);
  switch (b.kind) {
    case 'calligraphic': {
      const out: import('@/model/types').CalligraphicBrush = { id: b.id, name, kind: 'calligraphic', angle: num(b.angle, 0), roundness: Math.max(0, Math.min(100, num(b.roundness, 100))), size: Math.max(0.1, num(b.size, 5)) };
      if (typeof b.angleVariation === 'number') out.angleVariation = b.angleVariation;
      if (typeof b.roundnessVariation === 'number') out.roundnessVariation = b.roundnessVariation;
      if (typeof b.sizeVariation === 'number') out.sizeVariation = b.sizeVariation;
      return out;
    }
    case 'scatter': {
      const art = validArt(b.art);
      if (!art) return null;
      return { id: b.id, name, kind: 'scatter', art, size: pair(b.size, [100, 100]), spacing: pair(b.spacing, [100, 100]), scatter: pair(b.scatter, [0, 0]), rotation: pair(b.rotation, [0, 0]), rotationRelativeTo: b.rotationRelativeTo === 'path' ? 'path' : 'page', colorization: colorization(b.colorization) };
    }
    case 'art': {
      const art = validArt(b.art);
      if (!art) return null;
      const out: import('@/model/types').ArtBrush = { id: b.id, name, kind: 'art', art, width: Math.max(1, num(b.width, 100)), stretch: b.stretch === 'proportional' ? 'proportional' : 'stretch', colorization: colorization(b.colorization) };
      if (typeof b.flipAlong === 'boolean') out.flipAlong = b.flipAlong;
      if (typeof b.flipAcross === 'boolean') out.flipAcross = b.flipAcross;
      return out;
    }
    case 'pattern': {
      const side = validArt(b.side);
      if (!side) return null;
      const out: import('@/model/types').PatternBrush = { id: b.id, name, kind: 'pattern', side, scale: Math.max(1, num(b.scale, 100)), spacing: num(b.spacing, 0), fit: b.fit === 'space' || b.fit === 'approximate' ? b.fit : 'stretch', colorization: colorization(b.colorization) };
      const start = validArt(b.start);
      const end = validArt(b.end);
      if (start) out.start = start;
      if (end) out.end = end;
      if (typeof b.flipAlong === 'boolean') out.flipAlong = b.flipAlong;
      if (typeof b.flipAcross === 'boolean') out.flipAcross = b.flipAcross;
      return out;
    }
    default:
      return null;
  }
}

/**
 * Validate and normalise a raw document object. Missing fields get defaults,
 * dangling references are repaired, orphaned nodes are dropped.
 */
export function validateDocument(raw: unknown): Document {
  const d = obj(raw);
  if (!d.nodes || typeof d.nodes !== 'object') throw new ProjectError('The file does not contain a document.');
  const fallback = createDocument();
  const nodes: Record<ID, Node> = {};
  for (const [id, v] of Object.entries(d.nodes as Record<string, unknown>)) {
    const n = validNode(id, v);
    if (n) nodes[id] = n;
  }
  // repair children lists and parent links
  const referenced = new Set<ID>();
  for (const n of Object.values(nodes)) {
    if (n.type === 'layer' || n.type === 'group') {
      n.children = n.children.filter((c) => nodes[c] && c !== n.id && !referenced.has(c));
      for (const c of n.children) {
        referenced.add(c);
        nodes[c].parent = n.id;
      }
      if (n.type === 'group' && n.clipId && !n.children.includes(n.clipId)) n.clipId = null;
    }
  }
  let layers = (Array.isArray(d.layers) ? d.layers : []).filter((id): id is string => typeof id === 'string' && nodes[id]?.type === 'layer');
  // layers not listed but present as layer nodes
  for (const n of Object.values(nodes)) if (n.type === 'layer' && !layers.includes(n.id)) layers.push(n.id);
  for (const id of layers) nodes[id].parent = null;
  // drop unreachable nodes
  const reachable = new Set<ID>();
  const visit = (id: ID) => {
    const n = nodes[id];
    if (!n || reachable.has(id)) return;
    reachable.add(id);
    if (n.type === 'layer' || n.type === 'group') for (const c of n.children) visit(c);
  };
  for (const id of layers) visit(id);
  for (const id of Object.keys(nodes)) if (!reachable.has(id)) delete nodes[id];
  for (const n of Object.values(nodes)) {
    if (n.type === 'text' && n.pathId && !nodes[n.pathId]) {
      n.pathId = null;
      if (n.kind === 'path') n.kind = 'point';
    }
  }
  if (!layers.length) {
    const layer = makeLayer({}, 0);
    nodes[layer.id] = layer;
    layers = [layer.id];
  }
  let artboards = (Array.isArray(d.artboards) ? d.artboards : []).map(validArtboard).filter((a): a is Artboard => !!a);
  if (!artboards.length) artboards = fallback.artboards;
  const grid = obj(d.grid);
  const meta = obj(d.meta);
  const units = d.units === 'pt' || d.units === 'mm' || d.units === 'cm' || d.units === 'in' ? d.units : 'px';
  const swatches = Array.isArray(d.swatches)
    ? d.swatches
        .map((s) => {
          const so = obj(s);
          const sw: import('@/model/types').Swatch = { id: str(so.id, newId()), name: str(so.name, 'Swatch'), paint: validPaint(so.paint, { type: 'solid', color: '#000000', opacity: 1 }) };
          if (so.kind === 'global' || so.kind === 'spot') sw.kind = so.kind;
          const cm = obj(so.cmyk);
          if (typeof cm.c === 'number' && typeof cm.m === 'number' && typeof cm.y === 'number' && typeof cm.k === 'number') sw.cmyk = { c: num(cm.c, 0), m: num(cm.m, 0), y: num(cm.y, 0), k: num(cm.k, 0) };
          return sw;
        })
        .filter((s) => s.paint.type !== 'none')
    : defaultSwatches();
  const patterns = Array.isArray(d.patterns)
    ? d.patterns
        .map((p) => {
          const po = obj(p);
          const def: import('@/model/types').PatternDef = { id: str(po.id, newId()), name: str(po.name, 'Pattern'), width: Math.max(1, num(po.width, 10)), height: Math.max(1, num(po.height, 10)), svg: str(po.svg, '') };
          const art = validateNodeMap(po.nodes, po.root);
          if (art) {
            def.nodes = art.nodes;
            def.root = art.root;
          }
          if (po.layout === 'brick-row' || po.layout === 'brick-col' || po.layout === 'hex-row' || po.layout === 'hex-col' || po.layout === 'grid') def.layout = po.layout;
          if (typeof po.offset === 'number') def.offset = Math.max(0, Math.min(1, po.offset));
          const sp = obj(po.spacing);
          if (typeof sp.x === 'number' || typeof sp.y === 'number') def.spacing = { x: num(sp.x, 0), y: num(sp.y, 0) };
          if (typeof po.background === 'string') def.background = validHex(po.background, '#ffffff');
          return def;
        })
        .filter((p) => !!p.svg || !!p.nodes)
    : [];
  const brushes = Array.isArray(d.brushes) ? d.brushes.map(validBrush).filter((b): b is import('@/model/types').BrushDef => !!b) : [];
  const symbols = Array.isArray(d.symbols)
    ? d.symbols
        .map((s) => {
          const so = obj(s);
          const art = validateNodeMap(so.nodes, so.root);
          if (!art) return null;
          const def: import('@/model/types').SymbolDef = { id: str(so.id, newId()), name: str(so.name, 'Symbol'), nodes: art.nodes, root: art.root, version: Math.max(1, Math.round(num(so.version, 1))) };
          return def;
        })
        .filter((s): s is import('@/model/types').SymbolDef => !!s)
    : [];
  const guides = Array.isArray(d.guides)
    ? d.guides
        .map((g) => {
          const go = obj(g);
          return { id: str(go.id, newId()), axis: (go.axis === 'y' ? 'y' : 'x') as 'x' | 'y', position: num(go.position, 0), locked: bool(go.locked, false) };
        })
        .filter((g) => Number.isFinite(g.position))
    : [];
  const dg = defaultGrid();
  const bleedRaw = obj(d.bleed);
  const bleed = { top: Math.max(0, num(bleedRaw.top, 0)), right: Math.max(0, num(bleedRaw.right, 0)), bottom: Math.max(0, num(bleedRaw.bottom, 0)), left: Math.max(0, num(bleedRaw.left, 0)) };
  return {
    id: str(d.id, newId()),
    name: str(d.name, 'Untitled'),
    units,
    artboards,
    layers,
    nodes,
    guides,
    swatches,
    patterns,
    symbols,
    brushes,
    grid: { size: Math.max(1, num(grid.size, dg.size)), subdivisions: Math.max(1, Math.round(num(grid.subdivisions, dg.subdivisions))), color: validHex(grid.color, dg.color), style: grid.style === 'dots' ? 'dots' : 'lines' },
    colorMode: d.colorMode === 'cmyk' ? 'cmyk' : 'rgb',
    bleed,
    meta: {
      created: str(meta.created, new Date().toISOString()),
      modified: str(meta.modified, new Date().toISOString()),
      generator: str(meta.generator, 'OPuller'),
      version: num(meta.version, PROJECT_VERSION),
    },
  };
}

/** Whether two documents are the same for "did anything change" purposes. */
export function sameDocumentContent(a: Document, b: Document): boolean {
  if (a === b) return true;
  const strip = (d: Document) => JSON.stringify({ ...d, meta: undefined, id: undefined });
  return strip(a) === strip(b);
}

/** True when the document is an untouched blank document (one empty layer). */
export function isBlankDocument(doc: Document): boolean {
  if (doc.layers.length !== 1) return false;
  const layer = doc.nodes[doc.layers[0]];
  if (!layer || layer.type !== 'layer' || layer.children.length) return false;
  return Object.keys(doc.nodes).length === 1 && doc.guides.length === 0;
}
