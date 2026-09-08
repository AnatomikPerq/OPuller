/**
 * Graphs wiring: Object > Graph commands (Type…, Data…, Regenerate, Refit),
 * the Graph Data editor (spreadsheet + paste), the Graph Type dialog and the
 * scripting API.
 */
import React, { useMemo, useState } from 'react';
import { registerCommands, type Command } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Select, TextField, IconButton } from '@/ui/widgets';
import { Plus, Minus, ClipboardPaste } from 'lucide-react';
import { getState, useStore, type EditorState } from '@/store/store';
import type { ID, HexColor } from '@/model/types';
import { insertionParent } from '@/tools/shapes/tool';
import { activeArtboard } from '@/io/fileOps';
import { GRAPH_TYPES, DEFAULT_OPTIONS, sampleSpec, parseTable, tableText, type GraphSpec, type GraphType, type GraphOptions } from './build';
import { createGraph, regenerateGraph, refitGraph, graphsOf, graphSpec, isGraph } from './ops';
import * as build from './build';
import './graphs.css';

const graphsIn = (s: EditorState) => graphsOf(s.doc, s.selection);
const hasGraph = (s: EditorState) => graphsIn(s).length > 0;

export function createGraphCommand(rect?: { x: number; y: number; width: number; height: number }, spec?: Partial<GraphSpec>): ID | null {
  const s = getState();
  const ab = activeArtboard();
  const r = rect ?? (ab ? { x: ab.x + ab.width * 0.15, y: ab.y + ab.height * 0.2, width: ab.width * 0.5, height: ab.height * 0.4 } : { x: 100, y: 100, width: 400, height: 300 });
  let id: ID | null = null;
  s.updateDoc((d) => {
    id = createGraph(d, insertionParent(), r, { ...sampleSpec(spec?.type ?? 'column'), ...spec, options: { ...DEFAULT_OPTIONS, ...(spec?.options ?? {}) } });
  }, 'Create Graph');
  if (id) getState().setSelection([id]);
  return id;
}

export function updateGraph(id: ID, patch: Partial<GraphSpec>, label: string | null = 'Graph Data'): void {
  getState().updateDoc((d) => {
    regenerateGraph(d, id, patch);
  }, label ?? undefined);
}

const commands: Command[] = [
  { id: 'graph.new', label: 'New Graph', menu: 'Object/Graph', order: 760, run: () => { const id = createGraphCommand(); if (id) getState().openDialog('graph.data', { id }); } },
  { id: 'graph.data', label: 'Data…', menu: 'Object/Graph', order: 761, run: () => { const g = graphsIn(getState())[0]; if (g) getState().openDialog('graph.data', { id: g }); }, enabled: hasGraph },
  { id: 'graph.type', label: 'Type…', menu: 'Object/Graph', order: 762, run: () => { const g = graphsIn(getState())[0]; if (g) getState().openDialog('graph.type', { id: g }); }, enabled: hasGraph },
  { id: 'graph.regenerate', label: 'Regenerate', menu: 'Object/Graph', order: 763, separatorBefore: true, run: () => { const s = getState(); const gs = graphsIn(s); s.updateDoc((d) => { for (const g of gs) regenerateGraph(d, g); }, 'Regenerate Graph'); }, enabled: hasGraph },
  { id: 'graph.refit', label: 'Refit to Size', menu: 'Object/Graph', order: 764, run: () => { const s = getState(); const gs = graphsIn(s); s.updateDoc((d) => { for (const g of gs) refitGraph(d, g); }, 'Refit Graph'); }, enabled: hasGraph },
  { id: 'graph.ungroup', label: 'Ungroup (stop being a graph)', menu: 'Object/Graph', order: 765, run: () => { const s = getState(); const gs = graphsIn(s); s.updateDoc((d) => { for (const g of gs) { const n = d.nodes[g]; if (n && isGraph(n)) { delete (n as { data?: unknown }).data; n.name = 'Group'; } } }, 'Ungroup Graph'); }, enabled: hasGraph },
];
registerCommands(commands);

// ---------------------------------------------------------------------------
// Graph Data dialog: an editable table (categories × series) with paste support
// ---------------------------------------------------------------------------

function GraphDataDialog({ props, close }: { props: { id: ID }; close: () => void }) {
  const spec = useMemo(() => graphSpec(getState().doc, props.id), [props.id]);
  const [data, setData] = useState<number[][]>(() => spec?.data.map((r) => [...r]) ?? []);
  const [categories, setCategories] = useState<string[]>(() => [...(spec?.categories ?? [])]);
  const [series, setSeries] = useState<string[]>(() => [...(spec?.series ?? [])]);
  const [raw, setRaw] = useState<string | null>(null);
  if (!spec) return null;
  const cols = series.length;
  const apply = (commit: boolean) => updateGraph(props.id, { data, categories, series }, commit ? 'Graph Data' : null);
  const ok = () => {
    apply(true);
    close();
  };
  const addRow = () => {
    setData([...data, Array.from({ length: cols }, () => 0)]);
    setCategories([...categories, `${categories.length + 1}`]);
  };
  const addCol = () => {
    setData(data.map((r) => [...r, 0]));
    setSeries([...series, `Series ${series.length + 1}`]);
  };
  const removeRow = () => {
    if (data.length <= 1) return;
    setData(data.slice(0, -1));
    setCategories(categories.slice(0, -1));
  };
  const removeCol = () => {
    if (cols <= 1) return;
    setData(data.map((r) => r.slice(0, -1)));
    setSeries(series.slice(0, -1));
  };
  const importText = (text: string) => {
    const t = parseTable(text);
    if (!t.data.length) return;
    setData(t.data);
    setCategories(t.categories);
    setSeries(t.series);
    setRaw(null);
  };
  return (
    <DialogFrame
      title="Graph Data"
      onClose={close}
      width={620}
      className="graph-dialog"
      footer={
        <>
          <Button onClick={() => setRaw(raw === null ? tableText({ data, categories, series }) : null)} title="Edit as tab-separated text (paste from a spreadsheet)">
            <ClipboardPaste size={13} /> {raw === null ? 'Text / paste' : 'Table'}
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={() => { apply(false); }} title="Preview without closing">Apply</Button>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={ok} data-testid="graph-data-ok">
            OK
          </Button>
        </>
      }
    >
      {raw !== null ? (
        <div className="graph-raw">
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} data-testid="graph-raw" />
          <Row gap={6}>
            <Button small onClick={() => importText(raw)} data-testid="graph-raw-apply">
              Use this data
            </Button>
            <span className="dim small">First row = series names, first column = categories (tabs, commas or semicolons).</span>
          </Row>
        </div>
      ) : (
        <div className="graph-table-wrap">
          <table className="graph-table" data-testid="graph-table">
            <thead>
              <tr>
                <th />
                {series.map((s, c) => (
                  <th key={c}>
                    <input value={s} onChange={(e) => setSeries(series.map((x, i) => (i === c ? e.target.value : x)))} onKeyDown={(e) => e.stopPropagation()} data-testid={`graph-series-${c}`} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, r) => (
                <tr key={r}>
                  <th>
                    <input value={categories[r] ?? ''} onChange={(e) => setCategories(categories.map((x, i) => (i === r ? e.target.value : x)))} onKeyDown={(e) => e.stopPropagation()} data-testid={`graph-cat-${r}`} />
                  </th>
                  {row.map((v, c) => (
                    <td key={c}>
                      <input
                        type="number"
                        step="any"
                        value={Number.isFinite(v) ? v : 0}
                        onChange={(e) => setData(data.map((rr, i) => (i === r ? rr.map((x, j) => (j === c ? Number(e.target.value) : x)) : rr)))}
                        onKeyDown={(e) => e.stopPropagation()}
                        data-testid={`graph-cell-${r}-${c}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Row gap={6}>
            <IconButton icon={<Plus size={13} />} title="Add category (row)" onClick={addRow} data-testid="graph-add-row" />
            <IconButton icon={<Minus size={13} />} title="Remove last category" onClick={removeRow} disabled={data.length <= 1} />
            <span className="dim small">rows</span>
            <span className="graph-sep" />
            <IconButton icon={<Plus size={13} />} title="Add series (column)" onClick={addCol} data-testid="graph-add-col" />
            <IconButton icon={<Minus size={13} />} title="Remove last series" onClick={removeCol} disabled={cols <= 1} />
            <span className="dim small">columns</span>
          </Row>
        </div>
      )}
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Graph Type dialog
// ---------------------------------------------------------------------------

function GraphTypeDialog({ props, close }: { props: { id: ID }; close: () => void }) {
  const spec = useStore((s) => graphSpec(s.doc, props.id));
  if (!spec) return null;
  const o = spec.options;
  const set = (p: Partial<GraphSpec>) => updateGraph(props.id, p, null);
  const setOpt = (p: Partial<GraphOptions>) => set({ options: { ...o, ...p } });
  const ok = () => {
    getState().commit('Graph Type');
    close();
  };
  const cancel = () => {
    getState().revert();
    close();
  };
  return (
    <DialogFrame
      title="Graph Type"
      onClose={cancel}
      width={460}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="graph-type-ok">
            OK
          </Button>
        </>
      }
    >
      <Select label="Type" value={spec.type} options={GRAPH_TYPES.map((t) => ({ value: t.id, label: t.label }))} onChange={(v) => set({ type: v as GraphType })} width={220} id="graph-type" />
      <Row gap={8}>
        <Select label="Value axis" value={o.valueAxis} options={[{ value: 'left', label: 'On left side' }, { value: 'right', label: 'On right side' }, { value: 'both', label: 'On both sides' }, { value: 'none', label: 'None' }]} onChange={(v) => setOpt({ valueAxis: v as GraphOptions['valueAxis'] })} width={170} />
        <Select label="Legend" value={o.legend} options={[{ value: 'right', label: 'Right' }, { value: 'top', label: 'Top' }, { value: 'none', label: 'None' }]} onChange={(v) => setOpt({ legend: v as GraphOptions['legend'] })} width={120} />
      </Row>
      <Row gap={8}>
        <NumberField label="Column width" value={Math.round(o.barWidth * 100)} min={10} max={100} unit="%" decimals={0} onChange={(v) => setOpt({ barWidth: v / 100 })} width={130} data-testid="graph-bar-width" />
        <NumberField label="Cluster width" value={Math.round(o.clusterWidth * 100)} min={10} max={100} unit="%" decimals={0} onChange={(v) => setOpt({ clusterWidth: v / 100 })} width={130} />
        <NumberField label="Font" value={o.fontSize} min={4} max={72} unit="px" decimals={0} onChange={(v) => setOpt({ fontSize: v })} width={90} />
      </Row>
      <Row gap={10} wrap>
        <Checkbox checked={o.categoryAxis} onChange={(v) => setOpt({ categoryAxis: v })} label="Category axis" />
        <Checkbox checked={o.showValues} onChange={(v) => setOpt({ showValues: v })} label="Show values" />
        <Checkbox checked={o.markers} onChange={(v) => setOpt({ markers: v })} label="Markers" />
        <Select label="Pie labels" value={o.pieLabels} options={[{ value: 'none', label: 'None' }, { value: 'value', label: 'Values' }, { value: 'percent', label: 'Percent' }]} onChange={(v) => setOpt({ pieLabels: v as GraphOptions['pieLabels'] })} width={120} />
      </Row>
      <Row gap={8}>
        <NumberField label="Min" value={o.min ?? Number.NaN} placeholder="auto" onChange={(v) => setOpt({ min: Number.isFinite(v) ? v : null })} width={110} />
        <NumberField label="Max" value={o.max ?? Number.NaN} placeholder="auto" onChange={(v) => setOpt({ max: Number.isFinite(v) ? v : null })} width={110} />
        <NumberField label="Ticks" value={o.ticks} min={1} max={20} decimals={0} onChange={(v) => setOpt({ ticks: Math.round(v) })} width={90} />
        <Button small onClick={() => setOpt({ min: null, max: null })}>
          Auto range
        </Button>
      </Row>
      <div className="graph-colors">
        <span className="field-label">Colours</span>
        {o.colors.map((c, i) => (
          <label key={i} className="graph-color" title={`Series ${i + 1}`} style={{ background: c }}>
            <input type="color" value={c} onChange={(e) => setOpt({ colors: o.colors.map((x, j) => (j === i ? (e.target.value as HexColor) : x)) })} />
          </label>
        ))}
      </div>
      <div className="dim small">Changes preview live; Cancel restores the graph.</div>
    </DialogFrame>
  );
}

registerDialog('graph.data', GraphDataDialog as any);
registerDialog('graph.type', GraphTypeDialog as any);

(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  graphs: { ...build, createGraph, regenerateGraph, refitGraph, graphsOf, graphSpec, isGraph, createGraphCommand, updateGraph },
};

void TextField;
void React;
