// Profile the Image Trace pipeline stage by stage on a real photo, inside the running editor page.
// usage: node profile.mjs <image path> [maxSize] [colors] [method]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const maxSize = Number(process.argv[3] ?? 640);
const colors = Number(process.argv[4] ?? 64);
const method = process.argv[5] ?? 'overlapping';
const ext = path.extname(file).slice(1).toLowerCase();
const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[page error]', m.text());
});
await page.goto('http://127.0.0.1:5180/');
await page.waitForFunction(() => !!window.__opuller?.raster);
await page.evaluate(() => window.__opuller.store.getState().closeDialog?.());

const result = await page.evaluate(
  async ({ dataUrl, maxSize, colors, method }) => {
    const api = window.__opuller;
    const R = api.raster;
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const k = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h);
    const t = {};
    let t0 = performance.now();
    const map = R.colorLabels({ width: w, height: h, data: data.data }, colors);
    t.quantize = performance.now() - t0;
    t0 = performance.now();
    R.removeSmallRegions(map, 3);
    t.despeckle = performance.now() - t0;
    const order = [];
    for (let i = 0; i < map.palette.length; i++) if (map.counts[i] > 0) order.push(i);
    order.sort((a, b) => map.counts[b] - map.counts[a]);
    const rank = new Int32Array(map.palette.length).fill(-1);
    order.forEach((l, i) => (rank[l] = i));
    const opts = R.potraceOptionsFor({ ...R.DEFAULT_VECTORIZE, paths: 85, corners: 60, noise: 3 });
    const n = w * h;
    const bitmap = new Uint8Array(n);
    const layers = [];
    let anchors = 0;
    let paths = 0;
    t0 = performance.now();
    for (let li = 0; li < order.length; li++) {
      const label = order[li];
      for (let i = 0; i < n; i++) {
        const l = map.labels[i];
        bitmap[i] = l >= 0 && (method === 'overlapping' ? rank[l] >= li : l === label) ? 1 : 0;
      }
      const s0 = performance.now();
      const sps = R.traceBitmap({ width: w, height: h, data: bitmap }, opts);
      const ms = performance.now() - s0;
      let a = 0;
      for (const sp of sps) a += sp.anchors.length;
      anchors += a;
      paths += sps.length;
      layers.push({ label, pixels: map.counts[label], paths: sps.length, anchors: a, ms: Math.round(ms) });
    }
    t.trace = performance.now() - t0;
    return { w, h, palette: map.palette.length, t, anchors, paths, slowest: layers.sort((a, b) => b.ms - a.ms).slice(0, 8) };
  },
  { dataUrl, maxSize, colors, method },
);
console.log(JSON.stringify(result, null, 1));
await browser.close();
