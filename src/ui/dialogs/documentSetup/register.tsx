/**
 * Document Setup dialog: units, active artboard (size, position, background,
 * transparency), grid settings and the canvas colour preference.
 */
import React, { useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, NumberField, Row, Section, Select, TextField, PopoverButton, Segmented } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { getState, useStore, DEFAULT_PREFS } from '@/store/store';
import type { Units, ColorMode, Bleed } from '@/model/types';
import { UNIT_LABELS } from '@/util/units';
import { BleedFields } from '@/print/BleedFields';
import { setDocumentColorMode } from '@/print/register';

const UNIT_OPTIONS = (Object.keys(UNIT_LABELS) as Units[]).map((u) => ({ value: u, label: UNIT_LABELS[u] }));

function ColorSwatch({ color, onChange, title }: { color: string; onChange: (hex: string) => void; title: string }) {
  return (
    <PopoverButton button={({ toggle, ref }) => <button type="button" ref={ref} className="io-color-swatch" style={{ background: color }} onClick={toggle} title={title} />}>
      <ColorPicker paint={{ type: 'solid', color, opacity: 1 }} onChange={(p) => p.type === 'solid' && onChange(p.color)} allowNone={false} allowGradient={false} />
    </PopoverButton>
  );
}

function DocumentSetupDialog({ close }: { props: Record<string, unknown>; close: () => void }) {
  const doc = useStore((s) => s.doc);
  const activeId = useStore((s) => s.activeArtboardId);
  const prefs = useStore((s) => s.prefs);
  const [name, setName] = useState(doc.name);
  const [units, setUnits] = useState<Units>(prefs.units);
  const [artboardId, setArtboardId] = useState(doc.artboards.find((a) => a.id === activeId)?.id ?? doc.artboards[0]?.id ?? '');
  const [artboards, setArtboards] = useState(() => doc.artboards.map((a) => ({ ...a })));
  const [grid, setGrid] = useState({ ...doc.grid });
  const [canvasColor, setCanvasColor] = useState(prefs.canvasColor);
  const [colorMode, setColorMode] = useState<ColorMode>(doc.colorMode);
  const [bleed, setBleed] = useState<Bleed>({ ...doc.bleed });

  const ab = artboards.find((a) => a.id === artboardId) ?? artboards[0];
  const patchArtboard = (patch: Partial<typeof ab>) => setArtboards((list) => list.map((a) => (a.id === ab?.id ? { ...a, ...patch } : a)));

  const apply = () => {
    const s = getState();
    s.updateDoc((d) => {
      d.name = name.trim() || d.name;
      d.units = units;
      for (const a of artboards) {
        const target = d.artboards.find((x) => x.id === a.id);
        if (!target) continue;
        target.name = a.name.trim() || target.name;
        target.x = a.x;
        target.y = a.y;
        target.width = Math.max(1, a.width);
        target.height = Math.max(1, a.height);
        target.background = a.background;
        target.transparent = a.transparent;
      }
      d.grid = { size: Math.max(1, grid.size), subdivisions: Math.max(1, Math.round(grid.subdivisions)), color: grid.color, style: grid.style };
      d.bleed = { top: Math.max(0, bleed.top), right: Math.max(0, bleed.right), bottom: Math.max(0, bleed.bottom), left: Math.max(0, bleed.left) };
    }, 'Document Setup');
    if (colorMode !== doc.colorMode) setDocumentColorMode(colorMode);
    s.setPrefs({ units, canvasColor });
    if (ab) s.setActiveArtboard(ab.id);
    close();
  };

  return (
    <DialogFrame
      title="Document Setup"
      onClose={close}
      width={480}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={apply} data-testid="doc-setup-ok">
            OK
          </Button>
        </>
      }
    >
      <Section title="Document">
        <div className="io-form-row">
          <span className="io-form-label">Name</span>
          <TextField value={name} onChange={setName} onCommit={setName} />
        </div>
        <div className="io-form-row">
          <span className="io-form-label">Units</span>
          <Select value={units} options={UNIT_OPTIONS} onChange={setUnits} width={90} />
        </div>
        <div className="io-form-row">
          <span className="io-form-label">Color mode</span>
          <Segmented
            value={colorMode}
            onChange={setColorMode}
            options={[
              { value: 'rgb', label: 'RGB' },
              { value: 'cmyk', label: 'CMYK' },
            ]}
          />
        </div>
        <div className="io-form-row">
          <span className="io-form-label">Bleed</span>
          <BleedFields value={bleed} onChange={setBleed} units={units} testIdPrefix="doc-setup-bleed" />
        </div>
      </Section>
      {ab && (
        <Section title="Artboard" right={artboards.length > 1 ? <Select value={artboardId} options={artboards.map((a) => ({ value: a.id, label: a.name }))} onChange={setArtboardId} width={140} /> : undefined}>
          <div className="io-form-row">
            <span className="io-form-label">Name</span>
            <TextField value={ab.name} onCommit={(v) => patchArtboard({ name: v })} />
          </div>
          <div className="io-form-row">
            <span className="io-form-label">Size</span>
            <Row gap={6}>
              <NumberField label="W" value={ab.width} unit={units} min={1} max={100000} onChange={(v) => patchArtboard({ width: v })} width={120} data-testid="doc-setup-width" />
              <NumberField label="H" value={ab.height} unit={units} min={1} max={100000} onChange={(v) => patchArtboard({ height: v })} width={120} data-testid="doc-setup-height" />
            </Row>
          </div>
          <div className="io-form-row">
            <span className="io-form-label">Position</span>
            <Row gap={6}>
              <NumberField label="X" value={ab.x} unit={units} onChange={(v) => patchArtboard({ x: v })} width={120} />
              <NumberField label="Y" value={ab.y} unit={units} onChange={(v) => patchArtboard({ y: v })} width={120} />
            </Row>
          </div>
          <div className="io-form-row">
            <span className="io-form-label">Background</span>
            <Row gap={10}>
              <ColorSwatch color={ab.background} onChange={(c) => patchArtboard({ background: c })} title="Artboard background" />
              <Checkbox checked={ab.transparent} onChange={(v) => patchArtboard({ transparent: v })} label="Transparent" />
            </Row>
          </div>
        </Section>
      )}
      <Section title="Grid">
        <div className="io-form-row">
          <span className="io-form-label">Gridline every</span>
          <Row gap={6}>
            <NumberField value={grid.size} unit={units} min={1} max={10000} onChange={(v) => setGrid({ ...grid, size: v })} width={120} data-testid="doc-setup-grid-size" />
            <NumberField label="Subdivisions" value={grid.subdivisions} min={1} max={100} decimals={0} onChange={(v) => setGrid({ ...grid, subdivisions: Math.round(v) })} width={140} />
          </Row>
        </div>
        <div className="io-form-row">
          <span className="io-form-label">Style</span>
          <Row gap={10}>
            <Segmented
              value={grid.style}
              onChange={(v) => setGrid({ ...grid, style: v })}
              options={[
                { value: 'lines', label: 'Lines' },
                { value: 'dots', label: 'Dots' },
              ]}
            />
            <ColorSwatch color={grid.color} onChange={(c) => setGrid({ ...grid, color: c })} title="Grid colour" />
          </Row>
        </div>
      </Section>
      <Section title="Canvas">
        <div className="io-form-row">
          <span className="io-form-label">Canvas colour</span>
          <Row gap={8}>
            <ColorSwatch color={canvasColor} onChange={setCanvasColor} title="Canvas colour (preference)" />
            <Button small onClick={() => setCanvasColor(DEFAULT_PREFS.canvasColor)}>
              Reset
            </Button>
            <span className="io-hint">Preference, not saved in the document</span>
          </Row>
        </div>
      </Section>
    </DialogFrame>
  );
}

registerDialog('documentSetup', DocumentSetupDialog);

void React;
