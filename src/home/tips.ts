/** Quick tips shown on the Home screen (Learn) and in Help > Quick Tips. */
export const TIPS: Array<[string, string]> = [
  ['Draw', 'Shapes: M rectangle, L ellipse, \\ line. Pen (P) for Béziers, Pencil (N) for freehand, Curvature (Shift+`) for smooth curves.'],
  ['Combine', 'Select overlapping shapes and use the Pathfinder panel (Unite, Minus Front, Intersect…) or the Shape Builder (Shift+M): drag across regions to merge, Alt-drag to delete.'],
  ['Colour', 'The Color, Swatches and Gradient panels edit the fill or stroke of the selection (X swaps the active one, Shift+X swaps fill and stroke). Gradient tool (G) edits gradients on the canvas.'],
  ['Strokes', 'Stroke panel: width, caps, joins, dashes, arrowheads. Width tool (Shift+W) makes variable-width strokes.'],
  ['Type', 'T creates point text, drag for area text, click a path for type on a path. Type > Create Outlines turns text into paths.'],
  ['Transform', 'Bounding-box handles scale, corners rotate. R/S/O/Shift+E tools, the Transform panel and Object > Transform dialogs give numeric control; Ctrl+D repeats.'],
  ['Cut', 'Scissors (C) split paths at a point, Knife (K) cuts shapes along a drawn line, Eraser (Shift+E) removes areas.'],
  ['Artboards', 'Shift+O edits artboards on the canvas; the Artboards panel lists them. Export per artboard with File > Export.'],
  ['Export', 'File > Export (Ctrl+E): SVG, PNG, JPEG, WebP, PDF per artboard or selection. Projects are kept in the browser library and can be saved as .opuller files.'],
  ['AI', 'Help > Connect an AI: an MCP server lets Claude (or any MCP client) build and edit documents with every tool.'],
];
