import { describe, it, expect } from 'vitest';
import { importSvg, parseSvgLength, itemsToLayers, looksLikeSvg } from '@/io/svgImport';
import type { PathNode, GroupNode, TextNode, ImageNode, Node } from '@/model/types';
import { pathBounds, transformSubPaths } from '@/geometry/path';

/** A realistic logo export (Illustrator-like: layers as groups, classes in <style>, gradients, clip paths, transforms). */
const LOGO = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
  viewBox="0 0 200 100" style="enable-background:new 0 0 200 100;" xml:space="preserve" width="400px" height="200px">
<style type="text/css">
  .st0{fill:#FF0000;stroke:#000000;stroke-width:2;}
  .st1{fill:url(#grad1);}
  .st2{fill:none;stroke:#0000FF;stroke-width:4;stroke-linecap:round;stroke-dasharray:4,2;}
  #special{opacity:0.5}
</style>
<defs>
  <linearGradient id="grad1" gradientUnits="userSpaceOnUse" x1="10" y1="60" x2="60" y2="60">
    <stop offset="0" style="stop-color:#00FF00"/>
    <stop offset="100%" style="stop-color:#0000FF;stop-opacity:0.5"/>
  </linearGradient>
  <radialGradient id="grad2" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="white"/>
    <stop offset="1" stop-color="black"/>
  </radialGradient>
  <linearGradient id="grad3" xlink:href="#grad1" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"/>
  <clipPath id="clip1"><circle cx="150" cy="50" r="20"/></clipPath>
  <symbol id="sym" viewBox="0 0 10 10"><rect width="10" height="10" fill="purple"/></symbol>
</defs>
<g id="Background">
  <rect class="st0" x="10" y="10" width="50" height="30" rx="5"/>
  <circle class="st1" cx="35" cy="60" r="25"/>
  <ellipse cx="100" cy="50" rx="30" ry="10" fill="url(#grad2)" fill-opacity="0.8"/>
</g>
<g id="Shapes" transform="translate(100,0) scale(0.5)">
  <path id="special" d="M0,0 L40,0 L40,40 Z" fill="rgb(0, 128, 0)"/>
  <g transform="rotate(45 20 20)">
    <polygon points="0,0 20,0 10,20" fill="hsl(120, 100%, 50%)"/>
    <polyline class="st2" points="0,40 10,50 20,40"/>
    <line x1="0" y1="60" x2="40" y2="60" stroke="orange" stroke-width="3"/>
  </g>
  <rect x="0" y="80" width="10" height="10" fill="url(#grad3)"/>
</g>
<g id="Clipped" clip-path="url(#clip1)">
  <rect x="120" y="20" width="60" height="60" fill="#123456"/>
</g>
<text x="20" y="90" font-family="'Open Sans', Arial" font-size="12" font-weight="bold" text-anchor="middle" fill="#333333">Logo<tspan x="20" y="98" font-weight="normal">tag line</tspan></text>
<image x="170" y="10" width="20" height="20" xlink:href="data:image/png;base64,iVBORw0KGgo="/>
<use xlink:href="#sym" x="180" y="80" width="10" height="10"/>
<g id="Hidden" style="display:none"><rect width="5" height="5"/></g>
<g id="Blend" style="mix-blend-mode:multiply;visibility:hidden"><rect width="5" height="5"/></g>
</svg>`;

function byName(nodes: Node[], name: string): Node {
  const n = nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node ${name} not found; have: ${nodes.map((x) => x.name).join(', ')}`);
  return n;
}

function children(nodes: Node[], g: GroupNode): Node[] {
  return g.children.map((id) => nodes.find((n) => n.id === id)!).filter(Boolean);
}

describe('svg import', () => {
  it('parses lengths with units', () => {
    expect(parseSvgLength('10')).toBe(10);
    expect(parseSvgLength('1in')).toBe(96);
    expect(parseSvgLength('25.4mm')).toBeCloseTo(96);
    expect(parseSvgLength('72pt')).toBeCloseTo(96);
    expect(parseSvgLength('50%', 200)).toBe(100);
    expect(parseSvgLength('2em', 0, 12)).toBe(24);
    expect(parseSvgLength('abc')).toBeNull();
    expect(looksLikeSvg('  <svg xmlns="x">')).toBe(true);
    expect(looksLikeSvg('hello')).toBe(false);
  });

  it('imports a realistic logo: size, layers, shapes, gradients, transforms, clip paths, text, image, use', () => {
    const res = importSvg(LOGO);
    // width/height attributes win over the viewBox (uniform scale 2x)
    expect(res.width).toBe(400);
    expect(res.height).toBe(200);
    expect(res.viewBox).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    const nodes = res.nodes;
    const roots = res.items.map((i) => i.root);
    expect(roots.map((r) => r.name)).toEqual(['Background', 'Shapes', 'Clipped', 'Logo', 'Image', 'Use', 'Hidden', 'Blend']);

    // --- Background group -------------------------------------------------
    const bg = byName(nodes, 'Background') as GroupNode;
    expect(bg.type).toBe('group');
    const [rect, circle, ellipse] = children(nodes, bg) as PathNode[];
    expect(rect.type).toBe('path');
    expect(rect.shape?.kind).toBe('rect');
    // class .st0 → red fill, black 2px stroke; the root scale (2x) lives on the parent group
    expect(bg.transform.a).toBeCloseTo(2);
    expect(rect.fill).toEqual({ type: 'solid', color: '#ff0000', opacity: 1 });
    expect(rect.stroke.paint).toEqual({ type: 'solid', color: '#000000', opacity: 1 });
    expect(rect.stroke.width).toBeCloseTo(2);
    if (rect.shape?.kind === 'rect') {
      expect(rect.shape.width).toBeCloseTo(50);
      expect(rect.shape.height).toBeCloseTo(30);
      expect(rect.shape.radii[0]).toBeCloseTo(5);
    }
    expect(rect.transform.e).toBeCloseTo(10);
    expect(rect.transform.f).toBeCloseTo(10);

    expect(circle.shape?.kind).toBe('ellipse');
    expect(circle.fill.type).toBe('linear');
    if (circle.fill.type === 'linear') {
      // userSpaceOnUse x1=10..60 over the circle bounds x 10..60 → 0..1
      expect(circle.fill.x1).toBeCloseTo(0);
      expect(circle.fill.x2).toBeCloseTo(1);
      expect(circle.fill.y1).toBeCloseTo(0.5);
      expect(circle.fill.stops[0]).toEqual({ offset: 0, color: '#00ff00', opacity: 1 });
      expect(circle.fill.stops[1]).toEqual({ offset: 1, color: '#0000ff', opacity: 0.5 });
    }
    expect(ellipse.fill.type).toBe('radial');
    if (ellipse.fill.type === 'radial') {
      expect(ellipse.fill.cx).toBeCloseTo(0.5);
      expect(ellipse.fill.r).toBeCloseTo(0.5);
      // fill-opacity multiplies the stop opacities
      expect(ellipse.fill.stops[0].opacity).toBeCloseTo(0.8);
      expect(ellipse.fill.stops[0].color).toBe('#ffffff');
    }

    // --- Shapes group: transform kept on the group, nested rotation group -----
    const shapes = byName(nodes, 'Shapes') as GroupNode;
    // root scale (2) * translate(100,0) scale(0.5) → matrix(1 0 0 1 200 0)
    expect(shapes.transform.a).toBeCloseTo(1);
    expect(shapes.transform.d).toBeCloseTo(1);
    expect(shapes.transform.e).toBeCloseTo(200);
    const [special, rotated, gradRect] = children(nodes, shapes);
    expect(special.name).toBe('special');
    expect(special.opacity).toBeCloseTo(0.5); // #special rule from <style>
    expect((special as PathNode).fill).toEqual({ type: 'solid', color: '#008000', opacity: 1 });
    expect(rotated.type).toBe('group');
    const [polygon, polyline, line] = children(nodes, rotated as GroupNode) as PathNode[];
    expect(polygon.subpaths[0].closed).toBe(true);
    expect(polygon.subpaths[0].anchors.length).toBe(3);
    expect(polygon.fill).toEqual({ type: 'solid', color: '#00ff00', opacity: 1 });
    expect(polyline.subpaths[0].closed).toBe(false);
    expect(polyline.fill.type).toBe('none');
    expect(polyline.stroke.paint).toEqual({ type: 'solid', color: '#0000ff', opacity: 1 });
    expect(polyline.stroke.width).toBe(4);
    expect(polyline.stroke.cap).toBe('round');
    expect(polyline.stroke.dash).toEqual([4, 2]);
    expect(line.shape?.kind).toBe('line');
    expect(line.stroke.paint).toEqual({ type: 'solid', color: '#ffa500', opacity: 1 });
    expect(line.fill.type).toBe('none');
    // href-inherited stops with objectBoundingBox coordinates
    expect((gradRect as PathNode).fill.type).toBe('linear');
    if ((gradRect as PathNode).fill.type === 'linear') {
      const f = (gradRect as PathNode).fill as Extract<PathNode['fill'], { type: 'linear' }>;
      expect(f.x2).toBeCloseTo(1);
      expect(f.y2).toBeCloseTo(1);
      expect(f.stops[1].color).toBe('#0000ff');
    }

    // --- clip group ---------------------------------------------------------
    const clipped = byName(nodes, 'Clipped') as GroupNode;
    expect(clipped.type).toBe('group');
    expect(clipped.clipId).toBeTruthy();
    const clipNode = nodes.find((n) => n.id === clipped.clipId) as PathNode;
    expect(clipNode.type).toBe('path');
    expect(clipNode.shape?.kind).toBe('ellipse');
    expect(clipped.children[0]).toBe(clipNode.id);
    const clippedRect = nodes.find((n) => n.id === clipped.children[1]) as PathNode;
    expect(clippedRect.fill).toEqual({ type: 'solid', color: '#123456', opacity: 1 });

    // --- text ---------------------------------------------------------------
    const text = byName(nodes, 'Logo') as TextNode;
    expect(text.type).toBe('text');
    expect(text.text).toBe('Logo\ntag line');
    expect(text.style.fontFamily).toBe('Open Sans');
    expect(text.style.fontWeight).toBe(700);
    expect(text.style.textAlign).toBe('center');
    expect(text.fill).toEqual({ type: 'solid', color: '#333333', opacity: 1 });
    expect(text.runs.map((r) => r.text).join('')).toBe(text.text);
    expect(text.runs.find((r) => r.text === 'tag line')?.style?.fontWeight).toBe(400);
    // scaled by the root transform (2x): position (20,90) → (40,180)
    expect(text.transform.e).toBeCloseTo(40);
    expect(text.transform.f).toBeCloseTo(180);
    expect(text.transform.a).toBeCloseTo(2);

    // --- image ----------------------------------------------------------------
    const image = byName(nodes, 'Image') as ImageNode;
    expect(image.type).toBe('image');
    expect(image.src.startsWith('data:image/png')).toBe(true);
    expect(image.width).toBe(20);
    expect(image.transform.a).toBeCloseTo(2);
    expect(image.transform.e).toBeCloseTo(340);

    // --- use → symbol ---------------------------------------------------------
    const use = byName(nodes, 'Use') as GroupNode;
    const sym = children(nodes, use)[0] as GroupNode;
    expect(sym.type).toBe('group');
    const symRect = children(nodes, sym)[0] as PathNode;
    expect(symRect.fill).toEqual({ type: 'solid', color: '#800080', opacity: 1 });

    // --- hidden / blend --------------------------------------------------------
    expect(byName(nodes, 'Hidden').visible).toBe(false);
    const blend = byName(nodes, 'Blend');
    expect(blend.blendMode).toBe('multiply');
    expect(blend.visible).toBe(false);

    // every node is registered exactly once and parent links are consistent
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(nodes.length);
    for (const n of nodes) {
      if (n.type === 'group') for (const c of n.children) expect(nodes.find((x) => x.id === c)?.parent).toBe(n.id);
    }
    for (const it of res.items) expect(it.root.parent).toBeNull();
  });

  it('bakes path transforms into geometry and scales strokes', () => {
    const res = importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="M0 0 H10 V10 Z" transform="translate(5,5) scale(3)" stroke="red" stroke-width="2" fill="none"/></svg>');
    const p = res.nodes[0] as PathNode;
    expect(p.type).toBe('path');
    expect(p.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const b = pathBounds(p.subpaths)!;
    expect(b.x).toBeCloseTo(5);
    expect(b.width).toBeCloseTo(30);
    expect(p.stroke.width).toBeCloseTo(6);
  });

  it('handles viewBox-only documents, mm sizes and nested svg', () => {
    const res = importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><svg x="10" y="10" width="50" height="50" viewBox="0 0 100 100"><rect width="100" height="100"/></svg></svg>');
    expect(res.width).toBeCloseTo(793.7, 0);
    expect(res.height).toBeCloseTo(1122.5, 0);
    const g = res.items[0].root as GroupNode;
    expect(g.type).toBe('group');
    const rect = res.nodes.find((n) => n.type === 'path') as PathNode;
    const world = transformSubPaths(rect.subpaths, { ...g.transform });
    const b = pathBounds(transformSubPaths(world, rect.transform))!;
    // nested svg: 50 user units at scale 96/25.4 starting at (10,10)
    const s = 96 / 25.4;
    expect(b.x).toBeCloseTo(10 * s, 1);
    expect(b.width).toBeCloseTo(50 * s, 1);
  });

  it('converts top-level groups into layers', () => {
    const res = importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="A"><rect width="1" height="1"/></g><g id="B"><rect width="1" height="1"/></g></svg>');
    const layers = itemsToLayers(res.items);
    expect(layers.length).toBe(2);
    expect(layers.map((l) => l.root.type)).toEqual(['layer', 'layer']);
    expect(layers.map((l) => l.root.name)).toEqual(['A', 'B']);
    const single = itemsToLayers(importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>').items);
    expect(single.length).toBe(1);
    expect(single[0].root.type).toBe('layer');
    expect((single[0].root as GroupNode).children.length).toBe(1);
  });

  it('rejects invalid markup', () => {
    expect(() => importSvg('not svg at all')).toThrow();
  });
});
