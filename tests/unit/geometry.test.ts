import { describe, it, expect } from 'vitest';
import { parseSvgPathData, pathToSvgD, pathBounds, nearestPointOnPath, pointInPath, insertAnchorAt, splitAtLocation } from '@/geometry/path';
import { multiply, invert, rotate, translate, scale, applyToPoint, decompose, parseSvgTransform } from '@/geometry/matrix';
import { rectSubPath, ellipseSubPath, starSubPath, roundCorners } from '@/geometry/shapes';
import { evalExpression, parseLength } from '@/util/units';
import { hexToHsb, hsbToHex, parseCssColor } from '@/util/color';

describe('matrix', () => {
  it('inverts', () => {
    const m = multiply(translate(10, 20), multiply(rotate(30), scale(2, 3)));
    const inv = invert(m);
    const p = applyToPoint(inv, applyToPoint(m, { x: 5, y: 7 }));
    expect(p.x).toBeCloseTo(5);
    expect(p.y).toBeCloseTo(7);
  });
  it('decomposes rotation', () => {
    const d = decompose(multiply(translate(1, 2), rotate(45)));
    expect(d.rotation).toBeCloseTo(45);
    expect(d.scaleX).toBeCloseTo(1);
    expect(d.translateX).toBe(1);
  });
  it('parses svg transforms', () => {
    const m = parseSvgTransform('translate(10 20) scale(2)');
    expect(applyToPoint(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 22 });
  });
});

describe('path data', () => {
  it('round-trips lines and curves', () => {
    const d = 'M10 10L50 10C60 10 60 40 50 40Z';
    const sps = parseSvgPathData(d);
    expect(sps).toHaveLength(1);
    expect(sps[0].closed).toBe(true);
    expect(sps[0].anchors).toHaveLength(3);
    const out = pathToSvgD(sps);
    expect(out.startsWith('M10 10L50 10C60 10 60 40 50 40')).toBe(true);
  });
  it('handles relative commands, arcs and implicit repeats', () => {
    const sps = parseSvgPathData('m0 0 10 0 0 10 a5 5 0 0 1 -10 0 z');
    expect(sps[0].anchors.length).toBeGreaterThanOrEqual(4);
    const b = pathBounds(sps)!;
    expect(b.x).toBeCloseTo(0, 0);
    expect(b.width).toBeCloseTo(10, 0);
  });
  it('computes bounds of an ellipse', () => {
    const b = pathBounds([ellipseSubPath(50, 30)])!;
    expect(b.width).toBeCloseTo(100, 1);
    expect(b.height).toBeCloseTo(60, 1);
  });
  it('finds nearest point and point-in-path', () => {
    const rect = [rectSubPath(100, 50)];
    const near = nearestPointOnPath(rect, { x: 50, y: -5 })!;
    expect(near.distance).toBeCloseTo(5);
    expect(pointInPath(rect, { x: 10, y: 10 })).toBe(true);
    expect(pointInPath(rect, { x: 110, y: 10 })).toBe(false);
  });
  it('inserts anchors and splits', () => {
    const sp = ellipseSubPath(50, 50);
    const idx = insertAnchorAt(sp, 0, 0.5);
    expect(idx).toBe(1);
    expect(sp.anchors).toHaveLength(5);
    const parts = splitAtLocation(sp, 2, 0.5);
    expect(parts).toHaveLength(1);
    expect(parts[0].closed).toBe(false);
    expect(parts[0].anchors.length).toBe(7);
  });
  it('rounds corners of a star', () => {
    const star = starSubPath(5, 50, 20);
    const r = roundCorners(star, 5);
    expect(r.anchors.length).toBe(20);
  });
});

describe('units & colours', () => {
  it('evaluates expressions', () => {
    expect(evalExpression('10+5*2')).toBe(20);
    expect(evalExpression('(1+2)/3')).toBe(1);
    expect(evalExpression('abc')).toBeNull();
    expect(parseLength('1in', 'px')).toBe(96);
    expect(parseLength('50%', 'px', 200)).toBe(100);
  });
  it('converts colours', () => {
    expect(hsbToHex(hexToHsb('#7a1f3d'))).toBe('#7a1f3d');
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ hex: '#ff0000', alpha: 1 });
    expect(parseCssColor('#0f08')?.alpha).toBeCloseTo(0.533, 2);
  });
});
