/**
 * Scripting API used by the AI bridge (MCP server) and available as
 * `window.__opuller.mcp`. Every method takes one params object and returns
 * JSON-serialisable data. All coordinates are world units (px).
 */
import type { Document, ID, Node, PathNode, TextNode, Paint, StrokeStyle, LiveShape, Rect, Vec, Matrix, TextStyle, ImageNode } from '@/model/types';
import { isContainer } from '@/model/types';
import { getState, setState, useStore } from '@/store/store';
import { makeShape, makePath, makeText, makeImage, newId } from '@/model/nodes';
import { addNode, removeNode, worldBounds, selectionBounds, applyWorldMatrix, refreshLiveShape, worldSubPaths, setWorldSubPaths, topmostOf, descendants, cloneSubtree, addSubtree, getChildren, moveNode, indexInParent, isEditable } from '@/model/document';
import { translate, scale as scaleM, rotate as rotateM, multiply, compose, identity, applyToPoint } from '@/geometry/matrix';
import { parseSvgPathData, pathToSvgD } from '@/geometry/path';
import { rectUnion } from '@/geometry/vec';
import { allCommands, runCommand, getCommand, isEnabled } from '@/commands/registry';
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

function idsParam(p: Params): ID[] {
  const s = getState();
  if (Array.isArray(p.ids) && p.ids.length) return p.ids.filter((id: ID) => !!s.doc.nodes[id]);
  if (typeof p.id === 'string') return s.doc.nodes[p.id] ? [p.id] : [];
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
    if (p.type === 'solid') return { type: 'solid', color: normalizeHex(p.color ?? '#000000'), opacity: p.opacity ?? 1 };
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
    runCommand(p.id, p.arg);
    return { ok: true, selection: getState().selection, dialog: getState().dialog?.type ?? null };
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
    if (n.type === 'path') out.d = pathToSvgD(worldSubPaths(doc, p.id));
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
    if (p.rotation) m = multiply(m, rotateM(Number(p.rotation)));
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
    if (format === 'pdf') {
      const { exportPdf } = await import('@/io/pdf');
      const { withTextOutlines } = await import('@/io/svgExport');
      const d = p.outlineText ? (await withTextOutlines(s.doc, opts.ids)).doc : s.doc;
      const r = await exportPdf(d, { ...opts, pretty: false });
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { format, base64: btoa(bin), pages: r.pages, name: `${s.doc.name}.pdf` };
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
    if (p.rotate !== undefined) m = multiply(rotateM(Number(p.rotate), origin.x, origin.y), m);
    if (p.matrix) m = multiply(p.matrix as Matrix, m);
    s.updateDoc((d) => {
      for (const id of ids) applyWorldMatrix(d, id, m, true);
    }, p.label ?? 'Transform');
    return ids.map((id) => summary(getState().doc, id, 0, true));
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
  pathfinder(p) {
    const ids = idsParam(p);
    if (ids.length) getState().setSelection(ids);
    const ops = ['unite', 'minusFront', 'intersect', 'exclude', 'minusBack', 'divide', 'trim', 'merge', 'crop', 'outline'];
    if (!ops.includes(p.op)) throw new Error(`op must be one of ${ops.join(', ')}`);
    const before = getState().docVersion;
    runCommand(`pathfinder.${p.op}`);
    const s = getState();
    return { changed: s.docVersion !== before, selection: s.selection, result: s.selection.map((id) => summary(s.doc, id, 1, true)) };
  },
  setAppearance(p) {
    const s = getState();
    const patch: any = {};
    if (p.fill !== undefined) patch.fill = toPaint(p.fill, s.appearance.fill);
    if (p.stroke !== undefined) patch.stroke = toStroke(p.stroke, s.appearance.stroke);
    if (p.textStyle) patch.textStyle = { ...s.appearance.textStyle, ...p.textStyle };
    s.setAppearance(patch);
    return getState().appearance;
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
    // eslint-disable-next-line no-new-func
    const fn = new Function('api', 'store', 'getState', 'runCommand', 'helpers', `return (async () => { ${p.code} })()`);
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
