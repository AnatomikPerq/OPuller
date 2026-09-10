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
