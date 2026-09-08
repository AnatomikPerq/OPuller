/**
 * Renders the artwork of a pattern definition into the SVG markup of one
 * repeating cell (`def.svg`), using the same static renderer as the canvas.
 * Registers itself as the pattern renderer (see refresh.ts).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Document, PatternDef } from '@/model/types';
import { StaticDocument } from '@/canvas/Renderer';
import { patternCell } from './tile';
import { patternDocument, setPatternRenderer, refreshPatternSvg } from './refresh';

/** Markup of one cell: background + a copy of the tile artwork at every tile origin. */
export function renderPatternCell(doc: Document, def: PatternDef): string {
  const view = patternDocument(doc, def);
  const cell = patternCell(def);
  const parts: React.ReactNode[] = [];
  if (def.background) parts.push(React.createElement('rect', { key: 'bg', x: 0, y: 0, width: cell.width, height: cell.height, fill: def.background }));
  if (view) {
    cell.tiles.forEach((t, i) => {
      parts.push(
        React.createElement(
          'g',
          { key: i, transform: t.x || t.y ? `translate(${fmt(t.x)} ${fmt(t.y)})` : undefined },
          React.createElement(StaticDocument, { doc: view, ids: [def.root!], prefix: `pt-${def.id}-${i}-`, exportMode: true }),
        ),
      );
    });
  }
  return renderToStaticMarkup(React.createElement(React.Fragment, null, ...parts));
}

function fmt(v: number): string {
  return (+v.toFixed(3)).toString();
}

setPatternRenderer(renderPatternCell);

export { patternDocument, refreshPatternSvg };
