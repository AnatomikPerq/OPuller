# OPuller

A professional vector graphics editor for the web — an Adobe Illustrator alternative with a
full toolset (pen, direct selection, shapes, text, pathfinder, shape builder, gradients,
transforms, blends, raster tracing and more), panels, keyboard shortcuts, undo/redo and
SVG / PNG / JPEG / WebP / PDF export.

## Run

```bash
npm install
npm run dev          # http://127.0.0.1:5180
```

Production build:

```bash
npm run build        # typecheck + vite build → dist/
npm run preview
```

## Tests

```bash
npm test             # unit tests (vitest)
npm run test:e2e     # Playwright e2e (starts/reuses the dev server)
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the document model, store, tool/command/
panel registries and the contribution rules.

## Stack

React 19, TypeScript, Vite, zustand + immer, paper.js (geometry kernel), opentype.js,
jsPDF + svg2pdf.js, imagetracerjs, lucide-react, @fontsource fonts.
