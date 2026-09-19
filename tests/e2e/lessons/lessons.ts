/**
 * Illustrator lesson builds, scripted through the same API the MCP server uses
 * (`window.__opuller.mcp`). Each builder runs inside the page and returns nothing; the
 * spec renders the artboard and compares it with the baseline PNG next to this file.
 *
 * The lessons exercise the parity fixes: per-corner rectangle radii, live corners before a
 * warp, counter-clockwise rotation, current appearance for the pencil, Zig Zag / Pucker &
 * Bloat / Transform effects, blends with a step count, align and distribute (owl, kitten, rowan);
 * swatches, 90° gradients, Pathfinder cuts, Reflect, the Warp (liquify) brush and the Smooth tool,
 * Outline Stroke (landscape); Pen curves, live corners, Pathfinder intersect and Create Outlines
 * (fox). Builders may be async (liquify, swatches and Create Outlines are); the specs await them.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type LessonBuilder = () => void | Promise<void>;

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

/**
 * Summer landscape (lesson 3): swatches, three rectangles with 90° gradients, a sun centred on
 * the artboard behind the sea, clouds united from circles and cut with the Pathfinder, mountains
 * mirrored with Reflect, waves pushed with the Warp (liquify) brush and smoothed with the Smooth
 * tool, a white foam copy of the sea, a boat with live corners, a notched flag and the boat's
 * reflection in the water (Outline Stroke + unite, reflected across the horizontal axis).
 */
export async function buildLandscape(): Promise<void> {
  const api = (window as any).__opuller.mcp;
  // the lesson starts by adding the palette to the Swatches panel
  const SW: Record<string, string> = { Голубой: '#5aaee6', Бирюзовый: '#1fa9a3', Песочный: '#f1d9a3', Коричневый: '#8a5a2b', 'Светло-коричневый': '#b98455', Красный: '#d8423a', Белый: '#ffffff', Морской: '#137a86' };
  for (const [name, color] of Object.entries(SW)) await api.swatches({ op: 'add', name, color });
  // a 90° gradient: Illustrator's start stop (white by default) sits at the bottom
  const vertical = (bottom: string, top: string) => ({ type: 'linear', x1: 0.5, y1: 1, x2: 0.5, y2: 0, stops: [{ offset: 0, color: bottom }, { offset: 1, color: top }] });
  const sky = api.createShape({ kind: 'rect', x: 0, y: 0, width: 800, height: 340, fill: SW.Песочный, stroke: 'none', name: 'Sky' });
  const sea = api.createShape({ kind: 'rect', x: 0, y: 310, width: 800, height: 200, fill: SW.Голубой, stroke: 'none', name: 'Sea' });
  api.createShape({ kind: 'rect', x: 0, y: 480, width: 800, height: 120, fill: SW.Песочный, stroke: 'none', name: 'Beach' });
  api.updateNodes({ ids: [sea.id], patch: { fill: vertical(SW.Бирюзовый, SW.Голубой) } });
  api.updateNodes({ ids: [sky.id], patch: { fill: vertical(SW.Песочный, SW.Голубой) } });
  // the sun: centred on the artboard, then sent below the sea and the beach
  const sun = api.createShape({ kind: 'circle', cx: 300, cy: 300, r: 70, fill: '#ffd35c', stroke: 'none', name: 'Sun' });
  api.align({ ids: [sun.id], h: 'center', to: 'artboard' });
  api.arrange({ ids: [sun.id], op: 'backward' });
  api.arrange({ ids: [sun.id], op: 'backward' });
  // clouds: four circles united, the bottom cut off with a rectangle (Pathfinder), then copies
  const puffs = [
    [150, 122, 28],
    [186, 102, 38],
    [226, 116, 30],
    [196, 134, 30],
  ].map(([cx, cy, r], i) => api.createShape({ kind: 'circle', cx, cy, r, fill: SW.Белый, stroke: 'none', name: `Puff ${i + 1}` }).id);
  const united = api.pathfinder({ op: 'unite', ids: puffs });
  const cutter = api.createShape({ kind: 'rect', x: 100, y: 140, width: 180, height: 40, fill: SW.Белый, stroke: 'none', name: 'Cutter' });
  const cloud = api.pathfinder({ op: 'minusFront', ids: [united.selection[0], cutter.id] }).selection[0];
  api.updateNodes({ ids: [cloud], patch: { name: 'Cloud' } });
  const cloud2 = api.duplicate({ ids: [cloud], dx: 380, dy: -30 })[0].id;
  api.transform({ ids: [cloud2], scale: 0.8 });
  const cloud3 = api.duplicate({ ids: [cloud], dx: 230, dy: 60 })[0].id;
  api.transform({ ids: [cloud3], scale: 0.55 });
  // mountains: a brown polygon; a lighter copy mirrored (Reflect, vertical axis) and shrunk behind it
  const mountains = api.pen({ anchors: [{ x: 0, y: 340 }, { x: 0, y: 320 }, { x: 130, y: 215 }, { x: 225, y: 295 }, { x: 335, y: 190 }, { x: 455, y: 300 }, { x: 565, y: 235 }, { x: 660, y: 305 }, { x: 800, y: 330 }, { x: 800, y: 340 }], closed: true, fill: SW.Коричневый, stroke: 'none', name: 'Mountains' });
  api.arrange({ ids: [mountains.id], op: 'back' });
  api.arrange({ ids: [mountains.id], op: 'forward' });
  api.arrange({ ids: [mountains.id], op: 'forward' });
  const far = api.duplicate({ ids: [mountains.id] })[0].id;
  api.updateNodes({ ids: [far], patch: { fill: SW['Светло-коричневый'], name: 'Far mountains' } });
  api.transform({ ids: [far], scale: { x: -0.75, y: 0.75 }, translate: { x: 90, y: 0 }, origin: { x: 400, y: 340 } });
  api.arrange({ ids: [far], op: 'backward' });
  // waves: the Warp brush (Shift+R) pushed up along the top edge of the sea, then the Smooth tool
  const brush = { width: 100, height: 100, intensity: 60 };
  for (let x = 70; x <= 730; x += 90) await api.liquify({ kind: 'warp', ids: [sea.id], points: [{ x, y: 326 }, { x, y: 290 }], options: brush });
  api.select({ ids: [sea.id] });
  await api.gesture({ tool: 'smooth', points: Array.from({ length: 19 }, (_, i) => ({ x: 40 + i * 40, y: 306 })), steps: 4 });
  // white foam: a copy of the sea raised a little, below the sea, its waves pushed elsewhere
  const foam = api.duplicate({ ids: [sea.id], dy: -12 })[0].id;
  api.updateNodes({ ids: [foam], patch: { fill: SW.Белый, name: 'Foam' } });
  api.arrange({ ids: [foam], op: 'backward' });
  for (let x = 115; x <= 700; x += 180) await api.liquify({ kind: 'warp', ids: [foam], points: [{ x, y: 312 }, { x, y: 288 }], options: brush });
  // two small waves: rectangles bent with the Warp brush
  for (const [x, y, w] of [
    [120, 405, 90],
    [560, 438, 110],
  ]) {
    const r = api.createShape({ kind: 'rect', x, y, width: w, height: 6, fill: SW.Белый, stroke: 'none', name: 'Wave' });
    await api.liquify({ kind: 'warp', ids: [r.id], points: [{ x: x + w / 2, y: y + 14 }, { x: x + w / 2, y: y - 6 }], options: { width: 60, height: 60, intensity: 50 } });
  }
  // the boat: a hull with rounded bottom corners, a red stripe cut from a copy, portholes, mast, sail, flag
  const hull = api.pen({ anchors: [{ x: 320, y: 400 }, { x: 480, y: 400 }, { x: 455, y: 440, cornerRadius: 14 }, { x: 345, y: 440, cornerRadius: 14 }], closed: true, fill: SW.Коричневый, stroke: 'none', name: 'Hull' });
  const hullCopy = api.duplicate({ ids: [hull.id] })[0].id;
  const band = api.createShape({ kind: 'rect', x: 300, y: 412, width: 200, height: 12, fill: SW.Красный, stroke: 'none', name: 'Band' });
  const stripe = api.pathfinder({ op: 'intersect', ids: [hullCopy, band.id] }).selection[0];
  api.updateNodes({ ids: [stripe], patch: { fill: SW.Красный, name: 'Stripe' } });
  const portholes = [370, 400, 430].map((cx) => api.createShape({ kind: 'circle', cx, cy: 431, r: 4, fill: '#5a3818', stroke: 'none', name: 'Porthole' }).id);
  const mast = api.pen({ anchors: [{ x: 400, y: 400 }, { x: 400, y: 298 }], fill: 'none', stroke: { color: SW.Коричневый, width: 6, cap: 'round', join: 'round' }, name: 'Mast' });
  const sail = api.pen({ anchors: [{ x: 405, y: 306 }, { x: 405, y: 392 }, { x: 472, y: 392 }], closed: true, fill: '#f7f1e1', stroke: 'none', name: 'Sail' });
  const jib = api.pen({ anchors: [{ x: 395, y: 326 }, { x: 395, y: 392 }, { x: 348, y: 392 }], closed: true, fill: '#f7f1e1', stroke: 'none', name: 'Jib' });
  // the flag: a rectangle with one extra anchor pulled left makes the notch; then a push with the Warp brush
  const flag = api.pen({ anchors: [{ x: 403, y: 298 }, { x: 445, y: 298 }, { x: 433, y: 307 }, { x: 445, y: 316 }, { x: 403, y: 316 }], closed: true, fill: SW.Красный, stroke: 'none', name: 'Flag' });
  await api.liquify({ kind: 'warp', ids: [flag.id], points: [{ x: 440, y: 312 }, { x: 440, y: 302 }], options: { width: 40, height: 40, intensity: 50 } });
  // the reflection: a copy of the boat, the mast outlined (Object > Path > Outline Stroke), everything
  // united, coloured, reflected across the horizontal axis (squashed into the water) and rippled
  const parts = [hull.id, stripe, ...portholes, mast.id, sail.id, jib.id, flag.id];
  const copies: string[] = api.duplicate({ ids: parts }).map((n: any) => n.id);
  const mastCopy = copies[parts.indexOf(mast.id)];
  api.select({ ids: [mastCopy] });
  const outlined: string[] = api.runCommand({ id: 'path.outlineStroke' }).selection;
  const shadow = api.pathfinder({ op: 'unite', ids: [...copies.filter((id) => id !== mastCopy), ...outlined] }).selection[0];
  api.updateNodes({ ids: [shadow], patch: { fill: SW.Морской, name: 'Reflection' } });
  api.transform({ ids: [shadow], scale: { x: 1, y: -0.28 }, origin: { x: 400, y: 440 } });
  for (const x of [365, 435]) await api.liquify({ kind: 'warp', ids: [shadow], points: [{ x, y: 462 }, { x: x + 18, y: 462 }], options: { width: 50, height: 50, intensity: 45 } });
  api.select({ ids: [] });
}

/**
 * Fox (lesson 2: "outlines, fills, text" — redraw a picture with the Pen and add a caption):
 * every shape is a Pen path with Bézier handles or a live corner, the black ear and tail tips are
 * cut out of copies with the Pathfinder, the whiskers are stroked open paths and the caption is
 * point text converted to outlines (Type > Create Outlines) so the file does not depend on fonts.
 */
export async function buildFox(): Promise<void> {
  const api = (window as any).__opuller.mcp;
  const ORANGE = '#f0893a';
  const WHITE = '#ffffff';
  const BLACK = '#1d1d1d';
  type A = { x: number; y: number; handleIn?: { x: number; y: number }; handleOut?: { x: number; y: number }; cornerRadius?: number };
  const shape = (anchors: A[], fill: string, name: string) => api.pen({ anchors, closed: true, fill, stroke: 'none', name }).id as string;
  // a black tip: the part of a copy of `id` inside a circle around (cx, cy)
  const tip = (id: string, cx: number, cy: number, r: number, name: string) => {
    const copy = api.duplicate({ ids: [id] })[0].id;
    const disc = api.createShape({ kind: 'circle', cx, cy, r, fill: BLACK, stroke: 'none', name: `${name} disc` });
    const cut = api.pathfinder({ op: 'intersect', ids: [copy, disc.id] }).selection[0];
    api.updateNodes({ ids: [cut], patch: { fill: BLACK, name } });
    return cut;
  };
  api.createShape({ kind: 'rect', x: 0, y: 0, width: 800, height: 600, fill: '#3dbac6', stroke: 'none', name: 'Background' });
  // tail: a curved teardrop from the rump to the lower right, black at the end
  const tail = shape(
    [
      { x: 505, y: 372, handleOut: { x: 60, y: -10 } },
      { x: 650, y: 400, handleIn: { x: -40, y: -30 }, handleOut: { x: 40, y: 30 } },
      { x: 720, y: 500, handleIn: { x: 10, y: -30 }, handleOut: { x: -10, y: 30 } },
      { x: 660, y: 520, handleIn: { x: 30, y: 20 }, handleOut: { x: -60, y: -40 } },
      { x: 520, y: 430, handleIn: { x: 40, y: 20 } },
    ],
    ORANGE,
    'Tail',
  );
  tip(tail, 712, 512, 46, 'Tail tip');
  // legs: four tapered strips with black feet; the far pair first (behind the body)
  const leg = (x: number, dark: boolean) => {
    const id = shape([{ x: x - 16, y: 360 }, { x: x + 18, y: 360 }, { x: x + 10, y: 520 }, { x: x - 2, y: 520 }], dark ? '#d9742c' : ORANGE, 'Leg');
    shape([{ x: x - 10, y: 508, cornerRadius: 4 }, { x: x + 16, y: 508, cornerRadius: 4 }, { x: x + 18, y: 528, cornerRadius: 6 }, { x: x - 14, y: 528, cornerRadius: 6 }], BLACK, 'Paw');
    return id;
  };
  leg(392, true);
  leg(482, true);
  // body: an egg lying on its side, the chest towards the head
  shape(
    [
      { x: 330, y: 330, handleIn: { x: -30, y: 40 }, handleOut: { x: 40, y: -40 } },
      { x: 450, y: 296, handleIn: { x: -40, y: -6 }, handleOut: { x: 40, y: 6 } },
      { x: 530, y: 380, handleIn: { x: 10, y: -40 }, handleOut: { x: -10, y: 40 } },
      { x: 430, y: 436, handleIn: { x: 50, y: 0 }, handleOut: { x: -50, y: 0 } },
      { x: 310, y: 400, handleIn: { x: 30, y: 30 } },
    ],
    ORANGE,
    'Body',
  );
  leg(360, false);
  leg(450, false);
  // neck and the white bib running down the chest
  shape([{ x: 268, y: 300, handleOut: { x: 30, y: 20 } }, { x: 350, y: 340, handleOut: { x: -10, y: 50 } }, { x: 330, y: 420, handleIn: { x: 20, y: 10 } }, { x: 300, y: 400, handleIn: { x: 10, y: 20 } }, { x: 300, y: 320, handleIn: { x: -10, y: 30 } }], ORANGE, 'Neck');
  shape([{ x: 300, y: 330, handleOut: { x: 20, y: 10 } }, { x: 342, y: 350, handleOut: { x: -4, y: 40 } }, { x: 322, y: 424, handleIn: { x: 12, y: 8 } }, { x: 304, y: 404, handleIn: { x: 4, y: 20 } }], WHITE, 'Bib');
  // ears: tall triangles with a soft base corner, white inner ears, black tips
  const earL = shape([{ x: 178, y: 46 }, { x: 252, y: 176, cornerRadius: 30 }, { x: 156, y: 200, cornerRadius: 30 }], ORANGE, 'Ear L');
  const earR = shape([{ x: 426, y: 24 }, { x: 424, y: 190, cornerRadius: 30 }, { x: 322, y: 176, cornerRadius: 30 }], ORANGE, 'Ear R');
  shape([{ x: 186, y: 76 }, { x: 234, y: 168, cornerRadius: 20 }, { x: 178, y: 182, cornerRadius: 20 }], WHITE, 'Inner ear L');
  shape([{ x: 412, y: 56 }, { x: 408, y: 178, cornerRadius: 20 }, { x: 344, y: 170, cornerRadius: 20 }], WHITE, 'Inner ear R');
  tip(earL, 178, 46, 34, 'Ear tip L');
  tip(earR, 426, 24, 34, 'Ear tip R');
  // head: a rounded wedge, the chin at the bottom left
  shape(
    [
      { x: 165, y: 195, handleIn: { x: -10, y: 40 }, handleOut: { x: 40, y: -25 } },
      { x: 300, y: 172, handleIn: { x: -50, y: 0 }, handleOut: { x: 50, y: 0 } },
      { x: 432, y: 205, handleIn: { x: -30, y: -25 }, handleOut: { x: -20, y: 60 } },
      { x: 236, y: 345, handleIn: { x: 60, y: 10 }, handleOut: { x: -40, y: -10 } },
    ],
    ORANGE,
    'Head',
  );
  // white cheek: a soft patch on the lower right of the muzzle
  shape([{ x: 250, y: 342, handleOut: { x: 50, y: 6 } }, { x: 376, y: 286, handleIn: { x: -4, y: 40 }, handleOut: { x: 2, y: -16 } }, { x: 336, y: 270, handleIn: { x: 30, y: -4 }, handleOut: { x: -30, y: 4 } }, { x: 268, y: 306, handleIn: { x: 24, y: -14 } }], WHITE, 'Cheek');
  // eyes with highlights, the nose and a smile
  for (const [cx, cy] of [
    [240, 246],
    [332, 252],
  ]) {
    api.createShape({ kind: 'circle', cx, cy, r: 16, fill: BLACK, stroke: 'none', name: 'Eye' });
    api.createShape({ kind: 'circle', cx: cx - 5, cy: cy - 5, r: 6, fill: WHITE, stroke: 'none', name: 'Highlight' });
  }
  api.createShape({ kind: 'ellipse', cx: 232, cy: 320, rx: 11, ry: 8, fill: BLACK, stroke: 'none', name: 'Nose' });
  api.pen({ anchors: [{ x: 244, y: 326, handleOut: { x: 6, y: 16 } }, { x: 274, y: 340, handleIn: { x: -12, y: 6 } }], fill: 'none', stroke: { color: BLACK, width: 3, cap: 'round' }, name: 'Smile' });
  // whiskers: three stroked lines per side
  for (const k of [-1, 0, 1]) {
    api.pen({ anchors: [{ x: 212, y: 318 + k * 8 }, { x: 150, y: 306 + k * 16 }], fill: 'none', stroke: { color: BLACK, width: 2, cap: 'round' }, name: 'Whisker' });
    api.pen({ anchors: [{ x: 300, y: 336 + k * 6 }, { x: 362, y: 330 + k * 16 }], fill: 'none', stroke: { color: BLACK, width: 2, cap: 'round' }, name: 'Whisker' });
  }
  // the caption, then Type > Create Outlines (asynchronous: it loads the font first)
  const caption = api.createText({ text: 'Лиса', x: 560, y: 150, fontFamily: 'Montserrat', fontWeight: 700, fontSize: 72, fill: WHITE, name: 'Caption' });
  api.select({ ids: [caption.id] });
  api.runCommand({ id: 'type.createOutlines' });
  for (let i = 0; i < 200 && api.findNodes({ type: 'text' }).length; i++) await new Promise((r) => setTimeout(r, 50));
  api.select({ ids: [] });
}

export const LESSONS: Record<string, LessonBuilder> = { owl: buildOwl, kitten: buildKitten, rowan: buildRowan, landscape: buildLandscape, fox: buildFox };
