# OPuller — architecture & contribution contract

OPuller is a browser-based vector editor (an Illustrator-class tool) built with
**React 19 + TypeScript + Vite**, a **zustand** store with **immer**, an **SVG DOM
renderer**, and **paper.js** as the geometry kernel (booleans, offsets, fitting).

Read this whole file before touching code. The rules at the end are mandatory.

## Directory map

```
src/
  model/        document model (types.ts = THE contract), factories (nodes.ts),
                tree/bounds/transform operations (document.ts), defaults.ts
  geometry/     matrix, vec, bezier, path (SubPath ops + SVG d parsing), shapes,
                paperBridge (booleans/offset/simplify/fit), widthProfile
  store/        store.ts — zustand store: doc, history, selection, viewport, tools,
                view settings, prefs, appearance defaults, UI state
  canvas/       Viewport.tsx (events, rulers, grid, artboards, overlay), Renderer.tsx
                (document → SVG, also used for export), hitTest.ts, snap.ts,
                selectionHandles.ts, SelectionOverlay.tsx, overlayStore.ts,
                toolContext.ts, viewportSlots.ts
  tools/        types.ts (Tool contract), registry.ts, index.ts (auto-registration),
                <name>/tool.tsx per tool
  commands/     registry.ts (Command contract, menus & shortcuts), core.ts,
                viewCommands.ts, appearance.ts
  ui/           App shell (MenuBar, Toolbar, ControlBar, StatusBar, Dock),
                widgets.tsx (shared form controls), ColorPicker.tsx, PaintIndicator,
                panels/registry.ts, dialogs/registry.ts, DialogHost.tsx (DialogFrame)
  text/         layout.ts (text measurement / line layout)
  util/         units.ts (units, expressions), color.ts, keys.ts, files.ts
  io/           (import/export — owned by the IO module)
  samples/      sample documents
tests/
  unit/         vitest (jsdom)          -> `npm test`
  e2e/          Playwright (Chromium)   -> `npm run test:e2e`, helpers in helpers.ts
docs/           this file
```

## Core concepts

### Document model (`src/model/types.ts`)

* `Document` holds `nodes: Record<ID, Node>` (normalized), `layers: ID[]` (bottom→top),
  `artboards`, `guides`, `swatches`, `patterns`, `grid`.
* Node types: `layer`, `group` (with optional `clipId` = clipping mask child), `path`,
  `text`, `image`. Every node has `parent`, `transform` (matrix relative to the parent),
  `visible`, `locked`, `opacity`, `blendMode`, `effects`.
* **Paths** are lists of `SubPath { anchors: Anchor[]; closed }`. `Anchor.handleIn/Out`
  are **relative** offsets from `anchor.point` (null = no handle). A path may carry a
  `shape: LiveShape` (rect/ellipse/polygon/star/line/spiral/arc) that regenerates the
  geometry from parameters (`refreshLiveShape`). Editing anchors must clear `shape`.
* **Paint**: `none | solid | linear | radial | pattern`. Gradients use *object
  bounding box* units (0..1). Colours are lowercase `#rrggbb` hex + separate opacity.
* **Stroke**: `StrokeStyle` (paint, width, cap, join, miterLimit, dash, align,
  arrowheads, optional `widthProfile`).
* **Text**: `TextNode { kind: point|area|path, text, runs, style, box?, pathId? }`.
  `text/layout.ts` measures text with a canvas and lays out lines/runs.
* Geometry is local; `worldMatrix(doc, id)` maps local → world. Paths without live
  shapes get transforms **baked** into their geometry (`bakeTransform`) after gestures;
  live shapes keep translation/rotation in the matrix and scale in the parameters.

### Store (`src/store/store.ts`)

```ts
const s = getState();               // outside React
const zoom = useStore(st => st.zoom); // inside React (select narrowly!)
s.updateDoc(draft => { ...mutate with immer... });   // no history entry yet
s.commit('Label');                                   // records an undo step
s.updateDoc(draft => {...}, 'Label');                // update + commit in one go
s.replaceDoc(nextDoc);                               // replace with a produced doc (gestures)
s.revert();                                          // drop uncommitted changes (Escape)
```
* During a drag: call `updateDoc`/`replaceDoc` on every move, `commit(label)` once on
  pointer-up. Never commit per move.
* Selection: `s.selection: ID[]`, `s.selectedAnchors: AnchorRef[]`, `setSelection`,
  `addToSelection`, `toggleSelection`, `clearSelection`.
* Viewport: `zoom`, `pan` (screen = world*zoom + pan), `setZoom(z, screenAnchor)`,
  `zoomToRect`. Helpers `screenToWorld/worldToScreen` in store.ts.
* `s.appearance` = fill/stroke/textStyle used for **new** objects (Illustrator
  semantics: when nothing is selected, colour edits change these defaults).
  Use `commands/appearance.ts` (`setFillPaint`, `setStrokePaint`, `setStrokeProps`,
  `setTextStyle`, `useCurrentAppearance`) instead of touching nodes directly.
* `s.view` (rulers/grid/guides/snap/outline...), `s.prefs` (units, nudge, theme,
  snapTolerance, handleSize...), `s.toolOptions[toolId]` (persisted per tool).
* UI: `openDialog(type, props)`, `closeDialog`, `openContextMenu`, `toast(msg, kind)`,
  `setStatus`, `togglePanel(id)`.

### Tools (`src/tools/types.ts`)

Create `src/tools/<name>/tool.tsx` exporting `tool: Tool` or `tools: Tool[]`.
It is registered automatically (glob import). Fields:

```ts
{ id, name, shortcut?: 'p' | 'shift+c', icon (lucide component), group, order, cursor?,
  defaults?, Options?: React.FC (rendered in the control bar), hint?,
  activate/deactivate, onPointerDown/Move/Up, onDoubleClick, onKeyDown (return true when
  consumed), onModifiers, renderOverlay(ctx) => ReactNode (screen-space SVG),
  showSelectionOverlay: true | false | 'anchors', isBusy(), cancel(ctx) }
```
* Toolbar groups (flyouts) by `group`; ordering by `order` (hundreds = separators):
  `select` 10-99 (select, direct, lasso, wand), `pen` 100-199, `draw` 200-299 (pencil,
  brush, smooth...), `shapes` 300-399, `text` 400-499, `transform` 500-599,
  `edit` 600-699 (scissors, knife, eraser, shape builder, width, blend, gradient,
  eyedropper, measure...), `artboard` 800, `navigate` 900.
* `ToolContext` (`ctx`): `ctx.state` (fresh snapshot), `ctx.doc`, `ctx.zoom`,
  `ctx.hitTest(world, opts)`, `ctx.hitTestAnchors(world, ids)`, `ctx.beginSnap(opts)` →
  `SnapSession.snap(p)` / `snapRect(r)`, `ctx.setSnapGuides(result)`,
  `ctx.setCursor`, `ctx.setStatus`, `ctx.commit(label)`, `ctx.requestOverlay()`,
  `ctx.options<T>()` / `ctx.setOptions(patch)`, `ctx.setTool(id)`,
  `ctx.worldToScreen/screenToWorld`, `ctx.tolerance()` (world units).
* Events: `ToolPointerEvent { world, screen, button, shift, alt, ctrl, meta, primary,
  pressure, native }`. `primary` = Ctrl (Win/Linux) / Cmd (mac).
* Keep gesture state in module-level variables (see `tools/select/tool.tsx`,
  `tools/shapes/tool.tsx` for the reference pattern). Escape must call `cancel` and
  `state.revert()`.
* Overlays: draw in **screen space** in `renderOverlay`. Use
  `useOverlayStore` (`setHud`, `setMarquee`, `setSnap`) for common visuals.
* New objects go to `insertionParent()` (`tools/shapes/tool.tsx`) with
  `addNode(draft, node, parent)` and take `state.appearance` fill/stroke.
* Read tool options with `useToolOptions(toolId)` in the Options component.

### Commands (`src/commands/registry.ts`)

```ts
registerCommands([{ id: 'path.join', label: 'Join', menu: 'Object/Path', shortcut: 'mod+j',
  order: 10, separatorBefore?: true, run: () => {...}, enabled: when.hasPathSelection,
  checked?: (s) => bool, hidden?: true, allowInTextEdit?: true }]);
```
* Top-level menus: File, Edit, Object, Type, Select, Effect, View, Window, Help.
  `menu: 'Object/Path'` creates a submenu. Menus, shortcuts and the canvas context menu
  (`src/ui/contextMenu/register.ts`, lists command ids) are all driven by the registry.
* Shortcut syntax: `mod` = Ctrl/Cmd, plus `shift`, `alt`; keys `a`-`z`, `0`-`9`, `f1`..,
  `up/down/left/right`, `delete`, `backspace`, `enter`, `esc`, `space`, `=`, `-`, `[`, `]`.
* Run from anywhere: `runCommand('id')`.

### Panels (`src/ui/panels/registry.ts`)

Create `src/ui/panels/<name>/register.tsx`:
```ts
registerPanel({ id: 'stroke', title: 'Stroke', component: StrokePanel, order: 30, defaultVisible: true });
```
Default dock layout (ids must match): properties, transform, align, pathfinder |
color, swatches, gradient, stroke | layers, artboards, history, navigator |
character, paragraph, appearance, effects. Unknown ids land in a trailing group.
Panels render inside `.panel-body` (padded, scrollable). Use widgets from
`src/ui/widgets.tsx`: `NumberField` (scrub, units, expressions, `mixed`), `TextField`,
`Select`, `Checkbox`, `Button`, `IconButton`, `Segmented`, `Slider`, `Popover`,
`PopoverButton`, `Tooltip`, `Row`, `Section`, `Tabs`, `Divider`. Colour editing:
`ColorPicker` (`src/ui/ColorPicker.tsx`) and `paintCss(paint)` for previews.

### Dialogs (`src/ui/dialogs/registry.ts`)

```ts
registerDialog('offsetPath', ({ props, close }) => <DialogFrame title="Offset Path" onClose={close} footer={...}>...</DialogFrame>);
getState().openDialog('offsetPath', { ... });
```
`DialogFrame` is exported from `src/ui/DialogHost.tsx`.

### Module auto-loading

Any `register.ts`/`register.tsx` under `src/` is imported at startup (`src/modules.ts`).
Put `registerCommands`, `registerPanel`, `registerDialog`, `registerViewportSlot`,
`addContextMenuSection` calls there. Tools use `src/tools/<name>/tool.tsx`.

### Rendering (`src/canvas/Renderer.tsx`)

`LiveDocument` renders from the store (fine-grained subscriptions). `StaticDocument`
renders a given `Document` (export). Gradients → `<linearGradient>`/`<radialGradient>`
in userSpaceOnUse mapped onto the node's local bounds; effects → `<filter>`; clip
groups → `<clipPath>`; arrowheads → `<marker>`; text → `<text>/<tspan>` (or
`<textPath>`). Node elements carry `data-id`.

### Geometry helpers you will need

* `geometry/path.ts`: `parseSvgPathData`, `pathToSvgD`, `pathBounds`,
  `transformSubPaths`, `nearestPointOnPath`, `pointInPath`, `insertAnchorAt`,
  `removeAnchor`, `splitAtLocation`, `joinSubPaths`, `makeSmooth`, `makeCorner`,
  `flattenSubPath`, `locationAtOffset`, `reverseSubPath`, `polylineSubPath`.
* `geometry/paperBridge.ts`: `booleanOp('unite'|'subtract'|'intersect'|'exclude'|'divide', a, b)`,
  `uniteAll`, `divideToFaces`, `offsetPath`, `outlineStroke`, `simplifyPath`,
  `smoothPath`, `flattenPath`, `fitPoints` (freehand → Bézier), `containsPoint`,
  `intersections`, `interpolatePaths`, `reorient`. All work in one coordinate space —
  use `worldSubPaths(doc, id)` / `setWorldSubPaths(doc, id, sps)` from model/document.
* `model/document.ts`: tree ops (`addNode`, `removeNode`, `moveNode`, `cloneSubtree`,
  `groupNodes`, `ungroupNode`), queries (`descendants`, `ancestors`, `paintOrder`,
  `selectableNodes`, `topmostOf`, `sortByPaintOrder`), transforms (`worldMatrix`,
  `applyWorldMatrix`, `bakeTransform`), bounds (`localBounds`, `worldBounds`,
  `visualBounds`, `selectionBounds`), `collectPaths`.
* `canvas/hitTest.ts`: `hitTest`, `hitTestAnchors`, `hitTestSegment`, `nodesInRect`.
* `util/units.ts`: `formatLength`, `parseLength`, `pxToUnit`; `util/color.ts`.

## Testing

* `npm run typecheck` (tsc) must pass. Run it after every file you write.
* Unit tests: `tests/unit/<area>.test.ts` (vitest, jsdom). Pure geometry/model logic
  belongs here.
* E2E: `tests/e2e/<feature>.spec.ts` with helpers from `tests/e2e/helpers.ts`
  (`openApp`, `drawRect`, `dragWorld`, `clickWorld`, `selectTool`, `getState`,
  `withStore`, `runCommand`, `nodeById`, `worldBounds`). `window.__opuller` exposes
  `store`, `runCommand`, `worldBounds`, `api.{document,nodes,path,paper}`.
  Run a single file: `npx playwright test tests/e2e/<feature>.spec.ts`.
  The dev server (port 5180) is reused if already running — **do not start another
  Vite server and do not kill the running one**.

## Mandatory rules for contributors (human or agent)

1. **File ownership.** Only create/edit files inside the paths assigned to you. Do
   not edit core files (`src/model/*`, `src/store/*`, `src/canvas/*`,
   `src/geometry/*`, `src/ui/widgets.tsx`, `src/ui/App.tsx`, `src/ui/*.tsx` shell,
   `src/commands/registry.ts`, `src/commands/core.ts`, `src/tools/select`,
   `src/tools/shapes`, `src/styles.css`). If you truly need a core change, describe the
   exact change in your final report (file, function, why) — do not apply it.
   Small additions of **new** exported helpers are allowed only in files you own.
2. **Never leave a file syntactically broken.** Write complete files (Write tool),
   then run `npm run typecheck`. Other people are working in the same tree at the
   same time and the dev server hot-reloads everything.
3. Fix only type errors in your own files; if `tsc` reports errors in files you do not
   own, ignore them (someone else is mid-edit) and mention them in your report.
4. Styling: use the CSS variables in `src/styles.css` (`--bg-panel`, `--border`,
   `--text-muted`, `--accent`, ...). Put feature CSS in your own `*.css` file imported
   from your module (Vite handles it). Match the existing look: 12px UI font, compact
   24px controls, dark theme first (light theme uses the same variables).
5. Undo: every user-visible document change must be one history step
   (`updateDoc(fn, 'Label')` or `commit('Label')` after a gesture).
6. Everything you build must actually work end-to-end in the browser. Verify with a
   Playwright test in `tests/e2e/<feature>.spec.ts` and by running it. If the page is
   broken by an unrelated file, wait ~30 s and retry before investigating.
7. Icons: `lucide-react`. Shortcuts: follow Illustrator where it exists.
8. Do not add npm dependencies without a strong reason; if you do, say so in the report.
9. Keep the model serializable (plain JSON). No class instances or functions in nodes.
10. Report at the end: what was built (files), what works (tested how), what is missing,
    and any requested core changes.

## Feature modules (where things live)

| Area | Folder(s) | Notes |
| --- | --- | --- |
| Path editing tools | `src/tools/{direct,pen,anchor,curvature,lasso}`, shared helpers in `src/tools/pathEditing` | world-space anchor/handle editing |
| Freehand tools | `src/tools/{pencil,brush,blob,smooth,patheraser,eraser}`, `src/tools/freehand` | cutting/sampling helpers reused by the Knife |
| Type | `src/tools/text`, `src/text/{fonts,layout,outline,editing}.ts`, panels `character`, `paragraph`, `src/commands/typeCommands` | |
| Transform | `src/transform`, `src/tools/{rotate,scale,reflect,shear,freetransform}`, panels `transform`, `align`, dialogs `transform` | angles use Illustrator's convention |
| Pathfinder / Shape Builder | `src/pathops`, `src/tools/shapebuilder`, panel `pathfinder`, `src/commands/pathCommands` | paper.js booleans |
| Colour | `src/color`, panels `color`, `swatches`, `gradient`, `stroke`, `src/tools/{gradient,eyedropper}` | |
| Layers & appearance | panels `layers`, `properties`, `appearance`, `effects`, `history`, `navigator`, `info`, `src/commands/{layerCommands,effectCommands}` | |
| IO | `src/io` (SVG import/export, raster, PDF, project files, clipboard, autosave, recent), dialogs `export`, `recover`, `newDocument`, `documentSetup` | |
| Artboards | `src/artboards`, `src/tools/artboard` | panel + Object > Artboards |
| Cut tools | `src/tools/{scissors,knife}` | knife uses a thin blade polygon subtracted with paper.js |
| Width tool | `src/tools/width` | writes `stroke.widthProfile`, rendered by `geometry/widthProfile.ts` |
| Blend | `src/blend`, `src/tools/blend` | blend group = `data.blend`, steps carry `data.blendStep`; steps regenerate on commit |
| Measure | `src/tools/measure` | |
| Raster | `src/raster` (Image Trace via imagetracerjs, Rasterize, Crop), `src/tools/pixelbrush` | |
| Samples | `src/samples` | File > Open Sample; the bird is built with boolean ops at load |
| Help & preferences | `src/help` | Preferences (Ctrl+K), Keyboard Shortcuts, About, Welcome screen |
| AI bridge / MCP | `src/mcp` (page side: `api.ts` methods, `bridge.ts` WebSocket client), `mcp/server.ts` (MCP stdio server), `.mcp.json` | `window.__opuller.mcp` exposes the same methods |

### Extension points added later

* `registerStatusItem(id, Component)` (`src/ui/statusItems.ts`) — small components at the right end of the status bar.
* `Tool.getCursor(ctx)` — dynamic cursors that survive Space/hand pans.
* Synthetic pointer events (`PointerEvent` dispatched on `[data-testid="viewport"]`) drive tools exactly like real input; the viewport tolerates unknown pointer ids.
