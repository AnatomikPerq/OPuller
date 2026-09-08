import type { ReactNode, ComponentType } from 'react';
import type { Vec, ID, AnchorRef, HandleRef, Document } from '@/model/types';
import type { EditorState } from '@/store/store';
import type { HitResult, HitOptions } from '@/canvas/hitTest';
import type { SnapResult, SnapOptions, SnapSession } from '@/canvas/snap';

export interface ToolPointerEvent {
  /** world coordinates (unsnapped) */
  world: Vec;
  /** viewport (screen) coordinates in CSS px */
  screen: Vec;
  button: number;
  buttons: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  /** ctrl on Windows/Linux, cmd on macOS */
  primary: boolean;
  pointerId: number;
  pointerType: string;
  pressure: number;
  native: PointerEvent;
}

export interface ToolKeyEvent {
  key: string;
  code: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  primary: boolean;
  repeat: boolean;
  native: KeyboardEvent;
}

export interface ToolContext {
  /** current store state (call each time — it is a snapshot) */
  readonly state: EditorState;
  readonly doc: Document;
  readonly zoom: number;
  /** snap a world point (uses view settings); pass a session for gestures */
  snap(p: Vec, opts?: SnapOptions, session?: SnapSession): SnapResult;
  /** create a snap session with cached candidates for a gesture */
  beginSnap(opts?: SnapOptions): SnapSession;
  hitTest(world: Vec, opts?: Partial<HitOptions>): HitResult | null;
  /** hit test anchors/handles of the given (selected) paths */
  hitTestAnchors(world: Vec, ids: ID[], includeHandles?: boolean): HitResult | null;
  worldToScreen(p: Vec): Vec;
  screenToWorld(p: Vec): Vec;
  /** snap tolerance in world units */
  tolerance(): number;
  requestOverlay(): void;
  setCursor(cursor: string): void;
  setStatus(text: string): void;
  commit(label: string): void;
  /** the pointer is captured by the viewport for the gesture */
  capture(pointerId: number): void;
  /** show/hide the snap guides drawn by the viewport */
  setSnapGuides(result: SnapResult | null): void;
  /** switch to another tool (e.g. after creating text) */
  setTool(id: string): void;
  /** options of the current tool merged with defaults */
  options<T extends Record<string, unknown>>(): T;
  setOptions(patch: Record<string, unknown>): void;
}

export interface Tool {
  id: string;
  name: string;
  /** keyboard shortcut like "v", "shift+m" */
  shortcut?: string;
  icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  /** toolbar flyout group id; tools in the same group share one toolbar slot */
  group: string;
  /** ordering inside the toolbar and within a group */
  order: number;
  cursor?: string;
  /** default option values (persisted per tool) */
  defaults?: Record<string, unknown>;
  /** control bar component rendered when the tool is active */
  Options?: ComponentType;
  /** short description for the status bar */
  hint?: string;

  activate?(ctx: ToolContext): void;
  deactivate?(ctx: ToolContext): void;
  onPointerDown?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: ToolPointerEvent, ctx: ToolContext): void;
  onDoubleClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  /** return true when the key was consumed (prevents global shortcuts) */
  onKeyDown?(e: ToolKeyEvent, ctx: ToolContext): boolean | void;
  onKeyUp?(e: ToolKeyEvent, ctx: ToolContext): boolean | void;
  /** modifier keys changed while idle (to update cursor/preview) */
  onModifiers?(e: ToolKeyEvent, ctx: ToolContext): void;
  /** draw in screen space inside the overlay <svg> */
  renderOverlay?(ctx: ToolContext): ReactNode;
  /** whether the default selection handles/bounds should be shown */
  showSelectionOverlay?: boolean | 'anchors';
  /** whether an in-progress gesture exists (Escape cancels it) */
  isBusy?(): boolean;
  cancel?(ctx: ToolContext): void;
}

export type { HitResult, HitOptions, SnapResult, SnapOptions, SnapSession, AnchorRef, HandleRef };
