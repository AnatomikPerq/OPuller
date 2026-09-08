/**
 * OPuller MCP server.
 *
 * Exposes the running OPuller editor (browser tab) to AI assistants through the
 * Model Context Protocol. The editor connects to this process over a local
 * WebSocket (ws://127.0.0.1:5187, see src/mcp/bridge.ts); every MCP tool call is
 * forwarded to the page and the result is returned to the assistant.
 *
 * Run:   node mcp/server.ts          (stdio transport; Node >= 22.6 with type stripping)
 * Claude Code picks it up from .mcp.json in the repository root.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.OPULLER_BRIDGE_PORT ?? 5187);
const EDITOR_URL = process.env.OPULLER_URL ?? 'http://localhost:5180';
const CALL_TIMEOUT = 60_000;
const WAIT_FOR_EDITOR = 15_000;

interface Session {
  ws: WebSocket;
  id: string;
  title: string;
  url: string;
  methods: string[];
  connectedAt: number;
}

const sessions = new Map<WebSocket, Session>();
let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const waiters: Array<() => void> = [];

function log(...args: unknown[]): void {
  console.error('[opuller-mcp]', ...args);
}

function activeSession(): Session | null {
  let best: Session | null = null;
  for (const s of sessions.values()) if (!best || s.connectedAt > best.connectedAt) best = s;
  return best;
}

let wss: WebSocketServer | null = null;
let wsError: string | null = null;

function startWebSocketServer(): void {
  try {
    wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
  } catch (err: any) {
    wsError = String(err?.message ?? err);
    log('WebSocket server failed:', wsError);
    return;
  }
  wss.on('error', (err) => {
    wsError = String((err as Error).message ?? err);
    log('WebSocket server error:', wsError);
  });
  wss.on('listening', () => log(`bridge listening on ws://127.0.0.1:${PORT}`));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        sessions.set(ws, { ws, id: msg.session?.id ?? String(seq++), title: msg.session?.title ?? 'OPuller', url: msg.session?.url ?? '', methods: msg.methods ?? [], connectedAt: Date.now() });
        log(`editor connected: ${msg.session?.title} (${sessions.size} session${sessions.size === 1 ? '' : 's'})`);
        for (const w of waiters.splice(0)) w();
        return;
      }
      if (msg.type === 'response' && typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
      }
    });
    ws.on('close', () => {
      const s = sessions.get(ws);
      sessions.delete(ws);
      if (s) log(`editor disconnected: ${s.title}`);
    });
  });
}

async function waitForEditor(ms: number): Promise<Session> {
  const s = activeSession();
  if (s) return s;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
  const s2 = activeSession();
  if (!s2) {
    throw new Error(
      `No OPuller editor is connected.${wsError ? ` (bridge error: ${wsError})` : ''} Open ${EDITOR_URL} in a browser (start it with "npm run dev" in the OPuller folder). The page connects to ws://127.0.0.1:${PORT} automatically; check Window > AI Bridge (MCP) is enabled.`,
    );
  }
  return s2;
}

async function call<T = any>(method: string, params: Record<string, unknown> = {}, timeout = CALL_TIMEOUT): Promise<T> {
  const session = await waitForEditor(WAIT_FOR_EDITOR);
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Editor did not answer "${method}" within ${timeout / 1000}s`));
    }, timeout);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      session.ws.send(JSON.stringify({ type: 'request', id, method, params }));
    } catch (err: any) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Failed to send to the editor: ${err?.message ?? err}`));
    }
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'opuller', version: '0.1.0' }, { instructions: INSTRUCTIONS() });

function INSTRUCTIONS(): string {
  return [
    'OPuller is a vector graphics editor (Illustrator-class) running in the browser. These tools drive the live editor.',
    'Coordinates are world units (px); artboard 1 usually starts at (0,0). Use opuller_status first to learn the artboards, then create objects with opuller_create_shape / opuller_create_path / opuller_create_text,',
    'combine them with opuller_pathfinder (unite, minusFront, intersect, exclude, divide...), style them with opuller_update_nodes (fill/stroke/opacity/effects), and verify visually with opuller_screenshot or opuller_render_png.',
    'Every menu command is available through opuller_run_command (list with opuller_list_commands) and every tool through opuller_gesture / opuller_click (mouse gestures in world coordinates).',
    'Each editing call is one undo step; opuller_undo reverts mistakes.',
  ].join('\n');
}

const MAX_TEXT = 200_000;

function text(v: unknown): { content: Array<{ type: 'text'; text: string }> } {
  let s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT) + `\n… (truncated, ${s.length} chars total)`;
  return { content: [{ type: 'text', text: s }] };
}

function image(dataUrl: string, extra?: string) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Unexpected image data');
  const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [{ type: 'image', data: m[2], mimeType: m[1] }];
  if (extra) content.push({ type: 'text', text: extra });
  return { content };
}

async function writeDataUrl(dataUrl: string, file: string): Promise<string> {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Unexpected image data');
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(m[2], 'base64'));
  return abs;
}

const paintSchema = z
  .union([
    z.string().describe('"#rrggbb", a colour name, or "none"'),
    z.null(),
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('solid'), color: z.string(), opacity: z.number().optional() }),
    z.object({
      type: z.literal('linear'),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      stops: z.array(z.object({ offset: z.number(), color: z.string(), opacity: z.number().optional() })),
      spread: z.enum(['pad', 'reflect', 'repeat']).optional(),
    }),
    z.object({
      type: z.literal('radial'),
      cx: z.number().optional(),
      cy: z.number().optional(),
      r: z.number().optional(),
      fx: z.number().optional(),
      fy: z.number().optional(),
      stops: z.array(z.object({ offset: z.number(), color: z.string(), opacity: z.number().optional() })),
      spread: z.enum(['pad', 'reflect', 'repeat']).optional(),
    }),
  ])
  .describe('Paint: "#rrggbb" | "none" | {type:"solid",color,opacity} | {type:"linear"|"radial", stops:[{offset,color,opacity}], x1..y2 / cx,cy,r in 0..1 bounding-box units}');

const strokeSchema = z
  .union([
    z.string(),
    z.null(),
    z.object({
      color: z.string().optional(),
      paint: paintSchema.optional(),
      width: z.number().optional(),
      cap: z.enum(['butt', 'round', 'square']).optional(),
      join: z.enum(['miter', 'round', 'bevel']).optional(),
      miterLimit: z.number().optional(),
      dash: z.array(z.number()).optional(),
      dashOffset: z.number().optional(),
      align: z.enum(['center', 'inside', 'outside']).optional(),
      markerStart: z.enum(['none', 'arrow', 'triangle', 'circle', 'square', 'bar', 'diamond', 'open-arrow']).optional(),
      markerEnd: z.enum(['none', 'arrow', 'triangle', 'circle', 'square', 'bar', 'diamond', 'open-arrow']).optional(),
      markerScale: z.number().optional(),
    }),
  ])
  .describe('Stroke: "#rrggbb" | "none" | {color|paint, width, cap, join, dash:[on,off], markerStart/End}');

const idsSchema = z.array(z.string()).optional().describe('Node ids; defaults to the current selection');

// ---- state ------------------------------------------------------------------

server.registerTool('opuller_status', { title: 'Editor status', description: 'Document summary (artboards, layers), selection, active tool, view and history state. Call this first.' }, async () => text(await call('status')));

server.registerTool('opuller_list_tools', { title: 'List tools', description: 'All canvas tools (id, name, shortcut, group, hint, default options). Use ids with opuller_set_tool / opuller_gesture.' }, async () => text(await call('listTools')));

server.registerTool(
  'opuller_list_commands',
  { title: 'List commands', description: 'All menu commands (id, label, menu path, shortcut, enabled). Filter by menu prefix such as "Object/Path".', inputSchema: { menu: z.string().optional() } },
  async ({ menu }) => text(await call('listCommands', { menu })),
);

server.registerTool(
  'opuller_run_command',
  { title: 'Run command', description: 'Run any menu command by id (see opuller_list_commands), e.g. "object.group", "pathfinder.unite", "path.offset", "type.createOutlines", "view.fitArtboard".', inputSchema: { id: z.string(), arg: z.unknown().optional() } },
  async ({ id, arg }) => text(await call('runCommand', { id, arg })),
);

server.registerTool(
  'opuller_set_tool',
  { title: 'Activate tool', description: 'Activate a canvas tool by id (select, direct, pen, pencil, brush, rect, ellipse, polygon, star, line, text, rotate, scale, shapebuilder, gradient, eyedropper, scissors, knife, width, artboard, ...) and optionally set its options.', inputSchema: { id: z.string(), options: z.record(z.string(), z.unknown()).optional() } },
  async ({ id, options }) => text(await call('setTool', { id, options })),
);

// ---- document ---------------------------------------------------------------

server.registerTool(
  'opuller_get_tree',
  { title: 'Document tree', description: 'Layers and objects as a nested summary (id, type, name, bounds, fill/stroke, text...).', inputSchema: { depth: z.number().optional().describe('nesting depth (default 10)'), bounds: z.boolean().optional().describe('include world bounds (default true)') } },
  async ({ depth, bounds }) => text(await call('getTree', { depth, bounds })),
);

server.registerTool('opuller_get_node', { title: 'Get node', description: 'Full JSON of one node plus its world bounds and (for paths) SVG path data "d" in world coordinates.', inputSchema: { id: z.string() } }, async ({ id }) => text(await call('getNode', { id })));

server.registerTool(
  'opuller_find_nodes',
  { title: 'Find nodes', description: 'Find objects by name (regex), type (path|text|image|group) or contained text.', inputSchema: { name: z.string().optional(), type: z.enum(['path', 'text', 'image', 'group']).optional(), text: z.string().optional() } },
  async (p) => text(await call('findNodes', p)),
);

server.registerTool('opuller_get_document', { title: 'Get document JSON', description: 'The complete document model (can be large).' }, async () => text(await call('getDocument')));

server.registerTool(
  'opuller_select',
  { title: 'Select', description: 'Set the selection: ids (replace/add/remove), all, or none.', inputSchema: { ids: z.array(z.string()).optional(), mode: z.enum(['replace', 'add', 'remove']).optional(), all: z.boolean().optional(), none: z.boolean().optional() } },
  async (p) => text(await call('select', p)),
);

// ---- create -----------------------------------------------------------------

server.registerTool(
  'opuller_create_shape',
  {
    title: 'Create shape',
    description: 'Create a live shape. rect: x,y,width,height[,radius]; ellipse/circle: cx,cy,rx,ry (or r); polygon: cx,cy,radius,sides; star: cx,cy,outerRadius,innerRadius,points; line: x1,y1,x2,y2. fill/stroke default to the current appearance.',
    inputSchema: {
      kind: z.enum(['rect', 'ellipse', 'circle', 'polygon', 'star', 'line']),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      cx: z.number().optional(),
      cy: z.number().optional(),
      r: z.number().optional(),
      rx: z.number().optional(),
      ry: z.number().optional(),
      radius: z.number().optional(),
      radii: z.array(z.number()).length(4).optional().describe('rect corner radii [tl,tr,br,bl]'),
      sides: z.number().optional(),
      points: z.number().optional(),
      outerRadius: z.number().optional(),
      innerRadius: z.number().optional(),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      rotation: z.number().optional().describe('degrees'),
      fill: paintSchema.optional(),
      stroke: strokeSchema.optional(),
      opacity: z.number().optional(),
      name: z.string().optional(),
      parent: z.string().optional().describe('layer or group id (default: active layer)'),
      select: z.boolean().optional(),
    },
  },
  async (p) => text(await call('createShape', p)),
);

server.registerTool(
  'opuller_create_path',
  {
    title: 'Create path',
    description: 'Create a path from SVG path data (M/L/C/Q/A/Z...). Coordinates are world units unless x/y/scale offsets are given.',
    inputSchema: { d: z.string(), x: z.number().optional(), y: z.number().optional(), scale: z.number().optional(), closed: z.boolean().optional(), fill: paintSchema.optional(), stroke: strokeSchema.optional(), fillRule: z.enum(['nonzero', 'evenodd']).optional(), opacity: z.number().optional(), name: z.string().optional(), parent: z.string().optional(), select: z.boolean().optional() },
  },
  async (p) => text(await call('createPath', p)),
);

server.registerTool(
  'opuller_create_text',
  {
    title: 'Create text',
    description: 'Create point text (x,y = start of the baseline) or area text (with width/height). Fonts available: Inter, Roboto, Open Sans, Montserrat, Playfair Display, Lora, Oswald, Source Code Pro, Pacifico, Bebas Neue, Raleway, Merriweather, Poppins, Nunito (+ system fonts).',
    inputSchema: {
      text: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().optional(),
      fontWeight: z.number().optional(),
      fontStyle: z.enum(['normal', 'italic']).optional(),
      lineHeight: z.number().optional(),
      letterSpacing: z.number().optional(),
      textAlign: z.enum(['left', 'center', 'right', 'justify']).optional(),
      kind: z.enum(['point', 'area']).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      fill: paintSchema.optional(),
      stroke: strokeSchema.optional(),
      name: z.string().optional(),
      parent: z.string().optional(),
      select: z.boolean().optional(),
    },
  },
  async (p) => text(await call('createText', p)),
);

server.registerTool(
  'opuller_place_svg',
  { title: 'Place SVG', description: 'Import SVG markup (or an SVG file path) into the document as editable objects.', inputSchema: { svg: z.string().optional(), file: z.string().optional(), x: z.number().optional().describe('centre x'), y: z.number().optional().describe('centre y'), fit: z.boolean().optional(), name: z.string().optional(), select: z.boolean().optional() } },
  async (p) => {
    let svg = p.svg;
    if (!svg && p.file) svg = await fs.readFile(path.resolve(p.file), 'utf8');
    if (!svg) throw new Error('Give svg markup or a file path');
    return text(await call('placeSvg', { ...p, svg }));
  },
);

server.registerTool(
  'opuller_place_image',
  { title: 'Place image', description: 'Place a raster image from a file path, http(s) URL or data URL.', inputSchema: { file: z.string().optional(), url: z.string().optional(), dataUrl: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), name: z.string().optional() } },
  async (p) => {
    let dataUrl = p.dataUrl;
    if (!dataUrl && p.file) {
      const abs = path.resolve(p.file);
      const buf = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    }
    return text(await call('placeImage', { ...p, dataUrl }));
  },
);

// ---- edit -------------------------------------------------------------------

server.registerTool(
  'opuller_update_nodes',
  {
    title: 'Update nodes',
    description: 'Patch properties of nodes: fill, stroke, opacity (0..1), blendMode, name, visible, locked, effects (array), text, style (text style), shape (live shape params), d (path data), data. Deep-merges objects.',
    inputSchema: { ids: idsSchema, patch: z.record(z.string(), z.unknown()), label: z.string().optional().describe('history label') },
  },
  async (p) => text(await call('updateNodes', p)),
);

server.registerTool('opuller_set_path_data', { title: 'Set path data', description: 'Replace the geometry of a path with SVG path data in world coordinates.', inputSchema: { id: z.string(), d: z.string() } }, async (p) => text(await call('setPathData', p)));

server.registerTool(
  'opuller_transform',
  {
    title: 'Transform',
    description: 'Move / scale / rotate nodes (default: selection). scale can be a number or {x,y}; rotate in degrees; origin defaults to the selection centre.',
    inputSchema: { ids: idsSchema, translate: z.object({ x: z.number(), y: z.number() }).optional(), scale: z.union([z.number(), z.object({ x: z.number(), y: z.number().optional() })]).optional(), rotate: z.number().optional(), origin: z.object({ x: z.number(), y: z.number() }).optional(), matrix: z.object({ a: z.number(), b: z.number(), c: z.number(), d: z.number(), e: z.number(), f: z.number() }).optional() },
  },
  async (p) => text(await call('transform', p)),
);

server.registerTool('opuller_set_bounds', { title: 'Set bounds', description: 'Move/resize one node by its world bounding box (any of x, y, width, height).', inputSchema: { id: z.string(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional() } }, async (p) => text(await call('setBounds', p)));

server.registerTool('opuller_delete_nodes', { title: 'Delete nodes', description: 'Delete nodes (default: selection).', inputSchema: { ids: idsSchema } }, async (p) => text(await call('deleteNodes', p)));

server.registerTool('opuller_duplicate', { title: 'Duplicate', description: 'Duplicate nodes with an optional offset; the copies become the selection.', inputSchema: { ids: idsSchema, dx: z.number().optional(), dy: z.number().optional() } }, async (p) => text(await call('duplicate', p)));

server.registerTool('opuller_group', { title: 'Group', description: 'Group nodes (default: selection).', inputSchema: { ids: idsSchema } }, async (p) => text(await call('group', p)));
server.registerTool('opuller_ungroup', { title: 'Ungroup', description: 'Ungroup groups (default: selection).', inputSchema: { ids: idsSchema } }, async (p) => text(await call('ungroup', p)));

server.registerTool('opuller_arrange', { title: 'Arrange', description: 'Change stacking order: front | back | forward | backward.', inputSchema: { ids: idsSchema, op: z.enum(['front', 'back', 'forward', 'backward']) } }, async (p) => text(await call('arrange', p)));

server.registerTool('opuller_move_to_layer', { title: 'Move to layer', description: 'Move nodes into a layer or group.', inputSchema: { ids: idsSchema, layerId: z.string() } }, async (p) => text(await call('moveToLayer', p)));

server.registerTool(
  'opuller_pathfinder',
  { title: 'Pathfinder', description: 'Combine paths: unite, minusFront (top shapes cut from the bottom one), intersect, exclude, minusBack, divide, trim, merge, crop, outline. Works on ids or the selection; returns the resulting nodes.', inputSchema: { op: z.enum(['unite', 'minusFront', 'intersect', 'exclude', 'minusBack', 'divide', 'trim', 'merge', 'crop', 'outline']), ids: idsSchema } },
  async (p) => text(await call('pathfinder', p)),
);

server.registerTool('opuller_set_appearance', { title: 'Set default appearance', description: 'Set the fill/stroke/text style used for NEW objects (and for the selection when the UI applies it).', inputSchema: { fill: paintSchema.optional(), stroke: strokeSchema.optional(), textStyle: z.record(z.string(), z.unknown()).optional() } }, async (p) => text(await call('setAppearance', p)));

// ---- history / document -----------------------------------------------------

server.registerTool('opuller_undo', { title: 'Undo', description: 'Undo one or more steps.', inputSchema: { steps: z.number().optional() } }, async (p) => text(await call('undo', p)));
server.registerTool('opuller_redo', { title: 'Redo', description: 'Redo one or more steps.', inputSchema: { steps: z.number().optional() } }, async (p) => text(await call('redo', p)));
server.registerTool('opuller_history', { title: 'History', description: 'Undo/redo stack labels.' }, async () => text(await call('history')));

server.registerTool(
  'opuller_new_document',
  { title: 'New document', description: 'Replace the current document with a new one (unsaved changes are lost).', inputSchema: { name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), artboards: z.number().optional(), units: z.enum(['px', 'pt', 'mm', 'cm', 'in']).optional(), background: z.string().optional(), transparent: z.boolean().optional() } },
  async (p) => text(await call('newDocument', p)),
);

server.registerTool('opuller_save_project', { title: 'Save project file', description: 'Write the document as an OPuller project (.opuller JSON) to a file path on this machine.', inputSchema: { file: z.string() } }, async ({ file }) => {
  const r = await call<{ json: string }>('getProject');
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, r.json, 'utf8');
  return text({ saved: abs, bytes: r.json.length });
});

server.registerTool('opuller_load_project', { title: 'Load project file', description: 'Load an OPuller project (.opuller JSON) or SVG-free JSON from a file path, replacing the document.', inputSchema: { file: z.string() } }, async ({ file }) => {
  const abs = path.resolve(file);
  const json = await fs.readFile(abs, 'utf8');
  return text(await call('loadProject', { json, fileName: path.basename(abs) }));
});

server.registerTool(
  'opuller_artboards',
  { title: 'Artboards', description: 'List artboards, or add / update / remove / activate one.', inputSchema: { op: z.enum(['list', 'add', 'update', 'remove', 'activate']).optional(), id: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), background: z.string().optional(), transparent: z.boolean().optional(), patch: z.record(z.string(), z.unknown()).optional() } },
  async (p) => text(await call('artboards', p)),
);

// ---- output -----------------------------------------------------------------

server.registerTool(
  'opuller_export_svg',
  { title: 'Export SVG', description: 'Export the artboard, the selection, given ids or the whole document as SVG text; optionally write it to a file.', inputSchema: { scope: z.enum(['artboard', 'artboards', 'selection', 'document']).optional(), ids: z.array(z.string()).optional(), artboardId: z.string().optional(), file: z.string().optional(), pretty: z.boolean().optional(), margin: z.number().optional() } },
  async (p) => {
    const r = await call<{ svg: string }>('exportSvg', p);
    if (p.file) {
      const abs = path.resolve(p.file);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, r.svg, 'utf8');
      return text({ saved: abs, ...r, svg: r.svg.length > 4000 ? r.svg.slice(0, 4000) + '…' : r.svg });
    }
    return text(r.svg);
  },
);

server.registerTool(
  'opuller_render_png',
  { title: 'Render PNG', description: 'Rasterise the artboard / selection / document and return it as an image (optionally also written to a file). Use it to look at the result of your edits.', inputSchema: { scope: z.enum(['artboard', 'selection', 'document']).optional(), ids: z.array(z.string()).optional(), artboardId: z.string().optional(), scale: z.number().optional().describe('pixels per unit (default 1; keep the image below ~1500px)'), width: z.number().optional(), background: z.string().nullable().optional(), margin: z.number().optional(), file: z.string().optional() } },
  async (p) => {
    const r = await call<{ dataUrl: string; width: number; height: number }>('renderPng', p);
    let note = `${r.width}×${r.height}px`;
    if (p.file) note += `, saved to ${await writeDataUrl(r.dataUrl, p.file)}`;
    return image(r.dataUrl, note);
  },
);

server.registerTool('opuller_screenshot', { title: 'Screenshot', description: 'Render the region currently visible in the editor viewport (what the user sees, without UI) as an image.', inputSchema: { maxWidth: z.number().optional(), file: z.string().optional() } }, async (p) => {
  const r = await call<{ dataUrl: string; width: number; height: number; world: unknown }>('screenshot', p);
  let note = `${r.width}×${r.height}px, world region ${JSON.stringify(r.world)}`;
  if (p.file) note += `, saved to ${await writeDataUrl(r.dataUrl, p.file)}`;
  return image(r.dataUrl, note);
});

server.registerTool(
  'opuller_zoom',
  { title: 'Zoom / fit', description: 'Fit the artboard, everything or the selection; or set zoom (1 = 100%) around a world centre; or zoom to a world rect.', inputSchema: { fit: z.enum(['artboard', 'all', 'selection']).optional(), zoom: z.number().optional(), center: z.object({ x: z.number(), y: z.number() }).optional(), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(), padding: z.number().optional() } },
  async (p) => text(await call('zoom', p)),
);

server.registerTool('opuller_view', { title: 'View settings', description: 'Toggle view settings: rulers, grid, guides, snapToGrid, snapToPoint, smartGuides, snapToPixel, outline, showAnchors, showBounds, showArtboards, transparencyGrid.', inputSchema: { patch: z.record(z.string(), z.boolean()) } }, async (p) => text(await call('view', p)));

server.registerTool('opuller_prefs', { title: 'Preferences', description: 'Read or patch preferences (units, nudge, snapTolerance, theme, scaleStrokes, handleSize, ...).', inputSchema: { patch: z.record(z.string(), z.unknown()).optional() } }, async (p) => text(await call('prefs', p)));

// ---- simulate ---------------------------------------------------------------

server.registerTool(
  'opuller_gesture',
  {
    title: 'Mouse gesture',
    description: 'Simulate a pointer drag on the canvas in world coordinates (pointerdown at the first point, moves through the others, pointerup at the last). Optionally activate a tool first. Modifiers: shift, alt, ctrl/mod. This drives any tool exactly like a user (pen clicks, shape builder drags, knife cuts, marquee selection...).',
    inputSchema: { points: z.array(z.object({ x: z.number(), y: z.number() })).min(1), tool: z.string().optional(), options: z.record(z.string(), z.unknown()).optional(), modifiers: z.array(z.string()).optional(), button: z.number().optional(), steps: z.number().optional().describe('intermediate moves per segment (default 6)'), keepDown: z.boolean().optional(), delay: z.number().optional() },
  },
  async (p) => text(await call('gesture', p)),
);

server.registerTool('opuller_click', { title: 'Click', description: 'Click (or double-click with count=2) at a world position, optionally with a tool and modifiers.', inputSchema: { x: z.number(), y: z.number(), tool: z.string().optional(), options: z.record(z.string(), z.unknown()).optional(), modifiers: z.array(z.string()).optional(), count: z.number().optional(), button: z.number().optional() } }, async (p) => text(await call('click', p)));

server.registerTool('opuller_hover', { title: 'Hover', description: 'Move the pointer to a world position (updates hover state / cursor).', inputSchema: { x: z.number(), y: z.number(), modifiers: z.array(z.string()).optional() } }, async (p) => text(await call('hover', p)));

server.registerTool('opuller_key', { title: 'Key press', description: 'Press keyboard shortcuts, e.g. ["mod+z"], ["Escape"], ["Enter"], ["shift+m"], ["Delete"].', inputSchema: { keys: z.array(z.string()), modifiers: z.array(z.string()).optional() } }, async (p) => text(await call('key', p)));

server.registerTool('opuller_type_text', { title: 'Set text content', description: 'Append or replace the text of a text object (default: the edited/selected one).', inputSchema: { id: z.string().optional(), text: z.string(), replace: z.boolean().optional() } }, async (p) => text(await call('typeText', p)));

server.registerTool(
  'opuller_eval',
  { title: 'Evaluate script', description: 'Advanced: run JavaScript inside the editor page. Available: api (window.__opuller: store, runCommand, worldBounds, api.{document,nodes,path,paper}), store (zustand), getState(), runCommand(id), helpers. Use `return` to send a value back. Edits must go through getState().updateDoc(draft => ..., "Label").', inputSchema: { code: z.string() } },
  async (p) => text(await call('eval', p)),
);

server.registerTool('opuller_toast', { title: 'Toast', description: 'Show a message to the user in the editor.', inputSchema: { message: z.string(), kind: z.enum(['info', 'success', 'error']).optional() } }, async (p) => text(await call('toast', p)));

// ---- resources / prompts ----------------------------------------------------

server.registerResource('status', 'opuller://status', { title: 'Editor status', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await call('status'), null, 2) }] }));
server.registerResource('tree', 'opuller://tree', { title: 'Document tree', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await call('getTree', {}), null, 2) }] }));
server.registerResource('svg', 'opuller://svg', { title: 'Active artboard as SVG', mimeType: 'image/svg+xml' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/svg+xml', text: (await call<{ svg: string }>('exportSvg', { scope: 'artboard' })).svg }] }));

server.registerPrompt(
  'opuller_guide',
  { title: 'How to work with OPuller', description: 'A short guide for drawing with the OPuller tools.', argsSchema: { task: z.string().optional() } },
  ({ task }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            'You are driving the OPuller vector editor through MCP tools.',
            'Workflow: opuller_status → plan coordinates on the artboard → create objects (opuller_create_shape/path/text) → combine (opuller_pathfinder) → style (opuller_update_nodes) → verify (opuller_screenshot / opuller_render_png) → fix with opuller_undo if needed.',
            'Example — a bird from circles: create overlapping circles for the body, head and wings, subtract circles (minusFront) to carve the wing edges, unite the remaining pieces, set fill to #1da1f2 and stroke to none.',
            task ? `Task: ${task}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    ],
  }),
);

// ---------------------------------------------------------------------------

startWebSocketServer();
const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP server ready (stdio)');
