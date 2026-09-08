/**
 * Symbol Sprayer (Shift+S): sprays instances of the symbol selected in the
 * Symbols panel into a symbol set. The mode option turns the same tool into
 * Illustrator's shifter / sizer / spinner / screener: instances under the
 * brush are moved, scaled, rotated or faded. Alt reverses (delete / shrink /
 * opaque).
 */
import React from 'react';
import { SprayCan } from 'lucide-react';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';
import type { ID, Vec, GroupNode } from '@/model/types';
import { getState, useStore } from '@/store/store';
import { makeGroup } from '@/model/nodes';
import { addNode, removeNode, worldBounds, parentWorldMatrix } from '@/model/document';
import { multiply, invert, translate, rotate, scale as scaleM, compose, decompose } from '@/geometry/matrix';
import { insertionParent } from '@/tools/shapes/tool';
import { placeInstance, isSymbolSet, isSymbolInstance, getSymbol } from '@/symbols/ops';
import { currentSymbolId } from '@/symbols/actions';
import { useSymbolStore } from '@/symbols/store';
import { useToolOptions } from '@/canvas/toolContext';
import { NumberField, Row, Select, Segmented } from '@/ui/widgets';

export type SprayMode = 'spray' | 'shift' | 'size' | 'spin' | 'screen';

interface Options extends Record<string, unknown> {
  mode: SprayMode;
  diameter: number;
  intensity: number;
  density: number;
  sizeVariation: number;
  rotationVariation: number;
}

const DEFAULTS: Options = { mode: 'spray', diameter: 120, intensity: 5, density: 50, sizeVariation: 30, rotationVariation: 30 };

interface Gesture {
  setId: ID;
  last: Vec;
  travelled: number;
  rnd: () => number;
  alt: boolean;
  count: number;
}

let gesture: Gesture | null = null;
let cursorWorld: Vec | null = null;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 7;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** The symbol set to spray into: the selected set, else a new one. */
function targetSet(ctx: ToolContext, symbolName: string): ID {
  const s = ctx.state;
  const selectedSet = s.selection.find((id) => isSymbolSet(s.doc.nodes[id]));
  if (selectedSet) return selectedSet;
  const parent = insertionParent();
  const g = makeGroup([], { name: `${symbolName} Set` });
  g.data = { symbolSet: true };
  s.updateDoc((d) => addNode(d, g, parent));
  return g.id;
}

function instancesNear(ctx: ToolContext, setId: ID, center: Vec, radius: number): ID[] {
  const d = ctx.doc;
  const set = d.nodes[setId] as GroupNode | undefined;
  if (!set || set.type !== 'group') return [];
  const out: ID[] = [];
  for (const cid of set.children) {
    const b = worldBounds(d, cid);
    if (!b) continue;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    if (Math.hypot(cx - center.x, cy - center.y) <= radius) out.push(cid);
  }
  return out;
}

function spray(ctx: ToolContext, g: Gesture, p: Vec, opts: Options, symbolId: ID): void {
  const s = ctx.state;
  const r = opts.diameter / 2;
  const spacing = Math.max(4, r * (1.1 - opts.density / 100));
  const rate = Math.max(1, Math.round(opts.intensity / 2));
  s.updateDoc((d) => {
    const set = d.nodes[g.setId];
    if (!set || set.type !== 'group') return;
    for (let i = 0; i < rate; i++) {
      const ang = g.rnd() * Math.PI * 2;
      const dist = Math.sqrt(g.rnd()) * r * 0.85;
      const at = { x: p.x + Math.cos(ang) * dist, y: p.y + Math.sin(ang) * dist };
      const sv = opts.sizeVariation / 100;
      const scale = 1 + (g.rnd() * 2 - 1) * sv;
      const rot = (g.rnd() * 2 - 1) * opts.rotationVariation;
      placeInstance(d, symbolId, at, g.setId, { scale: Math.max(0.05, scale), rotation: rot });
      g.count++;
    }
  });
  void spacing;
}

function erase(ctx: ToolContext, g: Gesture, p: Vec, opts: Options): void {
  const ids = instancesNear(ctx, g.setId, p, opts.diameter / 2);
  if (!ids.length) return;
  ctx.state.updateDoc((d) => {
    for (const id of ids) removeNode(d, id);
  });
  g.count += ids.length;
}

function adjust(ctx: ToolContext, g: Gesture, p: Vec, delta: Vec, opts: Options, e: ToolPointerEvent): void {
  const ids = instancesNear(ctx, g.setId, p, opts.diameter / 2);
  if (!ids.length) return;
  const radius = opts.diameter / 2;
  const strength = opts.intensity / 10;
  ctx.state.updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n) continue;
      const b = worldBounds(d, id);
      const c = b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : p;
      const fall = Math.max(0, 1 - Math.hypot(c.x - p.x, c.y - p.y) / radius) * strength + 0.15 * strength;
      const pw = parentWorldMatrix(d, id);
      const inv = invert(pw);
      const world = multiply(pw, n.transform);
      switch (opts.mode) {
        case 'shift': {
          const m = translate(delta.x * fall, delta.y * fall);
          n.transform = multiply(inv, multiply(m, world));
          break;
        }
        case 'size': {
          const k = e.alt ? 1 - 0.04 * fall : 1 + 0.04 * fall;
          n.transform = multiply(inv, compose(translate(c.x, c.y), scaleM(k, k), translate(-c.x, -c.y), world));
          break;
        }
        case 'spin': {
          const ang = (Math.atan2(delta.y, delta.x) * 180) / Math.PI;
          const cur = decompose(world).rotation;
          let diff = ((ang - cur + 540) % 360) - 180;
          diff *= 0.15 * fall;
          n.transform = multiply(inv, compose(translate(c.x, c.y), rotate(diff), translate(-c.x, -c.y), world));
          break;
        }
        case 'screen': {
          n.opacity = Math.max(0.05, Math.min(1, n.opacity + (e.alt ? 0.03 : -0.03) * fall));
          break;
        }
        default:
          break;
      }
    }
  });
  g.count++;
}

function SprayerOptions() {
  const [opts, set] = useToolOptions<Options>('symbolSprayer');
  const symbols = useStore((s) => s.doc.symbols);
  const activeId = useSymbolStore((s) => s.activeId);
  const setActive = useSymbolStore((s) => s.setActive);
  const cur = symbols.find((x) => x.id === activeId) ?? symbols[0];
  return (
    <Row gap={8}>
      <Segmented<SprayMode>
        value={opts.mode}
        onChange={(v) => set({ mode: v })}
        options={[
          { value: 'spray', label: 'Spray' },
          { value: 'shift', label: 'Shift' },
          { value: 'size', label: 'Size' },
          { value: 'spin', label: 'Spin' },
          { value: 'screen', label: 'Screen' },
        ]}
      />
      <Select label="Symbol" value={cur?.id ?? ''} options={symbols.length ? symbols.map((s) => ({ value: s.id, label: s.name })) : [{ value: '', label: 'No symbols' }]} onChange={(v) => setActive(v)} width={150} id="sprayer-symbol" />
      <NumberField label="Diameter" value={opts.diameter} min={8} max={2000} unit="px" onChange={(v) => set({ diameter: Math.max(8, v) })} width={110} data-testid="sprayer-diameter" />
      <NumberField label="Intensity" value={opts.intensity} min={1} max={10} decimals={0} onChange={(v) => set({ intensity: Math.round(v) })} width={90} />
      <NumberField label="Density" value={opts.density} min={0} max={100} unit="%" decimals={0} onChange={(v) => set({ density: v })} width={90} />
      <NumberField label="Size ±" value={opts.sizeVariation} min={0} max={100} unit="%" decimals={0} onChange={(v) => set({ sizeVariation: v })} width={90} />
      <NumberField label="Rotate ±" value={opts.rotationVariation} min={0} max={180} unit="deg" decimals={0} onChange={(v) => set({ rotationVariation: v })} width={96} />
    </Row>
  );
}

export const tool: Tool = {
  id: 'symbolSprayer',
  name: 'Symbol Sprayer Tool',
  shortcut: 'shift+s',
  icon: SprayCan,
  group: 'edit',
  order: 640,
  cursor: 'crosshair',
  hint: 'Drag to spray instances of the selected symbol. Alt-drag deletes. Modes: Shift / Size / Spin / Screen adjust instances under the brush.',
  defaults: DEFAULTS,
  Options: SprayerOptions,
  showSelectionOverlay: true,

  activate(ctx) {
    gesture = null;
    ctx.setCursor('crosshair');
  },
  deactivate() {
    gesture = null;
    cursorWorld = null;
  },
  isBusy: () => !!gesture,
  cancel(ctx) {
    gesture = null;
    ctx.state.revert();
    ctx.requestOverlay();
  },
  onPointerDown(e, ctx) {
    if (e.button !== 0) return;
    const symbolId = currentSymbolId();
    if (!symbolId) {
      ctx.setStatus('No symbols: add one from the Symbols panel first');
      getState().toast('Select a symbol in the Symbols panel first (or Object > Symbol > Add Symbol Library)', 'info');
      return;
    }
    const opts = ctx.options<Options>();
    const def = getSymbol(ctx.doc, symbolId);
    const setId = targetSet(ctx, def?.name ?? 'Symbol');
    gesture = { setId, last: e.world, travelled: 0, rnd: rng(Date.now() & 0xffff), alt: e.alt, count: 0 };
    if (opts.mode === 'spray') {
      if (e.alt) erase(ctx, gesture, e.world, opts);
      else spray(ctx, gesture, e.world, opts, symbolId);
    }
    ctx.requestOverlay();
  },
  onPointerMove(e, ctx) {
    cursorWorld = e.world;
    ctx.requestOverlay();
    const g = gesture;
    if (!g) return;
    const opts = ctx.options<Options>();
    const delta = { x: e.world.x - g.last.x, y: e.world.y - g.last.y };
    const step = Math.hypot(delta.x, delta.y);
    g.travelled += step;
    if (opts.mode === 'spray') {
      const r = opts.diameter / 2;
      const spacing = Math.max(4, r * (1.1 - opts.density / 100));
      if (g.travelled >= spacing) {
        g.travelled = 0;
        const symbolId = currentSymbolId();
        if (symbolId) {
          if (e.alt) erase(ctx, g, e.world, opts);
          else spray(ctx, g, e.world, opts, symbolId);
        }
      }
    } else if (step > 0) adjust(ctx, g, e.world, delta, opts, e);
    g.last = e.world;
  },
  onPointerUp(e, ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    const opts = ctx.options<Options>();
    const s = ctx.state;
    const set = s.doc.nodes[g.setId];
    if (set && set.type === 'group' && !set.children.length) {
      s.updateDoc((d) => removeNode(d, g.setId));
      s.revert();
      return;
    }
    const labels: Record<SprayMode, string> = { spray: e.alt ? 'Delete Symbol Instances' : 'Spray Symbols', shift: 'Shift Symbols', size: 'Size Symbols', spin: 'Spin Symbols', screen: 'Screen Symbols' };
    ctx.commit(labels[opts.mode]);
    getState().setSelection([g.setId]);
    ctx.requestOverlay();
  },
  onKeyDown(e, ctx) {
    if (e.key === 'Escape' && gesture) {
      this.cancel!(ctx);
      return true;
    }
    if ((e.key === '[' || e.key === ']') && !e.primary) {
      const opts = ctx.options<Options>();
      const step = opts.diameter < 50 ? 4 : 20;
      ctx.setOptions({ diameter: Math.max(8, opts.diameter + (e.key === ']' ? step : -step)) });
      ctx.requestOverlay();
      return true;
    }
    return false;
  },
  renderOverlay(ctx) {
    if (!cursorWorld) return null;
    const opts = ctx.options<Options>();
    const p = ctx.worldToScreen(cursorWorld);
    const r = (opts.diameter / 2) * ctx.zoom;
    return <circle cx={p.x} cy={p.y} r={r} fill="none" stroke="#8a2b4f" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />;
  },
};

export type { ID as SymbolInstanceId };
void isSymbolInstance;
