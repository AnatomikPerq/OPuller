/**
 * Recolor Artwork (Edit > Edit Colors > Recolor Artwork…): lists the colours
 * used by the selection, lets each be reassigned, applies harmonies, swatch
 * libraries, colour reduction and global hue/saturation/brightness shifts with
 * a live preview. OK commits one history step, Cancel restores the artwork.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Shuffle, RotateCcw, Dices } from 'lucide-react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, IconButton, Select, Slider, Row } from '@/ui/widgets';
import { getState, useStore } from '@/store/store';
import type { HexColor, ID, SolidPaint, Document } from '@/model/types';
import { collectColors, mapColors, harmonyPalette, reduceColors, nearestColor, shiftHsb, isWhite, isBlack, isGray, seededRandom, colorLeaves, toHsb, fromHsb, HARMONIES, type Harmony, type ColorTargets } from '@/color/editColors';
import { SWATCH_LIBRARIES } from '@/color/libraries';
import { SolidColorPopover } from '@/ui/panels/color/shared';
import { makeSwatch, uniqueSwatchName } from '@/color/swatches';
import { colorNameFor } from '@/color/globals';
import { contrastText } from '@/util/color';
import './recolor.css';

interface Entry {
  from: HexColor;
  to: HexColor;
  count: number;
  slots: string;
}

interface Options {
  hue: number;
  saturation: number;
  brightness: number;
  preserveWhite: boolean;
  preserveBlack: boolean;
  preserveGray: boolean;
  fills: boolean;
  strokes: boolean;
  gradients: boolean;
  saveGlobal: boolean;
}

const DEFAULT_OPTIONS: Options = { hue: 0, saturation: 0, brightness: 0, preserveWhite: true, preserveBlack: false, preserveGray: false, fills: true, strokes: true, gradients: true, saveGlobal: false };

function buildMapper(entries: Entry[], o: Options): (hex: HexColor) => HexColor {
  const map = new Map(entries.map((e) => [e.from, e.to]));
  const shift = o.hue !== 0 || o.saturation !== 0 || o.brightness !== 0;
  return (hex) => {
    if (o.preserveWhite && isWhite(hex)) return hex;
    if (o.preserveBlack && isBlack(hex)) return hex;
    if (o.preserveGray && isGray(hex) && !isWhite(hex) && !isBlack(hex)) return hex;
    let out = map.get(hex) ?? hex;
    if (shift) out = shiftHsb(out, { hue: o.hue, saturation: o.saturation / 100, brightness: o.brightness / 100 });
    return out;
  };
}

/** Create global swatches for the final colours and link the recoloured paints to them. */
function saveAsGlobalSwatches(d: Document, ids: ID[], colors: HexColor[]): number {
  const existing = [...d.swatches];
  const byColor = new Map<HexColor, ID>();
  for (const c of colors) {
    let sw = existing.find((s) => s.kind && s.paint.type === 'solid' && s.paint.color === c);
    if (!sw) {
      sw = makeSwatch(uniqueSwatchName(existing, colorNameFor(c, d.colorMode)), { type: 'solid', color: c, opacity: 1 });
      sw.kind = 'global';
      existing.push(sw);
      d.swatches.push(sw);
    }
    byColor.set(c, sw.id);
  }
  let linked = 0;
  for (const id of colorLeaves(d, ids)) {
    const n = d.nodes[id];
    if (!n || (n.type !== 'path' && n.type !== 'text')) continue;
    const link = (p: SolidPaint): SolidPaint => {
      const sid = byColor.get(p.color);
      if (!sid || p.swatchId === sid) return p;
      linked++;
      return { ...p, swatchId: sid, tint: 100 };
    };
    if (n.fill.type === 'solid') n.fill = link(n.fill);
    if (n.stroke.paint.type === 'solid') n.stroke = { ...n.stroke, paint: link(n.stroke.paint) };
  }
  return linked;
}

function RecolorDialog({ close }: { close: () => void }) {
  const docMode = useStore((s) => s.doc.colorMode);
  const ids = useRef<ID[]>(getState().selection).current;
  const [entries, setEntries] = useState<Entry[]>(() => {
    const s = getState();
    return collectColors(s.doc, ids).map((u) => ({ from: u.color, to: u.color, count: u.count, slots: Array.from(u.slots).join(', ') }));
  });
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTIONS);
  const [harmony, setHarmony] = useState<'none' | Harmony>('none');
  const [baseColor, setBaseColor] = useState<HexColor>(entries[0]?.from ?? '#7a1f3d');
  const [reduce, setReduce] = useState(0);
  const [library, setLibrary] = useState('');
  const [editing, setEditing] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [baseEditing, setBaseEditing] = useState<HTMLElement | null>(null);
  const seed = useRef(1);

  const targets: ColorTargets = useMemo(() => ({ fills: opts.fills, strokes: opts.strokes, gradients: opts.gradients }), [opts.fills, opts.strokes, opts.gradients]);

  // live preview: revert the uncommitted preview and apply the current mapping
  const preview = useCallback(
    (ents: Entry[], o: Options) => {
      const s = getState();
      s.revert();
      const fn = buildMapper(ents, o);
      s.updateDoc((d) => {
        mapColors(d, ids, fn, { fills: o.fills, strokes: o.strokes, gradients: o.gradients });
      });
    },
    [ids],
  );
  useEffect(() => {
    preview(entries, opts);
  }, [entries, opts, preview]);

  const setTo = (index: number, to: HexColor) => setEntries((list) => list.map((e, i) => (i === index ? { ...e, to } : e)));
  const patch = (p: Partial<Options>) => setOpts((o) => ({ ...o, ...p }));

  const applyHarmony = (h: 'none' | Harmony, base = baseColor) => {
    setHarmony(h);
    if (h === 'none') {
      setEntries((list) => list.map((e) => ({ ...e, to: e.from })));
      return;
    }
    const palette = harmonyPalette(base, h, Math.max(2, entries.length));
    setEntries((list) =>
      list.map((e, i) => {
        const pal = toHsb(palette[i % palette.length]);
        const orig = toHsb(e.from);
        // keep the object's own lightness so shading relationships survive
        return { ...e, to: isGray(e.from) ? e.from : fromHsb({ h: pal.h, s: Math.max(pal.s, orig.s * 0.6), b: orig.b }) };
      }),
    );
  };
  const applyReduce = (n: number) => {
    setReduce(n);
    if (!n) {
      setEntries((list) => list.map((e) => ({ ...e, to: e.from })));
      return;
    }
    const palette = reduceColors(entries.map((e) => ({ color: e.from, count: e.count })), n);
    setEntries((list) => list.map((e) => ({ ...e, to: nearestColor(e.from, palette) })));
  };
  const applyLibrary = (id: string) => {
    setLibrary(id);
    const lib = SWATCH_LIBRARIES.find((l) => l.id === id);
    if (!lib) {
      setEntries((list) => list.map((e) => ({ ...e, to: e.from })));
      return;
    }
    const palette = lib.colors.map(([, c]) => c);
    setEntries((list) => list.map((e) => ({ ...e, to: nearestColor(e.from, palette) })));
  };
  const shuffleOrder = () => {
    const rnd = seededRandom(seed.current++);
    setEntries((list) => {
      const tos = list.map((e) => e.to);
      for (let i = tos.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [tos[i], tos[j]] = [tos[j], tos[i]];
      }
      return list.map((e, i) => ({ ...e, to: tos[i] }));
    });
  };
  const randomSb = () => {
    const rnd = seededRandom(seed.current++ * 7919);
    setEntries((list) =>
      list.map((e) => {
        const h = toHsb(e.to);
        return { ...e, to: fromHsb({ h: h.h, s: h.s * (0.75 + rnd() * 0.5), b: h.b * (0.8 + rnd() * 0.4) }) };
      }),
    );
  };
  const reset = () => {
    setEntries((list) => list.map((e) => ({ ...e, to: e.from })));
    setOpts(DEFAULT_OPTIONS);
    setHarmony('none');
    setReduce(0);
    setLibrary('');
  };

  const ok = () => {
    const s = getState();
    s.revert();
    const fn = buildMapper(entries, opts);
    let linked = 0;
    s.updateDoc((d) => {
      mapColors(d, ids, fn, targets);
      if (opts.saveGlobal) {
        const finals = Array.from(new Set(entries.map((e) => fn(e.from)).filter((c) => !(opts.preserveWhite && isWhite(c)))));
        linked = saveAsGlobalSwatches(d, ids, finals);
      }
    });
    s.commit('Recolor Artwork');
    if (opts.saveGlobal) getState().toast(`Linked ${linked} paints to global swatches`, 'success');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };

  const finalColors = useMemo(() => {
    const fn = buildMapper(entries, opts);
    return entries.map((e) => fn(e.from));
  }, [entries, opts]);

  return (
    <DialogFrame
      title="Recolor Artwork"
      onClose={cancel}
      width={720}
      className="recolor-dialog"
      footer={
        <>
          <Checkbox checked={opts.saveGlobal} onChange={(v) => patch({ saveGlobal: v })} label="Save colours as global swatches" title="Create global swatches for the new colours and link the artwork to them" />
          <div style={{ flex: 1 }} />
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="recolor-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="recolor" data-testid="recolor-dialog">
        <div className="recolor-assign">
          <div className="recolor-head">
            <span>Assign</span>
            <span className="dim small">{entries.length} colours in {colorLeaves(getState().doc, ids).length} objects</span>
            <span style={{ flex: 1 }} />
            <IconButton icon={<Shuffle size={13} />} title="Randomly change colour order" onClick={shuffleOrder} data-testid="recolor-shuffle" />
            <IconButton icon={<Dices size={13} />} title="Randomly change saturation and brightness" onClick={randomSb} data-testid="recolor-random-sb" />
            <IconButton icon={<RotateCcw size={13} />} title="Reset" onClick={reset} data-testid="recolor-reset" />
          </div>
          <div className="recolor-rows">
            {entries.map((e, i) => (
              <div className="recolor-row" key={e.from} data-testid={`recolor-row-${i}`}>
                <span className="recolor-chip from" style={{ background: e.from, color: contrastText(e.from) }} title={`${e.from.toUpperCase()} — ${e.slots}`}>
                  {e.count}
                </span>
                <span className="recolor-hex">{e.from.toUpperCase()}</span>
                <ArrowRight size={12} className="recolor-arrow" />
                <button type="button" className="recolor-chip to" style={{ background: finalColors[i] }} title="Click to choose the new colour" onClick={(ev) => setEditing({ index: i, anchor: ev.currentTarget })} data-testid={`recolor-to-${i}`} />
                <span className="recolor-hex" data-testid={`recolor-final-${i}`}>
                  {finalColors[i].toUpperCase()}
                </span>
              </div>
            ))}
            {!entries.length && <div className="dim small">The selection has no solid colours or gradients.</div>}
          </div>
          {editing && (
            <SolidColorPopover
              open
              anchor={editing.anchor}
              color={{ type: 'solid', color: entries[editing.index].to, opacity: 1 }}
              onClose={() => setEditing(null)}
              onChange={(c) => setTo(editing.index, c.color)}
              title={`New colour for ${entries[editing.index].from.toUpperCase()}`}
              placement="right"
            />
          )}
        </div>
        <div className="recolor-edit">
          <div className="recolor-head">Edit</div>
          <div className="recolor-field">
            <span className="field-label">Harmony</span>
            <Select value={harmony} options={[{ value: 'none', label: 'None (keep colours)' }, ...HARMONIES.map((h) => ({ value: h.id, label: h.label }))]} onChange={(v) => applyHarmony(v as 'none' | Harmony)} width={170} id="recolor-harmony" />
            <button type="button" className="recolor-chip base" style={{ background: baseColor }} title="Base colour of the harmony" onClick={(ev) => setBaseEditing(ev.currentTarget)} data-testid="recolor-base" />
          </div>
          {baseEditing && (
            <SolidColorPopover
              open
              anchor={baseEditing}
              color={{ type: 'solid', color: baseColor, opacity: 1 }}
              onClose={() => setBaseEditing(null)}
              onChange={(c) => {
                setBaseColor(c.color);
                if (harmony !== 'none') applyHarmony(harmony, c.color);
              }}
              title="Base colour"
              placement="left"
            />
          )}
          <div className="recolor-field">
            <span className="field-label">Reduce to</span>
            <Select value={String(reduce)} options={[{ value: '0', label: 'All colours' }, ...[1, 2, 3, 4, 5, 6, 8, 12].map((n) => ({ value: String(n), label: `${n} colour${n > 1 ? 's' : ''}` }))]} onChange={(v) => applyReduce(Number(v))} width={130} id="recolor-reduce" />
          </div>
          <div className="recolor-field">
            <span className="field-label">Library</span>
            <Select value={library} options={[{ value: '', label: 'None' }, ...SWATCH_LIBRARIES.map((l) => ({ value: l.id, label: l.name }))]} onChange={applyLibrary} width={170} id="recolor-library" />
          </div>
          <div className="recolor-sliders">
            <Slider label="Hue" value={opts.hue} min={-180} max={180} unit="deg" onChange={(v) => patch({ hue: v })} className="recolor-slider" />
            <Slider label="Saturation" value={opts.saturation} min={-100} max={100} unit="%" onChange={(v) => patch({ saturation: v })} className="recolor-slider" />
            <Slider label="Brightness" value={opts.brightness} min={-100} max={100} unit="%" onChange={(v) => patch({ brightness: v })} className="recolor-slider" />
          </div>
          <div className="recolor-options">
            <span className="field-label">Preserve</span>
            <Row gap={10} wrap>
              <Checkbox checked={opts.preserveWhite} onChange={(v) => patch({ preserveWhite: v })} label="White" />
              <Checkbox checked={opts.preserveBlack} onChange={(v) => patch({ preserveBlack: v })} label="Black" />
              <Checkbox checked={opts.preserveGray} onChange={(v) => patch({ preserveGray: v })} label="Grays" />
            </Row>
            <span className="field-label">Apply to</span>
            <Row gap={10} wrap>
              <Checkbox checked={opts.fills} onChange={(v) => patch({ fills: v })} label="Fills" />
              <Checkbox checked={opts.strokes} onChange={(v) => patch({ strokes: v })} label="Strokes" />
              <Checkbox checked={opts.gradients} onChange={(v) => patch({ gradients: v })} label="Gradients" />
            </Row>
          </div>
          <div className="dim small">Document colour mode: {docMode.toUpperCase()}. Changes preview on the artboard; Cancel restores the artwork.</div>
        </div>
      </div>
    </DialogFrame>
  );
}

registerDialog('recolor', ({ close }) => <RecolorDialog close={close} />);
