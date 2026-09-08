/**
 * Image properties: natural size, displayed size (proportional lock), Trace / Crop.
 */
import React, { useState } from 'react';
import { Link, Unlink, ScanLine, Crop } from 'lucide-react';
import type { ID, ImageNode } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { NumberField, Button, Checkbox } from '@/ui/widgets';
import { getCommand, runCommand, isEnabled } from '@/commands/registry';
import { common } from './edit';

function images(ids: ID[]): ImageNode[] {
  const doc = getState().doc;
  return ids.map((id) => doc.nodes[id]).filter((n): n is ImageNode => !!n && n.type === 'image');
}

export function ImageSection({ ids }: { ids: ID[] }) {
  const units = useStore((s) => s.prefs.units);
  useStore((s) => s.docVersion);
  const [lock, setLock] = useState(true);
  const list = images(ids);
  const w = common(list.map((n) => n.width));
  const h = common(list.map((n) => n.height));
  const nw = common(list.map((n) => n.naturalWidth));
  const nh = common(list.map((n) => n.naturalHeight));
  const smoothing = common(list.map((n) => n.smoothing !== false));
  const patch = (fn: (n: ImageNode) => void) =>
    getState().updateDoc((d) => {
      for (const n of list) {
        const nn = d.nodes[n.id];
        if (nn && nn.type === 'image') fn(nn);
      }
    });
  const commit = (label: string) => getState().commit(label);
  const trace = getCommand('image.trace');
  const crop = getCommand('image.crop');
  const s = getState();
  return (
    <>
      <div className="pp-info">
        <span>
          Natural: <b>{nw !== null && nh !== null ? `${Math.round(nw)} × ${Math.round(nh)} px` : 'Mixed'}</b>
        </span>
        <span>{list.length > 1 ? `${list.length} images` : ''}</span>
      </div>
      <div className="pp-transform">
        <NumberField
          label="W"
          value={w}
          mixed={w === null}
          onChange={(v) =>
            patch((n) => {
              const ratio = n.width > 0 ? n.height / n.width : 1;
              n.width = Math.max(1, v);
              if (lock) n.height = Math.max(1, v * ratio);
            })
          }
          onCommit={() => commit('Resize Image')}
          min={1}
          unit={units}
          data-testid="pp-image-w"
        />
        <NumberField
          label="H"
          value={h}
          mixed={h === null}
          onChange={(v) =>
            patch((n) => {
              const ratio = n.height > 0 ? n.width / n.height : 1;
              n.height = Math.max(1, v);
              if (lock) n.width = Math.max(1, v * ratio);
            })
          }
          onCommit={() => commit('Resize Image')}
          min={1}
          unit={units}
          data-testid="pp-image-h"
        />
        <button type="button" className={`pp-lock ${lock ? 'active' : ''}`} style={{ gridRow: '1', height: 24 }} onClick={() => setLock(!lock)} title={lock ? 'Proportions locked' : 'Lock proportions'} aria-pressed={lock}>
          {lock ? <Link size={11} /> : <Unlink size={11} />}
        </button>
      </div>
      <div className="pp-row">
        <Checkbox checked={smoothing !== false} indeterminate={smoothing === null} onChange={(v) => { patch((n) => { n.smoothing = v; }); commit('Image Smoothing'); }} label="Smooth scaling" />
        <span className="grow" />
        <Button
          small
          onClick={() => {
            patch((n) => {
              n.width = n.naturalWidth;
              n.height = n.naturalHeight;
            });
            commit('Reset Image Size');
          }}
          title="Reset to the natural size"
        >
          1:1
        </Button>
      </div>
      {(trace || crop) && (
        <div className="pp-actions">
          {trace && (
            <button type="button" className="pp-action" disabled={!isEnabled(trace, s)} onClick={() => runCommand('image.trace')} title={trace.label}>
              <ScanLine size={13} /> Trace
            </button>
          )}
          {crop && (
            <button type="button" className="pp-action" disabled={!isEnabled(crop, s)} onClick={() => runCommand('image.crop')} title={crop.label}>
              <Crop size={13} /> Crop
            </button>
          )}
        </div>
      )}
    </>
  );
}
