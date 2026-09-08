# OPuller

A professional vector graphics editor for the web — an Adobe Illustrator alternative with a
full toolset, panels, keyboard shortcuts, unlimited undo and SVG / PNG / JPEG / WebP / PDF
export. Vector first, raster second. Burgundy **OP** icon, dark UI.

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
Lasso (Q), Pen (P) with Add/Delete/Convert anchor tools, Curvature (Shift+`), Pencil (N),
Paintbrush (B), Blob brush (Shift+B), Smooth, Path Eraser, Pixel Brush, Rectangle (M),
Rounded Rectangle, Ellipse (L), Polygon, Star, Line (\), Type (T), Rotate (R), Scale (S),
Reflect (O), Shear, Free Transform (E), Shape Builder (Shift+M), Eraser (Shift+E),
Gradient (G), Eyedropper (I), Measure, Scissors (C), Knife (K), Width (Shift+W),
Blend (W), Artboard (Shift+O), Hand (H), Zoom (Z).

**Panels**: Properties, Transform, Align, Pathfinder, Color, Swatches (with libraries),
Gradient, Stroke (caps, joins, dashes, arrowheads), Layers (drag & drop, thumbnails),
Artboards, History, Navigator, Info, Character, Paragraph, Appearance, Effects.

**Object operations**: Pathfinder (unite, minus front/back, intersect, exclude, divide,
trim, merge, crop, outline), compound paths, clipping masks, offset path, outline
stroke, simplify, join/average, expand, blends (steps / distance / smooth colour, live
update), transform each / again, arrange, group / isolation mode, image trace,
rasterize, crop image, effects (drop / inner shadow, glows, blur, colour adjustments,
round corners).

**Type**: point, area and type-on-a-path text, 14 bundled font families plus system
fonts, custom font upload, Create Outlines.

**Files**: `.opuller` project files (JSON, images embedded), SVG import/export, PNG /
JPEG / WebP / PDF export per artboard or selection, clipboard (SVG in/out), drag & drop
placement, autosave with recovery, recent files, sample documents (File > Open Sample —
including the bird built from 13 circles with Pathfinder).

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
   `opuller_export_svg`, `opuller_save_project` and more — `opuller_status`,
   `opuller_list_tools` and `opuller_list_commands` describe the editor.

Command-line helpers: `npm run mcp:smoke` (end-to-end check) and
`node mcp/call.ts <tool> '<json>'` (call one tool). The same API is available in the
browser console as `window.__opuller.mcp`.

## Tests

```bash
npm test             # unit tests (vitest)
npm run test:e2e     # Playwright e2e (starts/reuses the dev server)
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the document model, store, tool/command/
panel registries, module layout and the contribution rules.

## Stack

React 19, TypeScript, Vite, zustand + immer, paper.js (geometry kernel), opentype.js,
jsPDF + svg2pdf.js, imagetracerjs, lucide-react, @fontsource fonts,
@modelcontextprotocol/sdk + ws (AI bridge).
