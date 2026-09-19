# CLAUDE.md — working in the OPuller repository

OPuller is a browser-based vector editor (an Adobe Illustrator alternative) built with
React 19 + TypeScript + Vite, zustand + immer, an SVG DOM renderer and paper.js as the
geometry kernel. It ships an MCP server so an AI can drive the editor.

## Commands

```bash
npm run dev          # dev server on http://127.0.0.1:5180 (strict port)
npm run typecheck    # tsc --noEmit — run after every change
npm test             # vitest unit tests (tests/unit)
npm run test:e2e     # Playwright (tests/e2e); reuses a running dev server
npx playwright test tests/e2e/<name>.spec.ts   # one spec
npm run build        # typecheck + production build
npm run mcp          # MCP server (stdio); also registered in .mcp.json
npm run mcp:smoke    # end-to-end check of the MCP server against the open editor tab
node mcp/call.ts <tool> '<json>'   # call one MCP tool (e.g. render the artboard to a PNG file)
npm run preview      # serve dist/ on :5181 with the production security headers (CSP check)
node scripts/gen-shortcuts.mjs   # refresh the shortcut tables in public/guide/index.html (needs the dev server)
node scripts/gen-og.mjs          # refresh public/og.png + public/screenshot.png (needs the dev server)
node scripts/illustrator/ai.mjs 'return app.version'   # run ExtendScript in the installed Illustrator (COM)
node scripts/illustrator/warp-fixtures.mjs             # re-sample Effect > Warp from Illustrator into tests/fixtures/warp/
```

Adobe Illustrator 2026 is installed on this machine: when a behaviour should match Illustrator,
measure it there through `scripts/illustrator/ai.mjs` (`runJsx`, ES3 ExtendScript, `return` a
string; `JSX_JSON` serialises objects) instead of guessing, and keep the samples as fixtures.

Playwright starts its own dev server when none is running and kills it afterwards; when you
use the Browser pane, restart the preview (`.claude/launch.json` → `opuller-dev`) after a
test run. Screenshots of the pane can time out when the window is hidden — render the
document through `node mcp/call.ts opuller_render_png '{"scope":"artboard","file":"out.png"}'`
and Read the file instead.

## Read first

* `docs/ARCHITECTURE.md` — the contract: document model, store, tool/command/panel/dialog
  registries, auto-registration, module map, extension points.
* `docs/COMPARISON.md` — feature inventory versus Illustrator (what exists, what is missing).
* `src/model/types.ts` — the document model (paths = subpaths of anchors with relative
  handles; live shapes; paint; stroke; text; images; artboards).

## How the code is organised

* Core (model, geometry, store, canvas, UI shell, widgets) lives in `src/model`, `src/geometry`,
  `src/store`, `src/canvas`, `src/ui/*.tsx`, `src/commands/{registry,core,viewCommands,appearance}.ts`.
* Features are self-contained modules: `src/<feature>/register.ts(x)` is auto-imported
  (`src/modules.ts` globs every `register.ts(x)`), tools are `src/tools/<name>/tool.tsx`
  exporting `tool` or `tools`. Panels/dialogs/commands/viewport slots register themselves.
* Everything user-visible goes through commands (`registerCommands`) so menus, shortcuts,
  the context menu and the MCP server stay in sync.
* Document edits: `updateDoc(draft => …, 'Label')` = one undo step. During drags call
  `updateDoc`/`replaceDoc` per move and `commit('Label')` once on pointer-up; `revert()` on Escape.
* Geometry in world space: `worldSubPaths` / `setWorldSubPaths`, booleans via
  `geometry/paperBridge.ts` (`booleanOp`, `uniteAll`, `offsetPath`, `outlineStroke`…).
  paper.js needs a canvas, so unit tests (jsdom) must not import it — keep pure logic in
  separate files.
* The public site around the editor is static: `index.html` carries the SEO head (canonical,
  Open Graph, JSON-LD) and a boot screen with links that React replaces; the pages
  `public/features/`, `public/guide/`, `public/ai/` share `public/site.css`; `robots.txt`,
  `sitemap.xml`, `og.png`, `screenshot.png` live in `public/`. Adding a page = a new
  `public/<page>/index.html` + a sitemap entry + a nav link on the other pages.
* Production runs under a strict Content-Security-Policy (`deploy/nginx-opuller-headers.conf`):
  no `eval` / `new Function` / inline scripts in browser code (`paper` is aliased to
  `paper-core`); markup injected with `dangerouslySetInnerHTML` from files passes
  `src/io/sanitizeSvg.ts`. `npm run preview` serves the build with the same headers.
* The AI bridge: `src/mcp/api.ts` holds the scripting methods (also `window.__opuller.mcp`);
  `mcp/server.ts` maps them to MCP tools. Add a method there when a feature should be
  scriptable, then a `registerTool` in the server.
* Geometry-changing effects register with `registerGeometryEffect` (`src/canvas/effectiveGeometry.ts`)
  and Expand Appearance with `registerExpander` (`src/appearance/expand.ts`); feature state that
  lives on nodes goes into `node.data.<marker>` with an `isX(doc, id)` helper in the module.
  Pure maths stays in files that import neither React nor paper.js so vitest can cover it.

## Conventions

* Run `npm run typecheck` after edits; keep the tree compiling (the dev server hot-reloads).
* Add or extend a Playwright spec for user-visible behaviour (`tests/e2e/helpers.ts` has
  `openApp`, `drawRect`, `dragWorld`, `clickWorld`, `runCommand`, `withStore`, `getState`).
  Use `data-testid` on new controls. `NumberField` puts the test id on the `<input>` itself.
* Tests must not `import()` source files dynamically from the page (Vite may serve a second
  module instance); expose what a test needs on `window.__opuller` from a `register.ts`.
* Illustrator conventions where they exist: shortcuts, menu names, angle direction
  (counter-clockwise positive), Alt = from centre / duplicate, Shift = constrain.
* Styling: CSS variables from `src/styles.css`; feature CSS in the feature folder; 12px UI
  font, 24px controls, dark theme first.
* Colours are lowercase `#rrggbb` + separate opacity; gradients in bounding-box units.
* No new npm dependencies without a reason; note them in the commit message.
* Commit checkpoints with descriptive messages and push them to `origin master`
  (https://github.com/AnatomikPerq/OPuller, public). Never commit pictures or other test
  material dropped into the project root.

## Do not

* Do not launch multi-agent Workflow orchestration here (the user finds it too expensive) —
  implement directly.
* Do not edit `src/model/types.ts` shape of existing fields without updating
  `src/io/project.ts` (file format) and `src/io/svgExport.ts` / `svgImport.ts`; new document
  or node fields need validation in `project.ts` too.
* Do not use `require()` or dynamic `import()` of source files inside browser code paths that
  must work synchronously; use static imports (Vite may serve a second module instance).
* Do not start a second Vite server or kill the running one.
* Do not commit `dist/`, `test-results/` or `playwright-report/`.
