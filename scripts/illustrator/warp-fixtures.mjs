/**
 * Sample Illustrator's Warp effect (Effect → Warp, "Adobe Deform") for the regression
 * fixtures in tests/fixtures/warp/: for every style / bend / distortion the expanded
 * outline of a 200×200 square (anchors + handles) and the image of a lattice of points
 * inside it. Needs Adobe Illustrator installed (Windows, see ai.mjs).
 *
 *   node scripts/illustrator/warp-fixtures.mjs [out.json] [--lattice 8] [--bends -100,-50,50,100]
 *        [--distort 0:0,30:0,0:30] [--frame 200x200] [--styles arc,flag] [--vbends 50,-50] [--vdistort 0:0,30:0]
 *        [--random 100 --seed 7]   (random cases instead of the matrix)
 *
 * Coordinates in the output are screen-oriented (y down) and relative to the frame origin.
 */
import { writeFileSync } from 'node:fs';
import { runJsx, JSX_JSON } from './ai.mjs';

const STYLES = ['arc', 'arcLower', 'arcUpper', 'arch', 'bulge', 'shellLower', 'shellUpper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const outFile = args.find((a) => !a.startsWith('--') && !/^-?[\d.,:x]+$/.test(a)) ?? 'tests/fixtures/warp/illustrator.json';
const lattice = Number(opt('lattice', 8));
const bends = opt('bends', '-100,-50,-25,25,50,100').split(',').map(Number);
// distortion pairs "h:v"
const distortions = opt('distort', '0:0,30:0,0:30,-20:40').split(',').map((d) => d.split(':').map(Number));
const [W, H] = opt('frame', '200x200').split('x').map(Number);
const styleFilter = opt('styles', '').split(',').filter(Boolean);
const vBends = opt('vbends', '50').split(',').filter(Boolean).map(Number);
const vDistortions = opt('vdistort', '0:0').split(',').filter(Boolean).map((d) => d.split(':').map(Number));

const cases = [];
const randomCount = Number(opt('random', 0));
if (randomCount) {
  // deterministic pseudo-random cases (mulberry32) for cross-checking a model
  let seed = Number(opt('seed', 1)) >>> 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = (lo, hi) => Math.round(lo + rnd() * (hi - lo));
  for (let i = 0; i < randomCount; i++) cases.push({ style: 1 + Math.floor(rnd() * 15), bend: r(-100, 100), rotate: rnd() < 0.5 ? 0 : 1, h: r(-100, 100), v: r(-100, 100) });
}
for (let s = 0; s < STYLES.length && !randomCount; s++) {
  if (styleFilter.length && !styleFilter.includes(STYLES[s])) continue;
  for (const bend of bends) for (const [h, v] of distortions) cases.push({ style: s + 1, bend, rotate: 0, h, v });
  // vertical axis: the transposition, checked with and without distortion
  for (const bend of vBends) for (const [h, v] of vDistortions) cases.push({ style: s + 1, bend, rotate: 1, h, v });
}

const jsx = JSX_JSON + `
var W = ${W}, H = ${H}, N = ${lattice};
var cases = ${JSON.stringify(cases)};
var doc = app.documents.add(DocumentColorSpace.RGB, W, H);
app.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM;
function r3(x) { return Math.round(x * 1000) / 1000; }
function sample(c) {
  var g = doc.groupItems.add();
  var r = doc.pathItems.rectangle(0, 0, W, H); r.stroked = false; r.filled = true; r.name = 'frame'; r.move(g, ElementPlacement.PLACEATEND);
  for (var j = 0; j <= N; j++) {
    var pts = [];
    for (var i = 0; i <= N; i++) pts.push([W * i / N, -H * j / N]);
    var p = doc.pathItems.add(); p.setEntirePath(pts); p.stroked = true; p.strokeWidth = 0.01; p.filled = false; p.closed = false; p.name = 'row' + j;
    p.move(g, ElementPlacement.PLACEATEND);
  }
  var xml = '<LiveEffect name="Adobe Deform"><Dict data="R DeformValue ' + (c.bend / 100) + ' R DeformHoriz ' + (c.h / 100) + ' R DeformVert ' + (c.v / 100) + ' I DeformStyle ' + c.style + ' B Rotate ' + c.rotate + ' "/></LiveEffect>';
  g.applyEffect(xml);
  doc.selection = null; g.selected = true;
  app.executeMenuCommand('expandStyle');
  var item = doc.selection[0];
  var out = { outline: null, grid: [] };
  var rows = {};
  function walk(it) {
    if (it.typename === 'GroupItem') { for (var k = 0; k < it.pageItems.length; k++) walk(it.pageItems[k]); return; }
    if (it.typename === 'CompoundPathItem') { for (var k2 = 0; k2 < it.pathItems.length; k2++) walk(it.pathItems[k2]); return; }
    if (it.typename !== 'PathItem') return;
    if (it.name.indexOf('row') === 0) {
      var arr = [];
      for (var i = 0; i < it.pathPoints.length; i++) arr.push([r3(it.pathPoints[i].anchor[0]), r3(-it.pathPoints[i].anchor[1])]);
      rows[it.name] = arr;
    } else {
      var o = [];
      for (var i2 = 0; i2 < it.pathPoints.length; i2++) {
        var pp = it.pathPoints[i2];
        o.push([r3(pp.anchor[0]), r3(-pp.anchor[1]), r3(pp.leftDirection[0]), r3(-pp.leftDirection[1]), r3(pp.rightDirection[0]), r3(-pp.rightDirection[1])]);
      }
      out.outline = o;
    }
  }
  walk(item);
  for (var j2 = 0; j2 <= N; j2++) out.grid.push(rows['row' + j2] || null);
  item.remove();
  return out;
}
var results = [];
for (var ci = 0; ci < cases.length; ci++) results.push(sample(cases[ci]));
doc.close(SaveOptions.DONOTSAVECHANGES);
return __json(results);
`;

const t0 = Date.now();
const results = JSON.parse(await runJsx(jsx));
const fixture = {
  source: `Adobe Illustrator ${await runJsx('return app.version;')} — Effect > Warp, expanded; frame ${W}×${H}, lattice ${lattice + 1}×${lattice + 1}`,
  frame: { width: W, height: H },
  lattice,
  cases: cases.map((c, i) => ({
    style: STYLES[c.style - 1],
    bend: c.bend,
    horizontal: c.rotate === 0,
    hDistort: c.h,
    vDistort: c.v,
    outline: results[i].outline,
    grid: results[i].grid,
  })),
};
writeFileSync(outFile, JSON.stringify(fixture));
console.log(`${fixture.cases.length} cases → ${outFile} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
