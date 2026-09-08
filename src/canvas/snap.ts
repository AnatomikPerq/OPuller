/**
 * Snapping: grid, guides, artboards, object bounds/centres, anchor points and
 * smart guides. A SnapSession caches candidates for the duration of a gesture.
 */
import type { Document, ID, Vec, Rect } from '@/model/types';
import type { EditorState } from '@/store/store';
import { selectableNodes, worldBounds, worldMatrix, descendants } from '@/model/document';
import { applyToPoint } from '@/geometry/matrix';

export interface SnapOptions {
  /** nodes that must not act as snap targets (e.g. the ones being dragged) */
  exclude?: Iterable<ID>;
  grid?: boolean;
  guides?: boolean;
  objects?: boolean;
  anchors?: boolean;
  artboards?: boolean;
  pixel?: boolean;
  /** custom extra candidate points (world) */
  extraPoints?: Vec[];
  /** tolerance override (world units) */
  tolerance?: number;
}

export interface SnapGuideLine {
  kind: 'h' | 'v';
  /** position of the line (y for 'h', x for 'v') in world units */
  position: number;
  /** extent of the line (world) */
  from: number;
  to: number;
  label?: string;
}

export interface SnapResult {
  point: Vec;
  snappedX: boolean;
  snappedY: boolean;
  /** exact point snap (anchor/intersection) */
  snappedPoint: boolean;
  lines: SnapGuideLine[];
  /** highlighted points */
  points: Vec[];
  label?: string;
}

interface Candidate {
  value: number;
  /** extent along the other axis for drawing the guide */
  from: number;
  to: number;
  source: 'grid' | 'guide' | 'artboard' | 'object' | 'anchor' | 'extra';
  label?: string;
}

interface PointCandidate {
  p: Vec;
  source: 'anchor' | 'extra' | 'artboard' | 'object';
}

export class SnapSession {
  private xs: Candidate[] = [];
  private ys: Candidate[] = [];
  private pts: PointCandidate[] = [];
  private grid: number | null = null;
  private pixel = false;
  private tolerance: number;

  constructor(
    private doc: Document,
    private state: EditorState,
    private opts: SnapOptions = {},
  ) {
    const view = state.view;
    this.tolerance = opts.tolerance ?? state.prefs.snapTolerance / state.zoom;
    const exclude = new Set<ID>(opts.exclude ?? []);
    // expand exclusion to descendants
    for (const id of Array.from(exclude)) for (const d of descendants(doc, id)) exclude.add(d);

    const useGrid = opts.grid ?? (view.snapToGrid && view.grid);
    const useGuides = opts.guides ?? (view.snapToGuides && view.guides);
    const useObjects = opts.objects ?? view.smartGuides;
    const useAnchors = opts.anchors ?? view.snapToPoint;
    const useArtboards = opts.artboards ?? view.smartGuides;
    this.pixel = opts.pixel ?? view.snapToPixel;
    if (useGrid) this.grid = doc.grid.size / Math.max(1, doc.grid.subdivisions);

    if (useGuides) {
      for (const g of doc.guides) {
        if (g.axis === 'x') this.xs.push({ value: g.position, from: -1e9, to: 1e9, source: 'guide' });
        else this.ys.push({ value: g.position, from: -1e9, to: 1e9, source: 'guide' });
      }
    }
    if (useArtboards) {
      for (const a of doc.artboards) {
        const r: Rect = { x: a.x, y: a.y, width: a.width, height: a.height };
        this.addRect(r, 'artboard');
      }
    }
    if (useObjects || useAnchors) {
      // limit to nodes near the viewport
      const vw = state.viewportSize;
      const view0 = { x: -state.pan.x / state.zoom, y: -state.pan.y / state.zoom };
      const viewRect: Rect = { x: view0.x - 200, y: view0.y - 200, width: vw.width / state.zoom + 400, height: vw.height / state.zoom + 400 };
      const ids = selectableNodes(doc, false);
      let anchorBudget = 4000;
      for (const id of ids) {
        if (exclude.has(id)) continue;
        const b = worldBounds(doc, id);
        if (!b) continue;
        if (b.x > viewRect.x + viewRect.width || b.x + b.width < viewRect.x || b.y > viewRect.y + viewRect.height || b.y + b.height < viewRect.y) continue;
        if (useObjects) this.addRect(b, 'object');
        if (useAnchors && anchorBudget > 0) {
          for (const d of descendants(doc, id, true)) {
            const n = doc.nodes[d];
            if (!n || n.type !== 'path' || exclude.has(d)) continue;
            const wm = worldMatrix(doc, d);
            for (const sp of n.subpaths) {
              for (const a of sp.anchors) {
                this.pts.push({ p: applyToPoint(wm, a.point), source: 'anchor' });
                if (--anchorBudget <= 0) break;
              }
              if (anchorBudget <= 0) break;
            }
          }
        }
      }
    }
    if (opts.extraPoints) for (const p of opts.extraPoints) this.pts.push({ p, source: 'extra' });
  }

  private addRect(r: Rect, source: Candidate['source']) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    this.xs.push({ value: r.x, from: r.y, to: r.y + r.height, source });
    this.xs.push({ value: r.x + r.width, from: r.y, to: r.y + r.height, source });
    this.xs.push({ value: cx, from: r.y, to: r.y + r.height, source, label: 'center' });
    this.ys.push({ value: r.y, from: r.x, to: r.x + r.width, source });
    this.ys.push({ value: r.y + r.height, from: r.x, to: r.x + r.width, source });
    this.ys.push({ value: cy, from: r.x, to: r.x + r.width, source, label: 'center' });
    if (source === 'object') {
      this.pts.push({ p: { x: cx, y: cy }, source: 'object' });
      this.pts.push({ p: { x: r.x, y: r.y }, source: 'object' });
      this.pts.push({ p: { x: r.x + r.width, y: r.y + r.height }, source: 'object' });
      this.pts.push({ p: { x: r.x + r.width, y: r.y }, source: 'object' });
      this.pts.push({ p: { x: r.x, y: r.y + r.height }, source: 'object' });
    }
  }

  /** Snap a point. */
  snap(p: Vec): SnapResult {
    const tol = this.tolerance;
    const result: SnapResult = { point: { ...p }, snappedX: false, snappedY: false, snappedPoint: false, lines: [], points: [] };

    // 1. exact points (anchors, centres, corners) take priority
    let bestPt: PointCandidate | null = null;
    let bestD = tol;
    for (const c of this.pts) {
      const d = Math.hypot(c.p.x - p.x, c.p.y - p.y);
      if (d < bestD) {
        bestD = d;
        bestPt = c;
      }
    }
    if (bestPt) {
      result.point = { ...bestPt.p };
      result.snappedX = result.snappedY = result.snappedPoint = true;
      result.points.push(bestPt.p);
      result.label = bestPt.source === 'anchor' ? 'anchor' : bestPt.source === 'object' ? 'point' : undefined;
      return result;
    }

    // 2. axis candidates (guides, bounds, artboards)
    const bx = nearest(this.xs, p.x, tol);
    const by = nearest(this.ys, p.y, tol);
    if (bx) {
      result.point.x = bx.value;
      result.snappedX = true;
      result.lines.push({ kind: 'v', position: bx.value, from: Math.min(bx.from, p.y), to: Math.max(bx.to, p.y), label: bx.label });
    }
    if (by) {
      result.point.y = by.value;
      result.snappedY = true;
      result.lines.push({ kind: 'h', position: by.value, from: Math.min(by.from, p.x), to: Math.max(by.to, p.x), label: by.label });
    }

    // 3. grid
    if (this.grid) {
      const g = this.grid;
      if (!result.snappedX) {
        const gx = Math.round(p.x / g) * g;
        if (Math.abs(gx - p.x) <= tol) {
          result.point.x = gx;
          result.snappedX = true;
        }
      }
      if (!result.snappedY) {
        const gy = Math.round(p.y / g) * g;
        if (Math.abs(gy - p.y) <= tol) {
          result.point.y = gy;
          result.snappedY = true;
        }
      }
    }

    // 4. pixel
    if (this.pixel) {
      if (!result.snappedX) result.point.x = Math.round(result.point.x);
      if (!result.snappedY) result.point.y = Math.round(result.point.y);
    }
    return result;
  }

  /**
   * Snap a rectangle being moved: tries the rect's edges and centre against
   * candidates and returns the delta to apply.
   */
  snapRect(r: Rect): { dx: number; dy: number; lines: SnapGuideLine[] } {
    const tol = this.tolerance;
    const xsProbe = [r.x, r.x + r.width / 2, r.x + r.width];
    const ysProbe = [r.y, r.y + r.height / 2, r.y + r.height];
    let bestX: { d: number; c: Candidate; probe: number } | null = null;
    let bestY: { d: number; c: Candidate; probe: number } | null = null;
    for (const px of xsProbe) {
      const c = nearest(this.xs, px, tol);
      if (c) {
        const d = Math.abs(c.value - px);
        if (!bestX || d < bestX.d) bestX = { d, c, probe: px };
      }
    }
    for (const py of ysProbe) {
      const c = nearest(this.ys, py, tol);
      if (c) {
        const d = Math.abs(c.value - py);
        if (!bestY || d < bestY.d) bestY = { d, c, probe: py };
      }
    }
    let dx = bestX ? bestX.c.value - bestX.probe : 0;
    let dy = bestY ? bestY.c.value - bestY.probe : 0;
    if (this.grid) {
      const g = this.grid;
      if (!bestX) {
        const gx = Math.round(r.x / g) * g;
        if (Math.abs(gx - r.x) <= tol) dx = gx - r.x;
      }
      if (!bestY) {
        const gy = Math.round(r.y / g) * g;
        if (Math.abs(gy - r.y) <= tol) dy = gy - r.y;
      }
    }
    if (this.pixel) {
      if (!bestX) dx = Math.round(r.x) - r.x;
      if (!bestY) dy = Math.round(r.y) - r.y;
    }
    const lines: SnapGuideLine[] = [];
    if (bestX) lines.push({ kind: 'v', position: bestX.c.value, from: Math.min(bestX.c.from, r.y + dy), to: Math.max(bestX.c.to, r.y + r.height + dy), label: bestX.c.label });
    if (bestY) lines.push({ kind: 'h', position: bestY.c.value, from: Math.min(bestY.c.from, r.x + dx), to: Math.max(bestY.c.to, r.x + r.width + dx), label: bestY.c.label });
    return { dx, dy, lines };
  }
}

function nearest(cands: Candidate[], v: number, tol: number): Candidate | null {
  let best: Candidate | null = null;
  let bestD = tol;
  for (const c of cands) {
    const d = Math.abs(c.value - v);
    if (d < bestD || (d === bestD && best && c.source === 'guide')) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** One-off snap (builds a session each time; fine for clicks, use sessions for drags). */
export function snapPoint(doc: Document, state: EditorState, p: Vec, opts?: SnapOptions): SnapResult {
  return new SnapSession(doc, state, opts).snap(p);
}

/** Constrain a delta to 45deg increments (shift-drag). */
export function constrainDelta(d: Vec, stepDeg = 45): Vec {
  const l = Math.hypot(d.x, d.y);
  if (l < 1e-9) return { x: 0, y: 0 };
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(d.y, d.x) / step) * step;
  // for 45deg steps, project onto the axis for axis-aligned angles to keep exactness
  return { x: Math.cos(a) * l, y: Math.sin(a) * l };
}
