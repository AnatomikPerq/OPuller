/**
 * Blend module wiring: Object > Blend commands, the Blend Options dialog and
 * live regeneration of blend steps when a source object changes.
 */
import React, { useState } from 'react';
import type { ID, Node } from '@/model/types';
import { useStore, getState, setState, type EditorState } from '@/store/store';
import { registerCommands, when } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Row, Segmented } from '@/ui/widgets';
import { collectPaths } from '@/model/document';
import { makeBlend, releaseBlend, expandBlend, reverseBlend, reverseBlendStacking, setBlendOptions, blendGroupsOf, blendSpec, regenerateBlend, isBlendGroup, DEFAULT_BLEND, type BlendSpec, type BlendSpacing } from './ops';

let lastOptions: Omit<BlendSpec, 'sources'> = { ...DEFAULT_BLEND };

export function makeBlendCommand(opts?: Partial<Omit<BlendSpec, 'sources'>>): ID | null {
  const s = getState();
  const paths = collectPaths(s.doc, s.selection);
  if (paths.length < 2) {
    s.toast('Select at least two paths to blend.', 'info');
    return null;
  }
  let gid: ID | null = null;
  s.updateDoc((d) => {
    gid = makeBlend(d, paths, { ...lastOptions, ...opts });
  }, 'Make Blend');
  if (gid) getState().setSelection([gid]);
  return gid;
}

function targetGroups(s: EditorState = getState()): ID[] {
  return blendGroupsOf(s.doc, s.selection);
}

const hasBlend = (s: EditorState) => targetGroups(s).length > 0;
const canMake = (s: EditorState) => collectPaths(s.doc, s.selection).length >= 2 && !hasBlend(s);

registerCommands([
  { id: 'blend.make', label: 'Make', menu: 'Object/Blend', shortcut: 'mod+alt+b', order: 500, run: () => makeBlendCommand(), enabled: canMake },
  {
    id: 'blend.release',
    label: 'Release',
    menu: 'Object/Blend',
    shortcut: 'mod+alt+shift+b',
    order: 501,
    run: () => {
      const groups = targetGroups();
      let kept: ID[] = [];
      getState().updateDoc((d) => {
        for (const g of groups) kept = kept.concat(releaseBlend(d, g));
      }, 'Release Blend');
      getState().setSelection(kept);
    },
    enabled: hasBlend,
  },
  {
    id: 'blend.expand',
    label: 'Expand',
    menu: 'Object/Blend',
    order: 502,
    run: () => {
      const groups = targetGroups();
      getState().updateDoc((d) => {
        for (const g of groups) expandBlend(d, g);
      }, 'Expand Blend');
    },
    enabled: hasBlend,
  },
  { id: 'blend.options', label: 'Blend Options…', menu: 'Object/Blend', order: 510, separatorBefore: true, run: () => getState().openDialog('blendOptions', {}), enabled: (s) => hasBlend(s) || canMake(s) },
  {
    id: 'blend.reverseSpine',
    label: 'Reverse Spine',
    menu: 'Object/Blend',
    order: 520,
    separatorBefore: true,
    run: () => {
      const groups = targetGroups();
      getState().updateDoc((d) => {
        for (const g of groups) reverseBlend(d, g);
      }, 'Reverse Spine');
    },
    enabled: hasBlend,
  },
  {
    id: 'blend.reverseStack',
    label: 'Reverse Front to Back',
    menu: 'Object/Blend',
    order: 521,
    run: () => {
      const groups = targetGroups();
      getState().updateDoc((d) => {
        for (const g of groups) reverseBlendStacking(d, g);
      }, 'Reverse Front to Back');
    },
    enabled: hasBlend,
  },
]);

// ---------------------------------------------------------------------------
// Live update: regenerate steps when a source changed (folded into the same undo step)
// ---------------------------------------------------------------------------

const seen = new WeakMap<Node, true>();

function sourcesChanged(doc: EditorState['doc'], gid: ID): boolean {
  const spec = blendSpec(doc.nodes[gid]);
  if (!spec) return false;
  for (const id of spec.sources) {
    const n = doc.nodes[id];
    if (!n) return true;
    if (!seen.has(n)) return true;
  }
  return false;
}

function markSeen(doc: EditorState['doc'], gid: ID): void {
  const spec = blendSpec(doc.nodes[gid]);
  if (!spec) return;
  for (const id of spec.sources) {
    const n = doc.nodes[id];
    if (n) seen.set(n, true);
  }
}

let updating = false;

useStore.subscribe(
  (s) => s.historyBase,
  (base) => {
    if (updating) return;
    const groups = Object.values(base.nodes).filter((n) => isBlendGroup(n)).map((n) => n.id);
    if (!groups.length) return;
    const stale = groups.filter((g) => sourcesChanged(base, g));
    if (!stale.length) return;
    const s = getState();
    if (s.doc !== base) return; // a gesture is in progress; wait for its commit
    updating = true;
    try {
      s.updateDoc((d) => {
        for (const g of stale) regenerateBlend(d, g);
      });
      // fold into the step that changed the sources
      const st = getState();
      setState({ historyBase: st.doc });
      for (const g of stale) markSeen(st.doc, g);
      for (const g of groups) markSeen(st.doc, g);
    } finally {
      updating = false;
    }
  },
);

// mark sources of freshly created blends as seen
useStore.subscribe(
  (s) => s.doc,
  (doc) => {
    for (const n of Object.values(doc.nodes)) if (isBlendGroup(n)) markSeen(doc, n.id);
  },
);

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function BlendOptionsDialog({ close }: { close: () => void }) {
  const s = getState();
  const groups = targetGroups(s);
  const existing = groups.length ? blendSpec(s.doc.nodes[groups[0]]) : null;
  const [spacing, setSpacing] = useState<BlendSpacing>(existing?.spacing ?? lastOptions.spacing);
  const [steps, setSteps] = useState(existing?.steps ?? lastOptions.steps);
  const [distance, setDistance] = useState(existing?.distance ?? lastOptions.distance);
  const apply = (opts: Partial<Omit<BlendSpec, 'sources'>>) => {
    if (groups.length) {
      getState().updateDoc((d) => {
        for (const g of groups) setBlendOptions(d, g, opts);
      });
    }
  };
  const ok = () => {
    lastOptions = { ...lastOptions, spacing, steps, distance };
    if (groups.length) {
      apply({ spacing, steps, distance });
      getState().commit('Blend Options');
    } else makeBlendCommand({ spacing, steps, distance });
    close();
  };
  const cancel = () => {
    if (groups.length) getState().revert();
    close();
  };
  return (
    <DialogFrame
      title="Blend Options"
      onClose={cancel}
      width={380}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button primary onClick={ok} data-testid="blend-ok">
            OK
          </Button>
        </>
      }
    >
      <Row gap={8}>
        <span className="field-label">Spacing</span>
        <Segmented<BlendSpacing>
          value={spacing}
          options={[
            { value: 'steps', label: 'Specified Steps' },
            { value: 'distance', label: 'Specified Distance' },
            { value: 'smooth', label: 'Smooth Color' },
          ]}
          onChange={(v) => {
            setSpacing(v);
            apply({ spacing: v, steps, distance });
          }}
        />
      </Row>
      {spacing === 'steps' && (
        <NumberField
          label="Steps"
          value={steps}
          onChange={(v) => {
            const n = Math.max(1, Math.min(1000, Math.round(v)));
            setSteps(n);
            apply({ spacing, steps: n, distance });
          }}
          min={1}
          max={1000}
          width={140}
          data-testid="blend-steps"
        />
      )}
      {spacing === 'distance' && (
        <NumberField
          label="Distance"
          value={distance}
          onChange={(v) => {
            const d = Math.max(0.5, v);
            setDistance(d);
            apply({ spacing, steps, distance: d });
          }}
          min={0.5}
          unit={s.prefs.units}
          width={140}
          data-testid="blend-distance"
        />
      )}
      <div className="dim small">{groups.length ? 'Changes preview live; Cancel restores the previous blend.' : 'The blend is created between the selected paths in stacking order.'}</div>
    </DialogFrame>
  );
}

registerDialog('blendOptions', ({ close }) => <BlendOptionsDialog close={close} />);

void when;
void React;
