/**
 * Sample one of Illustrator's live effects (Effect menu, applied through its LiveEffect XML) on
 * a set of reference shapes for the fixtures in tests/fixtures/effects/: every shape is drawn,
 * the effect applied, Expand Appearance run and the resulting anchors + handles read back.
 * Needs Adobe Illustrator installed (Windows, see ai.mjs).
 *
 *   node scripts/illustrator/effect-fixtures.mjs <effect> [out.json] [--params "k=v,k=v;k=v,..."] [--shapes square,circle]
 *
 * Effects (LiveEffect name → dictionary keys, from the plug-in binaries):
 *   puckerBloat  "Adobe Punk and Bloat"      R d_factor <percent>
 *   zigZag       "Adobe Zigzag"              R amount <pt | percent> R ridges <n> R roundness 0|1 I absoluteness 1|0 (relAmount is ignored)
 *   roughen      "Adobe Roughen"             R size <pt> R asiz <percent> R dtal <per inch> R roundness 0|1 I absoluteness 1|0
 *   roundCorners "Adobe Round Corners"       R radius <pt>
 *   offsetPath   "Adobe Offset Path"         R ofst <pt> I jntp 0|1|2 (round, bevel, miter) R mlim <limit>
 *   tweak        "Adobe Scribble and Tweak"  R horz R vert R ahor R aver I absoluteness B anch B in B out
 *
 * Coordinates in the output are screen-oriented (y down), in points = px of the reference
 * shapes (the document is created in points).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJsx, JSX_JSON } from './ai.mjs';

export const EFFECTS = {
  puckerBloat: { name: 'Adobe Punk and Bloat', params: (p) => `R d_factor ${p.amount} ` },
  zigZag: { name: 'Adobe Zigzag', params: (p) => `R amount ${p.size} R relAmount 0 R ridges ${p.ridges} R roundness ${p.smooth ? 1 : 0} I absoluteness ${p.relative ? 0 : 1} ` },
  roughen: { name: 'Adobe Roughen', params: (p) => `R size ${p.size} R asiz ${p.relSize ?? 0} R dtal ${p.detail} R roundness ${p.smooth ? 1 : 0} I absoluteness ${p.relative ? 0 : 1} ` },
  roundCorners: { name: 'Adobe Round Corners', params: (p) => `R radius ${p.radius} ` },
  offsetPath: { name: 'Adobe Offset Path', params: (p) => `R ofst ${p.offset} I jntp ${{ round: 0, bevel: 1, miter: 2 }[p.join ?? 'miter']} R mlim ${p.miterLimit ?? 4} ` },
  tweak: { name: 'Adobe Scribble and Tweak', params: (p) => `R horz ${p.horizontal} R vert ${p.vertical} R ahor ${p.horizontal} R aver ${p.vertical} I absoluteness ${p.relative ? 0 : 1} B anch ${p.anchors === false ? 0 : 1} B in ${p.inControl === false ? 0 : 1} B out ${p.outControl === false ? 0 : 1} ` },
};

/** Reference shapes: anchors as [x, y, inx, iny, outx, outy] (screen coordinates), handles absolute. */
export const SHAPES = {
  square: { closed: true, anchors: [[0, 0], [200, 0], [200, 200], [0, 200]] },
  rect: { closed: true, anchors: [[0, 0], [300, 0], [300, 100], [0, 100]] },
  triangle: { closed: true, anchors: [[100, 0], [200, 180], [0, 180]] },
  diamond: { closed: true, anchors: [[100, 0], [200, 100], [100, 200], [0, 100]] },
  star: { closed: true, anchors: Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 ? 40 : 100; return [100 + r * Math.cos(a), 100 + r * Math.sin(a)]; }) },
  circle: { closed: true, anchors: circle(100, 100, 100) },
  ellipse: { closed: true, anchors: circle(150, 50, 150, 50) },
  polyline: { closed: false, anchors: [[0, 0], [100, 80], [200, 0], [300, 80]] },
  curve: { closed: false, anchors: [[0, 100, 0, 100, 60, 0], [150, 100, 90, 200, 210, 0], [300, 100, 240, 200, 300, 100]] },
  wedge: { closed: true, anchors: [[0, 0], [200, 0, 200, 0, 140, 60], [0, 200]] },
  // one arc whose tight bounds (y 25..100) differ from the anchor (y = 100) and control (y 0..100) bounds
  arc: { closed: false, anchors: [[0, 100, 0, 100, 0, 0], [200, 100, 200, 0, 200, 100]] },
  // unequal straight segments (60, 120, 180) and a straight segment followed by a curved one
  steps: { closed: false, anchors: [[0, 0], [60, 0], [60, 120], [240, 120]] },
  mixed: { closed: false, anchors: [[0, 100], [100, 100], [200, 100, 100, 0, 300, 200]] },
  // two curves meeting at an anchor with unequal handles, and a line meeting a curve that starts with a handle
  kink: { closed: false, anchors: [[0, 0, 0, 0, 100, 0], [200, 100, 200, 0, 250, 150], [400, 100, 300, 200, 400, 100]] },
  lcurve: { closed: false, anchors: [[0, 100], [100, 100, 100, 100, 100, 40], [200, 100, 200, 0, 200, 100]] },
};

function circle(cx, cy, rx, ry = rx) {
  const k = 0.5522847498;
  return [
    [cx + rx, cy, cx + rx, cy - ry * k, cx + rx, cy + ry * k],
    [cx, cy + ry, cx + rx * k, cy + ry, cx - rx * k, cy + ry],
    [cx - rx, cy, cx - rx, cy + ry * k, cx - rx, cy - ry * k],
    [cx, cy - ry, cx - rx * k, cy - ry, cx + rx * k, cy - ry],
  ];
}

function parseParams(spec) {
  return spec.split(';').filter(Boolean).map((one) => Object.fromEntries(one.split(',').map((kv) => {
    const [k, v] = kv.split('=');
    const n = Number(v);
    return [k.trim(), v === 'true' ? true : v === 'false' ? false : Number.isNaN(n) ? v : n];
  })));
}

/** Apply `effect` with each parameter set to each shape; returns [{ shape, params, outline: [[x,y,inx,iny,outx,outy]...] | outlines }]. */
export async function sampleEffect(effectKey, paramSets, shapeKeys = Object.keys(SHAPES)) {
  const eff = EFFECTS[effectKey];
  if (!eff) throw new Error(`Unknown effect "${effectKey}" (${Object.keys(EFFECTS).join(', ')})`);
  const cases = [];
  for (const params of paramSets) for (const shape of shapeKeys) cases.push({ shape, params, xml: `<LiveEffect name="${eff.name}"><Dict data="${eff.params(params)}"/></LiveEffect>` });
  const jsx = JSX_JSON + `
var shapes = ${JSON.stringify(SHAPES)};
var cases = ${JSON.stringify(cases.map((c) => ({ shape: c.shape, xml: c.xml })))};
var doc = app.documents.add(DocumentColorSpace.RGB, 600, 600);
app.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM;
function r3(x) { return Math.round(x * 1000) / 1000; }
function draw(s) {
  var p = doc.pathItems.add();
  p.filled = true; p.stroked = false; p.closed = s.closed;
  for (var i = 0; i < s.anchors.length; i++) {
    var a = s.anchors[i];
    var pp = p.pathPoints.add();
    pp.anchor = [a[0], -a[1]];
    pp.leftDirection = a.length > 2 ? [a[2], -a[3]] : [a[0], -a[1]];
    pp.rightDirection = a.length > 2 ? [a[4], -a[5]] : [a[0], -a[1]];
    pp.pointType = a.length > 2 ? PointType.SMOOTH : PointType.CORNER;
  }
  return p;
}
function read(it, acc) {
  if (it.typename === 'GroupItem') { for (var k = 0; k < it.pageItems.length; k++) read(it.pageItems[k], acc); return; }
  if (it.typename === 'CompoundPathItem') { for (var k2 = 0; k2 < it.pathItems.length; k2++) read(it.pathItems[k2], acc); return; }
  if (it.typename !== 'PathItem') return;
  var o = [];
  for (var i = 0; i < it.pathPoints.length; i++) {
    var pp = it.pathPoints[i];
    o.push([r3(pp.anchor[0]), r3(-pp.anchor[1]), r3(pp.leftDirection[0]), r3(-pp.leftDirection[1]), r3(pp.rightDirection[0]), r3(-pp.rightDirection[1])]);
  }
  acc.push({ closed: it.closed, anchors: o });
}
var results = [];
for (var ci = 0; ci < cases.length; ci++) {
  var c = cases[ci];
  var p = draw(shapes[c.shape]);
  var res = { outlines: [] };
  try {
    p.applyEffect(c.xml);
    doc.selection = null; p.selected = true;
    app.executeMenuCommand('expandStyle');
    for (var si = 0; si < doc.selection.length; si++) read(doc.selection[si], res.outlines);
    for (var sj = doc.selection.length - 1; sj >= 0; sj--) doc.selection[sj].remove();
  } catch (e) { res.error = String(e); try { p.remove(); } catch (e2) {} }
  results.push(res);
}
doc.close(SaveOptions.DONOTSAVECHANGES);
return __json(results);
`;
  const results = JSON.parse(await runJsx(jsx));
  return cases.map((c, i) => ({ shape: c.shape, params: c.params, ...results[i] }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const effect = positional[0];
  if (!effect || !EFFECTS[effect]) {
    console.error(`usage: node scripts/illustrator/effect-fixtures.mjs <${Object.keys(EFFECTS).join('|')}> [out.json] --params "amount=30;amount=-30" [--shapes square,circle]`);
    process.exit(2);
  }
  const out = positional[1] ?? `tests/fixtures/effects/${effect}.json`;
  const paramSets = parseParams(opt('params', ''));
  if (!paramSets.length) {
    console.error('give at least one parameter set with --params');
    process.exit(2);
  }
  const shapes = opt('shapes', '').split(',').filter(Boolean);
  const t0 = Date.now();
  const cases = await sampleEffect(effect, paramSets, shapes.length ? shapes : undefined);
  const fixture = { source: `Adobe Illustrator ${await runJsx('return app.version;')} — Effect "${EFFECTS[effect].name}", expanded`, effect, shapes: SHAPES, cases };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture));
  const failed = cases.filter((c) => c.error).length;
  console.log(`${cases.length} cases${failed ? ` (${failed} failed)` : ''} → ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
