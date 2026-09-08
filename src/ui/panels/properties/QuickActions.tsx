/**
 * Quick action buttons: commands that exist in the registry (guarded with
 * getCommand) plus align-to-artboard buttons implemented here.
 */
import React from 'react';
import {
  Group,
  Ungroup,
  Focus,
  Crop,
  Type,
  Combine,
  SquareMinus,
  SquareDot,
  Diff,
  Lock,
  EyeOff,
  ChevronsUp,
  ChevronsDown,
  ArrowUp,
  ArrowDown,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  Layers,
} from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { getCommand, isEnabled, runCommand } from '@/commands/registry';
import { IconButton, PopoverButton } from '@/ui/widgets';
import { shortcutLabel } from '@/util/keys';
import { alignToArtboard, ALIGN_TITLES, editTargets, type AlignKind } from './edit';

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const ACTIONS: Action[] = [
  { id: 'object.group', label: 'Group', icon: <Group size={13} /> },
  { id: 'object.ungroup', label: 'Ungroup', icon: <Ungroup size={13} /> },
  { id: 'object.isolate', label: 'Isolate', icon: <Focus size={13} /> },
  { id: 'object.clipMake', label: 'Clip Mask', icon: <Crop size={13} /> },
  { id: 'type.createOutlines', label: 'Outlines', icon: <Type size={13} /> },
  { id: 'pathfinder.unite', label: 'Unite', icon: <Combine size={13} /> },
  { id: 'pathfinder.minusFront', label: 'Minus Front', icon: <SquareMinus size={13} /> },
  { id: 'pathfinder.intersect', label: 'Intersect', icon: <SquareDot size={13} /> },
  { id: 'pathfinder.exclude', label: 'Exclude', icon: <Diff size={13} /> },
  { id: 'layer.collectInNewLayer', label: 'To New Layer', icon: <Layers size={13} /> },
  { id: 'object.lock', label: 'Lock', icon: <Lock size={13} /> },
  { id: 'object.hide', label: 'Hide', icon: <EyeOff size={13} /> },
];

const ARRANGE: Action[] = [
  { id: 'object.bringToFront', label: 'Bring to Front', icon: <ChevronsUp size={13} /> },
  { id: 'object.bringForward', label: 'Bring Forward', icon: <ArrowUp size={13} /> },
  { id: 'object.sendBackward', label: 'Send Backward', icon: <ArrowDown size={13} /> },
  { id: 'object.sendToBack', label: 'Send to Back', icon: <ChevronsDown size={13} /> },
];

const ALIGN: Array<{ kind: AlignKind; icon: React.ReactNode }> = [
  { kind: 'left', icon: <AlignStartVertical size={14} /> },
  { kind: 'hcenter', icon: <AlignCenterVertical size={14} /> },
  { kind: 'right', icon: <AlignEndVertical size={14} /> },
  { kind: 'top', icon: <AlignStartHorizontal size={14} /> },
  { kind: 'vcenter', icon: <AlignCenterHorizontal size={14} /> },
  { kind: 'bottom', icon: <AlignEndHorizontal size={14} /> },
];

function title(id: string, label: string): string {
  const c = getCommand(id);
  const sc = Array.isArray(c?.shortcut) ? c?.shortcut[0] : c?.shortcut;
  return sc ? `${c?.label ?? label} (${shortcutLabel(sc)})` : (c?.label ?? label);
}

export function QuickActions() {
  useStore((s) => s.selection);
  useStore((s) => s.docVersion);
  useStore((s) => s.isolationId);
  const s = getState();
  const targets = editTargets(s);
  const arrange = ARRANGE.filter((a) => getCommand(a.id));
  return (
    <>
      <div className="pp-align-row">
        <span className="pp-align-label">Artboard</span>
        {ALIGN.map((a) => (
          <IconButton key={a.kind} icon={a.icon} title={ALIGN_TITLES[a.kind]} disabled={!targets.length} onClick={() => alignToArtboard(a.kind)} data-testid={`pp-align-${a.kind}`} size={14} />
        ))}
      </div>
      <div className="pp-actions">
        {ACTIONS.filter((a) => getCommand(a.id)).map((a) => {
          const c = getCommand(a.id)!;
          return (
            <button key={a.id} type="button" className="pp-action" disabled={!isEnabled(c, s)} onClick={() => runCommand(a.id)} title={title(a.id, a.label)} data-testid={`pp-action-${a.id}`}>
              {a.icon}
              {a.label}
            </button>
          );
        })}
        {arrange.length > 0 && (
          <PopoverButton
            className="fx-menu"
            button={({ toggle, ref }) => (
              <button ref={ref} type="button" className="pp-action" onClick={toggle} disabled={!s.selection.length} title="Arrange">
                <ChevronsUp size={13} />
                Arrange
              </button>
            )}
          >
            {(close) =>
              arrange.map((a) => {
                const c = getCommand(a.id)!;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className="fx-menu-item"
                    disabled={!isEnabled(c, getState())}
                    onClick={() => {
                      close();
                      runCommand(a.id);
                    }}
                  >
                    {a.icon}
                    {c.label}
                    <span className="dim small" style={{ marginLeft: 'auto' }}>
                      {shortcutLabel(Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut)}
                    </span>
                  </button>
                );
              })
            }
          </PopoverButton>
        )}
      </div>
    </>
  );
}
