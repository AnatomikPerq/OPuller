# OPuller

A professional vector graphics editor for the web — an Adobe Illustrator alternative with a
full toolset, panels, keyboard shortcuts, unlimited undo, RGB / CMYK documents with spot and
global colours, symbols, brushes, patterns, mesh gradients, envelopes, 3D, Live Paint, graphs, a
perspective grid, and SVG / PNG / JPEG / WebP / PDF / EPS export plus PDF / AI / EPS import.
Vector first, raster second. Burgundy **OP** icon, dark UI.

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

## What's inside

**Tools** (Illustrator shortcuts where they exist): Selection (V), Direct Selection (A),
Lasso (Q), Perspective Selection (Shift+V), Pen (P) with Add/Delete/Convert anchor tools,
Curvature (Shift+`), Pencil (N), Paintbrush (B) with calligraphic / scatter / art / pattern
brushes, Blob brush (Shift+B), Smooth, Path Eraser, Pixel Brush, Rectangle (M), Rounded
Rectangle, Ellipse (L), Polygon, Star, Line (\), Type (T), Graph (J), Rotate (R), Scale (S),
Reflect (O), Shear, Free Transform (E), Shape Builder (Shift+M), Live Paint Bucket (K),
Live Paint Selection (Shift+L), Eraser (Shift+E), Gradient (G, incl. freeform), Mesh (U),
Symbol Sprayer (Shift+S), Eyedropper (I), Measure, Scissors (C), Knife, Width (Shift+W),
Blend (W), the liquify brushes Warp (Shift+R), Twirl, Pucker, Bloat, Scallop, Crystallize and
Wrinkle, Perspective Grid (Shift+P), Artboard (Shift+O), Hand (H), Zoom (Z).

**Panels**: Properties, Transform, Align, Pathfinder, Color (RGB / HSB / CMYK, tints),
Swatches (process, global and spot colours, patterns, print libraries), Gradient (linear,
radial, freeform), Stroke (caps, joins, dashes, arrowheads, brushes), Layers (drag & drop,
thumbnails), Artboards, Symbols, Brushes, History, Navigator, Info, Character, Paragraph,
Appearance, Effects.

**Object operations**: Pathfinder (unite, minus front/back, intersect, exclude, divide,
trim, merge, crop, outline), Live Paint groups, compound paths, clipping masks, offset path,
outline stroke, simplify, join/average, expand / expand appearance, blends (steps / distance /
smooth colour, live update), transform each / again, arrange, group / isolation mode, symbols
(make, place, redefine, sprayer sets), patterns (make, edit tile, options, fill options),
gradient meshes and freeform gradients, envelope distort (warp with 15 styles, mesh, top
object, free distort), 3D extrude & bevel / revolve / rotate, perspective grid (attach to
plane, move along planes), graphs (9 types with a data table), Image Trace (an in-house
potrace engine with colour reduction: presets, Black & White / Grayscale / Color, Paths /
Corners / Noise, abutting or overlapping shapes, Fills and Strokes — thin lines become
stroked centerlines —, live preview in a Web Worker), rasterize, crop
image, effects (drop / inner shadow, glows, blur, colour adjustments, round corners), Edit
Colors (Recolor Artwork, saturate, balance, blend, grayscale, invert, CMYK ↔ RGB).

**Colour & print**: RGB or CMYK document colour mode, global swatches with tints, spot
colours, bleed with printer marks (trim / registration / colour bars / page info) in SVG,
PDF and EPS export.

**Type**: point, area and type-on-a-path text, 14 bundled font families plus system
fonts, custom font upload, Create Outlines.

**Files**: `.opuller` project files (JSON, images embedded), SVG import/export, PDF and
PDF-compatible AI import (editable objects or a rasterised page), classic AI / EPS import
(PostScript interpreter), PNG / JPEG / WebP / PDF / EPS export per artboard or selection,
clipboard (SVG in/out), drag & drop placement, autosave with recovery, recent files, sample
documents (File > Open Sample — including the bird built from 13 circles with Pathfinder).

## Let an AI drive the editor (MCP)

OPuller ships an [MCP](https://modelcontextprotocol.io) server so Claude (Claude Code,
Claude Desktop) or any MCP client can read the document, create and edit objects, run
every command and tool, simulate mouse gestures and look at the result as an image.

1. Open the editor in a browser (`npm run dev`). The page connects to the local bridge
   (`ws://127.0.0.1:5187`) automatically — the status bar shows **AI** when a server
   is attached (Window > AI Bridge (MCP) toggles it).
2. Register the server. Claude Code picks it up from the repository's `.mcp.json`;
   for other clients:

   ```json
   { "mcpServers": { "opuller": { "command": "node", "args": ["mcp/server.ts"] } } }
   ```

   Manual start: `npm run mcp` (stdio transport, Node ≥ 22.6).
3. Ask the assistant, e.g. *"Draw a bird from circles, colour it #1da1f2 and show me a
   screenshot"*. Tools include `opuller_create_shape`, `opuller_create_path`,
   `opuller_create_text`, `opuller_pathfinder`, `opuller_update_nodes`,
   `opuller_transform`, `opuller_gesture` (drive any tool with the mouse),
   `opuller_run_command`, `opuller_render_png`, `opuller_screenshot`,
   `opuller_export_svg`, `opuller_export_file` (SVG / PDF / EPS with bleed and marks),
   `opuller_place_file` (PDF / AI / EPS / SVG / images), `opuller_symbols`,
   `opuller_brushes`, `opuller_patterns`, `opuller_gradients`, `opuller_livepaint`,
   `opuller_graphs`, `opuller_perspective`, `opuller_liquify`, `opuller_image_trace`,
   `opuller_save_project` and more —
   `opuller_status`, `opuller_list_tools` and `opuller_list_commands` describe the editor.

Command-line helpers: `npm run mcp:smoke` (end-to-end check) and
`node mcp/call.ts <tool> '<json>'` (call one tool). The same API is available in the
browser console as `window.__opuller.mcp`.

## Tests

```bash
npm test             # unit tests (vitest)
npm run test:e2e     # Playwright e2e (starts/reuses the dev server)
node scripts/trace-profile.mjs photo.jpg 640 64   # time the Image Trace stages on a picture
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the document model, store, tool/command/
panel registries, module layout and the contribution rules.

## Stack

React 19, TypeScript, Vite, zustand + immer, paper.js (geometry kernel), opentype.js,
jsPDF + svg2pdf.js, pdfjs-dist (PDF / AI import), an in-house potrace port (Image Trace),
lucide-react, @fontsource fonts, @modelcontextprotocol/sdk + ws (AI bridge).
