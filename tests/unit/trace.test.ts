import { describe, it, expect } from 'vitest';
import { traceBitmap } from '@/raster/potrace';
import { thresholdLabels, grayLabels, colorLabels, removeSmallRegions, rgbToHex } from '@/raster/quantize';
import { vectorize, snapCurvesToLines, potraceOptionsFor, DEFAULT_VECTORIZE } from '@/raster/vectorize';
import { pathBounds, subpathArea, pointAt, segmentCount, pointInPath } from '@/geometry/path';
import type { SubPath } from '@/model/types';

function bitmap(w: number, h: number, on: (x: number, y: number) => boolean) {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = on(x, y) ? 1 : 0;
  return { width: w, height: h, data };
}

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number?]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a ?? 255;
    }
  return { width: w, height: h, data };
}

function maxRadiusError(sp: SubPath, cx: number, cy: number, r: number): number {
  let m = 0;
  const n = segmentCount(sp);
  for (let i = 0; i < n; i++) {
    for (let t = 0; t <= 1; t += 0.25) {
      const p = pointAt(sp, i, t);
      m = Math.max(m, Math.abs(Math.hypot(p.x - cx, p.y - cy) - r));
    }
  }
  return m;
}

describe('potrace', () => {
  it('traces a filled rectangle into one closed path with four corners', () => {
    const bm = bitmap(60, 40, (x, y) => x >= 10 && x < 50 && y >= 8 && y < 32);
    const sps = traceBitmap(bm, { turdSize: 2 });
    expect(sps.length).toBe(1);
    const sp = sps[0];
    expect(sp.closed).toBe(true);
    expect(sp.anchors.length).toBe(4);
    expect(sp.anchors.every((a) => !a.handleIn && !a.handleOut)).toBe(true);
    const b = pathBounds([sp])!;
    expect(b.x).toBeCloseTo(10, 5);
    expect(b.y).toBeCloseTo(8, 5);
    expect(b.width).toBeCloseTo(40, 5);
    expect(b.height).toBeCloseTo(24, 5);
  });

  it('traces a disc into a few smooth curves close to the true circle', () => {
    const bm = bitmap(120, 120, (x, y) => Math.hypot(x + 0.5 - 60, y + 0.5 - 60) <= 40);
    const sps = traceBitmap(bm);
    expect(sps.length).toBe(1);
    const sp = sps[0];
    expect(sp.anchors.length).toBeLessThan(16);
    expect(sp.anchors.some((a) => a.handleIn && a.handleOut)).toBe(true);
    expect(maxRadiusError(sp, 60, 60, 40)).toBeLessThan(1.2);
    expect(Math.abs(subpathArea(sp))).toBeGreaterThan(Math.PI * 40 * 40 * 0.97);
    expect(Math.abs(subpathArea(sp))).toBeLessThan(Math.PI * 40 * 40 * 1.03);
  });

  it('gives holes the opposite orientation and drops specks below the noise size', () => {
    const bm = bitmap(100, 100, (x, y) => {
      const d = Math.hypot(x + 0.5 - 50, y + 0.5 - 50);
      if (d <= 40 && d >= 20) return true;
      return x === 5 && y === 5; // one pixel speck
    });
    const sps = traceBitmap(bm, { turdSize: 2 });
    expect(sps.length).toBe(2);
    const areas = sps.map((sp) => subpathArea(sp));
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1]));
    const outer = sps[Math.abs(areas[0]) > Math.abs(areas[1]) ? 0 : 1];
    const hole = sps[Math.abs(areas[0]) > Math.abs(areas[1]) ? 1 : 0];
    expect(maxRadiusError(outer, 50, 50, 40)).toBeLessThan(1.2);
    expect(maxRadiusError(hole, 50, 50, 20)).toBeLessThan(1.2);
    // nonzero fill: the centre is empty, the ring is filled
    expect(pointInPath(sps, { x: 50, y: 50 }, 'nonzero')).toBe(false);
    expect(pointInPath(sps, { x: 50, y: 20 }, 'nonzero')).toBe(true);
    // with turdSize 0 the speck survives
    expect(traceBitmap(bm, { turdSize: 0 }).length).toBe(3);
  });

  it('alphaMax 0 produces polygons only', () => {
    const bm = bitmap(80, 80, (x, y) => Math.hypot(x + 0.5 - 40, y + 0.5 - 40) <= 30);
    const sps = traceBitmap(bm, { alphaMax: 0, optCurve: false });
    expect(sps[0].anchors.every((a) => !a.handleIn && !a.handleOut)).toBe(true);
    expect(sps[0].anchors.length).toBeGreaterThan(8);
  });
});

describe('quantize', () => {
  it('threshold splits black and white and keeps transparent pixels out', () => {
    const img = image(10, 2, (x, y) => (y === 1 ? [0, 0, 0, 0] : x < 5 ? [20, 20, 20] : [240, 240, 240]));
    const m = thresholdLabels(img, 128);
    expect(m.counts).toEqual([5, 5]);
    expect(Array.from(m.labels.slice(10))).toEqual(new Array(10).fill(-1));
    expect(rgbToHex(m.palette[0])).toBe('#000000');
  });

  it('grey levels cluster the luminance histogram', () => {
    const img = image(30, 1, (x) => (x < 10 ? [10, 10, 10] : x < 20 ? [128, 128, 128] : [250, 250, 250]));
    const m = grayLabels(img, 3);
    expect(m.palette.length).toBe(3);
    expect(new Set(Array.from(m.labels)).size).toBe(3);
    const hex = m.palette.map(rgbToHex).sort();
    expect(hex).toEqual(['#0a0a0a', '#808080', '#fafafa']);
  });

  it('colour palettes find the dominant colours and small regions merge into their neighbours', () => {
    const img = image(40, 40, (x, y) => (x >= 25 && x < 31 && y >= 17 && y < 23 ? [0, 255, 0] : x < 20 ? [255, 0, 0] : [0, 0, 255]));
    const m = colorLabels(img, 3);
    const hex = m.palette.map(rgbToHex);
    expect(hex).toContain('#ff0000');
    expect(hex).toContain('#0000ff');
    expect(hex).toContain('#00ff00');
    const green = hex.indexOf('#00ff00');
    expect(m.counts[green]).toBe(36);
    removeSmallRegions(m, 50);
    expect(m.counts[green]).toBe(0);
    expect(m.counts.reduce((a, b) => a + b, 0)).toBe(1600);
    expect(m.labels[20 * 40 + 27]).toBe(hex.indexOf('#0000ff'));
  });
});

describe('vectorize', () => {
  it('traces a two colour image into stacked layers covering the picture', () => {
    const img = image(80, 60, (x) => (x < 40 ? [255, 0, 0] : [0, 0, 255]));
    const r = vectorize(img, { mode: 'color', colors: 4, noise: 2, method: 'overlapping' });
    expect(r.layers.length).toBe(2);
    expect(r.layers.map((l) => l.color).sort()).toEqual(['#0000ff', '#ff0000']);
    // bottom layer covers the whole image, the top one its half
    const bottom = pathBounds(r.layers[0].subpaths)!;
    expect(bottom.width).toBeCloseTo(80, 3);
    expect(bottom.height).toBeCloseTo(60, 3);
    const top = pathBounds(r.layers[1].subpaths)!;
    expect(top.width).toBeCloseTo(40, 3);
    expect(r.anchors).toBeGreaterThan(0);
    // abutting: each layer is its own region
    const cut = vectorize(img, { mode: 'color', colors: 4, noise: 2, method: 'abutting' });
    expect(cut.layers.every((l) => Math.abs(pathBounds(l.subpaths)!.width - 40) < 1e-6)).toBe(true);
  });

  it('black & white with ignore white traces only the dark shape', () => {
    const img = image(60, 60, (x, y) => (Math.hypot(x + 0.5 - 30, y + 0.5 - 30) <= 20 ? [0, 0, 0] : [255, 255, 255]));
    const r = vectorize(img, { mode: 'bw', threshold: 128, ignoreWhite: true, noise: 2 });
    expect(r.layers.length).toBe(1);
    expect(r.layers[0].color).toBe('#000000');
    expect(maxRadiusError(r.layers[0].subpaths[0], 30, 30, 20)).toBeLessThan(1.3);
    const both = vectorize(img, { mode: 'bw', threshold: 128, ignoreWhite: false, noise: 2 });
    expect(both.layers.length).toBe(2);
    expect(both.layers[0].color).toBe('#ffffff');
  });

  it('snap curves to lines straightens nearly straight segments and the sliders map to potrace parameters', () => {
    const sp: SubPath = { closed: false, anchors: [{ point: { x: 0, y: 0 }, handleIn: null, handleOut: { x: 30, y: 0.2 }, kind: 'corner' }, { point: { x: 100, y: 0 }, handleIn: { x: -30, y: -0.1 }, handleOut: { x: 0, y: 40 }, kind: 'corner' }, { point: { x: 100, y: 100 }, handleIn: { x: -40, y: 0 }, handleOut: null, kind: 'corner' }] };
    const out = snapCurvesToLines(sp);
    expect(out.anchors[0].handleOut).toBeNull();
    expect(out.anchors[1].handleIn).toBeNull();
    expect(out.anchors[1].handleOut).not.toBeNull();
    expect(potraceOptionsFor({ ...DEFAULT_VECTORIZE, paths: 50, corners: 0, noise: 7 })).toMatchObject({ turdSize: 7, alphaMax: 1.334, optTolerance: 0.2 });
    expect(potraceOptionsFor({ ...DEFAULT_VECTORIZE, paths: 100 }).optTolerance).toBeCloseTo(0.05);
    expect(potraceOptionsFor({ ...DEFAULT_VECTORIZE, corners: 100 }).alphaMax).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Strokes (centerline tracing)
// ---------------------------------------------------------------------------
import { chamferDistance, thinZhangSuen, skeletonPolylines, simplifyPolyline, fitCurve, polylineToSubPath, traceStrokes } from '@/raster/centerline';

describe('centerline tracing', () => {
  it('measures distances to the background and splits thick from thin features', () => {
    // a 40x40 block plus a 3 px wide horizontal line
    const w = 120;
    const h = 60;
    const fg = new Uint8Array(w * h);
    for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) fg[y * w + x] = 1;
    for (let y = 28; y < 31; y++) for (let x = 60; x < 110; x++) fg[y * w + x] = 1;
    const bg = fg.map((v) => (v ? 0 : 1));
    const dist = chamferDistance(bg, w, h);
    expect(dist[30 * w + 30]).toBeGreaterThan(15); // block centre
    expect(dist[29 * w + 80]).toBeCloseTo(2, 0); // line centre: 2 px to the background
    expect(dist[5 * w + 5]).toBe(0);
    // seeds with negative offsets give the union of discs
    const seed = new Uint8Array(w * h);
    const off = new Float32Array(w * h);
    seed[30 * w + 30] = 1;
    off[30 * w + 30] = -10;
    const disc = chamferDistance(seed, w, h, off);
    expect(disc[30 * w + 38]).toBeLessThanOrEqual(0);
    expect(disc[30 * w + 42]).toBeGreaterThan(0);
    const split = traceStrokes(fg, w, h, { maxWeight: 10, minLength: 20, tolerance: 0.6 });
    expect(split.thick[30 * w + 30]).toBe(1);
    expect(split.thin[30 * w + 30]).toBe(0);
    expect(split.thin[29 * w + 80]).toBe(1);
    expect(split.thick[29 * w + 80]).toBe(0);
    // the block keeps its corners
    expect(split.thick[10 * w + 10]).toBe(1);
    expect(split.thick[49 * w + 49]).toBe(1);
    // every foreground pixel is either thin or thick
    for (let i = 0; i < w * h; i++) expect(split.thin[i] + split.thick[i]).toBe(fg[i]);
    expect(split.strokes.length).toBe(1);
  });

  it('thins a line to a one pixel skeleton and walks it into one polyline', () => {
    const w = 80;
    const h = 20;
    const mask = new Uint8Array(w * h);
    for (let y = 8; y < 12; y++) for (let x = 5; x < 70; x++) mask[y * w + x] = 1;
    const skel = thinZhangSuen(mask, w, h);
    let count = 0;
    for (let i = 0; i < skel.length; i++) count += skel[i];
    expect(count).toBeGreaterThan(55);
    expect(count).toBeLessThan(70);
    const polys = skeletonPolylines(skel, w, h);
    expect(polys.length).toBe(1);
    expect(polys[0].closed).toBe(false);
    expect(polys[0].pixels.length).toBe(count);
    // a T junction: three polylines meeting at the junction
    for (let y = 12; y < 18; y++) for (let x = 36; x < 40; x++) mask[y * w + x] = 1;
    const polysT = skeletonPolylines(thinZhangSuen(mask, w, h), w, h);
    expect(polysT.length).toBeGreaterThanOrEqual(3);
  });

  it('simplifies and fits polylines into smooth curves within the tolerance', () => {
    const pts = [];
    for (let i = 0; i <= 100; i++) pts.push({ x: i, y: Math.sin(i / 12) * 10 });
    const simple = simplifyPolyline(pts, 0.5);
    expect(simple.length).toBeLessThan(pts.length / 2);
    expect(simple[0]).toEqual(pts[0]);
    const cubics = fitCurve(pts, 0.5);
    expect(cubics.length).toBeGreaterThan(1);
    expect(cubics.length).toBeLessThan(12);
    const sp = polylineToSubPath(pts, false, 0.5)!;
    expect(sp.closed).toBe(false);
    expect(sp.anchors[0].point).toEqual(pts[0]);
    expect(sp.anchors[sp.anchors.length - 1].point).toEqual(pts[100]);
    expect(sp.anchors.some((a) => a.handleIn && a.handleOut)).toBe(true);
    // an L shape keeps its corner
    const L = [];
    for (let i = 0; i <= 40; i++) L.push({ x: i, y: 0 });
    for (let i = 1; i <= 40; i++) L.push({ x: 40, y: i });
    const lsp = polylineToSubPath(L, false, 0.5)!;
    expect(lsp.anchors.some((a) => Math.abs(a.point.x - 40) < 1e-6 && Math.abs(a.point.y) < 1e-6)).toBe(true);
  });

  it('traces thin features as strokes with their measured width and drops short ones', () => {
    const w = 120;
    const h = 60;
    const fg = new Uint8Array(w * h);
    for (let y = 28; y < 31; y++) for (let x = 10; x < 110; x++) fg[y * w + x] = 1; // 100 px long, 3 px wide
    for (let y = 5; y < 6; y++) for (let x = 50; x < 58; x++) fg[y * w + x] = 1; // 8 px speck line
    const strokes = traceStrokes(fg, w, h, { maxWeight: 10, minLength: 20, tolerance: 0.6 }).strokes;
    expect(strokes.length).toBe(1);
    expect(strokes[0].width).toBeCloseTo(3, 0);
    expect(strokes[0].length).toBeGreaterThan(90);
    expect(strokes[0].subpath.closed).toBe(false);
    const xs = strokes[0].subpath.anchors.map((a) => a.point.x);
    expect(Math.min(...xs)).toBeLessThan(14);
    expect(Math.max(...xs)).toBeGreaterThan(106);
    for (const a of strokes[0].subpath.anchors) expect(Math.abs(a.point.y - 29.5)).toBeLessThan(1.2);
  });

  it('vectorize with Strokes turns thin lines into stroked paths and keeps thick shapes as fills', () => {
    const img = image(140, 100, (x, y) => {
      const block = x >= 10 && x < 60 && y >= 10 && y < 60;
      const line = y >= 78 && y < 81 && x >= 10 && x < 130;
      return block || line ? [0, 0, 0] : [255, 255, 255];
    });
    const r = vectorize(img, { mode: 'bw', threshold: 128, ignoreWhite: true, noise: 2, fills: true, strokes: true, maxStrokeWeight: 10, minStrokeLength: 20 });
    expect(r.layers.length).toBe(1);
    const layer = r.layers[0];
    expect(layer.subpaths.length).toBe(1); // the block
    expect(layer.strokes.length).toBe(1); // the line
    expect(layer.strokes[0].width).toBeCloseTo(3, 0);
    const b = pathBounds(layer.subpaths)!;
    expect(b.width).toBeCloseTo(50, 0);
    // strokes only: the block is ignored
    const only = vectorize(img, { mode: 'bw', threshold: 128, ignoreWhite: true, noise: 2, fills: false, strokes: true, maxStrokeWeight: 10, minStrokeLength: 20 });
    expect(only.layers[0].subpaths.length).toBe(0);
    expect(only.layers[0].strokes.length).toBe(1);
    // a large max weight still only turns elongated features into strokes (a solid block has no centerline)
    const all = vectorize(img, { mode: 'bw', threshold: 128, ignoreWhite: true, noise: 2, fills: false, strokes: true, maxStrokeWeight: 100, minStrokeLength: 20 });
    expect(all.layers[0].strokes.length).toBe(1);
    expect(all.layers[0].subpaths.length).toBe(0);
  });
});
