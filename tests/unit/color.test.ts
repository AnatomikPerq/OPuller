import { describe, it, expect } from 'vitest';
import { hexToChannels, channelsToHex, rgbToCmyk, cmykToRgb, rgbToGray, spectrumColorAt, channelTrackCss, invertHex, complementHex, clampChannels } from '@/color/models';
import { activeSolid, withActiveColor, paintEquals, isGradient } from '@/color/paint';
import { colorAtOffset, addStopAt, removeStop, reverseGradient, linearAngle, withLinearAngle, toGradient, convertGradientType, gradientColorAt, applySpread, stopsCss, GRADIENT_PRESETS } from '@/color/gradient';
import { gradientFrame, bboxToWorld, worldToBbox, linearWorldPoints, radialWorldPoints, radialRadiusFromWorld, clampFocal } from '@/color/annotator';
import { dashPairs, pairsToDash, profilePoints, detectProfile, flipProfile, profilePreviewPath, strokeSummary, MIXED } from '@/color/stroke';
import { parseSwatchesJson, exportSwatchesJson, sanitizePaint, nodesUsingPaint, replacePaintInDoc, moveItem, uniqueSwatchName, findSwatchByPaint } from '@/color/swatches';
import { SWATCH_LIBRARIES } from '@/color/libraries';
import { projectOnSegment, constrainTo45, hitAnnotator, buildAnnotator, type AnnotatorModel } from '@/tools/gradient/model';
import { createDocument, makeShape, makeGroup } from '@/model/nodes';
import { addNode } from '@/model/document';
import { multiply, translate, rotate } from '@/geometry/matrix';
import { useStore } from '@/store/store';
import type { Document, LinearGradientPaint, RadialGradientPaint, Paint } from '@/model/types';

const LIN: LinearGradientPaint = { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, spread: 'pad', stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] };
const RAD: RadialGradientPaint = { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, spread: 'pad', stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 0 }] };

describe('colour models', () => {
  it('round-trips hex through every mode', () => {
    for (const mode of ['hsb', 'rgb', 'hsl', 'cmyk'] as const) {
      for (const hex of ['#7a1f3d', '#00ff00', '#123456', '#ffffff', '#000000']) {
        expect(channelsToHex(mode, hexToChannels(mode, hex))).toBe(hex);
      }
    }
    expect(channelsToHex('gray', hexToChannels('gray', '#808080'))).toBe('#808080');
  });
  it('approximates CMYK and grayscale', () => {
    expect(rgbToCmyk({ r: 255, g: 0, b: 0 })).toEqual({ c: 0, m: 100, y: 100, k: 0 });
    expect(rgbToCmyk({ r: 0, g: 0, b: 0 }).k).toBe(100);
    const back = cmykToRgb({ c: 0, m: 100, y: 100, k: 0 });
    expect(Math.round(back.r)).toBe(255);
    expect(Math.round(back.g)).toBe(0);
    expect(rgbToGray({ r: 255, g: 255, b: 255 })).toBe(0);
    expect(rgbToGray({ r: 0, g: 0, b: 0 })).toBe(100);
  });
  it('spectrum bar: white on top, pure hue in the middle, black at the bottom', () => {
    expect(spectrumColorAt(0, 0)).toBe('#ffffff');
    expect(spectrumColorAt(0, 0.5)).toBe('#ff0000');
    expect(spectrumColorAt(1 / 3, 0.5)).toBe('#00ff00');
    expect(spectrumColorAt(0.2, 1)).toBe('#000000');
  });
  it('builds preview tracks and clamps channels', () => {
    const css = channelTrackCss('rgb', 0, [0, 0, 0], 4);
    expect(css.startsWith('linear-gradient(to right, #000000 0.0%')).toBe(true);
    expect(css).toContain('#ff0000 100.0%');
    expect(clampChannels('hsb', [400, -5, 50])).toEqual([360, 0, 50]);
    expect(invertHex('#ff0000')).toBe('#00ffff');
    expect(complementHex('#ff0000')).toBe('#00ffff');
  });
});

describe('paint helpers', () => {
  it('reads and writes the active colour of solids and gradient stops', () => {
    expect(activeSolid({ type: 'none' })).toEqual({ type: 'solid', color: '#000000', opacity: 1 });
    expect(activeSolid(LIN, 1).color).toBe('#ffffff');
    expect(activeSolid(LIN, 99).color).toBe('#ffffff');
    const p = withActiveColor(LIN, 1, { color: '#ff0000' }) as LinearGradientPaint;
    expect(p.type).toBe('linear');
    expect(p.stops[1].color).toBe('#ff0000');
    expect(p.stops[0].color).toBe('#000000');
    expect(withActiveColor({ type: 'none' }, 0, { color: '#123456' })).toEqual({ type: 'solid', color: '#123456', opacity: 1 });
    expect(withActiveColor({ type: 'solid', color: '#000000', opacity: 1 }, 0, { opacity: 0.5 })).toEqual({ type: 'solid', color: '#000000', opacity: 0.5 });
    expect(paintEquals(LIN, { ...LIN })).toBe(true);
    expect(isGradient(RAD)).toBe(true);
  });
});

describe('gradients', () => {
  it('interpolates stop colours', () => {
    expect(colorAtOffset(LIN.stops, 0.5).color).toBe('#808080');
    expect(colorAtOffset(RAD.stops, 0.5)).toEqual({ color: '#800080', opacity: 0.5 });
    expect(colorAtOffset(LIN.stops, -1).color).toBe('#000000');
    expect(colorAtOffset(LIN.stops, 2).color).toBe('#ffffff');
  });
  it('adds, removes and reverses stops', () => {
    const { paint, index } = addStopAt(LIN, 0.25);
    expect(index).toBe(2);
    expect(paint.stops[2]).toEqual({ offset: 0.25, color: '#404040', opacity: 1 });
    expect(removeStop(LIN, 0)).toBe(LIN); // never below two stops
    expect(removeStop(paint, 2).stops.length).toBe(2);
    const r = reverseGradient(LIN);
    expect(r.stops[0]).toEqual({ offset: 0, color: '#ffffff', opacity: 1 });
    expect(r.stops[1]).toEqual({ offset: 1, color: '#000000', opacity: 1 });
    expect(stopsCss(RAD.stops)).toContain('rgba(0, 0, 255, 0) 100.00%');
  });
  it('measures and sets the angle in object space (Illustrator convention)', () => {
    expect(linearAngle(LIN)).toBe(0);
    expect(linearAngle({ ...LIN, x1: 0.5, y1: 1, x2: 0.5, y2: 0 })).toBeCloseTo(90);
    expect(linearAngle({ ...LIN, x1: 0.5, y1: 0, x2: 0.5, y2: 1 })).toBeCloseTo(-90);
    // a 2:1 box: the diagonal in bbox units is 45deg in object space only when aspect = 1
    expect(linearAngle({ ...LIN, x1: 0, y1: 0, x2: 1, y2: 1 }, 2)).toBeCloseTo(-26.565, 2);
    const rot = withLinearAngle(LIN, 90);
    expect(rot.x1).toBeCloseTo(0.5);
    expect(rot.x2).toBeCloseTo(0.5);
    expect(rot.y1).toBeCloseTo(1);
    expect(rot.y2).toBeCloseTo(0);
    expect(linearAngle(rot)).toBeCloseTo(90);
    // centre and length are preserved
    const g2 = withLinearAngle({ ...LIN, x1: 0.25, x2: 0.75 }, 45, 1);
    expect((g2.x1 + g2.x2) / 2).toBeCloseTo(0.5);
    expect(Math.hypot(g2.x2 - g2.x1, g2.y2 - g2.y1)).toBeCloseTo(0.5);
  });
  it('converts solids and between types', () => {
    const g = toGradient({ type: 'solid', color: '#ff9500', opacity: 0.5 }, 'linear');
    expect(g.type).toBe('linear');
    expect(g.stops[0]).toEqual({ offset: 0, color: '#ff9500', opacity: 0.5 });
    expect(toGradient({ type: 'none' }, 'radial').type).toBe('radial');
    expect(toGradient(LIN, 'linear')).toBe(LIN);
    const r = convertGradientType(LIN, 'radial') as RadialGradientPaint;
    expect(r.cx).toBeCloseTo(0.5);
    expect(r.r).toBeCloseTo(0.5);
    const l = convertGradientType(RAD, 'linear') as LinearGradientPaint;
    expect(l.x1).toBeCloseTo(0);
    expect(l.x2).toBeCloseTo(1);
  });
  it('samples gradient colours at bbox points with spread methods', () => {
    expect(gradientColorAt(LIN, 0.5, 0.2).color).toBe('#808080');
    expect(gradientColorAt(LIN, 3, 0.2).color).toBe('#ffffff');
    expect(gradientColorAt({ ...LIN, spread: 'repeat' }, 1.5, 0).color).toBe('#808080');
    expect(gradientColorAt({ ...LIN, spread: 'reflect' }, 1.5, 0).color).toBe('#808080');
    expect(gradientColorAt(RAD, 0.5, 0.5).color).toBe('#ff0000');
    expect(gradientColorAt(RAD, 1, 0.5).opacity).toBe(0);
    expect(applySpread(2.25, 'repeat')).toBeCloseTo(0.25);
    expect(applySpread(1.25, 'reflect')).toBeCloseTo(0.75);
  });
  it('ships valid presets', () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(12);
    for (const p of GRADIENT_PRESETS) {
      expect(p.paint.stops.length).toBeGreaterThanOrEqual(2);
      for (const s of p.paint.stops) expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(GRADIENT_PRESETS.filter((p) => /burgundy/i.test(p.name)).length).toBeGreaterThanOrEqual(2);
  });
});

function docWithRect(x = 100, y = 100, w = 200, h = 100, transform = translate(x, y)): { doc: Document; id: string } {
  const doc = createDocument({ width: 800, height: 600 });
  const rect = makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform });
  addNode(doc, rect, doc.layers[0]);
  return { doc, id: rect.id };
}

describe('gradient annotator geometry', () => {
  it('maps bbox units to world space and back', () => {
    const { doc, id } = docWithRect();
    const f = gradientFrame(doc, id)!;
    expect(f.bounds).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    const pts = linearWorldPoints(f, LIN);
    expect(pts.start).toEqual({ x: 100, y: 150 });
    expect(pts.end).toEqual({ x: 300, y: 150 });
    const uv = worldToBbox(f, { x: 150, y: 125 });
    expect(uv).toEqual({ u: 0.25, v: 0.25 });
    expect(bboxToWorld(f, uv.u, uv.v)).toEqual({ x: 150, y: 125 });
  });
  it('follows rotated nodes inside transformed groups', () => {
    const doc = createDocument({ width: 800, height: 600 });
    const g = makeGroup([], { transform: multiply(translate(300, 200), rotate(90)) });
    addNode(doc, g, doc.layers[0]);
    const rect = makeShape({ kind: 'rect', width: 100, height: 50, radii: [0, 0, 0, 0] }, { transform: translate(10, 0) });
    addNode(doc, rect, g.id);
    const f = gradientFrame(doc, rect.id)!;
    const pts = linearWorldPoints(f, LIN);
    // local start (10, 25) rotated 90deg (x,y)->(-y,x) then translated
    expect(pts.start.x).toBeCloseTo(300 - 25);
    expect(pts.start.y).toBeCloseTo(200 + 10);
    expect(pts.end.x).toBeCloseTo(300 - 25);
    expect(pts.end.y).toBeCloseTo(200 + 110);
    const back = worldToBbox(f, pts.end);
    expect(back.u).toBeCloseTo(1);
    expect(back.v).toBeCloseTo(0.5);
  });
  it('computes radial handles, radius and clamps the focal point', () => {
    const { doc, id } = docWithRect();
    const f = gradientFrame(doc, id)!;
    const h = radialWorldPoints(f, RAD);
    expect(h.center).toEqual({ x: 200, y: 150 });
    expect(h.radius).toEqual({ x: 300, y: 150 });
    expect(h.radiusY).toEqual({ x: 200, y: 200 });
    expect(radialRadiusFromWorld(f, h.center, { x: 250, y: 150 })).toBeCloseTo(0.25);
    expect(radialRadiusFromWorld(f, h.center, { x: 200, y: 175 })).toBeCloseTo(0.25);
    const fc = clampFocal(RAD, 2, 0.5);
    expect(fc.fx).toBeCloseTo(0.5 + 0.49);
    expect(clampFocal(RAD, 0.6, 0.5)).toEqual({ fx: 0.6, fy: 0.5 });
  });
  it('hit tests the screen model and constrains angles', () => {
    const model: AnnotatorModel = {
      id: 'x',
      target: 'fill',
      frame: { id: 'x', bounds: { x: 0, y: 0, width: 1, height: 1 }, wm: translate(0, 0), inv: translate(0, 0) },
      paint: LIN,
      rawPaint: LIN,
      targets: ['x'],
      start: { x: 100, y: 100 },
      end: { x: 300, y: 100 },
      center: null,
      radiusY: null,
      focal: null,
      ellipsePath: null,
      stops: [
        { index: 0, offset: 0, color: '#000', opacity: 1, screen: { x: 100, y: 100 } },
        { index: 1, offset: 1, color: '#fff', opacity: 1, screen: { x: 300, y: 100 } },
        { index: 2, offset: 0.5, color: '#888', opacity: 1, screen: { x: 200, y: 100 } },
      ],
    };
    expect(hitAnnotator(model, { x: 102, y: 101 })).toEqual({ kind: 'start' });
    expect(hitAnnotator(model, { x: 298, y: 103 })).toEqual({ kind: 'end' });
    expect(hitAnnotator(model, { x: 201, y: 104 })).toEqual({ kind: 'stop', index: 2 });
    const line = hitAnnotator(model, { x: 150, y: 103 });
    expect(line && line.kind === 'line' && Math.abs(line.t - 0.25) < 1e-6).toBe(true);
    expect(hitAnnotator(model, { x: 150, y: 130 })).toBeNull();
    expect(hitAnnotator(null, { x: 0, y: 0 })).toBeNull();
    expect(projectOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 3 })).toEqual({ t: 0.5, distance: 3 });
    const c = constrainTo45({ x: 0, y: 0 }, { x: 10, y: 1 });
    expect(c.x).toBeCloseTo(Math.hypot(10, 1));
    expect(c.y).toBeCloseTo(0);
    const d = constrainTo45({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(d.x).toBeCloseTo(d.y);
  });
  it('builds the annotator from the store selection', () => {
    const { doc, id } = docWithRect();
    (doc.nodes[id] as any).fill = LIN;
    const store = useStore.getState();
    store.setDocument(doc);
    store.setSelection([id]);
    const m = buildAnnotator(useStore.getState(), (p) => ({ x: p.x * 2, y: p.y * 2 }));
    expect(m).not.toBeNull();
    expect(m!.paint).toEqual(LIN);
    expect(m!.start).toEqual({ x: 200, y: 300 });
    expect(m!.end).toEqual({ x: 600, y: 300 });
    expect(m!.stops.length).toBe(2);
    store.setSelection([]);
    expect(buildAnnotator(useStore.getState(), (p) => p)).toBeNull();
  });
});

describe('stroke helpers', () => {
  it('converts dash arrays to slots and back', () => {
    expect(dashPairs([12, 6])).toEqual([12, 6, 0, 0, 0, 0]);
    expect(pairsToDash([12, 6, 0, 0, 0, 0])).toEqual([12, 6]);
    expect(pairsToDash([4, 2, 1, 2, 0, 0])).toEqual([4, 2, 1, 2]);
    expect(pairsToDash([0, 0, 0, 0, 0, 0])).toEqual([]);
  });
  it('creates, detects and flips width profiles', () => {
    expect(profilePoints('uniform', 4)).toBeUndefined();
    const taper = profilePoints('taperBoth', 4)!;
    expect(taper).toEqual([
      { offset: 0, width: 0 },
      { offset: 0.5, width: 4 },
      { offset: 1, width: 0 },
    ]);
    expect(detectProfile(taper, 4)).toBe('taperBoth');
    expect(detectProfile(undefined, 4)).toBe('uniform');
    expect(detectProfile([{ offset: 0, width: 1 }, { offset: 1, width: 3 }], 4)).toBeNull();
    const end = profilePoints('taperEnd', 2)!;
    const flipped = flipProfile(end);
    expect(detectProfile(flipped, 2)).toBe('taperStart');
    const asym = flipProfile([{ offset: 0.2, width: 2, left: 0.5, right: 1.5 }]);
    expect(asym[0]).toEqual({ offset: 0.8, width: 2, left: 1.5, right: 0.5 });
    expect(profilePreviewPath([[0, 0], [1, 1]]).startsWith('M')).toBe(true);
  });
  it('summarises the selection with mixed detection', () => {
    const doc = createDocument({ width: 800, height: 600 });
    const a = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] });
    const b = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] });
    a.stroke = { ...a.stroke, width: 2, dash: [1, 2] };
    b.stroke = { ...b.stroke, width: 5, dash: [1, 2] };
    addNode(doc, a, doc.layers[0]);
    addNode(doc, b, doc.layers[0]);
    const store = useStore.getState();
    store.setDocument(doc);
    store.setSelection([a.id, b.id]);
    const sum = strokeSummary(useStore.getState());
    expect(sum.hasTargets).toBe(true);
    expect(sum.width).toBe(MIXED);
    expect(sum.dash).toEqual([1, 2]);
    expect(sum.cap).toBe('butt');
    store.setSelection([]);
    const def = strokeSummary(useStore.getState());
    expect(def.hasTargets).toBe(false);
    expect(def.width).toBe(useStore.getState().appearance.stroke.width);
  });
});

describe('swatches', () => {
  it('parses and exports JSON in several shapes', () => {
    const list = parseSwatchesJson(JSON.stringify(['#ff0000', { name: 'Blue', color: '#0000ff' }, { name: 'Grad', paint: LIN }, { bad: true }]));
    expect(list.map((s) => s.name)).toEqual(['#FF0000', 'Blue', 'Grad']);
    expect(list[2].paint.type).toBe('linear');
    const text = exportSwatchesJson(list);
    const again = parseSwatchesJson(text);
    expect(again.map((s) => s.paint)).toEqual(list.map((s) => s.paint));
    expect(again[0].id).not.toBe(list[0].id);
    expect(() => parseSwatchesJson('nope')).toThrow();
    expect(() => parseSwatchesJson('[]')).toThrow();
  });
  it('sanitizes paints', () => {
    expect(sanitizePaint({ type: 'solid', color: 'red' })).toBeNull();
    expect(sanitizePaint({ type: 'solid', color: '#ABC', opacity: 5 })).toEqual({ type: 'solid', color: '#aabbcc', opacity: 1 });
    expect(sanitizePaint({ type: 'linear', stops: [{ offset: 0, color: '#000' }] })).toBeNull();
    const r = sanitizePaint({ type: 'radial', stops: RAD.stops, cx: 0.2 }) as RadialGradientPaint;
    expect(r.cx).toBe(0.2);
    expect(r.r).toBe(0.5);
    expect(sanitizePaint({ type: 'pattern', patternId: 'p1' })).toEqual({ type: 'pattern', patternId: 'p1', scale: 1, angle: 0 });
  });
  it('finds and replaces paints across the document', () => {
    const doc = createDocument({ width: 800, height: 600 });
    const red: Paint = { type: 'solid', color: '#ff0000', opacity: 1 };
    const a = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] }, { fill: red });
    const b = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] });
    b.stroke = { ...b.stroke, paint: { ...red } };
    const c = makeShape({ kind: 'rect', width: 10, height: 10, radii: [0, 0, 0, 0] }, { fill: { type: 'solid', color: '#ff0000', opacity: 0.5 } });
    addNode(doc, a, doc.layers[0]);
    addNode(doc, b, doc.layers[0]);
    addNode(doc, c, doc.layers[0]);
    expect(nodesUsingPaint(doc, red).sort()).toEqual([a.id, b.id].sort());
    const n = replacePaintInDoc(doc, red, { type: 'solid', color: '#00ff00', opacity: 1 });
    expect(n).toBe(2);
    expect((doc.nodes[a.id] as any).fill.color).toBe('#00ff00');
    expect((doc.nodes[b.id] as any).stroke.paint.color).toBe('#00ff00');
    expect((doc.nodes[c.id] as any).fill.color).toBe('#ff0000');
  });
  it('names, finds and reorders swatches', () => {
    const sw = createDocument().swatches;
    expect(uniqueSwatchName(sw, 'White')).toBe('White 2');
    expect(uniqueSwatchName(sw, 'Nope')).toBe('Nope');
    expect(findSwatchByPaint(sw, { type: 'solid', color: '#c8102e', opacity: 1 })?.name).toBe('Crimson');
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 2, 3]);
  });
  it('ships the requested libraries with valid colours', () => {
    const ids = SWATCH_LIBRARIES.map((l) => l.id);
    for (const id of ['basic', 'grays', 'websafe', 'material', 'flatui', 'pastels', 'earth', 'neon', 'skin']) expect(ids).toContain(id);
    for (const lib of SWATCH_LIBRARIES) for (const [name, hex] of lib.colors) {
      expect(name.length).toBeGreaterThan(0);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
