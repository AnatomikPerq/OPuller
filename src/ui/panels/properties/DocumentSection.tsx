/**
 * Properties panel content when nothing is selected: document settings and
 * quick view/preference toggles.
 */
import React from 'react';
import { Ruler, Grid3x3, Crosshair, Magnet, Sparkles, SquareDashed, Settings2, Frame } from 'lucide-react';
import type { Units } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { NumberField, Select, Checkbox, Button, IconButton, Section } from '@/ui/widgets';
import { getCommand, runCommand } from '@/commands/registry';
import { PaintSwatch } from '@/ui/panels/appearance/PaintSwatch';
import { activeArtboard } from './edit';

const UNIT_OPTIONS: Array<{ value: Units; label: string }> = [
  { value: 'px', label: 'Pixels (px)' },
  { value: 'pt', label: 'Points (pt)' },
  { value: 'mm', label: 'Millimeters (mm)' },
  { value: 'cm', label: 'Centimeters (cm)' },
  { value: 'in', label: 'Inches (in)' },
];

export function DocumentSection() {
  const units = useStore((s) => s.prefs.units);
  const setPrefs = useStore((s) => s.setPrefs);
  useStore((s) => s.docVersion);
  useStore((s) => s.activeArtboardId);
  const s = getState();
  const ab = activeArtboard(s);
  const grid = s.doc.grid;
  const setup = getCommand('file.documentSetup');
  const artboardCount = s.doc.artboards.length;

  const patchArtboard = (patch: { width?: number; height?: number; background?: string; transparent?: boolean }, label?: string) => {
    if (!ab) return;
    getState().updateDoc((d) => {
      const a = d.artboards.find((x) => x.id === ab.id);
      if (a) Object.assign(a, patch);
    }, label);
  };

  return (
    <>
      <Section title="Document" right={<span className="dim">{s.doc.name}</span>}>
        <Select label="Units" value={units} options={UNIT_OPTIONS} onChange={(v) => setPrefs({ units: v })} id="pp-units" />
        <div className="pp-grid-2">
          <NumberField label="W" value={ab?.width ?? null} onChange={(v) => patchArtboard({ width: Math.max(1, v) })} onCommit={() => getState().commit('Artboard Size')} min={1} unit={units} disabled={!ab} title="Active artboard width" data-testid="pp-artboard-w" />
          <NumberField label="H" value={ab?.height ?? null} onChange={(v) => patchArtboard({ height: Math.max(1, v) })} onCommit={() => getState().commit('Artboard Size')} min={1} unit={units} disabled={!ab} title="Active artboard height" data-testid="pp-artboard-h" />
        </div>
        <div className="pp-row">
          <PaintSwatch
            paint={{ type: 'solid', color: ab?.background ?? '#ffffff', opacity: 1 }}
            allowGradient={false}
            onChange={(p) => p.type === 'solid' && patchArtboard({ background: p.color })}
            onCommit={() => getState().commit('Artboard Background')}
            title="Artboard background colour"
            small
          />
          <span className="muted">Background</span>
          <span className="grow" />
          <Checkbox checked={!!ab?.transparent} onChange={(v) => patchArtboard({ transparent: v }, 'Artboard Background')} label="Transparent" disabled={!ab} />
        </div>
        <div className="pp-info">
          <span>
            Artboards: <b>{artboardCount}</b>
          </span>
          <span>
            Active: <b>{ab?.name ?? '—'}</b>
          </span>
        </div>
        <div className="pp-grid-2">
          <NumberField
            label="Grid"
            value={grid.size}
            onChange={(v) =>
              getState().updateDoc((d) => {
                d.grid.size = Math.max(1, v);
              })
            }
            onCommit={() => getState().commit('Grid Size')}
            min={1}
            unit={units}
            title="Grid size"
            data-testid="pp-grid-size"
          />
          <NumberField
            label="Sub"
            value={grid.subdivisions}
            onChange={(v) =>
              getState().updateDoc((d) => {
                d.grid.subdivisions = Math.max(1, Math.round(v));
              })
            }
            onCommit={() => getState().commit('Grid Subdivisions')}
            min={1}
            max={50}
            decimals={0}
            title="Grid subdivisions"
          />
        </div>
        <Button small onClick={() => runCommand('file.documentSetup')} disabled={!setup} title={setup ? 'Document Setup' : 'Document Setup is not available'}>
          <Settings2 size={12} />
          Document Setup…
        </Button>
      </Section>
      <PreferencesSection />
    </>
  );
}

export function PreferencesSection() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const toggles: Array<{ key: keyof typeof view; icon: React.ReactNode; title: string; id: string }> = [
    { key: 'rulers', icon: <Ruler size={15} />, title: 'Rulers (Ctrl+R)', id: 'rulers' },
    { key: 'grid', icon: <Grid3x3 size={15} />, title: "Grid (Ctrl+')", id: 'grid' },
    { key: 'guides', icon: <Crosshair size={15} />, title: 'Guides (Ctrl+;)', id: 'guides' },
    { key: 'snapToPoint', icon: <Magnet size={15} />, title: 'Snapping (snap to point / guides)', id: 'snap' },
    { key: 'smartGuides', icon: <Sparkles size={15} />, title: 'Smart guides (Ctrl+U)', id: 'smart' },
    { key: 'outline', icon: <SquareDashed size={15} />, title: 'Outline mode (Ctrl+Y)', id: 'outline' },
    { key: 'showArtboards', icon: <Frame size={15} />, title: 'Show artboards (Ctrl+Shift+H)', id: 'artboards' },
  ];
  return (
    <Section title="Preferences">
      <div className="pp-toggles">
        {toggles.map((t) => (
          <IconButton
            key={t.id}
            icon={t.icon}
            active={!!view[t.key]}
            title={t.title}
            data-testid={`pp-toggle-${t.id}`}
            onClick={() => {
              if (t.key === 'snapToPoint') {
                const on = !view.snapToPoint;
                setView({ snapToPoint: on, snapToGuides: on });
              } else setView({ [t.key]: !view[t.key] });
            }}
          />
        ))}
      </div>
    </Section>
  );
}
