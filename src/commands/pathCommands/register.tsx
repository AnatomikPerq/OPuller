/**
 * Object > Pathfinder, Object > Path, Compound Path, Clipping Mask and Expand
 * commands (+ the small Average / Expand dialogs).
 */
import React, { useEffect, useState } from 'react';
import type { ID } from '@/model/types';
import { registerCommands, getCommand, when } from '@/commands/registry';
import { getState, type EditorState } from '@/store/store';
import { topmostOf, descendants } from '@/model/document';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, Segmented } from '@/ui/widgets';
import { runPathfinder, pathfinderDef, type PathfinderOp } from '@/pathops/pathfinder';
import { selectionTargets, targetGeoms, targetCount, notifySkipped, replaceWithResults, commitChange } from '@/pathops/apply';
import {
  joinCommand,
  averageCommand,
  addAnchorsCommand,
  removeRedundantCommand,
  reverseCommand,
  divideBelowCommand,
  cleanUpCommand,
  compoundMakeCommand,
  compoundReleaseCommand,
  clipMakeCommand,
  clipReleaseCommand,
  outlineStrokeCommand,
  expandNodes,
  canJoin,
  canAverage,
  hasStrokedPath,
  canReleaseCompound,
  canClipMake,
  canClipRelease,
  type AverageAxis,
  type ExpandOptions,
} from '@/pathops/pathEdit';

// ---------------------------------------------------------------------------
// Pathfinder
// ---------------------------------------------------------------------------

/** Run a pathfinder operation on the selection. Returns true when the document changed. */
export function applyPathfinder(op: PathfinderOp): boolean {
  const s = getState();
  const def = pathfinderDef(op);
  const t = selectionTargets(s);
  notifySkipped(t);
  if (t.ids.length < def.min) {
    s.toast(`${def.label} needs at least ${def.min} selected path${def.min > 1 ? 's' : ''}.`, 'info');
    return false;
  }
  const geoms = targetGeoms(s.doc, t.ids);
  let out: ReturnType<typeof runPathfinder>;
  try {
    out = runPathfinder(op, geoms);
  } catch (err) {
    console.error(err);
    s.toast(`${def.label} failed on this geometry.`, 'error');
    return false;
  }
  if (!out.results.length) {
    s.toast('No result', 'info');
    return false;
  }
  let roots: ID[] = [];
  commitChange((d) => {
    roots = replaceWithResults(d, t.ids, out.results, { group: out.group, groupName: def.label }).roots;
  }, `Pathfinder ${def.label}`);
  getState().setSelection(roots);
  return true;
}

const minPaths = (n: number) => (s: EditorState) => targetCount(s) >= n;

const PF_ORDER: Record<PathfinderOp, number> = {
  unite: 300,
  minusFront: 301,
  intersect: 302,
  exclude: 303,
  divide: 310,
  trim: 311,
  merge: 312,
  crop: 313,
  outline: 314,
  minusBack: 304,
};

registerCommands(
  (['unite', 'minusFront', 'intersect', 'exclude', 'minusBack', 'divide', 'trim', 'merge', 'crop', 'outline'] as PathfinderOp[]).map((op) => {
    const def = pathfinderDef(op);
    return {
      id: `pathfinder.${op}`,
      label: def.label,
      menu: 'Object/Pathfinder',
      order: PF_ORDER[op],
      separatorBefore: op === 'divide',
      run: () => {
        applyPathfinder(op);
      },
      enabled: minPaths(def.min),
    };
  }),
);

// ---------------------------------------------------------------------------
// Expand (async because text outlines come from the type module)
// ---------------------------------------------------------------------------

export async function expandSelection(opts: ExpandOptions): Promise<void> {
  const s = getState();
  const roots = topmostOf(s.doc, s.selection);
  const textIds = roots.flatMap((r) => descendants(s.doc, r, true)).filter((id) => {
    const n = s.doc.nodes[id];
    return n && n.type === 'text' && n.text.trim().length > 0;
  });
  const outlines = getCommand('type.createOutlines');
  if (textIds.length && outlines) {
    const others = s.selection.filter((id) => s.doc.nodes[id]?.type !== 'text');
    await outlines.run();
    const after = getState();
    after.setSelection(others.concat(after.selection.filter((id) => !others.includes(id))));
  } else if (textIds.length) {
    s.toast('Text objects cannot be expanded (Create Outlines is not available).', 'info');
  }
  const st = getState();
  const t = selectionTargets(st);
  if (!t.ids.length) return;
  let res: { results: ID[]; changed: number } = { results: [], changed: 0 };
  commitChange((d) => {
    res = expandNodes(d, t.ids, opts);
  }, 'Expand');
  const map = new Map<ID, ID>();
  t.ids.forEach((id, i) => map.set(id, res.results[i] ?? id));
  const fin = getState();
  fin.setSelection(fin.selection.map((id) => map.get(id) ?? id));
  if (!res.changed && !textIds.length) fin.toast('Nothing to expand in the selection.', 'info');
}

function hasExpandable(s: EditorState): boolean {
  return s.selection.some((id) => {
    const n = s.doc.nodes[id];
    return !!n && (n.type === 'path' || n.type === 'text' || n.type === 'group');
  });
}

// ---------------------------------------------------------------------------
// Dialogs: Average, Expand
// ---------------------------------------------------------------------------

function useEnterKey(scope: string, onEnter: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.(`.${scope}`)) {
        e.preventDefault();
        setTimeout(onEnter, 0);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [scope, onEnter]);
}

let lastAxis: AverageAxis = 'both';

function AverageDialog({ close }: { close: () => void }) {
  const [axis, setAxis] = useState<AverageAxis>(lastAxis);
  const count = getState().selectedAnchors.length;
  const ok = () => {
    lastAxis = axis;
    averageCommand(axis);
    close();
  };
  useEnterKey('average-dialog', ok);
  return (
    <DialogFrame
      title="Average"
      onClose={close}
      width={340}
      className="average-dialog"
      footer={
        <>
          <Button onClick={close} data-testid="average-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} data-testid="average-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="muted small">Move the {count} selected anchor points to their average position.</div>
      <div className="row" style={{ gap: 8 }}>
        <span className="field-label">Axis</span>
        <Segmented<AverageAxis>
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'h', label: 'Horizontal', title: 'Align the points on a horizontal line' },
            { value: 'v', label: 'Vertical', title: 'Align the points on a vertical line' },
            { value: 'both', label: 'Both', title: 'Move all points to one spot' },
          ]}
        />
      </div>
    </DialogFrame>
  );
}

let lastExpand: ExpandOptions = { object: true, stroke: true };

function ExpandDialog({ close }: { close: () => void }) {
  const [opts, setOpts] = useState<ExpandOptions>(lastExpand);
  const s = getState();
  const hasText = s.selection.some((id) => s.doc.nodes[id]?.type === 'text');
  const ok = () => {
    lastExpand = opts;
    close();
    void expandSelection(opts);
  };
  useEnterKey('expand-dialog', ok);
  return (
    <DialogFrame
      title="Expand"
      onClose={close}
      width={340}
      className="expand-dialog"
      footer={
        <>
          <Button onClick={close} data-testid="expand-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} data-testid="expand-ok" disabled={!opts.object && !opts.stroke}>
            OK
          </Button>
        </>
      }
    >
      <Checkbox checked={opts.object} onChange={(v) => setOpts({ ...opts, object: v })} label="Object (live shapes become plain paths)" />
      <Checkbox checked={opts.stroke} onChange={(v) => setOpts({ ...opts, stroke: v })} label="Stroke (strokes become filled paths)" />
      {hasText && <div className="muted small">Text objects are converted to outlines first.</div>}
      <div className="dim small">Gradient and pattern fills stay as paint attributes.</div>
    </DialogFrame>
  );
}

registerDialog('averageAnchors', ({ close }) => <AverageDialog close={close} />);
registerDialog('expand', ({ close }) => <ExpandDialog close={close} />);

// ---------------------------------------------------------------------------
// Object > Path / Compound Path / Clipping Mask / Expand
// ---------------------------------------------------------------------------

registerCommands([
  { id: 'path.join', label: 'Join', menu: 'Object/Path', shortcut: 'mod+j', order: 10, run: joinCommand, enabled: canJoin },
  { id: 'path.average', label: 'Average…', menu: 'Object/Path', shortcut: 'mod+alt+j', order: 11, run: () => getState().openDialog('averageAnchors'), enabled: canAverage },
  { id: 'path.outlineStroke', label: 'Outline Stroke', menu: 'Object/Path', order: 20, separatorBefore: true, run: outlineStrokeCommand, enabled: hasStrokedPath },
  { id: 'path.offset', label: 'Offset Path…', menu: 'Object/Path', order: 21, run: () => getState().openDialog('offsetPath'), enabled: minPaths(1) },
  { id: 'path.simplify', label: 'Simplify…', menu: 'Object/Path', order: 22, run: () => getState().openDialog('simplify'), enabled: minPaths(1) },
  { id: 'path.addAnchors', label: 'Add Anchor Points', menu: 'Object/Path', order: 30, separatorBefore: true, run: addAnchorsCommand, enabled: minPaths(1) },
  { id: 'path.removeRedundant', label: 'Remove Redundant Points', menu: 'Object/Path', order: 31, run: removeRedundantCommand, enabled: minPaths(1) },
  { id: 'path.reverse', label: 'Reverse Path Direction', menu: 'Object/Path', order: 32, run: reverseCommand, enabled: minPaths(1) },
  { id: 'path.divideBelow', label: 'Divide Objects Below', menu: 'Object/Path', order: 40, separatorBefore: true, run: divideBelowCommand, enabled: minPaths(1) },
  { id: 'path.cleanUp', label: 'Clean Up', menu: 'Object/Path', order: 41, run: cleanUpCommand },
  { id: 'path.compoundMake', label: 'Make', menu: 'Object/Compound Path', shortcut: 'mod+8', order: 200, run: compoundMakeCommand, enabled: minPaths(1) },
  { id: 'path.compoundRelease', label: 'Release', menu: 'Object/Compound Path', shortcut: 'mod+alt+shift+8', order: 201, run: compoundReleaseCommand, enabled: canReleaseCompound },
  { id: 'object.clipMake', label: 'Make', menu: 'Object/Clipping Mask', shortcut: 'mod+7', order: 210, run: clipMakeCommand, enabled: canClipMake },
  { id: 'object.clipRelease', label: 'Release', menu: 'Object/Clipping Mask', shortcut: 'mod+alt+7', order: 211, run: clipReleaseCommand, enabled: canClipRelease },
  { id: 'object.expand', label: 'Expand…', menu: 'Object', order: 160, separatorBefore: true, run: () => getState().openDialog('expand'), enabled: hasExpandable },
]);

void when;
void React;
