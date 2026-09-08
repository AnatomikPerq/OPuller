/**
 * Global editor store (zustand). The document is immutable; edits go through
 * `updateDoc(fn)` which uses immer. History is snapshot based (structural sharing
 * keeps it cheap): call `commit(label)` after a gesture to record an undo step.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { produce, enableMapSet } from 'immer';
import type { Document, ID, AnchorRef, Paint, StrokeStyle, TextStyle, Vec, Units, HandleRef } from '@/model/types';
import { createDocument } from '@/model/nodes';
import { DEFAULT_FILL, defaultStroke, defaultTextStyle } from '@/model/defaults';
import { touch } from '@/model/document';

enableMapSet();

export interface HistoryEntry {
  doc: Document;
  selection: ID[];
  label: string;
}

export interface ViewSettings {
  rulers: boolean;
  grid: boolean;
  guides: boolean;
  snapToGrid: boolean;
  snapToPoint: boolean;
  snapToGuides: boolean;
  smartGuides: boolean;
  snapToPixel: boolean;
  outline: boolean;
  showAnchors: boolean;
  showBounds: boolean;
  showArtboards: boolean;
  lockGuides: boolean;
  transparencyGrid: boolean;
}

export interface Preferences {
  units: Units;
  nudge: number;
  bigNudge: number;
  snapTolerance: number;
  theme: 'dark' | 'light';
  uiScale: number;
  scaleStrokes: boolean;
  autosave: boolean;
  cornerRadius: number;
  handleSize: number;
  language: 'en' | 'ru';
  constrainAngle: number;
  showTooltips: boolean;
  canvasColor: string;
}

export interface DialogState {
  type: string;
  props?: Record<string, unknown>;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface ContextMenuItem {
  label?: string;
  separator?: boolean;
  disabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  onSelect?: () => void;
  children?: ContextMenuItem[];
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

export interface Appearance {
  fill: Paint;
  stroke: StrokeStyle;
  textStyle: TextStyle;
}

export interface EditorState {
  doc: Document;
  /** doc at the last commit */
  historyBase: Document;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** incremented on every doc change; handy for effects */
  docVersion: number;
  /** filename / handle for save */
  fileName: string | null;
  fileHandle: FileSystemFileHandle | null;
  dirty: boolean;

  // selection
  selection: ID[];
  selectedAnchors: AnchorRef[];
  selectedHandle: HandleRef | null;
  hoverId: ID | null;
  editingTextId: ID | null;
  /** Isolation mode: only this group's contents are editable */
  isolationId: ID | null;
  activeArtboardId: ID | null;
  activeLayerId: ID | null;

  // viewport
  zoom: number;
  pan: Vec;
  viewportSize: { width: number; height: number };

  // tools
  activeTool: string;
  previousTool: string | null;
  /** temporary tool override (space = hand, etc.) */
  temporaryTool: string | null;
  toolOptions: Record<string, Record<string, unknown>>;
  /** bumps when a tool wants the overlay re-rendered */
  overlayTick: number;
  cursor: string;

  view: ViewSettings;
  prefs: Preferences;
  /** appearance for new objects / shown when nothing is selected */
  appearance: Appearance;
  activePaintTarget: 'fill' | 'stroke';
  /** currently edited gradient stop index (Gradient panel / tool) */
  activeGradientStop: number;

  // ui
  panels: Record<string, boolean>;
  panelLayout: string[][];
  dialog: DialogState | null;
  contextMenu: ContextMenuState | null;
  toasts: Toast[];
  status: string;
  rightDockWidth: number;
  leftDockCollapsed: boolean;

  // actions
  setDocument: (doc: Document, opts?: { fileName?: string | null; handle?: FileSystemFileHandle | null }) => void;
  updateDoc: (fn: (draft: Document) => void, commitLabel?: string) => void;
  replaceDoc: (doc: Document, commitLabel?: string) => void;
  commit: (label: string) => void;
  /** discard uncommitted changes (e.g. cancel a drag) */
  revert: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;

  setSelection: (ids: ID[], anchors?: AnchorRef[]) => void;
  addToSelection: (ids: ID[]) => void;
  toggleSelection: (id: ID) => void;
  removeFromSelection: (ids: ID[]) => void;
  clearSelection: () => void;
  setSelectedAnchors: (anchors: AnchorRef[]) => void;
  setSelectedHandle: (h: HandleRef | null) => void;
  setHover: (id: ID | null) => void;
  setEditingText: (id: ID | null) => void;
  setIsolation: (id: ID | null) => void;
  setActiveArtboard: (id: ID | null) => void;
  setActiveLayer: (id: ID | null) => void;

  setZoom: (zoom: number, screenAnchor?: Vec) => void;
  setPan: (pan: Vec) => void;
  panBy: (dx: number, dy: number) => void;
  setViewportSize: (w: number, h: number) => void;
  zoomToRect: (rect: { x: number; y: number; width: number; height: number }, padding?: number) => void;

  setTool: (id: string) => void;
  setTemporaryTool: (id: string | null) => void;
  setToolOptions: (tool: string, options: Record<string, unknown>) => void;
  requestOverlay: () => void;
  setCursor: (cursor: string) => void;

  setView: (patch: Partial<ViewSettings>) => void;
  setPrefs: (patch: Partial<Preferences>) => void;
  setAppearance: (patch: Partial<Appearance>) => void;
  setActivePaintTarget: (t: 'fill' | 'stroke') => void;
  setActiveGradientStop: (i: number) => void;

  togglePanel: (id: string, visible?: boolean) => void;
  setPanelLayout: (layout: string[][]) => void;
  openDialog: (type: string, props?: Record<string, unknown>) => void;
  closeDialog: () => void;
  openContextMenu: (menu: ContextMenuState | null) => void;
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setStatus: (s: string) => void;
  setRightDockWidth: (w: number) => void;
  setLeftDockCollapsed: (b: boolean) => void;
}

const MAX_HISTORY = 200;

export const DEFAULT_VIEW: ViewSettings = {
  rulers: true,
  grid: false,
  guides: true,
  snapToGrid: false,
  snapToPoint: true,
  snapToGuides: true,
  smartGuides: true,
  snapToPixel: false,
  outline: false,
  showAnchors: true,
  showBounds: true,
  showArtboards: true,
  lockGuides: false,
  transparencyGrid: false,
};

export const DEFAULT_PREFS: Preferences = {
  units: 'px',
  nudge: 1,
  bigNudge: 10,
  snapTolerance: 6,
  theme: 'dark',
  uiScale: 1,
  scaleStrokes: false,
  autosave: true,
  cornerRadius: 12,
  handleSize: 7,
  language: 'en',
  constrainAngle: 45,
  showTooltips: true,
  canvasColor: '#1e1e21',
};

export const DEFAULT_PANEL_LAYOUT: string[][] = [
  ['properties', 'transform', 'align', 'pathfinder'],
  ['color', 'swatches', 'gradient', 'stroke'],
  ['layers', 'artboards', 'history', 'navigator'],
  ['character', 'paragraph', 'appearance', 'effects'],
];

const PERSIST_KEY = 'opuller.ui.v1';

function loadPersisted(): Partial<Pick<EditorState, 'toolOptions' | 'view' | 'prefs' | 'panels' | 'panelLayout' | 'rightDockWidth'>> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return {
      toolOptions: data.toolOptions ?? {},
      view: { ...DEFAULT_VIEW, ...(data.view ?? {}) },
      prefs: { ...DEFAULT_PREFS, ...(data.prefs ?? {}) },
      panels: data.panels ?? {},
      panelLayout: Array.isArray(data.panelLayout) ? data.panelLayout : DEFAULT_PANEL_LAYOUT,
      rightDockWidth: data.rightDockWidth ?? 300,
    };
  } catch {
    return {};
  }
}

let toastSeq = 1;

export const useStore = create<EditorState>()(
  subscribeWithSelector((set, get) => {
    const persisted = loadPersisted();
    const initialDoc = createDocument();
    return {
      doc: initialDoc,
      historyBase: initialDoc,
      past: [],
      future: [],
      docVersion: 0,
      fileName: null,
      fileHandle: null,
      dirty: false,

      selection: [],
      selectedAnchors: [],
      selectedHandle: null,
      hoverId: null,
      editingTextId: null,
      isolationId: null,
      activeArtboardId: initialDoc.artboards[0]?.id ?? null,
      activeLayerId: initialDoc.layers[0] ?? null,

      zoom: 1,
      pan: { x: 0, y: 0 },
      viewportSize: { width: 1200, height: 800 },

      activeTool: 'select',
      previousTool: null,
      temporaryTool: null,
      toolOptions: persisted.toolOptions ?? {},
      overlayTick: 0,
      cursor: 'default',

      view: persisted.view ?? { ...DEFAULT_VIEW },
      prefs: persisted.prefs ?? { ...DEFAULT_PREFS },
      appearance: { fill: { ...DEFAULT_FILL }, stroke: defaultStroke(), textStyle: defaultTextStyle() },
      activePaintTarget: 'fill',
      activeGradientStop: 0,

      panels: persisted.panels ?? {},
      panelLayout: persisted.panelLayout ?? DEFAULT_PANEL_LAYOUT,
      dialog: null,
      contextMenu: null,
      toasts: [],
      status: '',
      rightDockWidth: persisted.rightDockWidth ?? 300,
      leftDockCollapsed: false,

      setDocument: (doc, opts) =>
        set({
          doc,
          historyBase: doc,
          past: [],
          future: [],
          docVersion: get().docVersion + 1,
          selection: [],
          selectedAnchors: [],
          selectedHandle: null,
          hoverId: null,
          editingTextId: null,
          isolationId: null,
          activeArtboardId: doc.artboards[0]?.id ?? null,
          activeLayerId: doc.layers[doc.layers.length - 1] ?? null,
          fileName: opts?.fileName ?? null,
          fileHandle: opts?.handle ?? null,
          dirty: false,
        }),

      updateDoc: (fn, commitLabel) => {
        const s = get();
        const next = produce(s.doc, (draft) => {
          fn(draft);
          touch(draft);
        });
        if (next === s.doc) return;
        const patch: Partial<EditorState> = { doc: next, docVersion: s.docVersion + 1, dirty: true };
        // prune selection of removed nodes
        if (s.selection.some((id) => !next.nodes[id])) patch.selection = s.selection.filter((id) => !!next.nodes[id]);
        if (s.selectedAnchors.some((a) => !next.nodes[a.nodeId])) patch.selectedAnchors = s.selectedAnchors.filter((a) => !!next.nodes[a.nodeId]);
        if (s.hoverId && !next.nodes[s.hoverId]) patch.hoverId = null;
        if (s.editingTextId && !next.nodes[s.editingTextId]) patch.editingTextId = null;
        if (s.activeLayerId && !next.nodes[s.activeLayerId]) patch.activeLayerId = next.layers[next.layers.length - 1] ?? null;
        if (s.activeArtboardId && !next.artboards.some((a) => a.id === s.activeArtboardId)) patch.activeArtboardId = next.artboards[0]?.id ?? null;
        set(patch);
        if (commitLabel) get().commit(commitLabel);
      },

      replaceDoc: (doc, commitLabel) => {
        const s = get();
        set({ doc, docVersion: s.docVersion + 1, dirty: true, selection: s.selection.filter((id) => !!doc.nodes[id]) });
        if (commitLabel) get().commit(commitLabel);
      },

      commit: (label) => {
        const s = get();
        if (s.doc === s.historyBase) return;
        const past = s.past.concat([{ doc: s.historyBase, selection: s.selection, label }]);
        if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
        set({ past, future: [], historyBase: s.doc });
      },

      revert: () => {
        const s = get();
        if (s.doc === s.historyBase) return;
        set({ doc: s.historyBase, docVersion: s.docVersion + 1 });
      },

      undo: () => {
        const s = get();
        if (s.doc !== s.historyBase) {
          // uncommitted changes: treat as a step
          get().commit('Edit');
        }
        const st = get();
        const entry = st.past[st.past.length - 1];
        if (!entry) return;
        const future = st.future.concat([{ doc: st.doc, selection: st.selection, label: entry.label }]);
        set({
          doc: entry.doc,
          historyBase: entry.doc,
          past: st.past.slice(0, -1),
          future,
          docVersion: st.docVersion + 1,
          selection: entry.selection.filter((id) => !!entry.doc.nodes[id]),
          selectedAnchors: [],
          selectedHandle: null,
          editingTextId: null,
          dirty: true,
        });
      },

      redo: () => {
        const st = get();
        const entry = st.future[st.future.length - 1];
        if (!entry) return;
        const past = st.past.concat([{ doc: st.doc, selection: st.selection, label: entry.label }]);
        set({
          doc: entry.doc,
          historyBase: entry.doc,
          past,
          future: st.future.slice(0, -1),
          docVersion: st.docVersion + 1,
          selection: entry.selection.filter((id) => !!entry.doc.nodes[id]),
          selectedAnchors: [],
          selectedHandle: null,
          editingTextId: null,
          dirty: true,
        });
      },

      markSaved: () => set({ dirty: false }),

      setSelection: (ids, anchors) => {
        const doc = get().doc;
        const valid = Array.from(new Set(ids.filter((id) => !!doc.nodes[id])));
        set({ selection: valid, selectedAnchors: anchors ?? [], selectedHandle: null });
      },
      addToSelection: (ids) => {
        const doc = get().doc;
        const cur = get().selection;
        const next = cur.concat(ids.filter((id) => !!doc.nodes[id] && !cur.includes(id)));
        set({ selection: next });
      },
      toggleSelection: (id) => {
        const cur = get().selection;
        set({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id]) });
      },
      removeFromSelection: (ids) => set({ selection: get().selection.filter((x) => !ids.includes(x)) }),
      clearSelection: () => set({ selection: [], selectedAnchors: [], selectedHandle: null }),
      setSelectedAnchors: (anchors) => set({ selectedAnchors: anchors, selectedHandle: null }),
      setSelectedHandle: (h) => set({ selectedHandle: h }),
      setHover: (id) => {
        if (get().hoverId !== id) set({ hoverId: id });
      },
      setEditingText: (id) => set({ editingTextId: id }),
      setIsolation: (id) => set({ isolationId: id, selection: [] }),
      setActiveArtboard: (id) => set({ activeArtboardId: id }),
      setActiveLayer: (id) => set({ activeLayerId: id }),

      setZoom: (zoom, screenAnchor) => {
        const s = get();
        const z = Math.min(64, Math.max(0.01, zoom));
        const anchor = screenAnchor ?? { x: s.viewportSize.width / 2, y: s.viewportSize.height / 2 };
        // keep the world point under the anchor fixed
        const wx = (anchor.x - s.pan.x) / s.zoom;
        const wy = (anchor.y - s.pan.y) / s.zoom;
        set({ zoom: z, pan: { x: anchor.x - wx * z, y: anchor.y - wy * z } });
      },
      setPan: (pan) => set({ pan }),
      panBy: (dx, dy) => set({ pan: { x: get().pan.x + dx, y: get().pan.y + dy } }),
      setViewportSize: (width, height) => {
        const cur = get().viewportSize;
        if (cur.width !== width || cur.height !== height) set({ viewportSize: { width, height } });
      },
      zoomToRect: (rect, padding = 40) => {
        const s = get();
        const vw = s.viewportSize.width;
        const vh = s.viewportSize.height;
        const zx = (vw - padding * 2) / Math.max(1, rect.width);
        const zy = (vh - padding * 2) / Math.max(1, rect.height);
        const zoom = Math.min(64, Math.max(0.01, Math.min(zx, zy)));
        const pan = {
          x: vw / 2 - (rect.x + rect.width / 2) * zoom,
          y: vh / 2 - (rect.y + rect.height / 2) * zoom,
        };
        set({ zoom, pan });
      },

      setTool: (id) => {
        const s = get();
        if (s.activeTool === id) return;
        set({ activeTool: id, previousTool: s.activeTool, temporaryTool: null, editingTextId: id === 'text' ? s.editingTextId : null });
      },
      setTemporaryTool: (id) => set({ temporaryTool: id }),
      setToolOptions: (tool, options) => set({ toolOptions: { ...get().toolOptions, [tool]: { ...(get().toolOptions[tool] ?? {}), ...options } } }),
      requestOverlay: () => set({ overlayTick: get().overlayTick + 1 }),
      setCursor: (cursor) => {
        if (get().cursor !== cursor) set({ cursor });
      },

      setView: (patch) => set({ view: { ...get().view, ...patch } }),
      setPrefs: (patch) => set({ prefs: { ...get().prefs, ...patch } }),
      setAppearance: (patch) => set({ appearance: { ...get().appearance, ...patch } }),
      setActivePaintTarget: (t) => set({ activePaintTarget: t }),
      setActiveGradientStop: (i) => set({ activeGradientStop: i }),

      togglePanel: (id, visible) => set({ panels: { ...get().panels, [id]: visible ?? !(get().panels[id] ?? true) } }),
      setPanelLayout: (layout) => set({ panelLayout: layout }),
      openDialog: (type, props) => set({ dialog: { type, props } }),
      closeDialog: () => set({ dialog: null }),
      openContextMenu: (menu) => set({ contextMenu: menu }),
      toast: (message, kind = 'info') => {
        const id = toastSeq++;
        set({ toasts: get().toasts.concat([{ id, message, kind }]) });
        setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000);
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
      setStatus: (status) => {
        if (get().status !== status) set({ status });
      },
      setRightDockWidth: (w) => set({ rightDockWidth: Math.max(220, Math.min(600, w)) }),
      setLeftDockCollapsed: (b) => set({ leftDockCollapsed: b }),
    };
  }),
);

// Persist UI preferences
let persistTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe(
  (s) => [s.toolOptions, s.view, s.prefs, s.panels, s.panelLayout, s.rightDockWidth] as const,
  ([toolOptions, view, prefs, panels, panelLayout, rightDockWidth]) => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        localStorage.setItem(PERSIST_KEY, JSON.stringify({ toolOptions, view, prefs, panels, panelLayout, rightDockWidth }));
      } catch {
        /* ignore */
      }
    }, 300);
  },
);

/** Convenience accessors for non-React code. */
export const getState = useStore.getState;
export const setState = useStore.setState;

export function screenToWorld(p: Vec, s = getState()): Vec {
  return { x: (p.x - s.pan.x) / s.zoom, y: (p.y - s.pan.y) / s.zoom };
}

export function worldToScreen(p: Vec, s = getState()): Vec {
  return { x: p.x * s.zoom + s.pan.x, y: p.y * s.zoom + s.pan.y };
}
