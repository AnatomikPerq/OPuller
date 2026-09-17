/**
 * Illustrator lesson builds, scripted through the same API the MCP server uses
 * (`window.__opuller.mcp`). Each builder runs inside the page and returns nothing; the
 * spec renders the artboard and compares it with the baseline PNG next to this file.
 *
 * The lessons exercise the parity fixes: per-corner rectangle radii, live corners before a
 * warp, counter-clockwise rotation, current appearance for the pencil, Zig Zag / Pucker &
 * Bloat / Transform effects, blends with a step count, align and distribute.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type LessonBuilder = () => void;

/** Owl: a 47×61 mm body with one big bottom-left radius, warped ears with rounded tips turned ±26°. */
export function buildOwl(): void {
  const api = (window as any).__opuller.mcp;
  const S = 4; // 1 mm of the lesson ≈ 4 px
  const bodyX = 200;
  const bodyY = 120;
  const body = api.createShape({ kind: 'rect', x: bodyX, y: bodyY, width: 47 * S, height: 61 * S, radii: [23.636 * S, 23.636 * S, 0, 37.3 * S], fill: '#8d5a2b', stroke: 'none', name: 'Body' });
  // belly: an ellipse aligned to the body's horizontal centre, near the bottom
  const belly = api.createShape({ kind: 'ellipse', cx: 0, cy: 0, rx: 60, ry: 70, fill: '#e9c9a0', stroke: 'none', name: 'Belly' });
  api.setBounds({ id: belly.id, x: bodyX + 34, y: bodyY + 100 });
  api.align({ ids: [belly.id, body.id], h: 'center', to: 'key', key: body.id });
  // ears: triangles with a live corner at the tip, then Bulge 40 % vertical with −10 % distortion, turned outward
  const ear = (x: number, dir: number) => {
    const e = api.pen({ anchors: [{ x: x - 30, y: bodyY + 30 }, { x: x + 30, y: bodyY + 30 }, { x, y: bodyY - 50, cornerRadius: 9 }], closed: true, fill: '#8d5a2b', stroke: 'none', name: dir < 0 ? 'Ear L' : 'Ear R' });
    api.effect({ op: 'add', ids: [e.id], type: 'warp', params: { style: 'bulge', bend: 40, horizontal: false, hDistort: -10, vDistort: 0 } });
    api.transform({ ids: [e.id], rotate: 26 * dir, origin: { x, y: bodyY + 30 } });
    return e.id;
  };
  ear(bodyX + 40, 1);
  ear(bodyX + 47 * S - 40, -1);
  // eyes: two rings, distributed horizontally
  const eye = (x: number, name: string) => {
    const outer = api.createShape({ kind: 'circle', cx: x, cy: bodyY + 70, r: 30, fill: '#ffffff', stroke: { color: '#3b2412', width: 4 }, name: `${name} white` });
    const pupil = api.createShape({ kind: 'circle', cx: x + 6, cy: bodyY + 74, r: 12, fill: '#1a1a1a', stroke: 'none', name: `${name} pupil` });
    return [outer.id, pupil.id];
  };
  eye(bodyX + 55, 'Eye L');
  eye(bodyX + 47 * S - 55, 'Eye R');
  // beak: a small triangle whose tip is rounded
  api.pen({ anchors: [{ x: bodyX + 84, y: bodyY + 95 }, { x: bodyX + 104, y: bodyY + 95 }, { x: bodyX + 94, y: bodyY + 120, cornerRadius: 4 }], closed: true, fill: '#e8a531', stroke: 'none', name: 'Beak' });
  // feet: two puckered ellipses
  for (const dx of [50, 47 * S - 50]) {
    const foot = api.createShape({ kind: 'ellipse', cx: bodyX + dx, cy: bodyY + 61 * S, rx: 22, ry: 10, fill: '#e8a531', stroke: 'none', name: 'Foot' });
    api.effect({ op: 'add', ids: [foot.id], type: 'puckerBloat', params: { amount: -30 } });
  }
}

/** Kitten: a head with a Zig Zag mouth, whiskers drawn with the pen, a pencil paw painted with the *current* fill. */
export function buildKitten(): void {
  const api = (window as any).__opuller.mcp;
  const cx = 400;
  const cy = 300;
  api.createShape({ kind: 'rect', x: 0, y: 0, width: 800, height: 600, fill: '#f3ead8', stroke: 'none', name: 'Background' });
  // ears first (they sit behind the head): triangles with Bulge, rotated outward (counter-clockwise positive)
  for (const dir of [-1, 1]) {
    const x = cx + dir * 80;
    const e = api.pen({ anchors: [{ x: x - 35, y: cy - 80 }, { x: x + 35, y: cy - 80 }, { x, y: cy - 170, cornerRadius: 8 }], closed: true, fill: '#9a9a9a', stroke: 'none', name: 'Ear' });
    api.effect({ op: 'add', ids: [e.id], type: 'warp', params: { style: 'bulge', bend: 30, horizontal: false, hDistort: 0, vDistort: 0 } });
    api.transform({ ids: [e.id], rotate: -20 * dir, origin: { x, y: cy - 80 } });
  }
  api.createShape({ kind: 'circle', cx, cy, r: 120, fill: '#9a9a9a', stroke: 'none', name: 'Head' });
  // eyes
  for (const dir of [-1, 1]) {
    api.createShape({ kind: 'ellipse', cx: cx + dir * 45, cy: cy - 20, rx: 18, ry: 26, fill: '#3c9d3a', stroke: 'none', name: 'Eye' });
    api.createShape({ kind: 'ellipse', cx: cx + dir * 45, cy: cy - 20, rx: 5, ry: 20, fill: '#111111', stroke: 'none', name: 'Pupil' });
  }
  // nose and the Zig Zag mouth (size 4, 3 ridges, smooth)
  api.pen({ anchors: [{ x: cx - 12, y: cy + 20 }, { x: cx + 12, y: cy + 20 }, { x: cx, y: cy + 34, cornerRadius: 3 }], closed: true, fill: '#d97b8f', stroke: 'none', name: 'Nose' });
  const mouth = api.pen({ anchors: [{ x: cx - 50, y: cy + 60 }, { x: cx + 50, y: cy + 60 }], fill: 'none', stroke: { color: '#333333', width: 3, cap: 'round' }, name: 'Mouth' });
  api.effect({ op: 'add', ids: [mouth.id], type: 'zigZag', params: { size: 4, ridges: 3, smooth: true } });
  // whiskers: three pen strokes per side, then a Transform effect would do; here they are plain
  for (const dir of [-1, 1]) {
    for (const k of [-1, 0, 1]) {
      api.pen({ anchors: [{ x: cx + dir * 30, y: cy + 30 + k * 10 }, { x: cx + dir * 150, y: cy + 20 + k * 25 }], fill: 'none', stroke: { color: '#333333', width: 2, cap: 'round' }, name: 'Whisker' });
    }
  }
  // the back paw: a pencil stroke drawn while the (background-coloured) rectangle is selected — the
  // current fill, set explicitly, must win over the selection's paint
  const bg = api.findNodes ? api.findNodes({ name: 'Background' })?.[0]?.id : null;
  if (bg) api.select({ ids: [bg] });
  api.setAppearance({ fill: '#9a9a9a', stroke: 'none' });
  const paw: Array<[number, number]> = [];
  for (let i = 0; i <= 30; i++) paw.push([cx - 60 + Math.cos((i / 30) * Math.PI * 2) * 40, cy + 150 + Math.sin((i / 30) * Math.PI * 2) * 22]);
  api.pencil({ points: paw, closed: true, fillStrokes: true, name: 'Paw' });
}

/** Rowan: a branch with leaves placed by the Transform effect and berries blended between two circles. */
export function buildRowan(): void {
  const api = (window as any).__opuller.mcp;
  api.createShape({ kind: 'rect', x: 0, y: 0, width: 800, height: 600, fill: '#fbf5e6', stroke: 'none', name: 'Sky' });
  api.pen({ anchors: [{ x: 120, y: 520, handleOut: { x: 120, y: -140 } }, { x: 520, y: 140, handleIn: { x: -160, y: 40 } }], fill: 'none', stroke: { color: '#5b3a1e', width: 8, cap: 'round' }, name: 'Branch' });
  // one leaf: a puckered ellipse; the Transform effect repeats it along the branch, turning each copy
  const leaf = api.createShape({ kind: 'ellipse', cx: 200, cy: 430, rx: 42, ry: 16, fill: '#3f7d2c', stroke: 'none', name: 'Leaf' });
  api.transform({ ids: [leaf.id], rotate: -40 });
  api.effect({ op: 'add', ids: [leaf.id], type: 'puckerBloat', params: { amount: -18 } });
  api.effect({ op: 'add', ids: [leaf.id], type: 'transform', params: { copies: 5, dx: 62, dy: -58, angle: 4, scaleX: 92, scaleY: 92, origin: 'center' } });
  // berries: a blend of 6 steps between two circles, then expanded
  const a = api.createShape({ kind: 'circle', cx: 420, cy: 250, r: 16, fill: '#d6301b', stroke: 'none', name: 'Berry A' });
  const b = api.createShape({ kind: 'circle', cx: 560, cy: 330, r: 16, fill: '#f0642a', stroke: 'none', name: 'Berry B' });
  const blend = api.blend({ op: 'make', ids: [a.id, b.id], steps: 6 });
  api.blend({ op: 'expand', ids: [blend.groups[0].id] });
  // a second row aligned to the first one's vertical centre and distributed
  const c = api.createShape({ kind: 'circle', cx: 440, cy: 300, r: 14, fill: '#b8241a', stroke: 'none', name: 'Berry C' });
  const d = api.createShape({ kind: 'circle', cx: 500, cy: 320, r: 14, fill: '#b8241a', stroke: 'none', name: 'Berry D' });
  const e = api.createShape({ kind: 'circle', cx: 600, cy: 280, r: 14, fill: '#b8241a', stroke: 'none', name: 'Berry E' });
  api.align({ ids: [c.id, d.id, e.id], v: 'middle', distribute: 'h', spacing: 30 });
}

export const LESSONS: Record<string, LessonBuilder> = { owl: buildOwl, kitten: buildKitten, rowan: buildRowan };
