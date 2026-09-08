import { describe, it, expect } from 'vitest';
import { createDocument, makeShape } from '@/model/nodes';
import { addNode, worldBounds } from '@/model/document';
import { translate } from '@/geometry/matrix';
import { addArtboard, duplicateArtboard, deleteArtboard, fitArtboardToArtwork, rearrangeArtboards, convertToArtboards, uniqueArtboardName, artworkOnArtboard, moveArtboard, presetFor, ARTBOARD_PRESETS } from '@/artboards/ops';

function docWithRect(x = 100, y = 100, w = 200, h = 100) {
  const doc = createDocument({ width: 1000, height: 800 });
  const rect = makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform: translate(x, y), name: 'R' });
  addNode(doc, rect, doc.layers[0]);
  return { doc, rect };
}

describe('artboard ops', () => {
  it('adds artboards next to the right-most one with unique names', () => {
    const doc = createDocument({ width: 1000, height: 800 });
    const a = addArtboard(doc, {});
    expect(a.x).toBe(1100);
    expect(a.y).toBe(0);
    expect(a.name).toBe('Artboard 2');
    const b = addArtboard(doc, { name: 'Artboard 2' });
    expect(b.name).toBe('Artboard 2 2');
    expect(uniqueArtboardName(doc, 'Artboard 1')).toBe('Artboard 1 2');
    expect(uniqueArtboardName(doc, 'Artboard 1', doc.artboards[0].id)).toBe('Artboard 1');
  });

  it('finds artwork on an artboard and moves it with the artboard', () => {
    const { doc, rect } = docWithRect();
    const ab = doc.artboards[0];
    expect(artworkOnArtboard(doc, ab)).toEqual([rect.id]);
    moveArtboard(doc, ab.id, 50, 20, true);
    expect(doc.artboards[0].x).toBe(50);
    const b = worldBounds(doc, rect.id)!;
    expect(Math.round(b.x)).toBe(150);
    expect(Math.round(b.y)).toBe(120);
    moveArtboard(doc, ab.id, -50, -20, false);
    expect(Math.round(worldBounds(doc, rect.id)!.x)).toBe(150);
  });

  it('duplicates an artboard with its artwork and deletes (never the last one)', () => {
    const { doc, rect } = docWithRect();
    const copy = duplicateArtboard(doc, doc.artboards[0].id, true)!;
    expect(doc.artboards.length).toBe(2);
    expect(copy.name).toContain('copy');
    const paths = Object.values(doc.nodes).filter((n) => n.type === 'path');
    expect(paths.length).toBe(2);
    const other = paths.find((p) => p.id !== rect.id)!;
    const b = worldBounds(doc, other.id)!;
    expect(Math.round(b.x)).toBe(100 + copy.x);
    expect(deleteArtboard(doc, copy.id, true)).toBe(true);
    expect(doc.artboards.length).toBe(1);
    expect(Object.values(doc.nodes).filter((n) => n.type === 'path').length).toBe(1);
    expect(deleteArtboard(doc, doc.artboards[0].id)).toBe(false);
  });

  it('fits an artboard to its artwork', () => {
    const { doc } = docWithRect(100, 100, 200, 100);
    expect(fitArtboardToArtwork(doc, doc.artboards[0].id)).toBe(true);
    const ab = doc.artboards[0];
    expect([ab.x, ab.y, ab.width, ab.height]).toEqual([100, 100, 200, 100]);
    const empty = createDocument();
    expect(fitArtboardToArtwork(empty, empty.artboards[0].id)).toBe(false);
  });

  it('rearranges artboards in a grid and keeps artwork attached', () => {
    const { doc, rect } = docWithRect();
    addArtboard(doc, { width: 300, height: 300 });
    addArtboard(doc, { width: 300, height: 300 });
    rearrangeArtboards(doc, { columns: 1, spacing: 50, layout: 'row', moveArtwork: true });
    expect(doc.artboards.map((a) => a.x)).toEqual([0, 0, 0]);
    expect(doc.artboards[1].y).toBe(850);
    expect(doc.artboards[2].y).toBe(850 + 300 + 50);
    expect(Math.round(worldBounds(doc, rect.id)!.x)).toBe(100);
    rearrangeArtboards(doc, { columns: 3, spacing: 10, layout: 'row', moveArtwork: false });
    expect(doc.artboards.map((a) => a.y)).toEqual([0, 0, 0]);
    expect(doc.artboards[1].x).toBe(1010);
  });

  it('converts objects into artboards', () => {
    const { doc, rect } = docWithRect(500, 500, 120, 80);
    const made = convertToArtboards(doc, [rect.id]);
    expect(made.length).toBe(1);
    expect(made[0].x).toBe(500);
    expect(made[0].width).toBe(120);
    expect(doc.nodes[rect.id]).toBeUndefined();
    expect(made[0].name).toBe('R');
  });

  it('knows presets in both orientations', () => {
    expect(presetFor(794, 1123)?.name).toBe('A4');
    expect(presetFor(1123, 794)?.name).toBe('A4');
    expect(ARTBOARD_PRESETS.length).toBeGreaterThan(20);
  });
});
