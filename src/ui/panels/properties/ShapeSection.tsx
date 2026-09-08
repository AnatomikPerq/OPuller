/**
 * Live shape parameters (rect / ellipse / polygon / star / line) with mixed
 * values for multi-selection. Edits regenerate the geometry via refreshLiveShape.
 */
import React, { useState } from 'react';
import { Link, Unlink, SquareRoundCorner } from 'lucide-react';
import type { ID, LiveShape, PathNode } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { NumberField, IconButton } from '@/ui/widgets';
import { refreshLiveShape } from '@/model/document';
import { common } from './edit';

type Kind = LiveShape['kind'];

function shapes(ids: ID[]): LiveShape[] {
  const doc = getState().doc;
  return ids.map((id) => (doc.nodes[id] as PathNode | undefined)?.shape).filter((s): s is LiveShape => !!s);
}

function patchShapes(ids: ID[], fn: (s: LiveShape) => LiveShape, label?: string) {
  getState().updateDoc((d) => {
    for (const id of ids) {
      const n = d.nodes[id];
      if (!n || n.type !== 'path' || !n.shape) continue;
      n.shape = fn(n.shape);
      refreshLiveShape(n);
    }
  }, label);
}

const CORNER_CLASS = ['tl', 'tr', 'br', 'bl'];
const CORNER_TITLES = ['Top-left radius', 'Top-right radius', 'Bottom-right radius', 'Bottom-left radius'];

export function ShapeSection({ ids, kind }: { ids: ID[]; kind: Kind }) {
  const units = useStore((s) => s.prefs.units);
  useStore((s) => s.docVersion);
  const [linkRadii, setLinkRadii] = useState(true);
  const list = shapes(ids);
  const commit = (label: string) => getState().commit(label);
  const num = (pick: (s: LiveShape) => number | null) => common(list.map(pick).filter((v): v is number => v !== null));

  if (kind === 'rect') {
    const w = num((s) => (s.kind === 'rect' ? s.width : null));
    const h = num((s) => (s.kind === 'rect' ? s.height : null));
    const radii = [0, 1, 2, 3].map((i) => num((s) => (s.kind === 'rect' ? s.radii[i] : null)));
    const setRadius = (i: number, v: number) =>
      patchShapes(ids, (s) => {
        if (s.kind !== 'rect') return s;
        const r = [...s.radii] as [number, number, number, number];
        if (linkRadii) r.fill(Math.max(0, v));
        else r[i] = Math.max(0, v);
        return { ...s, radii: r };
      });
    return (
      <>
        <div className="pp-grid-2">
          <NumberField label="W" value={w} mixed={w === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'rect' ? { ...s, width: Math.max(0.01, v) } : s))} onCommit={() => commit('Rectangle Size')} min={0.01} unit={units} data-testid="pp-rect-w" />
          <NumberField label="H" value={h} mixed={h === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'rect' ? { ...s, height: Math.max(0.01, v) } : s))} onCommit={() => commit('Rectangle Size')} min={0.01} unit={units} data-testid="pp-rect-h" />
        </div>
        <div className="pp-row">
          <span className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <SquareRoundCorner size={12} /> Corners
          </span>
          <span className="grow" />
          <IconButton icon={linkRadii ? <Link size={12} /> : <Unlink size={12} />} active={linkRadii} title={linkRadii ? 'Corner radii linked' : 'Link corner radii'} onClick={() => setLinkRadii(!linkRadii)} data-testid="pp-radius-link" size={12} />
        </div>
        <div className="pp-grid-2">
          {radii.map((r, i) => (
            <NumberField
              key={i}
              label={<span className={`pp-corner ${CORNER_CLASS[i]}`} />}
              title={CORNER_TITLES[i]}
              value={r}
              mixed={r === null}
              onChange={(v) => setRadius(i, v)}
              onCommit={() => commit('Corner Radius')}
              min={0}
              unit={units}
              data-testid={`pp-radius-${i}`}
            />
          ))}
        </div>
      </>
    );
  }
  if (kind === 'ellipse') {
    const rx = num((s) => (s.kind === 'ellipse' ? s.rx : null));
    const ry = num((s) => (s.kind === 'ellipse' ? s.ry : null));
    return (
      <div className="pp-grid-2">
        <NumberField label="Rx" value={rx} mixed={rx === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'ellipse' ? { ...s, rx: Math.max(0.01, v) } : s))} onCommit={() => commit('Ellipse Radius')} min={0.01} unit={units} data-testid="pp-ellipse-rx" />
        <NumberField label="Ry" value={ry} mixed={ry === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'ellipse' ? { ...s, ry: Math.max(0.01, v) } : s))} onCommit={() => commit('Ellipse Radius')} min={0.01} unit={units} data-testid="pp-ellipse-ry" />
      </div>
    );
  }
  if (kind === 'polygon') {
    const sides = num((s) => (s.kind === 'polygon' ? s.sides : null));
    const radius = num((s) => (s.kind === 'polygon' ? s.radius : null));
    return (
      <div className="pp-grid-2">
        <NumberField label="Sides" value={sides} mixed={sides === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'polygon' ? { ...s, sides: Math.max(3, Math.round(v)) } : s))} onCommit={() => commit('Polygon Sides')} min={3} max={100} decimals={0} data-testid="pp-polygon-sides" />
        <NumberField label="R" value={radius} mixed={radius === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'polygon' ? { ...s, radius: Math.max(0.01, v) } : s))} onCommit={() => commit('Polygon Radius')} min={0.01} unit={units} data-testid="pp-polygon-radius" />
      </div>
    );
  }
  if (kind === 'star') {
    const points = num((s) => (s.kind === 'star' ? s.points : null));
    const outer = num((s) => (s.kind === 'star' ? s.outerRadius : null));
    const inner = num((s) => (s.kind === 'star' ? s.innerRadius : null));
    return (
      <>
        <div className="pp-grid-2">
          <NumberField label="Points" value={points} mixed={points === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'star' ? { ...s, points: Math.max(3, Math.round(v)) } : s))} onCommit={() => commit('Star Points')} min={3} max={100} decimals={0} data-testid="pp-star-points" />
          <NumberField label="R1" value={outer} mixed={outer === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'star' ? { ...s, outerRadius: Math.max(0.01, v) } : s))} onCommit={() => commit('Star Radius')} min={0.01} unit={units} title="Outer radius" data-testid="pp-star-outer" />
        </div>
        <div className="pp-grid-2">
          <NumberField label="R2" value={inner} mixed={inner === null} onChange={(v) => patchShapes(ids, (s) => (s.kind === 'star' ? { ...s, innerRadius: Math.max(0.01, v) } : s))} onCommit={() => commit('Star Radius')} min={0.01} unit={units} title="Inner radius" data-testid="pp-star-inner" />
          <span />
        </div>
      </>
    );
  }
  if (kind === 'line') {
    const len = num((s) => (s.kind === 'line' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) : null));
    const ang = num((s) => (s.kind === 'line' ? -(Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI : null));
    return (
      <div className="pp-grid-2">
        <NumberField
          label="L"
          value={len}
          mixed={len === null}
          onChange={(v) =>
            patchShapes(ids, (s) => {
              if (s.kind !== 'line') return s;
              const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
              return { ...s, x2: s.x1 + Math.cos(a) * Math.max(0, v), y2: s.y1 + Math.sin(a) * Math.max(0, v) };
            })
          }
          onCommit={() => commit('Line Length')}
          min={0}
          unit={units}
          title="Length"
          data-testid="pp-line-length"
        />
        <NumberField
          label="∠"
          value={ang}
          mixed={ang === null}
          onChange={(v) =>
            patchShapes(ids, (s) => {
              if (s.kind !== 'line') return s;
              const l = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
              const a = (-v * Math.PI) / 180;
              return { ...s, x2: s.x1 + Math.cos(a) * l, y2: s.y1 + Math.sin(a) * l };
            })
          }
          onCommit={() => commit('Line Angle')}
          unit="deg"
          decimals={1}
          title="Angle (counter-clockwise)"
          data-testid="pp-line-angle"
        />
      </div>
    );
  }
  return null;
}
