/**
 * Render a vector file (.ai, .svg, .pdf, .eps) with the installed Adobe Illustrator: the file
 * is opened, the first artboard exported as PNG-24 (white background unless --transparent)
 * and the document closed without saving.
 *
 *   node scripts/illustrator/render-file.mjs in.ai out.png [--scale 1] [--transparent]
 *
 * Also usable as a module: `renderFile(inPath, outPath, { scale })` → resolves with a report
 * ({ width, height, artboards, items }) describing what Illustrator opened.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJsx, JSX_JSON } from './ai.mjs';

export async function renderFile(inPath, outPath, { scale = 1, transparent = false } = {}) {
  const src = resolve(inPath).replace(/\\/g, '/');
  const dst = resolve(outPath).replace(/\\/g, '/');
  const jsx = JSX_JSON + `
var userInteraction = app.userInteractionLevel;
app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
var doc = app.open(new File(${JSON.stringify(src)}));
var ab = doc.artboards[0].artboardRect;
var opts = new ExportOptionsPNG24();
opts.artBoardClipping = true;
opts.transparency = ${transparent ? 'true' : 'false'};
opts.antiAliasing = true;
opts.horizontalScale = ${scale * 100};
opts.verticalScale = ${scale * 100};
doc.exportFile(new File(${JSON.stringify(dst)}), ExportType.PNG24, opts);
var report = { width: ab[2] - ab[0], height: ab[1] - ab[3], artboards: doc.artboards.length, items: doc.pageItems.length, layers: doc.layers.length };
doc.close(SaveOptions.DONOTSAVECHANGES);
app.userInteractionLevel = userInteraction;
return __json(report);
`;
  return JSON.parse(await runJsx(jsx));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const scaleIdx = args.indexOf('--scale');
  if (files.length < 2) {
    console.error('usage: node scripts/illustrator/render-file.mjs in.ai out.png [--scale 1] [--transparent]');
    process.exit(2);
  }
  renderFile(files[0], files[1], { scale: scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : 1, transparent: args.includes('--transparent') }).then(
    (r) => console.log(`${files[1]}: ${r.width}×${r.height}, ${r.items} items on ${r.layers} layer(s)`),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
