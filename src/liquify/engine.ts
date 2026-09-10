/**
 * Liquify gesture engine: runs the deformation brushes against the store.
 * Used by the canvas tools (src/tools/liquify) and by the scripting API
 * (applyLiquify in register.tsx). Talks to paper.js only through the freehand
 * fitter (Simplify pass), so keep the pure maths in brush.ts.
 */
import { produce } from 'immer';
import type { Anchor, Document, ID, Rect, SubPath, Vec } from '@/model/types';
import { getState } from '@/store/store';
import { worldSubPaths, setWorldSubPaths, worldBounds, ancestors, isEditable, collectPaths } from '@/model/document';
import { selectedEditablePaths, allEditablePaths, rectsIntersect } from '@/tools/freehand/apply';
import { refitRange, fitPolyline } from '@/tools/freehand/fit';
import { flattenSubPath, cloneAnchor, hasHandle, inferAnchorKind } from '@/geometry/path';
import {
  deformSubPaths,
  dropUnusedInserted,
  touchedRuns,
  spacingFor,
  simplifyTolerance,
  brushBounds,
  ripplesPerTurn,
  TOOL_DEFAULTS,
  type Brush,
  type LiquifyKind,
  type LiquifyOptions,
  type TouchFlag,
  type DeformParams,
} from './brush';

/** Nodes inside these constructs are generated / linked and must not be deformed. */
const BLOCKING_MARKERS = ['symbol', 'symbolSet', 'graph', 'blendStep', 'livePaint', 'perspective', 'envelope', 'lpKind'];

export const LIQUIFY_LABELS: Record<LiquifyKind, string> = {
  warp: 'Warp Tool',
  twirl: 'Twirl Tool',
  pucker: 'Pucker Tool',
  bloat: 'Bloat Tool',
  scallop: 'Scallop Tool',
  crystallize: 'Crystallize Tool',
  wrinkle: 'Wrinkle Tool',
};

/** Whether a node is a plain editable path the brushes may deform. */
export function isLiquifiable(doc: Document, id: ID): boolean {
  const n = doc.nodes[id];
  if (!n || n.type !== 'path') return false;
  if (!isEditable(doc, id)) return false;
  for (const aid of [id, ...ancestors(doc, id)]) {
    const d = doc.nodes[aid]?.data;
    if (d && BLOCKING_MARKERS.some((k) => k in d)) return false;
  }
  return true;
}

/** Options of a liquify tool merged with its defaults (read from the store, not from ctx.options()). */
export function currentOptions(kind: LiquifyKind): LiquifyOptions {
  return { ...TOOL_DEFAULTS[kind], ...(getState().toolOptions[kind] ?? {}) } as LiquifyOptions;
}

export function brushAt(p: Vec, o: LiquifyOptions): Brush {
  return { x: p.x, y: p.y, rx: Math.max(0.5, o.width / 2), ry: Math.max(0.5, o.height / 2), angle: o.angle };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Anchor spacing for the tool: Detail, capped so ripples of the detail tools can be represented. */
export function spacingOf(kind: LiquifyKind, o: LiquifyOptions): number {
  let spacing = spacingFor(o.width, o.height, o.detail);
  if (kind === 'scallop' || kind === 'crystallize' || kind === 'wrinkle') {
    const R = Math.min(o.width, o.height) / 2;
    const wavelength = (Math.PI * 2 * R) / ripplesPerTurn(o.complexity);
    spacing = Math.min(spacing, Math.max(0.75, wavelength / 4));
  }
  return spacing;
}

/** Make the two handles of an anchor collinear (average tangent), keeping their lengths. */
function smoothSeam(a: Anchor): void {
  if (!hasHandle(a.handleIn) || !hasHandle(a.handleOut)) return;
  const li = Math.hypot(a.handleIn.x, a.handleIn.y);
  const lo = Math.hypot(a.handleOut.x, a.handleOut.y);
  if (li < 1e-9 || lo < 1e-9) return;
  const tx = a.handleOut.x / lo - a.handleIn.x / li;
  const ty = a.handleOut.y / lo - a.handleIn.y / li;
  const tl = Math.hypot(tx, ty);
  if (tl < 1e-9) return;
  a.handleIn = { x: (-tx / tl) * li, y: (-ty / tl) * li };
  a.handleOut = { x: (tx / tl) * lo, y: (ty / tl) * lo };
  a.kind = 'smooth';
}

/**
 * Re-fit a whole closed subpath. paper.js' closed-path fitter is inaccurate,
 * so the ring is fitted as an open polyline that returns to its start and the
 * seam is smoothed afterwards.
 */
function refitClosedWhole(sp: SubPath, tolerance: number): SubPath {
  const pts = flattenSubPath(sp, 0.1);
  if (pts.length < 4) return sp;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) pts.push({ ...first });
  const fitted = fitPolyline(pts, tolerance, false);
  if (!fitted || fitted.anchors.length < 3) return sp;
  const anchors = fitted.anchors.map(cloneAnchor);
  const end = anchors.pop()!;
  anchors[0].handleIn = end.handleIn ? { ...end.handleIn } : null;
  smoothSeam(anchors[0]);
  inferAnchorKind(anchors[0]);
  return { anchors, closed: true };
}

/** Final pass over one subpath: drop unused inserted anchors, re-fit the touched runs. */
export function finishSubPath(sp: SubPath, flags: TouchFlag[], tolerance: number): SubPath {
  const cleaned = dropUnusedInserted(sp, flags);
  if (tolerance < 0.05) return cleaned.sp;
  const t = touchedRuns(cleaned.sp, cleaned.touched);
  try {
    if (t.whole) return t.sp.closed ? refitClosedWhole(t.sp, tolerance) : refitRange(t.sp, { i: 0, j: 0, whole: true }, tolerance, 0);
    let out = t.sp;
    for (const r of t.runs.slice().sort((a, b) => b.i - a.i)) {
      if (r.j <= r.i) continue;
      out = refitRange(out, { i: r.i, j: r.j, whole: false }, tolerance, 0);
    }
    return out;
  } catch {
    return cleaned.sp;
  }
}

/**
 * One liquify gesture. Targets are the selected paths when there is a
 * selection (or the given ids); otherwise every editable path the brush
 * passes over during the gesture. Every step replaces the document without a
 * history entry; `finish` commits one undo step, `cancel` reverts.
 */
export class LiquifySession {
  readonly targets = new Map<ID, TouchFlag[][]>();
  readonly fromSelection: boolean;
  private candidates: Array<{ id: ID; bounds: Rect }> = [];
  changed = false;
  readonly seed = Math.random();
  pointer: Vec;

  constructor(
    readonly kind: LiquifyKind,
    readonly opts: LiquifyOptions,
    pointer: Vec,
    ids?: ID[],
  ) {
    const s = getState();
    this.pointer = { ...pointer };
    const explicit = ids && ids.length ? collectPaths(s.doc, ids) : selectedEditablePaths(s);
    const chosen = explicit.filter((id) => isLiquifiable(s.doc, id));
    this.fromSelection = chosen.length > 0;
    if (this.fromSelection) {
      for (const id of chosen) this.targets.set(id, []);
    } else {
      for (const id of allEditablePaths(s)) {
        if (!isLiquifiable(s.doc, id)) continue;
        const b = worldBounds(s.doc, id);
        if (b) this.candidates.push({ id, bounds: b });
      }
    }
  }

  /** Number of paths touched so far. */
  get targetCount(): number {
    return this.targets.size;
  }

  hasCandidates(): boolean {
    return this.fromSelection || this.candidates.length > 0;
  }

  moveTo(p: Vec): void {
    this.pointer = { ...p };
  }

  /**
   * Apply one step at the current pointer position. `delta` is the pointer
   * movement (warp). Returns true when geometry changed.
   */
  step(delta?: Vec, pressure = 1): boolean {
    const s = getState();
    const o = this.opts;
    const brush = brushAt(this.pointer, o);
    if (!this.fromSelection) {
      const bb = brushBounds(brush);
      for (const c of this.candidates) if (!this.targets.has(c.id) && rectsIntersect(c.bounds, bb)) this.targets.set(c.id, []);
    }
    if (!this.targets.size) return false;
    const strength = clamp(o.intensity / 100, 0.01, 1) * (o.usePressure ? clamp(pressure, 0.05, 1) : 1);
    const params: DeformParams = {
      kind: this.kind,
      brush,
      strength,
      delta,
      rate: o.rate,
      complexity: o.complexity,
      horizontal: clamp(o.horizontal, 0, 100) / 100,
      vertical: clamp(o.vertical, 0, 100) / 100,
      seed: this.seed,
      spacing: spacingOf(this.kind, o),
      affectAnchors: o.affectAnchors,
      affectIn: o.affectIn,
      affectOut: o.affectOut,
    };
    if (this.kind === 'warp' && (!delta || (Math.abs(delta.x) < 1e-9 && Math.abs(delta.y) < 1e-9))) return false;
    let changed = false;
    const updates = new Map<ID, TouchFlag[][]>();
    const next = produce(s.doc, (d) => {
      for (const [id, flags] of this.targets) {
        const n = d.nodes[id];
        if (!n || n.type !== 'path') continue;
        const sps = worldSubPaths(d, id);
        const r = deformSubPaths(sps, params, flags.length === sps.length ? flags : undefined);
        if (r.changed) {
          setWorldSubPaths(d, id, r.sps);
          updates.set(id, r.touched);
          changed = true;
        }
      }
    });
    if (!changed) return false;
    for (const [id, f] of updates) this.targets.set(id, f);
    s.replaceDoc(next);
    this.changed = true;
    return true;
  }

  /** Warp: move the brush to `p`, applying the movement in small sub-steps so fast drags stay smooth. */
  warpTo(p: Vec, pressure = 1): boolean {
    const from = this.pointer;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return false;
    const stepLen = Math.max(1.5, Math.min(this.opts.width, this.opts.height) / 12);
    const n = Math.max(1, Math.min(8, Math.ceil(dist / stepLen)));
    let any = false;
    for (let i = 1; i <= n; i++) {
      const target = { x: from.x + (dx * i) / n, y: from.y + (dy * i) / n };
      const delta = { x: dx / n, y: dy / n };
      this.pointer = { x: target.x - delta.x, y: target.y - delta.y };
      if (this.step(delta, pressure)) any = true;
      this.pointer = target;
    }
    this.pointer = { ...p };
    return any;
  }

  /** Simplify the touched portions and record one undo step. Returns whether anything changed. */
  finish(label = LIQUIFY_LABELS[this.kind]): boolean {
    const s = getState();
    if (!this.changed) {
      s.revert();
      return false;
    }
    const tol = simplifyTolerance(this.opts.simplify);
    s.updateDoc((d) => {
      for (const [id, flags] of this.targets) {
        const n = d.nodes[id];
        if (!n || n.type !== 'path' || !flags.length) continue;
        const sps = worldSubPaths(d, id);
        if (sps.length !== flags.length) continue;
        setWorldSubPaths(
          d,
          id,
          sps.map((sp, i) => finishSubPath(sp, flags[i], tol)),
        );
      }
    });
    getState().commit(label);
    return true;
  }

  cancel(): void {
    getState().revert();
  }
}

export interface ApplyLiquifyParams {
  kind?: LiquifyKind;
  /** brush path (warp: the pointer moves through these; other tools: applied at each point) */
  points?: Vec[];
  x?: number;
  y?: number;
  /** timed tools: steps applied at every point (≈ 25 per second of holding the button) */
  steps?: number;
  /** targets (default: selection, else the paths under the brush) */
  ids?: ID[];
  /** overrides of the tool options (width, height, angle, intensity, detail, simplify, rate, complexity, horizontal, vertical, affect*) */
  options?: Partial<LiquifyOptions>;
  pressure?: number;
}

/** Scripted liquify (MCP / tests): one undo step. */
export function applyLiquify(p: ApplyLiquifyParams): { changed: boolean; targets: number; kind: LiquifyKind } {
  const kind: LiquifyKind = p.kind && p.kind in TOOL_DEFAULTS ? p.kind : 'warp';
  const opts: LiquifyOptions = { ...currentOptions(kind), ...(p.options ?? {}) };
  const pts: Vec[] = p.points && p.points.length ? p.points : [{ x: Number(p.x ?? 0), y: Number(p.y ?? 0) }];
  const session = new LiquifySession(kind, opts, pts[0], p.ids);
  const pressure = p.pressure ?? 1;
  if (kind === 'warp') {
    for (let i = 1; i < pts.length; i++) session.warpTo(pts[i], pressure);
  } else {
    const steps = Math.max(1, Math.min(500, Math.round(p.steps ?? 10)));
    for (const q of pts) {
      session.moveTo(q);
      for (let k = 0; k < steps; k++) session.step(undefined, pressure);
    }
  }
  const changed = session.finish();
  return { changed, targets: session.targetCount, kind };
}
