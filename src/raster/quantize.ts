/**
 * Colour reduction for Image Trace: threshold (black & white), grey levels and
 * colour palettes (median cut + k-means), plus a despeckle pass that merges
 * regions smaller than a given area into their neighbours. Pure code (no
 * DOM) so it runs in a Web Worker and in vitest.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** RGBA pixels (as in ImageData). */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Per pixel palette index (-1 = transparent / background). */
export interface LabelMap {
  width: number;
  height: number;
  labels: Int32Array;
  palette: RGB[];
  /** pixels per palette entry */
  counts: number[];
}

export const ALPHA_CUTOFF = 128;

export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function rgbToHex(c: RGB): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function countLabels(labels: Int32Array, n: number): number[] {
  const counts = new Array<number>(n).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l >= 0) counts[l]++;
  }
  return counts;
}

/** Black & white: pixels darker than `threshold` (0..255) are label 0 (black), the rest label 1 (white). */
export function thresholdLabels(img: RasterImage, threshold: number): LabelMap {
  const n = img.width * img.height;
  const labels = new Int32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] < ALPHA_CUTOFF) {
      labels[i] = -1;
      continue;
    }
    labels[i] = luminance(d[o], d[o + 1], d[o + 2]) < threshold ? 0 : 1;
  }
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
  ];
  return { width: img.width, height: img.height, labels, palette, counts: countLabels(labels, 2) };
}

/** Grey levels: k-means on the luminance histogram. */
export function grayLabels(img: RasterImage, levels: number): LabelMap {
  const k = Math.max(2, Math.min(256, Math.round(levels)));
  const n = img.width * img.height;
  const d = img.data;
  const hist = new Float64Array(256);
  const lum = new Uint8Array(n);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] < ALPHA_CUTOFF) continue;
    const l = Math.round(luminance(d[o], d[o + 1], d[o + 2]));
    lum[i] = l;
    hist[l]++;
    opaque++;
  }
  // initial centres spread over the occupied range
  let lo = 0;
  let hi = 255;
  while (lo < 255 && hist[lo] === 0) lo++;
  while (hi > 0 && hist[hi] === 0) hi--;
  const centres: number[] = [];
  for (let i = 0; i < k; i++) centres.push(k === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (k - 1));
  const assign = new Int32Array(256);
  if (opaque > 0) {
    for (let iter = 0; iter < 20; iter++) {
      // assign histogram bins to the nearest centre
      let c = 0;
      for (let v = 0; v < 256; v++) {
        while (c + 1 < centres.length && Math.abs(centres[c + 1] - v) <= Math.abs(centres[c] - v)) c++;
        assign[v] = c;
      }
      const sum = new Float64Array(centres.length);
      const cnt = new Float64Array(centres.length);
      for (let v = 0; v < 256; v++) {
        sum[assign[v]] += v * hist[v];
        cnt[assign[v]] += hist[v];
      }
      let moved = 0;
      for (let c2 = 0; c2 < centres.length; c2++) {
        if (cnt[c2] === 0) continue;
        const next = sum[c2] / cnt[c2];
        moved += Math.abs(next - centres[c2]);
        centres[c2] = next;
      }
      if (moved < 0.01) break;
    }
  }
  // final assignment and palette (drop empty levels)
  const used = new Int32Array(centres.length).fill(-1);
  const palette: RGB[] = [];
  const labels = new Int32Array(n);
  for (let v = 0; v < 256; v++) {
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < centres.length; c++) {
      const dd = Math.abs(centres[c] - v);
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
    assign[v] = best;
  }
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] < ALPHA_CUTOFF) {
      labels[i] = -1;
      continue;
    }
    const c = assign[lum[i]];
    if (used[c] < 0) {
      used[c] = palette.length;
      const g = Math.round(centres[c]);
      palette.push({ r: g, g, b: g });
    }
    labels[i] = used[c];
  }
  return { width: img.width, height: img.height, labels, palette, counts: countLabels(labels, palette.length) };
}

interface Box {
  /** indices into the sample arrays */
  start: number;
  end: number;
}

/** Median cut over an array of packed samples; returns cluster centres. */
function medianCut(samples: Int32Array, k: number): RGB[] {
  const n = samples.length;
  if (!n) return [];
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const R = (i: number) => (samples[idx[i]] >> 16) & 255;
  const G = (i: number) => (samples[idx[i]] >> 8) & 255;
  const B = (i: number) => samples[idx[i]] & 255;
  const boxes: Box[] = [{ start: 0, end: n }];
  while (boxes.length < k) {
    // split the box with the largest range
    let bi = -1;
    let bestRange = -1;
    let bestChan = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.end - box.start < 2) continue;
      let rMin = 255,
        rMax = 0,
        gMin = 255,
        gMax = 0,
        bMin = 255,
        bMax = 0;
      for (let i = box.start; i < box.end; i++) {
        const r = R(i);
        const g = G(i);
        const bb = B(i);
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
        if (bb < bMin) bMin = bb;
        if (bb > bMax) bMax = bb;
      }
      const ranges = [(rMax - rMin) * 1.0, (gMax - gMin) * 1.2, (bMax - bMin) * 0.8];
      let chan = 0;
      if (ranges[1] > ranges[chan]) chan = 1;
      if (ranges[2] > ranges[chan]) chan = 2;
      if (ranges[chan] > bestRange) {
        bestRange = ranges[chan];
        bi = b;
        bestChan = chan;
      }
    }
    if (bi < 0 || bestRange <= 0) break;
    const box = boxes[bi];
    const sub = Array.from(idx.subarray(box.start, box.end));
    const shift = bestChan === 0 ? 16 : bestChan === 1 ? 8 : 0;
    sub.sort((a, b) => ((samples[a] >> shift) & 255) - ((samples[b] >> shift) & 255));
    for (let i = 0; i < sub.length; i++) idx[box.start + i] = sub[i];
    const mid = box.start + Math.floor(sub.length / 2);
    boxes.splice(bi, 1, { start: box.start, end: mid }, { start: mid, end: box.end });
  }
  const centres: RGB[] = [];
  for (const box of boxes) {
    let r = 0,
      g = 0,
      b = 0;
    const cnt = box.end - box.start;
    if (!cnt) continue;
    for (let i = box.start; i < box.end; i++) {
      r += R(i);
      g += G(i);
      b += B(i);
    }
    centres.push({ r: r / cnt, g: g / cnt, b: b / cnt });
  }
  return centres;
}

/** Perceptually weighted squared distance between colours. */
function dist2(a: RGB, r: number, g: number, b: number): number {
  return (a.r - r) * (a.r - r) * 2 + (a.g - g) * (a.g - g) * 4 + (a.b - b) * (a.b - b) * 3;
}

/** Lloyd iterations over packed samples; empty clusters are dropped. Returns centres with their sample counts. */
function kmeans(packed: Int32Array, centres: RGB[], iterations: number): { centres: RGB[]; counts: number[] } {
  let cur = centres;
  let counts: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    const sums = new Float64Array(cur.length * 3);
    const cnt = new Float64Array(cur.length);
    for (let i = 0; i < packed.length; i++) {
      const v = packed[i];
      const r = (v >> 16) & 255;
      const g = (v >> 8) & 255;
      const b = v & 255;
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < cur.length; c++) {
        const dd = dist2(cur[c], r, g, b);
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      sums[best * 3] += r;
      sums[best * 3 + 1] += g;
      sums[best * 3 + 2] += b;
      cnt[best]++;
    }
    let moved = 0;
    const next: RGB[] = [];
    counts = [];
    for (let c = 0; c < cur.length; c++) {
      if (cnt[c] === 0) continue;
      const nc = { r: sums[c * 3] / cnt[c], g: sums[c * 3 + 1] / cnt[c], b: sums[c * 3 + 2] / cnt[c] };
      moved += Math.abs(nc.r - cur[c].r) + Math.abs(nc.g - cur[c].g) + Math.abs(nc.b - cur[c].b);
      next.push(nc);
      counts.push(cnt[c]);
    }
    cur = next;
    if (moved < 0.5) break;
  }
  return { centres: cur, counts };
}

/**
 * Ward's agglomerative merging: repeatedly join the two clusters whose merge
 * increases the within-cluster variance the least, so small but distinct
 * colours survive while similar shades of large areas are combined.
 */
function wardMerge(centres: RGB[], counts: number[], k: number): RGB[] {
  const cs = centres.map((c) => ({ ...c }));
  const ns = counts.slice();
  while (cs.length > k) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const cost = ((ns[i] * ns[j]) / (ns[i] + ns[j])) * dist2(cs[i], cs[j].r, cs[j].g, cs[j].b);
        if (cost < best) {
          best = cost;
          bi = i;
          bj = j;
        }
      }
    }
    const n = ns[bi] + ns[bj];
    cs[bi] = { r: (cs[bi].r * ns[bi] + cs[bj].r * ns[bj]) / n, g: (cs[bi].g * ns[bi] + cs[bj].g * ns[bj]) / n, b: (cs[bi].b * ns[bi] + cs[bj].b * ns[bj]) / n };
    ns[bi] = n;
    cs.splice(bj, 1);
    ns.splice(bj, 1);
  }
  return cs;
}

/**
 * Colour palette: the picture is over-segmented with median cut + k-means,
 * the clusters are merged down to `colors` with Ward's criterion (keeps small
 * distinct colours such as text or outlines), refined again and then every
 * pixel is assigned.
 */
export function colorLabels(img: RasterImage, colors: number): LabelMap {
  const k = Math.max(2, Math.min(256, Math.round(colors)));
  const n = img.width * img.height;
  const d = img.data;
  // sample opaque pixels (at most ~60k)
  let opaque = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] >= ALPHA_CUTOFF) opaque++;
  const stride = Math.max(1, Math.floor(opaque / 60000));
  const samples: number[] = [];
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] < ALPHA_CUTOFF) continue;
    if (seen++ % stride) continue;
    samples.push((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]);
  }
  const packed = Int32Array.from(samples);
  const over = Math.min(160, Math.max(k, k * 4, 32));
  let centres = medianCut(packed, over);
  if (!centres.length) return { width: img.width, height: img.height, labels: new Int32Array(n).fill(-1), palette: [], counts: [] };
  const fine = kmeans(packed, centres, 4);
  centres = fine.centres.length > k ? wardMerge(fine.centres, fine.counts, k) : fine.centres;
  centres = kmeans(packed, centres, 4).centres;
  // assign every pixel (cache by 15-bit colour key)
  const cache = new Int32Array(32768).fill(-1);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] < ALPHA_CUTOFF) {
      labels[i] = -1;
      continue;
    }
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let c = cache[key];
    if (c < 0) {
      let bd = Infinity;
      c = 0;
      for (let j = 0; j < centres.length; j++) {
        const dd = dist2(centres[j], r, g, b);
        if (dd < bd) {
          bd = dd;
          c = j;
        }
      }
      cache[key] = c;
    }
    labels[i] = c;
  }
  // final palette = mean of the assigned pixels (exact colours of the result)
  const sums = new Float64Array(centres.length * 3);
  const counts = new Array<number>(centres.length).fill(0);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l < 0) continue;
    const o = i * 4;
    sums[l * 3] += d[o];
    sums[l * 3 + 1] += d[o + 1];
    sums[l * 3 + 2] += d[o + 2];
    counts[l]++;
  }
  const palette: RGB[] = centres.map((c, i) => (counts[i] ? { r: Math.round(sums[i * 3] / counts[i]), g: Math.round(sums[i * 3 + 1] / counts[i]), b: Math.round(sums[i * 3 + 2] / counts[i]) } : { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }));
  return compact({ width: img.width, height: img.height, labels, palette, counts });
}

/** Drop unused palette entries and renumber. */
export function compact(map: LabelMap): LabelMap {
  const remap = new Int32Array(map.palette.length).fill(-1);
  const palette: RGB[] = [];
  const counts: number[] = [];
  for (let i = 0; i < map.palette.length; i++) {
    if (!map.counts[i]) continue;
    remap[i] = palette.length;
    palette.push(map.palette[i]);
    counts.push(map.counts[i]);
  }
  if (palette.length === map.palette.length) return map;
  const labels = map.labels;
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]];
  return { ...map, labels, palette, counts };
}

/**
 * Merge connected regions (4-neighbourhood) smaller than `minSize` pixels
 * into the most common label around them. Works in place and updates counts.
 */
export function removeSmallRegions(map: LabelMap, minSize: number): void {
  if (minSize <= 1) return;
  const { width: w, height: h, labels } = map;
  const n = w * h;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const region: number[] = [];
  const neighbours = new Map<number, number>();
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    const label = labels[start];
    // flood fill
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    region.length = 0;
    neighbours.clear();
    while (sp > 0) {
      const i = stack[--sp];
      region.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const check = (j: number) => {
        const l = labels[j];
        if (l === label) {
          if (!visited[j]) {
            visited[j] = 1;
            stack[sp++] = j;
          }
        } else neighbours.set(l, (neighbours.get(l) ?? 0) + 1);
      };
      if (x > 0) check(i - 1);
      if (x < w - 1) check(i + 1);
      if (y > 0) check(i - w);
      if (y < h - 1) check(i + w);
      if (region.length >= minSize && neighbours.size === 0) {
        // big enough and nothing to merge into anyway: keep draining without bookkeeping
      }
    }
    if (region.length >= minSize || !neighbours.size) continue;
    let best = label;
    let bestCount = -1;
    for (const [l, c] of neighbours) {
      if (c > bestCount) {
        bestCount = c;
        best = l;
      }
    }
    if (best === label) continue;
    for (const i of region) labels[i] = best;
    if (label >= 0) map.counts[label] -= region.length;
    if (best >= 0) map.counts[best] += region.length;
  }
}
