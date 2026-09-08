/**
 * Bleed editor (top/right/bottom/left with a link toggle) shared by the New
 * Document and Document Setup dialogs.
 */
import React, { useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import type { Bleed, Units } from '@/model/types';
import { NumberField, IconButton, Row } from '@/ui/widgets';

export function BleedFields({ value, onChange, units, testIdPrefix = 'bleed' }: { value: Bleed; onChange: (b: Bleed) => void; units: Units; testIdPrefix?: string }) {
  const [linked, setLinked] = useState(value.top === value.right && value.top === value.bottom && value.top === value.left);
  const set = (k: keyof Bleed, v: number) => {
    const val = Math.max(0, v);
    if (linked) onChange({ top: val, right: val, bottom: val, left: val });
    else onChange({ ...value, [k]: val });
  };
  return (
    <Row gap={6} wrap>
      <NumberField label="Top" value={value.top} unit={units} min={0} max={1000} onChange={(v) => set('top', v)} width={104} data-testid={`${testIdPrefix}-top`} />
      <NumberField label="Bottom" value={value.bottom} unit={units} min={0} max={1000} onChange={(v) => set('bottom', v)} width={104} data-testid={`${testIdPrefix}-bottom`} />
      <NumberField label="Left" value={value.left} unit={units} min={0} max={1000} onChange={(v) => set('left', v)} width={104} data-testid={`${testIdPrefix}-left`} />
      <NumberField label="Right" value={value.right} unit={units} min={0} max={1000} onChange={(v) => set('right', v)} width={104} data-testid={`${testIdPrefix}-right`} />
      <IconButton icon={linked ? <Link2 size={13} /> : <Link2Off size={13} />} active={linked} title={linked ? 'Bleed values are linked' : 'Edit bleed values independently'} onClick={() => setLinked(!linked)} data-testid={`${testIdPrefix}-link`} />
    </Row>
  );
}

void React;
