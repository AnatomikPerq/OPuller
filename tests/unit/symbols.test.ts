import { describe, it, expect } from 'vitest';
import { createDocument, makeShape } from '@/model/nodes';
import { addNode, worldBounds } from '@/model/document';
import { makeSymbol, placeInstance, symbolInstances, redefineFromInstance, breakLink, syncInstances, deleteSymbol, isSymbolInstance, replaceInstanceSymbol, addSymbolDef, symbolBounds } from '@/symbols/ops';
import { SYMBOL_LIBRARY } from '@/symbols/library';
import { validateDocument } from '@/io/project';

function rect(x: number, y: number, w: number, h: number, fill = '#ff0000') {
  return makeShape({ kind: 'rect', width: w, height: h, radii: [0, 0, 0, 0] }, { transform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y }, fill: { type: 'solid', color: fill, opacity: 1 } });
}

describe('symbols', () => {
  it('makes a symbol from artwork and replaces it by an instance at the same place', () => {
    const doc = createDocument();
    const a = rect(100, 100, 40, 20);
    const b = rect(150, 100, 20, 20, '#00ff00');
    addNode(doc, a, doc.layers[0]);
    addNode(doc, b, doc.layers[0]);
    const r = makeSymbol(doc, [a.id, b.id], 'Logo')!;
    expect(r).toBeTruthy();
    expect(doc.symbols).toHaveLength(1);
    expect(doc.nodes[a.id]).toBeUndefined();
    const inst = doc.nodes[r.instanceId];
    expect(isSymbolInstance(inst)).toBe(true);
    expect(inst.type === 'group' && inst.children.length).toBe(2);
    // same world bounds as the original artwork
    expect(worldBounds(doc, r.instanceId)).toEqual({ x: 100, y: 100, width: 70, height: 20 });
    // symbol space is centred
    expect(symbolBounds(doc, r.def)).toEqual({ x: -35, y: -10, width: 70, height: 20 });
  });

  it('places, redefines (all instances follow), breaks links and deletes', () => {
    const doc = createDocument();
    const a = rect(0, 0, 40, 40);
    addNode(doc, a, doc.layers[0]);
    const { def, instanceId } = makeSymbol(doc, [a.id], 'S')!;
    const second = placeInstance(doc, def.id, { x: 300, y: 300 }, doc.layers[0], { scale: 2 })!;
    expect(symbolInstances(doc, def.id)).toHaveLength(2);
    expect(worldBounds(doc, second)).toEqual({ x: 260, y: 260, width: 80, height: 80 });
    // edit the first instance's child and redefine
    const inst = doc.nodes[instanceId] as any;
    const child = doc.nodes[inst.children[0]] as any;
    child.fill = { type: 'solid', color: '#0000ff', opacity: 1 };
    redefineFromInstance(doc, instanceId);
    expect(def.version).toBe(2);
    const inst2 = doc.nodes[second] as any;
    expect((doc.nodes[inst2.children[0]] as any).fill.color).toBe('#0000ff');
    expect(inst2.data.symbol.version).toBe(2);
    // a stale instance is rebuilt by sync
    inst2.data.symbol.version = 1;
    expect(syncInstances(doc)).toBe(1);
    // break the link: plain group, artwork kept
    expect(breakLink(doc, second)).toBe(true);
    expect(isSymbolInstance(doc.nodes[second])).toBe(false);
    expect((doc.nodes[second] as any).children).toHaveLength(1);
    // delete keeps artwork for remaining instances
    expect(deleteSymbol(doc, def.id, 'break')).toBe(1);
    expect(doc.symbols).toHaveLength(0);
    expect(doc.nodes[instanceId]).toBeTruthy();
  });

  it('library symbols build, can replace instances and survive the project file round trip', () => {
    const doc = createDocument();
    const star = addSymbolDef(doc, SYMBOL_LIBRARY.find((e) => e.id === 'star')!.build());
    const heart = addSymbolDef(doc, SYMBOL_LIBRARY.find((e) => e.id === 'heart')!.build());
    const id = placeInstance(doc, star.id, { x: 50, y: 50 }, doc.layers[0])!;
    expect(replaceInstanceSymbol(doc, id, heart.id)).toBe(true);
    expect((doc.nodes[id] as any).data.symbol.id).toBe(heart.id);
    expect(doc.nodes[id].name).toBe('Heart');
    const copy = validateDocument(JSON.parse(JSON.stringify(doc)));
    expect(copy.symbols).toHaveLength(2);
    expect(copy.symbols[1].nodes[copy.symbols[1].root].type).toBe('group');
    expect(symbolInstances(copy)).toEqual([id]);
    for (const e of SYMBOL_LIBRARY) expect(symbolBounds(doc, e.build())!.width).toBeGreaterThan(10);
  });
});
