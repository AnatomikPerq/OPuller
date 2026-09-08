/**
 * Pathfinder panel: Shape Modes (unite, minus front, intersect, exclude,
 * minus back) and Pathfinders (divide, trim, merge, crop, outline).
 */
import React, { useMemo } from 'react';
import { SquaresUnite, SquaresSubtract, SquaresIntersect, SquaresExclude, Combine } from 'lucide-react';
import { registerPanel } from '@/ui/panels/registry';
import { useStore, getState } from '@/store/store';
import { IconButton, Tooltip, Button } from '@/ui/widgets';
import { runCommand } from '@/commands/registry';
import { shortcutLabel } from '@/util/keys';
import { PATHFINDER_OPS, type PathfinderOp } from '@/pathops/pathfinder';
import { targetCount } from '@/pathops/apply';
import { DivideIcon, TrimIcon, MergeIcon, CropIcon, OutlineIcon, MinusBackIcon } from './icons';
import './pathfinder.css';

const ICONS: Record<PathfinderOp, React.ReactNode> = {
  unite: <SquaresUnite size={15} />,
  minusFront: <SquaresSubtract size={15} />,
  intersect: <SquaresIntersect size={15} />,
  exclude: <SquaresExclude size={15} />,
  minusBack: <MinusBackIcon />,
  divide: <DivideIcon />,
  trim: <TrimIcon />,
  merge: <MergeIcon />,
  crop: <CropIcon />,
  outline: <OutlineIcon />,
};

const SHAPE_MODES: PathfinderOp[] = ['unite', 'minusFront', 'intersect', 'exclude', 'minusBack'];
const PATHFINDERS: PathfinderOp[] = ['divide', 'trim', 'merge', 'crop', 'outline'];

function OpButton({ op, count }: { op: PathfinderOp; count: number }) {
  const def = PATHFINDER_OPS.find((d) => d.op === op)!;
  const disabled = count < def.min;
  return (
    <Tooltip text={`${def.label} — ${def.description}`}>
      <IconButton icon={ICONS[op]} title={def.label} disabled={disabled} onClick={() => runCommand(`pathfinder.${op}`)} data-testid={`pf-${op}`} />
    </Tooltip>
  );
}

export function PathfinderPanel() {
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const count = useMemo(() => targetCount(getState()), [selection, docVersion]);
  const hint = count === 0 ? 'Select paths to combine' : count === 1 ? '1 path selected' : `${count} paths selected`;
  return (
    <div className="pf-panel" data-testid="pathfinder-panel">
      <div className="pf-title">Shape Modes</div>
      <div className="pf-row">
        {SHAPE_MODES.map((op) => (
          <OpButton key={op} op={op} count={count} />
        ))}
      </div>
      <div className="pf-title">Pathfinders</div>
      <div className="pf-row">
        {PATHFINDERS.map((op) => (
          <OpButton key={op} op={op} count={count} />
        ))}
      </div>
      <div className="pf-footer">
        <span data-testid="pf-hint">{hint}</span>
        <Button small onClick={() => getState().setTool('shapebuilder')} title={`Shape Builder Tool (${shortcutLabel('shift+m')})`}>
          <Combine size={13} />
          Shape Builder
        </Button>
      </div>
    </div>
  );
}

registerPanel({ id: 'pathfinder', title: 'Pathfinder', component: PathfinderPanel, order: 22, defaultVisible: true, minHeight: 120 });
