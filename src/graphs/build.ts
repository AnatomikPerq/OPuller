/**
 * Graph generator (pure): builds the artwork (paths + text) of a graph inside
 * a frame from a data table. Column / stacked column, bar / stacked bar, line,
 * area, scatter, pie and radar graphs with axes, ticks, labels and a legend.
 */
import type { Node, HexColor, Rect, Vec, SubPath } from '@/model/types';
import { makePath, makeText, makeShape } from '@/model/nodes';
import { noStroke, defaultStroke } from '@/model/defaults';
import { polylineSubPath } from '@/geometry/path';
import { arcSubPath, ellipseSubPath } from '@/geometry/shapes';
import { translate } from '@/geometry/matrix';

export type GraphType = 'column' | 'stackedColumn' | 'bar' | 'stackedBar' | 'line' | 'area' | 'scatter' | 'pie' | 'radar';

export const GRAPH_TYPES: Array<{ id: GraphType; label: string }> = [
  { id: 'column', label: 'Column' },
  { id: 'stackedColumn', label: 'Stacked Column' },
  { id: 'bar', label: 'Bar' },
  { id: 'stackedBar', label: 'Stacked Bar' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'scatter', label: 'Scatter' },
  { id: 'pie', label: 'Pie' },
  { id: 'radar', label: 'Radar' },
];

export interface GraphOptions {
  legend: 'right' | 'top' | 'none';
  valueAxis: 'left' | 'right' | 'both' | 'none';
  categoryAxis: boolean;
  /** column / bar width as a fraction of the slot (0.1..1) */
  barWidth: number;
  /** cluster width as a fraction of the category slot */
  clusterWidth: number;
  showValues: boolean;
  /** explicit value range; null = automatic */
  min: number | null;
  max: number | null;
  ticks: number;
  colors: HexColor[];
  fontSize: number;
  /** draw markers on line graphs */
  markers: boolean;
  /** pie: sort slices, show percent labels */
  pieLabels: 'none' | 'value' | 'percent';
}

export interface GraphSpec {
  type: GraphType;
  /** rows = categories, columns = series */
  data: number[][];
  categories: string[];
  series: string[];
  options: GraphOptions;
}

export const DEFAULT_COLORS: HexColor[] = ['#7a1f3d', '#1da1f2', '#ffcc00', '#34c759', '#5856d6', '#ff9500', '#00b8a9', '#ff2d55', '#8e8e93'];

export const DEFAULT_OPTIONS: GraphOptions = { legend: 'right', valueAxis: 'left', categoryAxis: true, barWidth: 0.7, clusterWidth: 0.8, showValues: false, min: null, max: null, ticks: 5, colors: DEFAULT_COLORS, fontSize: 11, markers: true, pieLabels: 'percent' };

export function sampleSpec(type: GraphType = 'column'): GraphSpec {
  return {
    type,
    data: [
      [12, 18],
      [20, 9],
      [15, 14],
      [8, 22],
    ],
    categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: ['Series 1', 'Series 2'],
    options: { ...DEFAULT_OPTIONS },
  };
}

const TEXT_W = 0.56; // average glyph width / font size

function textNode(text: string, x: number, y: number, size: number, align: 'left' | 'center' | 'right', color = '#1c1c1e'): Node {
  const t = makeText(text, { style: { fontSize: size, fontFamily: 'Inter', textAlign: 'left' }, fill: { type: 'solid', color, opacity: 1 }, name: text.slice(0, 20) });
  let dx = 0;
  const w = text.length * size * TEXT_W;
  if (align === 'center') dx = -w / 2;
  else if (align === 'right') dx = -w;
  t.transform = translate(x + dx, y);
  return t;
}

function rectNode(x: number, y: number, w: number, h: number, fill: HexColor, name: string): Node {
  const n = makeShape({ kind: 'rect', width: Math.max(0, w), height: Math.max(0, h), radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: fill, opacity: 1 }, stroke: noStroke(), name });
  n.transform = translate(x, y);
  return n;
}

function lineNode(pts: Vec[], color: HexColor, width: number, name: string, closed = false): Node {
  return makePath([polylineSubPath(pts, closed)], { fill: { type: 'none' }, stroke: defaultStroke({ paint: { type: 'solid', color, opacity: 1 }, width, join: 'round', cap: 'round' }), name });
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (+v.toFixed(2)).toString();
}

/** "Nice" axis range and step. */
export function niceRange(min: number, max: number, ticks: number): { min: number; max: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.2 };
  if (max === min) max = min + (min === 0 ? 1 : Math.abs(min) * 0.5);
  const span = max - min;
  const raw = span / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

function colorOf(o: GraphOptions, i: number): HexColor {
  const c = o.colors.length ? o.colors : DEFAULT_COLORS;
  return c[i % c.length];
}

function layout(spec: GraphSpec, frame: Rect) {
  const o = spec.options;
  const legendW = o.legend === 'right' && spec.series.length ? Math.max(...spec.series.map((s) => s.length)) * o.fontSize * TEXT_W + 28 : 0;
  const legendH = o.legend === 'top' && spec.series.length ? o.fontSize * 2 : 0;
  const axisW = o.valueAxis === 'none' ? 4 : o.fontSize * 3.6;
  const plot: Rect = {
    x: frame.x + (o.valueAxis === 'left' || o.valueAxis === 'both' ? axisW : 4),
    y: frame.y + legendH + o.fontSize,
    width: Math.max(10, frame.width - (o.valueAxis === 'left' || o.valueAxis === 'both' ? axisW : 4) - (o.valueAxis === 'right' || o.valueAxis === 'both' ? axisW : 4) - legendW),
    height: Math.max(10, frame.height - legendH - o.fontSize - (o.categoryAxis ? o.fontSize * 1.8 : 4)),
  };
  return { plot, legendW, legendH };
}

/** Build the graph artwork (nodes with transforms relative to the frame origin's parent space). */
export function buildGraph(spec: GraphSpec, frame: Rect): Node[] {
  const o = spec.options;
  const out: Node[] = [];
  const rows = spec.data.length;
  const cols = rows ? Math.max(...spec.data.map((r) => r.length)) : 0;
  const val = (r: number, c: number) => Number(spec.data[r]?.[c] ?? 0) || 0;
  if (!rows || !cols) return out;
  if (spec.type === 'pie') return buildPie(spec, frame);
  if (spec.type === 'radar') return buildRadar(spec, frame);
  const { plot, legendH } = layout(spec, frame);
  const horizontal = spec.type === 'bar' || spec.type === 'stackedBar';
  const stacked = spec.type === 'stackedColumn' || spec.type === 'stackedBar';
  // value range
  let vmin = Infinity;
  let vmax = -Infinity;
  if (stacked) {
    for (let r = 0; r < rows; r++) {
      let pos = 0;
      let neg = 0;
      for (let c = 0; c < cols; c++) {
        const v = val(r, c);
        if (v >= 0) pos += v;
        else neg += v;
      }
      vmax = Math.max(vmax, pos);
      vmin = Math.min(vmin, neg);
    }
  } else if (spec.type === 'scatter') {
    for (let r = 0; r < rows; r++) for (let c = 1; c < cols; c++) {
      vmax = Math.max(vmax, val(r, c));
      vmin = Math.min(vmin, val(r, c));
    }
  } else {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      vmax = Math.max(vmax, val(r, c));
      vmin = Math.min(vmin, val(r, c));
    }
  }
  vmin = Math.min(vmin, 0);
  vmax = Math.max(vmax, 0);
  const range = niceRange(o.min ?? vmin, o.max ?? vmax, o.ticks);
  const lo = o.min ?? range.min;
  const hi = o.max ?? range.max;
  const span = hi - lo || 1;
  // value → pixel along the value axis
  const vpx = (v: number) => (horizontal ? plot.x + ((v - lo) / span) * plot.width : plot.y + plot.height - ((v - lo) / span) * plot.height);
  const zero = vpx(0);
  // grid + value axis
  const axisColor = '#8e8e93';
  const drawValueAxis = o.valueAxis !== 'none';
  for (let t = range.min; t <= hi + 1e-9; t += range.step) {
    if (t < lo - 1e-9) continue;
    const p = vpx(t);
    if (horizontal) {
      out.push(lineNode([{ x: p, y: plot.y }, { x: p, y: plot.y + plot.height }], '#d3d3d8', 0.5, 'Grid'));
      if (drawValueAxis) out.push(textNode(fmt(t), p, plot.y + plot.height + o.fontSize * 1.3, o.fontSize, 'center', '#48484a'));
    } else {
      out.push(lineNode([{ x: plot.x, y: p }, { x: plot.x + plot.width, y: p }], '#d3d3d8', 0.5, 'Grid'));
      if (drawValueAxis && (o.valueAxis === 'left' || o.valueAxis === 'both')) out.push(textNode(fmt(t), plot.x - 6, p + o.fontSize * 0.35, o.fontSize, 'right', '#48484a'));
      if (drawValueAxis && (o.valueAxis === 'right' || o.valueAxis === 'both')) out.push(textNode(fmt(t), plot.x + plot.width + 6, p + o.fontSize * 0.35, o.fontSize, 'left', '#48484a'));
    }
  }
  // axes lines
  if (horizontal) {
    out.push(lineNode([{ x: zero, y: plot.y }, { x: zero, y: plot.y + plot.height }], axisColor, 1, 'Value axis'));
    if (o.categoryAxis) out.push(lineNode([{ x: plot.x, y: plot.y }, { x: plot.x, y: plot.y + plot.height }], axisColor, 1, 'Category axis'));
  } else {
    out.push(lineNode([{ x: plot.x, y: zero }, { x: plot.x + plot.width, y: zero }], axisColor, 1, 'Value axis'));
    if (o.categoryAxis) out.push(lineNode([{ x: plot.x, y: plot.y }, { x: plot.x, y: plot.y + plot.height }], axisColor, 1, 'Category axis'));
  }
  // category slots
  const slots = spec.type === 'scatter' ? 1 : rows;
  const slot = horizontal ? plot.height / slots : plot.width / slots;
  const catPos = (r: number) => (horizontal ? plot.y + slot * (r + 0.5) : plot.x + slot * (r + 0.5));
  // category labels
  if (o.categoryAxis && spec.type !== 'scatter') {
    for (let r = 0; r < rows; r++) {
      const label = spec.categories[r] ?? `${r + 1}`;
      if (horizontal) out.push(textNode(label, plot.x - 6, catPos(r) + o.fontSize * 0.35, o.fontSize, 'right'));
      else out.push(textNode(label, catPos(r), plot.y + plot.height + o.fontSize * 1.3, o.fontSize, 'center'));
    }
  }
  if (spec.type === 'column' || spec.type === 'bar' || stacked) {
    const cluster = slot * o.clusterWidth;
    const bw = stacked ? cluster * o.barWidth : (cluster / cols) * o.barWidth;
    for (let r = 0; r < rows; r++) {
      let posAcc = 0;
      let negAcc = 0;
      for (let c = 0; c < cols; c++) {
        const v = val(r, c);
        let a: number;
        let b: number;
        if (stacked) {
          if (v >= 0) {
            a = vpx(posAcc);
            b = vpx(posAcc + v);
            posAcc += v;
          } else {
            a = vpx(negAcc);
            b = vpx(negAcc + v);
            negAcc += v;
          }
        } else {
          a = zero;
          b = vpx(v);
        }
        const center = catPos(r);
        const off = stacked ? -bw / 2 : -cluster / 2 + (cluster / cols) * c + ((cluster / cols) * (1 - o.barWidth)) / 2;
        const name = `${spec.series[c] ?? `Series ${c + 1}`} · ${spec.categories[r] ?? r + 1}`;
        if (horizontal) out.push(rectNode(Math.min(a, b), center + off, Math.abs(b - a), bw, colorOf(o, c), name));
        else out.push(rectNode(center + off, Math.min(a, b), bw, Math.abs(b - a), colorOf(o, c), name));
        if (o.showValues) {
          if (horizontal) out.push(textNode(fmt(v), Math.max(a, b) + 4, center + off + bw / 2 + o.fontSize * 0.35, o.fontSize * 0.9, 'left'));
          else out.push(textNode(fmt(v), center + off + bw / 2, Math.min(a, b) - 4, o.fontSize * 0.9, 'center'));
        }
      }
    }
  } else if (spec.type === 'line' || spec.type === 'area') {
    for (let c = 0; c < cols; c++) {
      const pts: Vec[] = [];
      for (let r = 0; r < rows; r++) pts.push({ x: catPos(r), y: vpx(val(r, c)) });
      const color = colorOf(o, c);
      if (spec.type === 'area' && pts.length) {
        const poly = [{ x: pts[0].x, y: zero }, ...pts, { x: pts[pts.length - 1].x, y: zero }];
        const area = makePath([polylineSubPath(poly, true)], { fill: { type: 'solid', color, opacity: 0.55 }, stroke: noStroke(), name: `${spec.series[c] ?? `Series ${c + 1}`} area` });
        out.push(area);
      }
      out.push(lineNode(pts, color, 2, `${spec.series[c] ?? `Series ${c + 1}`}`));
      if (o.markers && spec.type === 'line') for (const p of pts) out.push(marker(p, color));
      if (o.showValues) for (let r = 0; r < rows; r++) out.push(textNode(fmt(val(r, c)), pts[r].x, pts[r].y - 6, o.fontSize * 0.9, 'center'));
    }
  } else if (spec.type === 'scatter') {
    // column 0 = x, other columns = y series
    let xmin = Infinity;
    let xmax = -Infinity;
    for (let r = 0; r < rows; r++) {
      xmin = Math.min(xmin, val(r, 0));
      xmax = Math.max(xmax, val(r, 0));
    }
    const xr = niceRange(xmin, xmax, o.ticks);
    const xs = (v: number) => plot.x + ((v - xr.min) / (xr.max - xr.min || 1)) * plot.width;
    for (let t = xr.min; t <= xr.max + 1e-9; t += xr.step) {
      out.push(lineNode([{ x: xs(t), y: plot.y }, { x: xs(t), y: plot.y + plot.height }], '#e6e6ea', 0.5, 'Grid'));
      out.push(textNode(fmt(t), xs(t), plot.y + plot.height + o.fontSize * 1.3, o.fontSize, 'center', '#48484a'));
    }
    for (let c = 1; c < cols; c++) {
      const color = colorOf(o, c - 1);
      const pts: Vec[] = [];
      for (let r = 0; r < rows; r++) pts.push({ x: xs(val(r, 0)), y: vpx(val(r, c)) });
      if (o.markers) for (const p of pts) out.push(marker(p, color));
      if (pts.length > 1) out.push(lineNode(pts, color, 1.5, spec.series[c] ?? `Series ${c}`));
    }
  }
  // legend
  const legendSeries = spec.type === 'scatter' ? spec.series.slice(1) : spec.series;
  if (o.legend !== 'none' && legendSeries.length) {
    if (o.legend === 'right') {
      const lx = frame.x + frame.width - (layout(spec, frame).legendW - 8);
      legendSeries.forEach((name, i) => {
        const ly = frame.y + legendH + i * (o.fontSize * 1.6);
        out.push(rectNode(lx, ly, o.fontSize, o.fontSize, colorOf(o, i), `Legend ${name}`));
        out.push(textNode(name, lx + o.fontSize + 6, ly + o.fontSize * 0.85, o.fontSize, 'left'));
      });
    } else {
      let lx = frame.x;
      legendSeries.forEach((name, i) => {
        out.push(rectNode(lx, frame.y, o.fontSize, o.fontSize, colorOf(o, i), `Legend ${name}`));
        out.push(textNode(name, lx + o.fontSize + 6, frame.y + o.fontSize * 0.85, o.fontSize, 'left'));
        lx += o.fontSize + 10 + name.length * o.fontSize * TEXT_W + 12;
      });
    }
  }
  return out;
}

function marker(p: Vec, color: HexColor): Node {
  const n = makePath([ellipseSubPath(3.5, 3.5)], { fill: { type: 'solid', color, opacity: 1 }, stroke: defaultStroke({ paint: { type: 'solid', color: '#ffffff', opacity: 1 }, width: 1 }), name: 'Marker' });
  n.transform = translate(p.x, p.y);
  return n;
}

function buildPie(spec: GraphSpec, frame: Rect): Node[] {
  const o = spec.options;
  const out: Node[] = [];
  const rows = spec.data.length;
  const cols = Math.max(...spec.data.map((r) => r.length));
  const { legendW } = layout(spec, frame);
  const availW = frame.width - legendW;
  const perPie = Math.min(availW / Math.max(1, cols), frame.height);
  const r = perPie / 2 - o.fontSize * 1.6;
  for (let c = 0; c < cols; c++) {
    const cx = frame.x + perPie * (c + 0.5);
    const cy = frame.y + frame.height / 2;
    const total = spec.data.reduce((s, row) => s + Math.max(0, Number(row[c] ?? 0) || 0), 0) || 1;
    let a = -90;
    for (let rIdx = 0; rIdx < rows; rIdx++) {
      const v = Math.max(0, Number(spec.data[rIdx]?.[c] ?? 0) || 0);
      if (!v) continue;
      const sweep = (v / total) * 360;
      const sp: SubPath = sweep >= 359.999 ? ellipseSubPath(r, r) : arcSubPath(r, r, a, a + sweep, true);
      const slice = makePath([sp], { fill: { type: 'solid', color: colorOf(o, rIdx), opacity: 1 }, stroke: defaultStroke({ paint: { type: 'solid', color: '#ffffff', opacity: 1 }, width: 1 }), name: `${spec.categories[rIdx] ?? rIdx + 1}` });
      slice.transform = translate(cx, cy);
      out.push(slice);
      if (o.pieLabels !== 'none') {
        const mid = ((a + sweep / 2) * Math.PI) / 180;
        const lx = cx + Math.cos(mid) * (r + o.fontSize);
        const ly = cy + Math.sin(mid) * (r + o.fontSize) + o.fontSize * 0.35;
        out.push(textNode(o.pieLabels === 'percent' ? `${Math.round((v / total) * 100)}%` : fmt(v), lx, ly, o.fontSize * 0.9, Math.cos(mid) < -0.2 ? 'right' : Math.cos(mid) > 0.2 ? 'left' : 'center'));
      }
      a += sweep;
    }
    if (cols > 1) out.push(textNode(spec.series[c] ?? `Series ${c + 1}`, cx, frame.y + frame.height - 2, o.fontSize, 'center'));
  }
  if (o.legend !== 'none') {
    const lx = frame.x + frame.width - legendW + 8;
    spec.categories.forEach((name, i) => {
      const ly = frame.y + i * (o.fontSize * 1.6);
      out.push(rectNode(lx, ly, o.fontSize, o.fontSize, colorOf(o, i), `Legend ${name}`));
      out.push(textNode(name, lx + o.fontSize + 6, ly + o.fontSize * 0.85, o.fontSize, 'left'));
    });
  }
  return out;
}

function buildRadar(spec: GraphSpec, frame: Rect): Node[] {
  const o = spec.options;
  const out: Node[] = [];
  const rows = spec.data.length;
  const cols = Math.max(...spec.data.map((r) => r.length));
  const { legendW } = layout(spec, frame);
  const cx = frame.x + (frame.width - legendW) / 2;
  const cy = frame.y + frame.height / 2;
  const R = Math.min(frame.width - legendW, frame.height) / 2 - o.fontSize * 2;
  let vmax = 0;
  for (const row of spec.data) for (const v of row) vmax = Math.max(vmax, Number(v) || 0);
  const range = niceRange(0, vmax, o.ticks);
  const rad = (v: number) => (v / (range.max || 1)) * R;
  const ang = (i: number) => -Math.PI / 2 + (i / rows) * Math.PI * 2;
  for (let t = range.step; t <= range.max + 1e-9; t += range.step) {
    const ring: Vec[] = [];
    for (let i = 0; i < rows; i++) ring.push({ x: cx + Math.cos(ang(i)) * rad(t), y: cy + Math.sin(ang(i)) * rad(t) });
    out.push(lineNode(ring, '#d3d3d8', 0.5, 'Grid', true));
    out.push(textNode(fmt(t), cx + 4, cy - rad(t) + o.fontSize * 0.35, o.fontSize * 0.8, 'left', '#8e8e93'));
  }
  for (let i = 0; i < rows; i++) {
    out.push(lineNode([{ x: cx, y: cy }, { x: cx + Math.cos(ang(i)) * R, y: cy + Math.sin(ang(i)) * R }], '#8e8e93', 0.75, 'Axis'));
    const lx = cx + Math.cos(ang(i)) * (R + o.fontSize * 0.8);
    const ly = cy + Math.sin(ang(i)) * (R + o.fontSize * 0.8) + o.fontSize * 0.35;
    out.push(textNode(spec.categories[i] ?? `${i + 1}`, lx, ly, o.fontSize, Math.cos(ang(i)) < -0.2 ? 'right' : Math.cos(ang(i)) > 0.2 ? 'left' : 'center'));
  }
  for (let c = 0; c < cols; c++) {
    const pts: Vec[] = [];
    for (let i = 0; i < rows; i++) {
      const v = Number(spec.data[i]?.[c] ?? 0) || 0;
      pts.push({ x: cx + Math.cos(ang(i)) * rad(v), y: cy + Math.sin(ang(i)) * rad(v) });
    }
    const color = colorOf(o, c);
    out.push(makePath([polylineSubPath(pts, true)], { fill: { type: 'solid', color, opacity: 0.25 }, stroke: defaultStroke({ paint: { type: 'solid', color, opacity: 1 }, width: 2, join: 'round' }), name: spec.series[c] ?? `Series ${c + 1}` }));
    if (o.markers) for (const p of pts) out.push(marker(p, color));
  }
  if (o.legend !== 'none') {
    const lx = frame.x + frame.width - legendW + 8;
    spec.series.forEach((name, i) => {
      const ly = frame.y + i * (o.fontSize * 1.6);
      out.push(rectNode(lx, ly, o.fontSize, o.fontSize, colorOf(o, i), `Legend ${name}`));
      out.push(textNode(name, lx + o.fontSize + 6, ly + o.fontSize * 0.85, o.fontSize, 'left'));
    });
  }
  return out;
}

/** Parse tab / comma separated text into a data table with optional header row and label column. */
export function parseTable(text: string): { data: number[][]; categories: string[]; series: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length);
  const rows = lines.map((l) => l.split(/\t|,|;/).map((c) => c.trim()));
  if (!rows.length) return { data: [], categories: [], series: [] };
  const isNum = (s: string) => s !== '' && Number.isFinite(Number(s));
  const headerRow = rows.length > 1 && rows[0].slice(1).some((c) => !isNum(c)) && !isNum(rows[0][0]);
  const body = rows.slice(headerRow ? 1 : 0);
  const labelCol = body.every((r) => !isNum(r[0]));
  const categories = labelCol ? body.map((r) => r[0]) : body.map((_, i) => `${i + 1}`);
  const data = body.map((r) => (labelCol ? r.slice(1) : r).map((c) => Number(c) || 0));
  const cols = Math.max(0, ...data.map((r) => r.length));
  let series: string[] = [];
  if (headerRow) {
    const h = rows[0];
    series = h.length > cols ? h.slice(h.length - cols) : h;
  }
  const ser = series.length ? series : Array.from({ length: cols }, (_, i) => `Series ${i + 1}`);
  return { data: data.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? 0)), categories, series: Array.from({ length: cols }, (_, i) => ser[i] ?? `Series ${i + 1}`) };
}

export function tableText(spec: Pick<GraphSpec, 'data' | 'categories' | 'series'>): string {
  const head = ['', ...spec.series].join('\t');
  const body = spec.data.map((r, i) => [spec.categories[i] ?? `${i + 1}`, ...r.map((v) => String(v))].join('\t'));
  return [head, ...body].join('\n');
}
