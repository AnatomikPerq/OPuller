/**
 * Scripting API used by the AI bridge (MCP server) and available as
 * `window.__opuller.mcp`. Every method takes one params object and returns
 * JSON-serialisable data. All coordinates are world units (px).
 */
import type { Document, ID, Node, PathNode, TextNode, Paint, StrokeStyle, LiveShape, Rect, Vec, Matrix, TextStyle, ImageNode, AnchorRef } from '@/model/types';
import { isContainer } from '@/model/types';
import { getState, setState, useStore } from '@/store/store';
import { makeShape, makePath, makeText, makeImage, newId, clonePaint, cloneStroke } from '@/model/nodes';
import { addNode, removeNode, worldBounds, selectionBounds, applyWorldMatrix, refreshLiveShape, worldSubPaths, setWorldSubPaths, topmostOf, descendants, cloneSubtree, addSubtree, getChildren, moveNode, indexInParent, isEditable, worldMatrix } from '@/model/document';
import { translate, scale as scaleM, rotate as rotateM, multiply, compose, identity, applyToPoint } from '@/geometry/matrix';
import { parseSvgPathData, pathToSvgD } from '@/geometry/path';
import { rectUnion } from '@/geometry/vec';
import { allCommands, runCommand, getCommand, isEnabled } from '@/commands/registry';
import { appearanceTargets } from '@/commands/appearance';
import { setCornerRadii } from '@/tools/pathEditing/corners';
import { applyBlendOptions, makeBlendCommand, blendOptionsFrom } from '@/blend/register';
import { blendGroupsOf } from '@/blend/ops';
import { applyOffsetPath } from '@/ui/dialogs/offsetPath/register';
import { applySimplify } from '@/ui/dialogs/simplify/register';
import { applyEffect, effectDef, EFFECT_DEFS, type EffectType } from '@/commands/effectCommands/effects';
import { alignFromParams } from '@/transform/align';
import { transformDocument, scaleEffect } from '@/transform/apply';
import { fitPolyline } from '@/tools/freehand/fit';
import { smoothSamples, endsNearStart } from '@/tools/freehand/sampling';
import { addWorldPath } from '@/tools/freehand/apply';
import { anchor as makeAnchorPt } from '@/geometry/path';
import { scaleFactor } from '@/geometry/matrix';
import { produce } from 'immer';
import type { Effect, SubPath, Swatch } from '@/model/types';
import { allTools, getTool } from '@/tools/registry';
import { insertionParent } from '@/tools/shapes/tool';
import { exportSvg } from '@/io/svgExport';
import { renderToDataUrl } from '@/io/raster';
import { placeSvgText, placeImageBlob, newDocument as newDoc, loadDocument } from '@/io/fileOps';
import { serializeProject, parseProject } from '@/io/project';
import { makeArtboard } from '@/model/nodes';
import { fitArtboard, fitAll } from '@/commands/viewCommands';
import { shortcutLabel } from '@/util/keys';
import { loadImage } from '@/util/files';

type Params = Record<string, any>;

function requireNode(id: ID): Node {
  const n = getState().doc.nodes[id];
  if (!n) throw new Error(`Unknown node id "${id}"`);
  return n;
}

/**
 * Target ids of a call: `ids` (or `id`) when given, otherwise the selection. Ids that name no
 * node are dropped; when none of the given ids exists the call fails instead of silently
 * acting on the selection.
 */
function idsParam(p: Params): ID[] {
  const s = getState();
  if (Array.isArray(p.ids) && p.ids.length) {
    const ids = p.ids.filter((id: ID) => !!s.doc.nodes[id]);
    if (!ids.length) throw new Error(`Unknown node ids: ${p.ids.map(String).join(', ')}`);
    return ids;
  }
  if (typeof p.id === 'string') {
    if (!s.doc.nodes[p.id]) throw new Error(`Unknown node id "${p.id}"`);
    return [p.id];
  }
  return s.selection.slice();
}

function summary(doc: Document, id: ID, depth: number, withBounds: boolean): any {
  const n = doc.nodes[id];
  if (!n) return null;
  const out: any = { id: n.id, type: n.type, name: n.name, visible: n.visible, locked: n.locked };
  if (n.opacity !== 1) out.opacity = n.opacity;
  if (n.blendMode !== 'normal') out.blendMode = n.blendMode;
  if (withBounds) {
    const b = worldBounds(doc, id);
    if (b) out.bounds = { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) };
  }
  if (n.type === 'path') {
    out.fill = n.fill;
    out.stroke = { paint: n.stroke.paint, width: n.stroke.width };
    if (n.shape) out.shape = n.shape;
    out.subpaths = n.subpaths.length;
    out.anchors = n.subpaths.reduce((a, sp) => a + sp.anchors.length, 0);
    out.closed = n.subpaths.every((sp) => sp.closed);
  } else if (n.type === 'text') {
    out.text = n.text;
    out.kind = n.kind;
    out.fontFamily = n.style.fontFamily;
    out.fontSize = n.style.fontSize;
    out.fill = n.fill;
  } else if (n.type === 'image') {
    out.width = n.width;
    out.height = n.height;
    out.naturalWidth = n.naturalWidth;
    out.naturalHeight = n.naturalHeight;
  } else if (isContainer(n)) {
    if (n.type === 'group' && n.clipId) out.clipId = n.clipId;
    out.children = depth > 0 ? n.children.map((c) => summary(doc, c, depth - 1, withBounds)) : n.children.length;
  }
  if (n.effects.length) out.effects = n.effects;
  if (n.data && Object.keys(n.data).length) out.data = n.data;
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function toPaint(p: any, fallback: Paint): Paint {
  if (p === undefined) return fallback;
  if (p === null || p === 'none') return { type: 'none' };
  if (typeof p === 'string') return { type: 'solid', color: normalizeHex(p), opacity: 1 };
  if (typeof p === 'object' && p.type) {
    if (p.type === 'solid') {
      const out: Paint = { type: 'solid', color: normalizeHex(p.color ?? '#000000'), opacity: p.opacity ?? 1 };
      // links to global / spot swatches survive (the colour follows the swatch, tint 0..100)
      if (typeof p.swatchId === 'string') out.swatchId = p.swatchId;
      if (p.tint !== undefined) out.tint = Number(p.tint);
      return out;
    }
    if (p.type === 'linear')
      return { type: 'linear', x1: p.x1 ?? 0, y1: p.y1 ?? 0, x2: p.x2 ?? 1, y2: p.y2 ?? 0, stops: stops(p.stops), spread: p.spread ?? 'pad' };
    if (p.type === 'radial') return { type: 'radial', cx: p.cx ?? 0.5, cy: p.cy ?? 0.5, r: p.r ?? 0.5, fx: p.fx, fy: p.fy, stops: stops(p.stops), spread: p.spread ?? 'pad' };
    if (p.type === 'none') return { type: 'none' };
  }
  throw new Error('Invalid paint: use "#rrggbb", "none" or {type:"solid"|"linear"|"radial", ...}');
}

function stops(list: any): Paint extends { stops: infer S } ? S : any {
  const arr = Array.isArray(list) && list.length ? list : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }];
  return arr.map((st: any, i: number) => ({ offset: st.offset ?? i / Math.max(1, arr.length - 1), color: normalizeHex(st.color ?? '#000000'), opacity: st.opacity ?? 1 })) as any;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
  gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', navy: '#000080', teal: '#008080',
  burgundy: '#7a1f3d', twitter: '#1da1f2', transparent: '#000000',
};

export function normalizeHex(c: string): string {
  let s = String(c).trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  if (!s.startsWith('#')) s = '#' + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{8}$/.test(s)) s = s.slice(0, 7);
  if (!/^#[0-9a-f]{6}$/.test(s)) throw new Error(`Invalid colour "${c}" (use #rrggbb)`);
  return s;
}

function toStroke(p: any, base: StrokeStyle): StrokeStyle {
  if (p === undefined) return { ...base, paint: base.paint, dash: [...base.dash] };
  if (p === null || p === 'none') return { ...base, paint: { type: 'none' }, dash: [...base.dash] };
  if (typeof p === 'string') return { ...base, paint: toPaint(p, base.paint), dash: [...base.dash] };
  const out: StrokeStyle = { ...base, dash: [...base.dash] };
  if (p.paint !== undefined || p.color !== undefined) out.paint = toPaint(p.paint ?? p.color, base.paint);
  if (p.width !== undefined) out.width = Number(p.width);
  if (p.cap) out.cap = p.cap;
  if (p.join) out.join = p.join;
  if (p.miterLimit !== undefined) out.miterLimit = Number(p.miterLimit);
  if (Array.isArray(p.dash)) out.dash = p.dash.map(Number);
  if (p.dashOffset !== undefined) out.dashOffset = Number(p.dashOffset);
  if (p.align) out.align = p.align;
  if (p.markerStart) out.markerStart = p.markerStart;
  if (p.markerEnd) out.markerEnd = p.markerEnd;
  if (p.markerScale !== undefined) out.markerScale = Number(p.markerScale);
  if (Array.isArray(p.widthProfile)) out.widthProfile = p.widthProfile;
  return out;
}

/**
 * Effect parameters checked against the effect's own fields (`def.defaults()`): unknown keys and
 * values of another type are errors, numbers must be finite. `enabled` is handled by the caller.
 */
function checkEffectParams(type: string, template: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = Object.keys(template).filter((k) => k !== 'type' && k !== 'enabled');
  for (const [key, value] of Object.entries(params)) {
    if (key === 'enabled' || key === 'type') continue;
    if (!(key in template)) throw new Error(`Effect "${type}" has no parameter "${key}"; parameters: ${known.join(', ')}`);
    const want = template[key];
    if (typeof want === 'number') {
      const v = Number(value);
      if (typeof value === 'boolean' || typeof value === 'object' || !Number.isFinite(v)) throw new Error(`Effect "${type}": "${key}" must be a number`);
      out[key] = v;
    } else if (typeof want === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Effect "${type}": "${key}" must be true or false`);
      out[key] = value;
    } else if (typeof want === 'string') {
      if (typeof value !== 'string') throw new Error(`Effect "${type}": "${key}" must be a string`);
      out[key] = value;
    } else out[key] = value;
  }
  return out;
}

function parentFor(p: Params): ID | null {
  if (typeof p.parent === 'string') {
    const n = getState().doc.nodes[p.parent];
    if (!n || !isContainer(n)) throw new Error(`Parent "${p.parent}" is not a layer or group`);
    return p.parent;
  }
  return insertionParent();
}

function deepMerge(target: any, patch: any): any {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const k of Object.keys(patch)) out[k] = deepMerge(out[k], patch[k]);
  return out;
}

function viewportElement(): HTMLElement {
  const el = document.querySelector('[data-testid="viewport"]') as HTMLElement | null;
  if (!el) throw new Error('Viewport not mounted');
  return el;
}

function pointerEvent(type: string, el: HTMLElement, world: Vec, o: { button?: number; buttons?: number; modifiers?: string[]; pointerId?: number; pressure?: number }): PointerEvent {
  const s = getState();
  const r = el.getBoundingClientRect();
  const mods = new Set((o.modifiers ?? []).map((m) => m.toLowerCase()));
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: r.left + world.x * s.zoom + s.pan.x,
    clientY: r.top + world.y * s.zoom + s.pan.y,
    button: o.button ?? 0,
    buttons: o.buttons ?? (type === 'pointerup' ? 0 : 1),
    pointerId: o.pointerId ?? 9001,
    pointerType: 'mouse',
    isPrimary: true,
    pressure: o.pressure ?? (type === 'pointerup' ? 0 : 0.5),
    shiftKey: mods.has('shift'),
    altKey: mods.has('alt'),
    ctrlKey: mods.has('ctrl') || mods.has('control') || mods.has('mod'),
    metaKey: mods.has('meta') || mods.has('cmd'),
  };
  return new PointerEvent(type, init);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keyEvent(type: 'keydown' | 'keyup', key: string, modifiers: string[]): KeyboardEvent {
  const mods = new Set(modifiers.map((m) => m.toLowerCase()));
  const map: Record<string, string> = { esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', delete: 'Delete', backspace: 'Backspace', tab: 'Tab', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const k = map[key.toLowerCase()] ?? (key.length === 1 ? key : key);
  const code = k.length === 1 ? (/[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : /[0-9]/.test(k) ? `Digit${k}` : '') : k === ' ' ? 'Space' : k;
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: mods.has('shift') && k.length === 1 ? k.toUpperCase() : k,
    code,
    shiftKey: mods.has('shift'),
    altKey: mods.has('alt'),
    ctrlKey: mods.has('ctrl') || mods.has('control') || mods.has('mod'),
    metaKey: mods.has('meta') || mods.has('cmd'),
  });
}

function nodeBoundsOrThrow(id: ID): Rect {
  const b = worldBounds(getState().doc, id);
  if (!b) throw new Error(`Node "${id}" has no bounds`);
  return b;
}

/** All API methods. Each returns JSON data (or a Promise of it). */
export const mcpApi: Record<string, (p: Params) => any> = {
  // ------------------------------------------------------------------ state
  status() {
    const s = getState();
    const doc = s.doc;
    return {
      document: {
        id: doc.id,
        name: doc.name,
        fileName: s.fileName,
        dirty: s.dirty,
        units: doc.units,
        artboards: doc.artboards.map((a) => ({ id: a.id, name: a.name, x: a.x, y: a.y, width: a.width, height: a.height, background: a.background, transparent: a.transparent })),
        activeArtboardId: s.activeArtboardId,
        layers: doc.layers.map((id) => ({ id, name: doc.nodes[id]?.name, children: getChildren(doc, id).length })),
        activeLayerId: s.activeLayerId,
        nodeCount: Object.keys(doc.nodes).length,
      },
      selection: s.selection,
      selectedAnchors: s.selectedAnchors.length,
      activeTool: s.activeTool,
      editingTextId: s.editingTextId,
      isolationId: s.isolationId,
      view: { zoom: s.zoom, pan: s.pan, viewport: s.viewportSize, ...s.view },
      history: { undo: s.past.length, redo: s.future.length, lastLabel: s.past[s.past.length - 1]?.label ?? null },
      appearance: s.appearance,
      prefs: s.prefs,
      dialog: s.dialog?.type ?? null,
    };
  },
  listTools() {
    return allTools().map((t) => ({ id: t.id, name: t.name, shortcut: t.shortcut ? shortcutLabel(t.shortcut) : null, group: t.group, hint: t.hint ?? null, defaults: t.defaults ?? null }));
  },
  listCommands(p) {
    const s = getState();
    return allCommands()
      .filter((c) => !p.menu || (c.menu ?? '').startsWith(p.menu))
      .map((c) => ({ id: c.id, label: c.label, menu: c.menu ?? null, shortcut: c.shortcut ? (Array.isArray(c.shortcut) ? c.shortcut.map(shortcutLabel) : shortcutLabel(c.shortcut)) : null, enabled: isEnabled(c, s), checked: c.checked ? c.checked(s) : undefined }));
  },
  runCommand(p) {
    const cmd = getCommand(p.id);
    if (!cmd) throw new Error(`Unknown command "${p.id}"`);
    if (!isEnabled(cmd)) throw new Error(`Command "${p.id}" is disabled in the current state`);
    // run the command directly: an error it throws is the caller's (the menu path toasts it instead)
    const result = () => ({ ok: true, selection: getState().selection, dialog: getState().dialog?.type ?? null });
    const r = cmd.run(p.arg);
    if (r && typeof (r as Promise<void>).then === 'function') return (r as Promise<void>).then(result);
    return result();
  },
  setTool(p) {
    if (!getTool(p.id)) throw new Error(`Unknown tool "${p.id}"`);
    getState().setTool(p.id);
    if (p.options) getState().setToolOptions(p.id, p.options);
    return { activeTool: getState().activeTool, options: { ...(getTool(p.id)?.defaults ?? {}), ...(getState().toolOptions[p.id] ?? {}) } };
  },
  closeDialog() {
    getState().closeDialog();
    return { ok: true };
  },

  // --------------------------------------------------------------- document
  getDocument() {
    return getState().doc;
  },
  getTree(p) {
    const doc = getState().doc;
    const depth = p.depth ?? 10;
    const withBounds = p.bounds !== false;
    return doc.layers.map((id) => summary(doc, id, depth, withBounds));
  },
  getNode(p) {
    const n = requireNode(p.id);
    const doc = getState().doc;
    const b = worldBounds(doc, p.id);
    const out: any = { ...n, bounds: b };
    if (n.type === 'path') out.d = pathToSvgD(worldSubPaths(doc, p.id, { liveCorners: true }));
    return out;
  },
  findNodes(p) {
    const doc = getState().doc;
    const re = p.name ? new RegExp(String(p.name), 'i') : null;
    const out: any[] = [];
    for (const n of Object.values(doc.nodes)) {
      if (n.type === 'layer') continue;
      if (p.type && n.type !== p.type) continue;
      if (re && !re.test(n.name)) continue;
      if (p.text && !(n.type === 'text' && n.text.includes(p.text))) continue;
      out.push(summary(doc, n.id, 0, true));
    }
    return out;
  },
  select(p) {
    const s = getState();
    if (p.all) runCommand('select.all');
    else if (p.none || (Array.isArray(p.ids) && !p.ids.length)) s.clearSelection();
    else {
      const ids = (p.ids ?? []).filter((id: ID) => !!s.doc.nodes[id] && s.doc.nodes[id].type !== 'layer');
      if (p.mode === 'add') s.addToSelection(ids);
      else if (p.mode === 'remove') s.removeFromSelection(ids);
      else s.setSelection(ids);
    }
    return { selection: getState().selection, bounds: selectionBounds(getState().doc, getState().selection) };
  },

  // ---------------------------------------------------------------- create
  createShape(p) {
    const s = getState();
    const kind = p.kind ?? 'rect';
    let shape: LiveShape;
    let m: Matrix;
    const w = Number(p.width ?? 100);
    const h = Number(p.height ?? p.width ?? 100);
    const cx = p.cx !== undefined ? Number(p.cx) : Number(p.x ?? 0) + w / 2;
    const cy = p.cy !== undefined ? Number(p.cy) : Number(p.y ?? 0) + h / 2;
    switch (kind) {
      case 'rect': {
        const r = p.radius !== undefined ? Number(p.radius) : 0;
        shape = { kind: 'rect', width: w, height: h, radii: Array.isArray(p.radii) ? (p.radii as any) : [r, r, r, r] };
        m = translate(cx - w / 2, cy - h / 2);
        break;
      }
      case 'ellipse':
      case 'circle': {
        const rx = p.rx !== undefined ? Number(p.rx) : p.r !== undefined ? Number(p.r) : w / 2;
        const ry = p.ry !== undefined ? Number(p.ry) : p.r !== undefined ? Number(p.r) : kind === 'circle' ? rx : h / 2;
        shape = { kind: 'ellipse', rx, ry };
        m = translate(cx, cy);
        break;
      }
      case 'polygon': {
        const radius = Number(p.radius ?? p.r ?? Math.max(w, h) / 2);
        shape = { kind: 'polygon', sides: Number(p.sides ?? 6), radius };
        m = translate(cx, cy);
        break;
      }
      case 'star': {
        const outer = Number(p.outerRadius ?? p.radius ?? p.r ?? Math.max(w, h) / 2);
        shape = { kind: 'star', points: Number(p.points ?? 5), outerRadius: outer, innerRadius: Number(p.innerRadius ?? outer * 0.5) };
        m = translate(cx, cy);
        break;
      }
      case 'line': {
        shape = { kind: 'line', x1: 0, y1: 0, x2: Number(p.x2 ?? 100) - Number(p.x1 ?? 0), y2: Number(p.y2 ?? 0) - Number(p.y1 ?? 0) };
        m = translate(Number(p.x1 ?? 0), Number(p.y1 ?? 0));
        break;
      }
      default:
        throw new Error(`Unknown shape kind "${kind}" (rect, ellipse, circle, polygon, star, line)`);
    }
    // Illustrator convention: positive angles turn counter-clockwise on screen
    if (p.rotation) m = multiply(m, rotateM(-Number(p.rotation)));
    const node = makeShape(shape, {
      fill: kind === 'line' && p.fill === undefined ? { type: 'none' } : toPaint(p.fill, s.appearance.fill),
      stroke: toStroke(p.stroke, kind === 'line' && p.stroke === undefined && s.appearance.stroke.paint.type === 'none' ? { ...s.appearance.stroke, paint: { type: 'solid', color: '#000000', opacity: 1 } } : s.appearance.stroke),
      transform: m,
      name: p.name,
      opacity: p.opacity,
    });
    const parent = parentFor(p);
    if (!parent) throw new Error('No layer to draw on');
    s.updateDoc((d) => addNode(d, node, parent), `Create ${node.name}`);
    if (p.select !== false) getState().setSelection([node.id]);
    return summary(getState().doc, node.id, 0, true);
  },
  createPath(p) {
    const s = getState();
    if (typeof p.d !== 'string' || !p.d.trim()) throw new Error('createPath needs SVG path data "d"');
    const sps = parseSvgPathData(p.d);
    if (!sps.length) throw new Error('Path data produced no geometry');
    if (p.closed) for (const sp of sps) sp.closed = true;
    const node = makePath([], { fill: toPaint(p.fill, s.appearance.fill), stroke: toStroke(p.stroke, s.appearance.stroke), name: p.name ?? 'Path', fillRule: p.fillRule ?? 'nonzero', opacity: p.opacity });
    const parent = parentFor(p);
    if (!parent) throw new Error('No layer to draw on');
    s.updateDoc((d) => {
      addNode(d, node, parent);
      const m = compose(translate(Number(p.x ?? 0), Number(p.y ?? 0)), p.scale ? scaleM(Number(p.scale)) : identity());
      setWorldSubPaths(d, node.id, sps.map((sp) => ({ ...sp, anchors: sp.anchors.map((a) => ({ ...a, point: applyToPoint(m, a.point), handleIn: a.handleIn ? { x: a.handleIn.x * (p.scale ?? 1), y: a.handleIn.y * (p.scale ?? 1) } : null, handleOut: a.handleOut ? { x: a.handleOut.x * (p.scale ?? 1), y: a.handleOut.y * (p.scale ?? 1) } : null })) })));
    }, 'Create Path');
    if (p.select !== false) getState().setSelection([node.id]);
    return summary(getState().doc, node.id, 0, true);
  },
  createText(p) {
    const s = getState();
    if (typeof p.text !== 'string') throw new Error('createText needs "text"');
    const style: Partial<TextStyle> = { ...s.appearance.textStyle };
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration', 'textTransform'] as const) if (p[k] !== undefined) (style as any)[k] = p[k];
    const kind = p.kind ?? (p.width ? 'area' : 'point');
    const node = makeText(p.text, {
      kind,
      style,
      fill: toPaint(p.fill, s.appearance.fill.type === 'none' || s.appearance.fill.type === 'solid' && s.appearance.fill.color === '#ffffff' ? { type: 'solid', color: '#000000', opacity: 1 } : s.appearance.fill),
      stroke: toStroke(p.stroke, { ...s.appearance.stroke, paint: { type: 'none' } }),
      box: kind === 'area' ? { width: Number(p.width ?? 300), height: Number(p.height ?? 200) } : undefined,
      transform: translate(Number(p.x ?? 0), Number(p.y ?? 0)),
      name: p.name,
    });
    const parent = parentFor(p);
    if (!parent) throw new Error('No layer to draw on');
    s.updateDoc((d) => addNode(d, node, parent), 'Create Text');
    if (p.select !== false) getState().setSelection([node.id]);
    return summary(getState().doc, node.id, 0, true);
  },
  placeSvg(p) {
    if (typeof p.svg !== 'string') throw new Error('placeSvg needs "svg" markup');
    const at = p.x !== undefined && p.y !== undefined ? { x: Number(p.x), y: Number(p.y) } : undefined;
    const ids = placeSvgText(p.svg, { name: p.name, select: p.select !== false, at, fit: p.fit ?? !at });
    return ids.map((id) => summary(getState().doc, id, 1, true));
  },
  async placeFile(p) {
    // bytes arrive base64-encoded from the MCP server (PDF / AI / EPS / SVG / images)
    const name = String(p.name ?? 'file');
    const b64 = String(p.base64 ?? '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'svg') {
      const ids = placeSvgText(new TextDecoder().decode(bytes), { name, select: true });
      return { ids, kind: 'svg' };
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
      const blob = new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
      const ids = await placeImageBlob(blob, { name });
      return { ids, kind: 'image' };
    }
    const mod = await import('@/io/vectorImport');
    const r = await mod.applyVectorImport(bytes.buffer, name, { action: p.open ? 'open' : 'place', page: p.page, mode: p.mode === 'image' ? 'image' : 'objects', text: p.text !== false });
    return { kind: r.kind, pages: r.pages, width: r.width, height: r.height, warnings: r.warnings, objects: r.items.reduce((n, it) => n + it.nodes.length, 0), selection: getState().selection };
  },
  async exportFile(p) {
    const s = getState();
    const format = String(p.format ?? 'svg');
    const scope = p.scope ?? (p.ids?.length ? 'selection' : 'artboard');
    const opts = { scope, ids: p.ids ?? (scope === 'selection' ? s.selection : undefined), artboardId: p.artboardId ?? s.activeArtboardId, bleed: p.bleed ? true : undefined, marks: p.marks ? { trimMarks: true, registrationMarks: true, colorBars: true, pageInfo: true } : undefined } as const;
    if (format === 'eps') {
      const eps = await import('@/io/epsExport');
      const { withTextOutlines } = await import('@/io/svgExport');
      const d = (await withTextOutlines(s.doc, opts.ids)).doc;
      await eps.prepareEpsImages(d, opts.ids);
      const r = eps.exportEps(d, { ...opts, cmyk: !!p.cmyk });
      return { format, text: r.eps, name: r.name, width: r.width, height: r.height };
    }
    const fallbackWarnings: string[] = [];
    if (format === 'ai' && p.aiFormat !== 'pdf') {
      // Illustrator 8 (legacy) native format: editable layers, text, gradients, spot colours
      try {
        const { exportAi } = await import('@/io/aiExport');
        const { prepareDocumentForAi } = await import('@/io/aiPrepare');
        const prep = await prepareDocumentForAi(s.doc, { ids: opts.ids, textMode: p.outlineText ? 'outlines' : (p.text ?? 'auto'), encoding: p.encoding ?? 'auto' });
        const r = exportAi(prep.doc, { ...opts, cmyk: p.cmyk === undefined ? undefined : !!p.cmyk, encoding: prep.encoding });
        return { format, aiFormat: 'legacy', text: r.ai, name: `${r.name}.ai`, width: r.width, height: r.height, encoding: prep.encoding, warnings: [...prep.warnings, ...r.warnings], failed: prep.failed };
      } catch (err: any) {
        // never lose the artwork: fall back to the PDF-compatible flavour and say so
        fallbackWarnings.push(`Illustrator 8 export failed (${err?.message ?? err}); a PDF-compatible .ai was written instead`);
      }
    }
    if (format === 'pdf' || format === 'ai') {
      const { exportPdf } = await import('@/io/pdf');
      const { withTextOutlines } = await import('@/io/svgExport');
      const d = p.outlineText ? (await withTextOutlines(s.doc, opts.ids)).doc : s.doc;
      const r = await exportPdf(d, { ...opts, pretty: false });
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { format, aiFormat: format === 'ai' ? 'pdf' : undefined, base64: btoa(bin), pages: r.pages, name: `${s.doc.name}.${format}`, warnings: fallbackWarnings.length ? fallbackWarnings : undefined };
    }
    const r = exportSvg(s.doc, { ...opts, pretty: p.pretty ?? true });
    return { format: 'svg', text: r.svg, name: r.name, width: r.width, height: r.height };
  },
  async placeImage(p) {
    const s = getState();
    let src: string | undefined = p.dataUrl ?? p.src;
    if (!src && p.url) src = p.url;
    if (!src) throw new Error('placeImage needs "dataUrl" (or "url")');
    if (src.startsWith('http')) {
      const blob = await (await fetch(src)).blob();
      const ids = await placeImageBlob(blob, { name: p.name });
      return ids.map((id) => summary(getState().doc, id, 0, true));
    }
    const img = await loadImage(src);
    const w = img.naturalWidth || 100;
    const h = img.naturalHeight || 100;
    const node: ImageNode = makeImage(src, w, h, { name: p.name ?? 'Image', width: p.width ? Number(p.width) : undefined, height: p.height ? Number(p.height) : p.width ? (Number(p.width) * h) / w : undefined, transform: translate(Number(p.x ?? 0), Number(p.y ?? 0)) });
    const parent = parentFor(p);
    if (!parent) throw new Error('No layer to draw on');
    s.updateDoc((d) => addNode(d, node, parent), 'Place Image');
    getState().setSelection([node.id]);
    return summary(getState().doc, node.id, 0, true);
  },

  // ------------------------------------------------------------------ edit
  updateNodes(p) {
    const ids = idsParam(p);
    if (!ids.length) throw new Error('No nodes to update (give ids or select something)');
    const patch = p.patch ?? {};
    const s = getState();
    s.updateDoc((d) => {
      for (const id of ids) {
        const n = d.nodes[id];
        if (!n) continue;
        const pt: any = { ...patch };
        if ('fill' in pt && (n.type === 'path' || n.type === 'text')) {
          n.fill = toPaint(pt.fill, n.fill);
          delete pt.fill;
        }
        if ('stroke' in pt && (n.type === 'path' || n.type === 'text')) {
          n.stroke = toStroke(pt.stroke, n.stroke);
          delete pt.stroke;
        }
        if ('style' in pt && n.type === 'text') {
          n.style = { ...n.style, ...pt.style };
          delete pt.style;
        }
        if ('text' in pt && n.type === 'text') {
          n.text = String(pt.text);
          n.runs = [{ text: n.text }];
          delete pt.text;
        }
        if ('d' in pt && n.type === 'path') {
          const sps = parseSvgPathData(String(pt.d));
          if (sps.length) {
            setWorldSubPaths(d, id, sps);
            n.shape = undefined;
          }
          delete pt.d;
        }
        if ('shape' in pt && n.type === 'path') {
          n.shape = n.shape ? ({ ...n.shape, ...pt.shape } as LiveShape) : (pt.shape as LiveShape);
          refreshLiveShape(n);
          delete pt.shape;
        }
        for (const k of Object.keys(pt)) {
          if (k === 'id' || k === 'type' || k === 'parent' || k === 'children') continue;
          (n as any)[k] = deepMerge((n as any)[k], pt[k]);
        }
      }
    }, p.label ?? 'Update');
    return ids.map((id) => summary(getState().doc, id, 0, true));
  },
  setPathData(p) {
    const n = requireNode(p.id);
    if (n.type !== 'path') throw new Error('setPathData needs a path node');
    const sps = parseSvgPathData(String(p.d));
    if (!sps.length) throw new Error('Path data produced no geometry');
    getState().updateDoc((d) => {
      setWorldSubPaths(d, p.id, sps);
      (d.nodes[p.id] as PathNode).shape = undefined;
    }, 'Set Path Data');
    return summary(getState().doc, p.id, 0, true);
  },
  transform(p) {
    const ids = topmostOf(getState().doc, idsParam(p));
    if (!ids.length) throw new Error('Nothing to transform');
    const s = getState();
    let sel: Rect | null = null;
    for (const id of ids) sel = rectUnion(sel, worldBounds(s.doc, id));
    const origin: Vec = p.origin ?? (sel ? { x: sel.x + sel.width / 2, y: sel.y + sel.height / 2 } : { x: 0, y: 0 });
    let m = identity();
    if (p.translate) m = multiply(translate(Number(p.translate.x ?? 0), Number(p.translate.y ?? 0)), m);
    if (p.scale !== undefined) {
      const sx = typeof p.scale === 'number' ? p.scale : Number(p.scale.x ?? 1);
      const sy = typeof p.scale === 'number' ? p.scale : Number(p.scale.y ?? sx);
      m = multiply(scaleM(sx, sy, origin.x, origin.y), m);
    }
    if (p.rotate !== undefined) m = multiply(rotateM(-Number(p.rotate), origin.x, origin.y), m); // counter-clockwise positive (Illustrator)
    if (p.matrix) m = multiply(p.matrix as Matrix, m);
    // the same pipeline as the UI: strokes / effects scale with the object only when asked
    // (prefs.scaleStrokes by default), corners always unless scaleCorners is false
    const scaleStrokes = p.scaleStrokes !== undefined ? !!p.scaleStrokes : s.prefs.scaleStrokes;
    const scaleEffects = p.scaleEffects !== undefined ? !!p.scaleEffects : scaleStrokes;
    const k = scaleFactor(m);
    // scaleCorners: false keeps every corner at its world size: remember the radii and the world
    // scale of each path before the transform (the bake changes both, and not always by k)
    const corners = new Map<ID, { k: number; radii: [number, number, number, number] | null; anchors: Array<Array<number | undefined>> }>();
    if (p.scaleCorners === false) {
      for (const id of ids) {
        for (const leaf of descendants(s.doc, id, true)) {
          const n = s.doc.nodes[leaf];
          if (!n || n.type !== 'path') continue;
          corners.set(leaf, { k: scaleFactor(worldMatrix(s.doc, leaf)) || 1, radii: n.shape?.kind === 'rect' ? ([...n.shape.radii] as [number, number, number, number]) : null, anchors: n.subpaths.map((sp) => sp.anchors.map((a) => a.cornerRadius)) });
        }
      }
    }
    const result = transformDocument(s.doc, ids, m, { scaleStrokes });
    let doc = result.doc;
    const rescaleEffects = scaleEffects !== scaleStrokes && Math.abs(k - 1) > 1e-9;
    if (rescaleEffects || corners.size) {
      doc = produce(doc, (d) => {
        for (const id of result.ids) {
          for (const leaf of descendants(d, id, true)) {
            const n = d.nodes[leaf];
            if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
            if (rescaleEffects) n.effects = n.effects.map((e) => scaleEffect(e, scaleEffects ? k : 1 / k));
            const snap = corners.get(leaf);
            if (snap && n.type === 'path') {
              // old local radius * (old world scale / new world scale) = the same world radius
              const ratio = snap.k / (scaleFactor(worldMatrix(d, leaf)) || 1);
              if (snap.radii && n.shape?.kind === 'rect') {
                n.shape = { ...n.shape, radii: snap.radii.map((r) => r * ratio) as [number, number, number, number] };
                refreshLiveShape(n);
              }
              n.subpaths.forEach((sp, si) => {
                sp.anchors.forEach((a, ai) => {
                  const r = snap.anchors[si]?.[ai];
                  if (r) a.cornerRadius = r * ratio;
                  else if (a.cornerRadius) delete a.cornerRadius;
                });
              });
            }
          }
        }
      });
    }
    s.replaceDoc(doc);
    s.commit(p.label ?? 'Transform');
    return result.ids.map((id) => summary(getState().doc, id, 0, true));
  },
  setBounds(p) {
    const n = requireNode(p.id);
    void n;
    const b = nodeBoundsOrThrow(p.id);
    const x = p.x !== undefined ? Number(p.x) : b.x;
    const y = p.y !== undefined ? Number(p.y) : b.y;
    const w = p.width !== undefined ? Number(p.width) : b.width;
    const h = p.height !== undefined ? Number(p.height) : b.height;
    const sx = b.width > 0 ? w / b.width : 1;
    const sy = b.height > 0 ? h / b.height : 1;
    const m = compose(translate(x, y), scaleM(sx, sy), translate(-b.x, -b.y));
    getState().updateDoc((d) => applyWorldMatrix(d, p.id, m, true), 'Set Bounds');
    return summary(getState().doc, p.id, 0, true);
  },
  deleteNodes(p) {
    const ids = topmostOf(getState().doc, idsParam(p)).filter((id) => getState().doc.nodes[id]?.type !== 'layer');
    getState().updateDoc((d) => {
      for (const id of ids) removeNode(d, id);
    }, 'Delete');
    return { deleted: ids };
  },
  duplicate(p) {
    const s = getState();
    const ids = topmostOf(s.doc, idsParam(p));
    const out: ID[] = [];
    s.updateDoc((d) => {
      for (const id of ids) {
        const n = d.nodes[id];
        if (!n || n.type === 'layer') continue;
        const { root, nodes } = cloneSubtree(d, id);
        addSubtree(d, root, nodes, n.parent, indexInParent(d, id) + 1);
        if (p.dx || p.dy) applyWorldMatrix(d, root.id, translate(Number(p.dx ?? 0), Number(p.dy ?? 0)), true);
        out.push(root.id);
      }
    }, 'Duplicate');
    getState().setSelection(out);
    return out.map((id) => summary(getState().doc, id, 0, true));
  },
  group(p) {
    const ids = idsParam(p);
    getState().setSelection(ids);
    runCommand('object.group');
    return { selection: getState().selection };
  },
  ungroup(p) {
    const ids = idsParam(p);
    getState().setSelection(ids);
    runCommand('object.ungroup');
    return { selection: getState().selection };
  },
  arrange(p) {
    const ids = idsParam(p);
    getState().setSelection(ids);
    const map: Record<string, string> = { front: 'object.bringToFront', back: 'object.sendToBack', forward: 'object.bringForward', backward: 'object.sendBackward' };
    const cmd = map[p.op];
    if (!cmd) throw new Error('arrange op must be front | back | forward | backward');
    runCommand(cmd);
    return { ok: true };
  },
  moveToLayer(p) {
    const ids = topmostOf(getState().doc, idsParam(p));
    const target = requireNode(p.layerId);
    if (!isContainer(target)) throw new Error('layerId must be a layer or group');
    getState().updateDoc((d) => {
      for (const id of ids) moveNode(d, id, p.layerId);
    }, 'Move to Layer');
    return { ok: true };
  },
  blend(p) {
    const s = getState();
    const op = String(p.op ?? 'make');
    const ids = idsParam(p);
    if (ids.length) s.setSelection(ids);
    const opts: Record<string, unknown> = {};
    for (const k of ['spacing', 'steps', 'distance', 'colors'] as const) if (p[k] !== undefined) opts[k] = p[k];
    let groups: ID[] = [];
    if (op === 'make') {
      if (blendGroupsOf(getState().doc, getState().selection).length) throw new Error('The selection already is a blend (use op "options" to change it)');
      const gid = makeBlendCommand(blendOptionsFrom(opts));
      if (!gid) throw new Error('Blend needs at least two paths');
      groups = [gid];
    } else if (op === 'options') {
      if (!blendGroupsOf(getState().doc, getState().selection).length) throw new Error('No blend in the selection (use op "make" to create one)');
      if (!Object.keys(opts).length) throw new Error('options needs spacing, steps, distance and/or colors');
      groups = applyBlendOptions(opts);
    } else if (op === 'expand' || op === 'release' || op === 'reverse' || op === 'reverseStack') {
      const cmd = op === 'reverse' ? 'blend.reverseSpine' : `blend.${op}`;
      const c = getCommand(cmd);
      if (!c || !isEnabled(c)) throw new Error(`"${op}" is not available for this selection`);
      runCommand(cmd);
      const st = getState();
      return { op, selection: st.selection, nodes: st.selection.map((id) => summary(st.doc, id, 1, true)) };
    } else throw new Error('op must be make | options | expand | release | reverse | reverseStack');
    const st = getState();
    return { op, groups: groups.map((g) => ({ ...summary(st.doc, g, 0, true), blend: (st.doc.nodes[g] as any)?.data?.blend, children: getChildren(st.doc, g).length })) };
  },
  offsetPath(p) {
    const ids = idsParam(p);
    if (ids.length) getState().setSelection(ids);
    const created = applyOffsetPath({ distance: p.distance ?? p.offset, join: p.join, miterLimit: p.miterLimit, mode: p.mode });
    const st = getState();
    return { created, nodes: created.map((id) => summary(st.doc, id, 0, true)) };
  },
  simplify(p) {
    const ids = idsParam(p);
    if (ids.length) getState().setSelection(ids);
    const r = applySimplify({ tolerance: p.tolerance, cornerAngle: p.cornerAngle, corners: p.corners, straightLines: p.straightLines });
    const st = getState();
    return { ...r, nodes: r.ids.map((id) => summary(st.doc, id, 0, true)) };
  },
  effect(p) {
    const s = getState();
    const op = String(p.op ?? 'add');
    const ids = idsParam(p).filter((id) => !!s.doc.nodes[id]);
    if (!ids.length) throw new Error('effect needs node ids (or a selection)');
    const list = (id: ID) => (getState().doc.nodes[id]?.effects ?? []).map((e, index) => ({ index, ...e }));
    if (op === 'list') return { nodes: ids.map((id) => ({ id, effects: list(id) })) };
    if (op === 'expand') {
      s.setSelection(ids);
      runCommand('object.expandAppearance');
      const st = getState();
      return { op, selection: st.selection, nodes: st.selection.map((id) => summary(st.doc, id, 0, true)) };
    }
    const type = typeof p.type === 'string' ? (p.type as EffectType) : undefined;
    const params = p.params && typeof p.params === 'object' ? (p.params as Record<string, unknown>) : {};
    if (op === 'add') {
      if (!type) throw new Error('add needs an effect "type"');
      const def = effectDef(type);
      if (!def) throw new Error(`Unknown effect type "${type}"; known: ${EFFECT_DEFS.map((d) => d.type).join(', ')}`);
      const defaults = def.defaults() as unknown as Record<string, unknown>;
      const effect = { ...defaults, ...checkEffectParams(type, defaults, params), type, enabled: params.enabled !== false } as Effect;
      applyEffect(effect, ids, p.replace ? { kind: 'replaceType' } : { kind: 'append' }, def.label);
      return { op, nodes: ids.map((id) => ({ id, effects: list(id) })) };
    }
    if (op === 'update' || op === 'remove') {
      let touched = 0;
      s.updateDoc((d) => {
        for (const id of ids) {
          const n = d.nodes[id];
          if (!n) continue;
          const idx = typeof p.index === 'number' ? p.index : type ? n.effects.findIndex((e) => e.type === type) : n.effects.length - 1;
          if (idx < 0 || !n.effects[idx]) continue;
          if (op === 'remove') n.effects.splice(idx, 1);
          else {
            const cur = n.effects[idx];
            const template = (effectDef(cur.type)?.defaults() ?? cur) as unknown as Record<string, unknown>;
            n.effects[idx] = { ...cur, ...checkEffectParams(cur.type, template, params), type: cur.type } as Effect;
          }
          touched++;
        }
      }, op === 'remove' ? 'Remove Effect' : 'Edit Effect');
      if (!touched) throw new Error('No matching effect (give "index" or "type")');
      return { op, nodes: ids.map((id) => ({ id, effects: list(id) })) };
    }
    throw new Error('op must be add | update | remove | expand | list');
  },
  align(p) {
    const s = getState();
    const ids = idsParam(p);
    if (ids.length) s.setSelection(ids);
    if (getState().selection.length === 0) throw new Error('align needs a selection or ids');
    if (p.h === undefined && p.v === undefined && p.distribute === undefined) throw new Error('Nothing to do: give h, v and/or distribute');
    // `done` lists the steps that moved something (an already aligned selection gives [])
    const done = alignFromParams(p);
    const st = getState();
    return { done, nodes: st.selection.map((id) => summary(st.doc, id, 0, true)) };
  },
  pencil(p) {
    const s = getState();
    const raw = Array.isArray(p.points) ? p.points : [];
    const pts: Vec[] = raw.map((q: any) => (Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]) } : { x: Number(q.x), y: Number(q.y) })).filter((q: Vec) => Number.isFinite(q.x) && Number.isFinite(q.y));
    if (pts.length < 2) throw new Error('pencil needs at least two points');
    const fidelity = Math.max(0.5, Math.min(20, Number(p.fidelity ?? 4)));
    const smoothness = Math.max(0, Math.min(100, Number(p.smoothness ?? 25)));
    const passes = Math.round(smoothness / 34);
    const samples = smoothSamples(pts.map((q) => ({ x: q.x, y: q.y, pressure: 1 })), passes);
    const closed = p.closed === true || (p.closed !== false && endsNearStart(samples, Number(p.closeDistance ?? 15)));
    const fitted = fitPolyline(samples.map((q) => ({ x: q.x, y: q.y })), fidelity, closed);
    if (!fitted) throw new Error('The points produced no geometry');
    const fill = p.fill !== undefined ? toPaint(p.fill, s.appearance.fill) : p.fillStrokes ? clonePaint(s.appearance.fill) : ({ type: 'none' } as Paint);
    let stroke = p.stroke !== undefined ? toStroke(p.stroke, s.appearance.stroke) : cloneStroke(s.appearance.stroke);
    if (stroke.paint.type === 'none' && fill.type === 'none') stroke = { ...stroke, paint: { type: 'solid', color: '#000000', opacity: 1 } };
    const parent = parentFor(p);
    if (!parent) throw new Error('No layer to draw on');
    let id: ID | null = null;
    s.updateDoc((d) => {
      id = addWorldPath(d, [fitted], { fill, stroke, name: p.name ?? 'Path', parent })?.id ?? null;
    }, 'Pencil');
    if (!id) throw new Error('Could not add the path');
    if (p.select !== false) getState().setSelection([id]);
    return { ...summary(getState().doc, id, 0, true), anchors: fitted.anchors.length, closed: fitted.closed };
  },
  pen(p) {
    const s = getState();
    const raw = Array.isArray(p.anchors) ? p.anchors : [];
    if (raw.length < 2) throw new Error('pen needs at least two anchors: [{ x, y, handleIn?: {x,y}, handleOut?: {x,y} }]');
    const vec = (v: any): Vec | null => (v && typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) ? { x: Number(v.x), y: Number(v.y) } : Array.isArray(v) && v.length === 2 ? { x: Number(v[0]), y: Number(v[1]) } : null);
    const absolute = p.absoluteHandles === true;
    const anchors = raw.map((a: any) => {
      const point = vec(a.point) ?? vec(a) ?? vec([a.x, a.y]);
      if (!point) throw new Error('Every anchor needs x, y');
      let hin = vec(a.handleIn);
      let hout = vec(a.handleOut);
      if (absolute) {
        if (hin) hin = { x: hin.x - point.x, y: hin.y - point.y };
        if (hout) hout = { x: hout.x - point.x, y: hout.y - point.y };
      }
      const an = makeAnchorPt(point, hin, hout, a.kind === 'smooth' || a.kind === 'corner' ? a.kind : undefined);
      if (Number.isFinite(Number(a.cornerRadius)) && Number(a.cornerRadius) > 0) an.cornerRadius = Number(a.cornerRadius);
      return an;
    });
    const sp: SubPath = { anchors, closed: p.closed === true };
    const parent = parentFor(p);
    if (!parent) throw new Error('No layer to draw on');
    const fill = p.fill !== undefined ? toPaint(p.fill, s.appearance.fill) : clonePaint(s.appearance.fill);
    const stroke = p.stroke !== undefined ? toStroke(p.stroke, s.appearance.stroke) : cloneStroke(s.appearance.stroke);
    let id: ID | null = null;
    s.updateDoc((d) => {
      id = addWorldPath(d, [sp], { fill, stroke, name: p.name ?? 'Path', parent, fillRule: p.fillRule })?.id ?? null;
    }, 'Pen');
    if (!id) throw new Error('Could not add the path');
    if (p.select !== false) getState().setSelection([id]);
    return summary(getState().doc, id, 0, true);
  },
  corners(p) {
    const s = getState();
    const ids = idsParam(p).filter((id) => s.doc.nodes[id]?.type === 'path');
    if (!ids.length) throw new Error('corners needs path ids (or a path selection)');
    const radius = Number(p.radius);
    if (!Number.isFinite(radius) || radius < 0) throw new Error('radius must be a number >= 0 (local units)');
    // anchors: [{subpath, index}] or plain indices of subpath 0; default = every corner of the path(s)
    const refs: AnchorRef[] = [];
    if (Array.isArray(p.anchors)) {
      for (const id of ids) {
        for (const a of p.anchors) {
          if (typeof a === 'number') refs.push({ nodeId: id, subpath: Number(p.subpath ?? 0), index: a });
          else if (a && typeof a === 'object') refs.push({ nodeId: id, subpath: Number(a.subpath ?? p.subpath ?? 0), index: Number(a.index) });
        }
      }
    }
    let count = 0;
    s.updateDoc((d) => {
      count = setCornerRadii(d, ids, radius, refs.length ? refs : undefined);
    }, 'Round Corners');
    const st = getState();
    return { ids, radius, corners: count, nodes: ids.map((id) => summary(st.doc, id, 0, true)) };
  },
  pathfinder(p) {
    const ids = idsParam(p);
    if (ids.length) getState().setSelection(ids);
    const ops = ['unite', 'minusFront', 'intersect', 'exclude', 'minusBack', 'divide', 'trim', 'merge', 'crop', 'outline'];
    if (!ops.includes(p.op)) throw new Error(`op must be one of ${ops.join(', ')}`);
    const before = getState().docVersion;
    runCommand(`pathfinder.${p.op}`, { cleanup: p.cleanup !== false });
    const s = getState();
    return { changed: s.docVersion !== before, selection: s.selection, result: s.selection.map((id) => summary(s.doc, id, 1, true)) };
  },
  setAppearance(p) {
    const s = getState();
    const target = String(p.target ?? 'defaults');
    if (!['defaults', 'selection', 'both'].includes(target)) throw new Error('target must be "defaults", "selection" or "both"');
    const patch: any = {};
    if (p.fill !== undefined) patch.fill = toPaint(p.fill, s.appearance.fill);
    if (p.stroke !== undefined) patch.stroke = toStroke(p.stroke, s.appearance.stroke);
    if (p.textStyle) patch.textStyle = { ...s.appearance.textStyle, ...p.textStyle };
    const targets = target === 'defaults' ? [] : appearanceTargets(idsParam(p));
    if (target !== 'defaults' && !targets.length) throw new Error('No paths or text to apply the appearance to (select something or give ids)');
    if (targets.length) {
      // objects are patched with what was given: a stroke width alone keeps every object's own colour and dash
      s.updateDoc((d) => {
        for (const id of targets) {
          const n = d.nodes[id];
          if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
          if (p.fill !== undefined) n.fill = toPaint(p.fill, n.fill);
          if (p.stroke !== undefined) n.stroke = toStroke(p.stroke, n.stroke);
          if (p.textStyle && n.type === 'text') n.style = { ...n.style, ...p.textStyle };
        }
      }, 'Appearance');
    }
    if (target !== 'selection') s.setAppearance(patch);
    return { target, applied: targets, appearance: getState().appearance };
  },

  // --------------------------------------------------------------- history
  undo(p) {
    const n = Math.max(1, Number(p.steps ?? 1));
    for (let i = 0; i < n; i++) getState().undo();
    return { undo: getState().past.length, redo: getState().future.length };
  },
  redo(p) {
    const n = Math.max(1, Number(p.steps ?? 1));
    for (let i = 0; i < n; i++) getState().redo();
    return { undo: getState().past.length, redo: getState().future.length };
  },
  history() {
    const s = getState();
    return { past: s.past.map((h) => h.label), future: s.future.map((h) => h.label).reverse(), pending: s.doc !== s.historyBase };
  },

  // ---------------------------------------------------------- document ops
  newDocument(p) {
    const doc = newDoc({ name: p.name, width: p.width, height: p.height, artboards: p.artboards, units: p.units, background: p.background, transparent: p.transparent });
    loadDocument(doc, { fileName: null });
    fitArtboard();
    return mcpApi.status({});
  },
  async getProject() {
    return { json: await serializeProject(getState().doc, false) };
  },
  loadProject(p) {
    const doc = parseProject(typeof p.json === 'string' ? p.json : JSON.stringify(p.json));
    loadDocument(doc, { fileName: p.fileName ?? null });
    fitArtboard();
    return mcpApi.status({});
  },
  artboards(p) {
    const s = getState();
    if (p.op === 'add') {
      const ab = makeArtboard({ name: p.name, x: p.x, y: p.y, width: p.width, height: p.height, background: p.background, transparent: p.transparent }, s.doc.artboards.length);
      if (p.x === undefined) {
        const last = s.doc.artboards[s.doc.artboards.length - 1];
        if (last) {
          ab.x = last.x + last.width + 100;
          ab.y = last.y;
        }
      }
      s.updateDoc((d) => {
        d.artboards.push(ab);
      }, 'New Artboard');
      getState().setActiveArtboard(ab.id);
      return ab;
    }
    if (p.op === 'update') {
      s.updateDoc((d) => {
        const ab = d.artboards.find((a) => a.id === p.id);
        if (!ab) throw new Error('Unknown artboard');
        Object.assign(ab, p.patch ?? {});
      }, 'Artboard Options');
      return getState().doc.artboards.find((a) => a.id === p.id);
    }
    if (p.op === 'remove') {
      if (s.doc.artboards.length <= 1) throw new Error('A document needs at least one artboard');
      s.updateDoc((d) => {
        d.artboards = d.artboards.filter((a) => a.id !== p.id);
      }, 'Delete Artboard');
      return { ok: true };
    }
    if (p.op === 'activate') {
      s.setActiveArtboard(p.id);
      return { ok: true };
    }
    return s.doc.artboards;
  },

  // ---------------------------------------------------------------- output
  exportSvg(p) {
    const s = getState();
    const scope = p.scope ?? (p.ids?.length ? 'selection' : 'artboard');
    const res = exportSvg(s.doc, { scope, ids: p.ids ?? (scope === 'selection' ? s.selection : undefined), artboardId: p.artboardId ?? s.activeArtboardId, pretty: p.pretty ?? true, background: p.background, margin: p.margin, precision: p.precision, bleed: p.bleed ? true : undefined, marks: p.marks ? { trimMarks: true, registrationMarks: true, colorBars: true, pageInfo: true, ...(typeof p.marks === 'object' ? p.marks : {}) } : undefined });
    return { svg: res.svg, x: res.x, y: res.y, width: res.width, height: res.height, name: res.name };
  },
  async renderPng(p) {
    const s = getState();
    const scope = p.scope ?? (p.ids?.length ? 'selection' : 'artboard');
    const r = await renderToDataUrl(s.doc, {
      scope,
      ids: p.ids ?? (scope === 'selection' ? s.selection : undefined),
      artboardId: p.artboardId ?? s.activeArtboardId,
      format: p.format ?? 'png',
      scale: p.scale,
      width: p.width,
      height: p.height,
      backgroundColor: p.background === undefined ? undefined : p.background,
      margin: p.margin,
      maxSize: 4096,
      bleed: p.bleed ? true : undefined,
      marks: p.marks ? { trimMarks: true, registrationMarks: true, colorBars: true, pageInfo: true, ...(typeof p.marks === 'object' ? p.marks : {}) } : undefined,
    });
    return { dataUrl: r.dataUrl, width: r.width, height: r.height };
  },
  async screenshot(p) {
    // render what the viewport currently shows (document region under the viewport)
    const s = getState();
    const vw = s.viewportSize.width;
    const vh = s.viewportSize.height;
    const x = -s.pan.x / s.zoom;
    const y = -s.pan.y / s.zoom;
    const w = vw / s.zoom;
    const h = vh / s.zoom;
    const tmp: Document = { ...s.doc, artboards: [makeArtboard({ x, y, width: w, height: h, transparent: true, name: 'view' })] };
    const maxW = Number(p.maxWidth ?? 1400);
    const scale = Math.min(s.zoom, maxW / w);
    const r = await renderToDataUrl(tmp, { scope: 'artboard', artboardId: tmp.artboards[0].id, format: 'png', scale, backgroundColor: s.prefs.canvasColor, maxSize: 4096 });
    return { dataUrl: r.dataUrl, width: r.width, height: r.height, world: { x, y, width: w, height: h } };
  },
  zoom(p) {
    const s = getState();
    if (p.fit === 'artboard') fitArtboard();
    else if (p.fit === 'all') fitAll();
    else if (p.fit === 'selection') runCommand('view.fitSelection');
    else if (p.rect) s.zoomToRect(p.rect, p.padding ?? 40);
    else if (p.zoom !== undefined) {
      s.setZoom(Number(p.zoom));
      if (p.center) {
        const st = getState();
        st.setPan({ x: st.viewportSize.width / 2 - p.center.x * st.zoom, y: st.viewportSize.height / 2 - p.center.y * st.zoom });
      }
    }
    const st = getState();
    return { zoom: st.zoom, pan: st.pan };
  },
  view(p) {
    getState().setView(p.patch ?? {});
    return getState().view;
  },
  prefs(p) {
    if (p.patch) getState().setPrefs(p.patch);
    return getState().prefs;
  },

  // ------------------------------------------------------------- simulate
  async gesture(p) {
    const el = viewportElement();
    const pts: Vec[] = p.points ?? [];
    if (pts.length < 1) throw new Error('gesture needs at least one point');
    if (p.tool) mcpApi.setTool({ id: p.tool, options: p.options });
    const mods: string[] = p.modifiers ?? [];
    const pid = 9000 + Math.floor(Math.random() * 1000);
    const button = p.button ?? 0;
    const steps = Math.max(1, Number(p.steps ?? 6));
    el.dispatchEvent(pointerEvent('pointermove', el, pts[0], { buttons: 0, modifiers: mods, pointerId: pid }));
    el.dispatchEvent(pointerEvent('pointerdown', el, pts[0], { button, buttons: 1, modifiers: mods, pointerId: pid }));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        el.dispatchEvent(pointerEvent('pointermove', el, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, { button, buttons: 1, modifiers: mods, pointerId: pid }));
        if (p.delay) await sleep(Number(p.delay));
      }
    }
    if (!p.keepDown) el.dispatchEvent(pointerEvent('pointerup', el, pts[pts.length - 1], { button, buttons: 0, modifiers: mods, pointerId: pid }));
    await sleep(0);
    const s = getState();
    return { selection: s.selection, activeTool: s.activeTool, status: s.status, history: s.past.length };
  },
  async click(p) {
    const el = viewportElement();
    const pt: Vec = { x: Number(p.x), y: Number(p.y) };
    if (p.tool) mcpApi.setTool({ id: p.tool, options: p.options });
    const mods: string[] = p.modifiers ?? [];
    const count = Math.max(1, Number(p.count ?? 1));
    const pid = 9000 + Math.floor(Math.random() * 1000);
    el.dispatchEvent(pointerEvent('pointermove', el, pt, { buttons: 0, modifiers: mods, pointerId: pid }));
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(pointerEvent('pointerdown', el, pt, { button: p.button ?? 0, buttons: 1, modifiers: mods, pointerId: pid }));
      el.dispatchEvent(pointerEvent('pointerup', el, pt, { button: p.button ?? 0, buttons: 0, modifiers: mods, pointerId: pid }));
    }
    if (count >= 2) {
      const s = getState();
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: r.left + pt.x * s.zoom + s.pan.x, clientY: r.top + pt.y * s.zoom + s.pan.y, button: 0 }));
    }
    await sleep(0);
    const s = getState();
    return { selection: s.selection, activeTool: s.activeTool, status: s.status };
  },
  async hover(p) {
    const el = viewportElement();
    el.dispatchEvent(pointerEvent('pointermove', el, { x: Number(p.x), y: Number(p.y) }, { buttons: 0, modifiers: p.modifiers ?? [], pointerId: 9999 }));
    await sleep(0);
    const s = getState();
    return { hoverId: s.hoverId, cursor: s.cursor, status: s.status };
  },
  async key(p) {
    const keys: string[] = Array.isArray(p.keys) ? p.keys : [p.key];
    const el = viewportElement();
    el.focus();
    for (const k of keys) {
      const mods: string[] = p.modifiers ?? [];
      // allow "mod+z" style
      const parts = String(k).split('+');
      const key = parts.pop()!;
      const allMods = mods.concat(parts);
      window.dispatchEvent(keyEvent('keydown', key, allMods));
      window.dispatchEvent(keyEvent('keyup', key, allMods));
      await sleep(0);
    }
    const s = getState();
    return { selection: s.selection, activeTool: s.activeTool, dialog: s.dialog?.type ?? null };
  },
  typeText(p) {
    const s = getState();
    const id = p.id ?? s.editingTextId ?? s.selection.find((x) => s.doc.nodes[x]?.type === 'text');
    if (!id) throw new Error('No text object to edit (select one or pass id)');
    const n = requireNode(id);
    if (n.type !== 'text') throw new Error('Not a text node');
    s.updateDoc((d) => {
      const t = d.nodes[id] as TextNode;
      t.text = p.replace ? String(p.text) : t.text + String(p.text);
      t.runs = [{ text: t.text }];
    }, 'Edit Text');
    return summary(getState().doc, id, 0, true);
  },
  eval(p) {
    if (typeof p.code !== 'string') throw new Error('eval needs "code"');
    let fn: Function;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('api', 'store', 'getState', 'runCommand', 'helpers', `return (async () => { ${p.code} })()`);
    } catch (err: any) {
      // the hosted site ships a Content-Security-Policy without 'unsafe-eval'
      if (err instanceof EvalError || /Content Security Policy|unsafe-eval/i.test(String(err?.message))) throw new Error("eval is disabled by this site's Content-Security-Policy; use the dev server (npm run dev) for scripted access, or the dedicated tools");
      throw err;
    }
    return fn((window as any).__opuller, useStore, getState, runCommand, (window as any).__opuller?.api);
  },
  toast(p) {
    getState().toast(String(p.message ?? ''), p.kind ?? 'info');
    return { ok: true };
  },
  async gradients(p) {
    const reg = await import('@/gradients/register');
    const meshMod = await import('@/gradients/mesh');
    const op = p.op ?? 'mesh';
    const s = getState();
    if (p.ids?.length) s.setSelection(p.ids);
    if (op === 'mesh') {
      const n = reg.createMeshOnSelection({ rows: p.rows, cols: p.cols, appearance: p.appearance, highlight: p.highlight });
      return { count: n };
    }
    if (op === 'freeform') {
      if (!p.points?.length) throw new Error('points required');
      reg.applyFreeform(p.points, p.mode);
      return { ok: true, points: p.points.length };
    }
    if (op === 'release') return { count: reg.releaseMesh() };
    if (op === 'setNode') {
      const st = getState();
      st.updateDoc((d) => {
        for (const id of st.selection) {
          const n = d.nodes[id];
          if (!n || (n.type !== 'path' && n.type !== 'text') || n.fill.type !== 'mesh') continue;
          const idx = Number(p.index ?? 0);
          const node = n.fill.nodes[idx];
          if (!node) continue;
          n.fill = { ...n.fill, nodes: n.fill.nodes.map((m, i) => (i === idx ? { ...m, color: p.color ?? m.color, opacity: p.opacity ?? m.opacity, x: p.x ?? m.x, y: p.y ?? m.y } : m)) };
        }
      }, 'Gradient Mesh');
      return { ok: true };
    }
    if (op === 'info') {
      const st = getState();
      return st.selection.map((id) => {
        const n = st.doc.nodes[id];
        if (!n || (n.type !== 'path' && n.type !== 'text')) return { id, fill: null };
        if (n.fill.type === 'mesh') return { id, fill: 'mesh', rows: n.fill.rows, cols: n.fill.cols, nodes: n.fill.nodes.map((m) => ({ x: +m.x.toFixed(3), y: +m.y.toFixed(3), color: m.color })) };
        if (n.fill.type === 'freeform') return { id, fill: 'freeform', mode: n.fill.mode, points: n.fill.points };
        return { id, fill: n.fill.type };
      });
    }
    void meshMod;
    throw new Error(`Unknown gradients op "${op}"`);
  },
  async brushes(p) {
    const ops = await import('@/brushes/ops');
    const act = await import('@/brushes/actions');
    const op = p.op ?? 'list';
    const s = getState();
    if (op === 'list') return s.doc.brushes.map((b) => ({ id: b.id, name: b.name, kind: b.kind, users: ops.nodesUsingBrush(s.doc, b.id).length }));
    if (op === 'apply') {
      if (p.ids?.length) s.setSelection(p.ids);
      return { count: act.applyBrushCommand(String(p.id), { scale: p.scale, flipAlong: p.flipAlong, flipAcross: p.flipAcross, colorization: p.colorization }) };
    }
    if (op === 'remove') {
      if (p.ids?.length) s.setSelection(p.ids);
      return { count: act.removeBrushStrokeCommand() };
    }
    if (op === 'expand') {
      return { count: act.expandBrushStrokesCommand(p.ids), selection: getState().selection };
    }
    if (op === 'calligraphic') {
      const def = act.newCalligraphicBrush({ name: p.name, size: p.size, angle: p.angle, roundness: p.roundness });
      return { id: def?.id ?? null };
    }
    if (op === 'fromSelection') {
      const kind = p.kind === 'art' || p.kind === 'pattern' ? p.kind : 'scatter';
      const def = act.newArtworkBrush(kind, { name: p.name, colorization: p.colorization, ids: p.ids });
      return { id: def?.id ?? null };
    }
    if (op === 'options') {
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'size', 'angle', 'roundness', 'width', 'scale', 'spacing', 'fit', 'stretch', 'colorization', 'flipAlong', 'flipAcross', 'rotationRelativeTo'] as const) if (p[k] !== undefined) patch[k] = p[k];
      act.updateBrushCommand(String(p.id), patch as never);
      return { ok: true };
    }
    if (op === 'delete') {
      act.deleteBrushCommand(String(p.id), p.mode === 'expand' ? 'expand' : 'remove');
      return { ok: true };
    }
    if (op === 'library') {
      const lib = (await import('@/brushes/library')).BRUSH_LIBRARY;
      if (p.name) {
        const entry = lib.find((e) => e.id === p.name || e.name === p.name);
        if (!entry) throw new Error(`Unknown library brush "${p.name}"`);
        return { id: act.addLibraryBrush(entry.id) };
      }
      return { added: act.addWholeBrushLibrary(), available: lib.map((e) => ({ id: e.id, kind: e.kind })) };
    }
    throw new Error(`Unknown brushes op "${op}"`);
  },
  async swatches(p) {
    const act = await import('@/color/actions');
    const sw = await import('@/color/swatches');
    const libs = await import('@/color/libraries');
    const { linkedPaint, isGlobalSwatch } = await import('@/color/globals');
    const s = getState();
    const op = String(p.op ?? 'list');
    const describe = (x: Swatch) => ({ id: x.id, name: x.name, kind: x.kind ?? 'process', paint: x.paint, cmyk: x.cmyk });
    const find = (): Swatch => {
      const st = getState();
      const byId = typeof p.id === 'string' ? st.doc.swatches.find((x) => x.id === p.id) : undefined;
      const byName = typeof p.name === 'string' ? st.doc.swatches.find((x) => x.name === p.name) : undefined;
      const hit = byId ?? byName;
      if (!hit) throw new Error(`No swatch ${p.id ? `with id "${p.id}"` : `named "${p.name}"`}`);
      return hit;
    };
    if (op === 'list') return { colorMode: s.doc.colorMode, swatches: s.doc.swatches.map(describe) };
    if (op === 'libraries') return { libraries: libs.SWATCH_LIBRARIES.map((l) => ({ id: l.id, name: l.name, count: l.colors.length, kind: l.kind ?? 'process' })) };
    if (op === 'addLibrary') {
      const n = act.addLibrary(String(p.library ?? p.id ?? ''));
      return { added: n, swatches: getState().doc.swatches.map(describe) };
    }
    if (op === 'add') {
      const paint = sw.sanitizePaint(p.paint !== undefined ? toPaint(p.paint, s.appearance.fill) : p.color !== undefined ? toPaint(p.color, s.appearance.fill) : null);
      if (!paint) throw new Error('add needs a paint or color');
      const kind = p.kind === 'global' || p.kind === 'spot' ? p.kind : undefined;
      const cmyk = p.cmyk && typeof p.cmyk === 'object' ? { c: Number(p.cmyk.c ?? 0), m: Number(p.cmyk.m ?? 0), y: Number(p.cmyk.y ?? 0), k: Number(p.cmyk.k ?? 0) } : undefined;
      const created = act.addSwatch(paint, typeof p.name === 'string' ? p.name : undefined, { kind, cmyk, apply: !!p.apply });
      return { swatch: describe(created) };
    }
    if (op === 'remove') {
      const hit = find();
      act.deleteSwatches([hit.id]);
      return { removed: hit.id, swatches: getState().doc.swatches.map(describe) };
    }
    if (op === 'rename') {
      const hit = find();
      if (typeof p.newName !== 'string') throw new Error('rename needs newName');
      act.renameSwatch(hit.id, p.newName);
      return { swatch: describe(getState().doc.swatches.find((x) => x.id === hit.id)!) };
    }
    if (op === 'update') {
      const hit = find();
      const paint = p.paint !== undefined ? sw.sanitizePaint(toPaint(p.paint, hit.paint)) : p.color !== undefined ? sw.sanitizePaint(toPaint(p.color, hit.paint)) : null;
      if (paint) act.updateSwatchPaint(hit.id, paint, p.updateObjects !== false, true, p.cmyk ?? undefined);
      if (p.kind === 'process' || p.kind === 'global' || p.kind === 'spot') act.setSwatchKind(hit.id, p.kind);
      return { swatch: describe(getState().doc.swatches.find((x) => x.id === hit.id)!) };
    }
    if (op === 'apply') {
      const hit = find();
      const ids = idsParam(p);
      if (ids.length) s.setSelection(ids);
      const target = p.target === 'stroke' ? 'stroke' : 'fill';
      const tint = p.tint !== undefined ? Math.max(0, Math.min(100, Number(p.tint))) : 100;
      act.applySwatch(hit, target, tint);
      const st = getState();
      return { applied: hit.id, target, tint, paint: isGlobalSwatch(hit) && hit.paint.type === 'solid' ? linkedPaint(hit, tint, hit.paint.opacity) : hit.paint, selection: st.selection, appearance: st.appearance };
    }
    if (op === 'select') {
      const hit = find();
      const n = act.selectObjectsUsing(hit.paint, hit.id);
      return { selected: n, selection: getState().selection };
    }
    throw new Error('op must be list | add | remove | rename | update | apply | select | libraries | addLibrary');
  },
  async fonts(p) {
    const f = await import('@/text/fonts');
    const op = String(p.op ?? 'list');
    const describe = (d: import('@/text/fonts').FontFamilyDef) => ({ family: d.family, category: d.category, source: d.source, outlines: d.outlines, faces: d.faces.map((x) => ({ weight: x.weight, style: x.style })) });
    if (op === 'list') {
      // system fonts: the browser cannot enumerate them without a permission prompt; the fixed list is what the picker offers
      return { families: f.listFamilies().map(describe), uploaded: f.uploadedFonts().map((u) => ({ id: u.id, family: u.family, weight: u.weight, style: u.style, fileName: u.fileName, outlines: u.parsable })) };
    }
    if (op === 'load') {
      const name = String(p.name ?? 'font.ttf');
      const b64 = String(p.base64 ?? '');
      if (!b64) throw new Error('load needs the font file as base64 (opuller_fonts file=...)');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const rec = await f.uploadFont(new File([bytes], name));
      return { loaded: { id: rec.id, family: rec.family, weight: rec.weight, style: rec.style, outlines: rec.parsable } };
    }
    if (op === 'remove') {
      const list = f.uploadedFonts();
      const hit = list.find((u) => u.id === p.id || u.family === p.family);
      if (!hit) throw new Error('No uploaded font with that id / family');
      await f.removeUploadedFont(hit.id);
      return { removed: hit.id };
    }
    throw new Error('op must be list | load | remove');
  },
  async patterns(p) {
    const ops = await import('@/patterns/ops');
    const reg = await import('@/patterns/register');
    const op = p.op ?? 'list';
    const s = getState();
    if (op === 'list') return s.doc.patterns.map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height, layout: d.layout ?? 'grid', editable: !!d.nodes, users: ops.nodesUsingPattern(s.doc, d.id).length }));
    if (op === 'make') {
      if (p.ids?.length) s.setSelection(p.ids);
      let def: import('@/model/types').PatternDef | null = null;
      s.updateDoc((d) => {
        def = ops.makePattern(d, getState().selection, { name: p.name, layout: p.layout, offset: p.offset, spacing: p.spacingX !== undefined || p.spacingY !== undefined ? { x: Number(p.spacingX ?? 0), y: Number(p.spacingY ?? 0) } : undefined, background: p.background ?? undefined, width: p.width, height: p.height, consume: p.consume })?.def ?? null;
      }, 'Make Pattern');
      return def ? { id: (def as import('@/model/types').PatternDef).id, name: (def as import('@/model/types').PatternDef).name } : { id: null };
    }
    if (op === 'apply') {
      const def = ops.getPattern(s.doc, String(p.id));
      if (!def) throw new Error('Unknown pattern id');
      if (p.ids?.length) s.setSelection(p.ids);
      const paint: import('@/model/types').Paint = { type: 'pattern', patternId: def.id, scale: p.scale ?? 1, angle: p.angle ?? 0, x: p.x, y: p.y };
      const { setFillPaint, setStrokePaint } = await import('@/commands/appearance');
      if (p.target === 'stroke') setStrokePaint(paint, true);
      else setFillPaint(paint, true);
      return { ok: true, selection: getState().selection };
    }
    if (op === 'options') {
      s.updateDoc((d) => {
        ops.updatePatternOptions(d, String(p.id), { name: p.name, layout: p.layout, offset: p.offset, width: p.width, height: p.height, spacing: p.spacingX !== undefined || p.spacingY !== undefined ? { x: Number(p.spacingX ?? 0), y: Number(p.spacingY ?? 0) } : undefined, background: p.background === undefined ? undefined : p.background });
      }, 'Pattern Options');
      return { ok: true };
    }
    if (op === 'edit') return { ok: reg.editPatternCommand(p.id ? String(p.id) : undefined) };
    if (op === 'finishEdit') {
      getState().setIsolation(null);
      return { ok: true };
    }
    if (op === 'expand') {
      if (p.ids?.length) s.setSelection(p.ids);
      return { count: reg.expandPatternFillCommand(), selection: getState().selection };
    }
    if (op === 'delete') {
      s.updateDoc((d) => ops.deletePattern(d, String(p.id)), 'Delete Pattern');
      return { ok: true };
    }
    if (op === 'library') {
      const lib = (await import('@/patterns/library')).PATTERN_LIBRARY;
      if (p.name) {
        const entry = lib.find((e) => e.id === p.name || e.name === p.name);
        if (!entry) throw new Error(`Unknown library pattern "${p.name}"`);
        reg.addPatternLibraryCommand(entry.id);
        const st = getState();
        return { id: st.doc.patterns[st.doc.patterns.length - 1]?.id ?? null };
      }
      return { added: reg.addPatternLibraryCommand(), available: lib.map((e) => e.id) };
    }
    throw new Error(`Unknown patterns op "${op}"`);
  },
  async symbols(p) {
    const sym = await import('@/symbols/ops');
    const act = await import('@/symbols/actions');
    const op = p.op ?? 'list';
    const s = getState();
    if (op === 'list') return s.doc.symbols.map((d) => ({ id: d.id, name: d.name, version: d.version, instances: sym.symbolInstances(s.doc, d.id).length, bounds: sym.symbolBounds(s.doc, d) }));
    if (op === 'make') {
      if (p.ids?.length) s.setSelection(p.ids);
      const id = act.makeSymbolCommand(p.name);
      return { id, instance: getState().selection[0] ?? null };
    }
    if (op === 'place') {
      const id = act.placeSymbolCommand(String(p.id ?? act.currentSymbolId()), p.x !== undefined && p.y !== undefined ? { x: Number(p.x), y: Number(p.y) } : undefined, { scale: p.scale, rotation: p.rotation });
      return { instance: id };
    }
    if (op === 'break') return { count: act.breakLinkCommand(p.ids) };
    if (op === 'redefine') {
      if (p.ids?.length) s.setSelection(p.ids);
      return { ok: act.redefineCommand(String(p.id)) };
    }
    if (op === 'edit') return { ok: act.editSymbolCommand(String(p.id)) };
    if (op === 'finishEdit') {
      getState().setIsolation(null);
      return { ok: true };
    }
    if (op === 'delete') {
      act.deleteSymbolCommand(String(p.id), p.mode === 'delete' ? 'delete' : 'break');
      return { ok: true };
    }
    if (op === 'rename') {
      act.renameSymbolCommand(String(p.id), String(p.name ?? ''));
      return { ok: true };
    }
    if (op === 'instances') return { ids: sym.symbolInstances(s.doc, p.id ? String(p.id) : undefined) };
    if (op === 'library') {
      if (p.name) {
        const lib = (await import('@/symbols/library')).SYMBOL_LIBRARY;
        const entry = lib.find((e) => e.id === p.name || e.name === p.name);
        if (!entry) throw new Error(`Unknown library symbol "${p.name}"`);
        return { id: act.addLibrarySymbol(entry.id) };
      }
      return { added: act.addWholeLibrary(), available: (await import('@/symbols/library')).SYMBOL_LIBRARY.map((e) => e.id) };
    }
    throw new Error(`Unknown symbols op "${op}"`);
  },
  async perspective(p) {
    const reg = await import('@/perspective/register');
    const ops = await import('@/perspective/ops');
    const { usePerspectiveStore } = await import('@/perspective/store');
    const op = p.op ?? 'get';
    const s = getState();
    const summary = () => {
      const st = getState();
      const ui = usePerspectiveStore.getState();
      return { grid: st.doc.perspective ?? null, visible: ui.visible, activePlane: ui.activePlane, drawOnPlane: ui.drawOnPlane, attached: ops.attachedNodes(st.doc).map((id) => ({ id, ...ops.attachmentOf(st.doc, id)! })) };
    };
    if (op === 'get') return summary();
    if (op === 'show' || op === 'hide') {
      reg.showGrid(op === 'show');
      return summary();
    }
    if (op === 'preset') {
      reg.setPreset((p.type === 1 || p.type === 3 ? p.type : 2) as 1 | 2 | 3);
      return summary();
    }
    if (op === 'define') {
      reg.ensureGrid();
      const patch: Record<string, unknown> = {};
      for (const k of ['type', 'horizon', 'vpLeft', 'vpRight', 'vpVertical', 'ground', 'corner', 'extent', 'height', 'cell', 'opacity']) if (p[k] !== undefined) patch[k] = p[k];
      const cur = getState().doc.perspective!;
      const next = patch.type !== undefined && patch.type !== cur.type ? (await import('@/perspective/grid')).withType(cur, patch.type as 1 | 2 | 3) : cur;
      reg.updateGrid({ ...next, ...patch } as import('@/model/types').PerspectiveGrid, 'Define Perspective Grid');
      usePerspectiveStore.getState().setVisible(true);
      return summary();
    }
    if (op === 'plane') {
      if (p.plane === 'left' || p.plane === 'right' || p.plane === 'floor') reg.setActivePlane(p.plane);
      if (p.drawOnPlane !== undefined) usePerspectiveStore.getState().setDrawOnPlane(!!p.drawOnPlane);
      return summary();
    }
    if (op === 'attach') {
      if (p.ids?.length) s.setSelection(p.ids);
      const done = await reg.attachSelection(undefined, p.plane);
      return { attached: done, selection: getState().selection };
    }
    if (op === 'release') {
      if (p.ids?.length) s.setSelection(p.ids);
      return { released: reg.releaseSelection() };
    }
    if (op === 'remove') {
      if (p.ids?.length) s.setSelection(p.ids);
      return { removed: reg.removeSelection() };
    }
    if (op === 'move') {
      const id = String(p.id ?? s.selection[0] ?? '');
      const g = s.doc.perspective;
      if (!g || !ops.isAttached(s.doc, id)) throw new Error('The node is not attached to a perspective plane');
      s.updateDoc((d) => {
        ops.moveAttached(d, id, g, Number(p.dx ?? 0), Number(p.dy ?? 0));
      }, 'Move in Perspective');
      return { id, ...ops.attachmentOf(getState().doc, id)! };
    }
    throw new Error(`Unknown perspective op "${op}"`);
  },
  async livepaint(p) {
    const ops = await import('@/livepaint/ops');
    const reg = await import('@/livepaint/register');
    const op = p.op ?? 'list';
    const s = getState();
    const groups = () => Object.values(getState().doc.nodes).filter((n) => ops.isLivePaintGroup(n)).map((n) => ({ id: n.id, ...ops.livePaintParts(getState().doc, n.id) }));
    if (op === 'list') return groups().map((g) => ({ id: g.id, faces: g.faces.length, edges: g.edges.length }));
    if (op === 'make') {
      const gid = reg.makeLivePaintCommand(p.ids?.length ? p.ids : undefined);
      return gid ? { id: gid, ...ops.livePaintParts(getState().doc, gid) } : { id: null };
    }
    if (op === 'parts') {
      const gid = ops.livePaintGroupOf(s.doc, String(p.id ?? s.selection[0] ?? ''));
      if (!gid) throw new Error('Not a Live Paint group');
      const parts = ops.livePaintParts(s.doc, gid);
      const info = (id: ID) => {
        const n = s.doc.nodes[id] as PathNode;
        return { id, fill: n.fill.type === 'solid' ? n.fill.color : n.fill.type, stroke: n.stroke.paint.type === 'solid' ? n.stroke.paint.color : n.stroke.paint.type, bounds: worldBounds(s.doc, id) };
      };
      return { id: gid, faces: parts.faces.map(info), edges: parts.edges.map(info) };
    }
    if (op === 'paint') {
      // fill a face / stroke an edge by id (or the part under a world point)
      const gid = ops.livePaintGroupOf(s.doc, String(p.id ?? s.selection[0] ?? ''));
      if (!gid) throw new Error('Not a Live Paint group');
      const parts = ops.livePaintParts(s.doc, gid);
      let target: ID | undefined = p.part ? String(p.part) : undefined;
      if (!target && p.x !== undefined && p.y !== undefined) {
        const { hitTest } = await import('@/canvas/hitTest');
        const hit = hitTest(s.doc, { x: Number(p.x), y: Number(p.y) }, { tolerance: 3, enterGroups: true });
        if (hit && (parts.faces.includes(hit.id) || parts.edges.includes(hit.id))) target = hit.id;
      }
      if (!target) throw new Error('No face or edge found');
      s.updateDoc((d) => {
        const n = d.nodes[target!] as PathNode;
        if (p.fill !== undefined) n.fill = p.fill === 'none' ? { type: 'none' } : { type: 'solid', color: String(p.fill), opacity: 1 };
        if (p.stroke !== undefined) n.stroke = { ...n.stroke, paint: p.stroke === 'none' ? { type: 'none' } : { type: 'solid', color: String(p.stroke), opacity: 1 } };
        if (p.strokeWidth !== undefined) n.stroke = { ...n.stroke, width: Number(p.strokeWidth) };
      }, 'Live Paint');
      return { painted: target };
    }
    if (op === 'release' || op === 'expand') {
      const gid = ops.livePaintGroupOf(s.doc, String(p.id ?? s.selection[0] ?? ''));
      if (!gid) throw new Error('Not a Live Paint group');
      let out: ID[] = [];
      s.updateDoc((d) => {
        if (op === 'release') out = ops.releaseLivePaint(d, gid);
        else out = ops.expandLivePaint(d, gid) ? [gid] : [];
      }, op === 'release' ? 'Release Live Paint' : 'Expand Live Paint');
      getState().setSelection(out);
      return { ids: out };
    }
    throw new Error(`Unknown livepaint op "${op}"`);
  },
  async graphs(p) {
    const ops = await import('@/graphs/ops');
    const reg = await import('@/graphs/register');
    const build = await import('@/graphs/build');
    const op = p.op ?? 'list';
    const s = getState();
    const spec = (): Partial<import('@/graphs/build').GraphSpec> => {
      const out: Partial<import('@/graphs/build').GraphSpec> = {};
      if (p.type) out.type = p.type;
      if (p.table) {
        const t = build.parseTable(String(p.table));
        out.data = t.data;
        out.categories = t.categories;
        out.series = t.series;
      }
      if (p.data) out.data = p.data;
      if (p.categories) out.categories = p.categories;
      if (p.series) out.series = p.series;
      if (p.options || p.colors) out.options = { ...build.DEFAULT_OPTIONS, ...(p.options ?? {}), ...(p.colors ? { colors: p.colors } : {}) };
      return out;
    };
    if (op === 'list') return Object.values(s.doc.nodes).filter((n) => ops.isGraph(n)).map((n) => ({ id: n.id, type: ops.graphSpec(s.doc, n.id)?.type, bounds: worldBounds(s.doc, n.id) }));
    if (op === 'create') {
      const rect = p.x !== undefined && p.y !== undefined ? { x: Number(p.x), y: Number(p.y), width: Number(p.width ?? 400), height: Number(p.height ?? 300) } : undefined;
      const id = reg.createGraphCommand(rect, spec());
      return id ? { id, spec: ops.graphSpec(getState().doc, id) } : { id: null };
    }
    const gid = ops.graphOf(s.doc, String(p.id ?? s.selection[0] ?? ''));
    if (!gid) throw new Error('Not a graph');
    if (op === 'get') return { id: gid, spec: ops.graphSpec(s.doc, gid), table: build.tableText(ops.graphSpec(s.doc, gid)!) };
    if (op === 'update') {
      reg.updateGraph(gid, spec(), 'Graph Data');
      return { id: gid, spec: ops.graphSpec(getState().doc, gid) };
    }
    if (op === 'refit') {
      s.updateDoc((d) => {
        ops.refitGraph(d, gid);
      }, 'Refit Graph');
      return { id: gid };
    }
    throw new Error(`Unknown graphs op "${op}"`);
  },
  async imageTrace(p) {
    const reg = await import('@/raster/register');
    const tr = await import('@/raster/trace');
    const op = p.op ?? 'trace';
    if (op === 'presets') return tr.TRACE_PRESETS.map((x) => ({ id: x.id, name: x.name, options: x.opts }));
    const s = getState();
    const ids: ID[] = (p.ids?.length ? p.ids : s.selection).filter((id: ID) => s.doc.nodes[id]?.type === 'image');
    if (!ids.length) throw new Error('Select an image (or pass ids of image nodes)');
    const preset = p.preset ? tr.TRACE_PRESETS.find((x) => x.id === p.preset || x.name === p.preset) : undefined;
    if (p.preset && !preset) throw new Error(`Unknown preset "${p.preset}"`);
    const opts = { ...tr.DEFAULT_TRACE, ...(preset?.opts ?? {}), ...(p.options ?? {}) } as import('@/raster/trace').TraceOptions;
    const groups = await reg.traceImages(ids, opts);
    const st = getState();
    return { groups, paths: groups.reduce((a, g) => a + tr.countTraced(st.doc, g), 0), selection: st.selection, options: opts };
  },
  async liquify(p) {
    const mod = await import('@/liquify/engine');
    const brush = await import('@/liquify/brush');
    const op = p.op ?? 'apply';
    if (op === 'options') {
      const kind = brush.LIQUIFY_KINDS.includes(p.kind) ? (p.kind as import('@/liquify/brush').LiquifyKind) : 'warp';
      if (p.options) {
        const reg = await import('@/liquify/register');
        const global: Record<string, unknown> = {};
        const own: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p.options as Record<string, unknown>)) ((brush.GLOBAL_KEYS as string[]).includes(k) ? global : own)[k] = v;
        if (Object.keys(global).length) reg.setGlobalBrush(global);
        if (Object.keys(own).length) getState().setToolOptions(kind, own);
      }
      return { kind, options: mod.currentOptions(kind) };
    }
    if (op === 'apply') {
      const r = mod.applyLiquify({ kind: p.kind, points: p.points, x: p.x, y: p.y, steps: p.steps, ids: p.ids, options: p.options, pressure: p.pressure });
      return { ...r, selection: getState().selection, history: getState().past.length };
    }
    throw new Error('op must be apply | options');
  },
  async projects(p) {
    const lib = await import('@/home/projects');
    const op = p.op ?? 'list';
    if (op === 'list') return (await lib.listProjects()).map((m) => ({ id: m.id, name: m.name, fileName: m.fileName, updated: m.updated, created: m.created, width: m.width, height: m.height, artboards: m.artboards, objects: m.objects, bytes: m.bytes }));
    if (op === 'save') {
      const s = getState();
      const m = await lib.saveProject(s.doc, { fileName: s.fileName, name: p.name });
      return m ? { saved: m.id, name: m.name } : { saved: null };
    }
    if (op === 'open') {
      const doc = await lib.loadProject(String(p.id));
      if (!doc) throw new Error('Unknown project id');
      const s = getState();
      if (s.dirty && lib.shouldPersist(s.doc)) await lib.saveProject(s.doc, { fileName: s.fileName });
      const { loadDocument: load } = await import('@/io/fileOps');
      load(doc, { fileName: lib.getProjectMeta(String(p.id))?.fileName ?? null, remember: false, dirty: false });
      fitArtboard();
      void lib.touchProject(String(p.id));
      return mcpApi.status({});
    }
    if (op === 'delete') {
      await lib.deleteProject(String(p.id));
      return { ok: true };
    }
    if (op === 'rename') {
      await lib.renameProject(String(p.id), String(p.name ?? ''));
      return { ok: true };
    }
    if (op === 'home') {
      const { useHomeStore } = await import('@/home/store');
      useHomeStore.getState().setOpen(!!(p.open ?? true), p.section);
      return { open: useHomeStore.getState().open };
    }
    throw new Error('op must be list | save | open | delete | rename | home');
  },
  ping() {
    return { pong: true, time: Date.now(), title: document.title, url: location.href };
  },
};

export function isEditableNode(id: ID): boolean {
  return isEditable(getState().doc, id);
}

export { newId, descendants, setState };
