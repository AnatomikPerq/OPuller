/**
 * UI state of the transform module (not part of the document / history):
 * reference point, proportional lock, align settings, the shared tool pivot
 * and the "Transform Again" memory.
 */
import { create } from 'zustand';
import type { ID, Matrix, Vec } from '@/model/types';
import type { RefPoint } from './refPoint';

export type AlignTo = 'selection' | 'key' | 'artboard';

/** Parameters of a Transform Each operation (re-run by Transform Again). */
export interface EachParams {
  scaleX: number; // percent
  scaleY: number;
  moveX: number; // px
  moveY: number;
  angle: number; // degrees ccw
  reflectX: boolean;
  reflectY: boolean;
  random: boolean;
  ref: RefPoint;
}

export interface TransformRecord {
  label: string;
  copy: boolean;
  /** pivot of the linear part: an absolute world point (tools) or a reference point of the selection bounds */
  pivot: { kind: 'absolute'; point: Vec } | { kind: 'ref'; ref: RefPoint };
  /** linear part (a, b, c, d) applied about the pivot */
  linear: Matrix;
  /** translation applied afterwards (world units) */
  translate: Vec;
  /** Transform Each: applied per object around its own reference point */
  each?: EachParams;
}

export interface TransformUIState {
  refPoint: RefPoint;
  constrain: boolean;
  alignTo: AlignTo;
  keyObject: ID | null;
  /** distribute spacing value in px; null = auto */
  spacing: number | null;
  lastTransform: TransformRecord | null;
  /** reference point of the rotate/scale/reflect/shear tools (null = selection center) */
  toolPivot: { point: Vec; selectionKey: string } | null;
  setRefPoint: (r: RefPoint) => void;
  setConstrain: (b: boolean) => void;
  setAlignTo: (a: AlignTo) => void;
  setKeyObject: (id: ID | null) => void;
  setSpacing: (v: number | null) => void;
  setLastTransform: (r: TransformRecord | null) => void;
  setToolPivot: (p: { point: Vec; selectionKey: string } | null) => void;
}

export const useTransformStore = create<TransformUIState>((set) => ({
  refPoint: 'c',
  constrain: false,
  alignTo: 'selection',
  keyObject: null,
  spacing: null,
  lastTransform: null,
  toolPivot: null,
  setRefPoint: (refPoint) => set({ refPoint }),
  setConstrain: (constrain) => set({ constrain }),
  setAlignTo: (alignTo) => set({ alignTo }),
  setKeyObject: (keyObject) => set({ keyObject }),
  setSpacing: (spacing) => set({ spacing }),
  setLastTransform: (lastTransform) => set({ lastTransform }),
  setToolPivot: (toolPivot) => set({ toolPivot }),
}));

export const getTransformState = useTransformStore.getState;
