/**
 * Layer Options dialog (double-click a layer in the Layers panel).
 */
import React, { useState } from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { useStore, getState } from '@/store/store';
import { Button, Checkbox, Label, TextField, PopoverButton } from '@/ui/widgets';
import { ColorPicker } from '@/ui/ColorPicker';
import { LAYER_COLORS } from '@/model/defaults';
import type { ID } from '@/model/types';
import '@/ui/panels/layers/layers.css';

function LayerOptionsDialog({ props, close }: { props: { id: ID }; close: () => void }) {
  const node = useStore((s) => s.doc.nodes[props.id]);
  const [name, setName] = useState(node?.name ?? '');
  const [color, setColor] = useState(node && node.type === 'layer' ? node.color : LAYER_COLORS[0]);
  const [locked, setLocked] = useState(node?.locked ?? false);
  const [visible, setVisible] = useState(node?.visible ?? true);
  if (!node) {
    return (
      <DialogFrame title="Layer Options" onClose={close}>
        <div className="muted">The layer no longer exists.</div>
      </DialogFrame>
    );
  }
  const isLayer = node.type === 'layer';
  const ok = () => {
    const s = getState();
    s.updateDoc((d) => {
      const n = d.nodes[props.id];
      if (!n) return;
      const clean = name.trim();
      if (clean) n.name = clean;
      n.locked = locked;
      n.visible = visible;
      if (n.type === 'layer') n.color = color;
    }, isLayer ? 'Layer Options' : 'Options');
    close();
  };
  return (
    <DialogFrame
      title={isLayer ? 'Layer Options' : 'Options'}
      onClose={close}
      width={380}
      footer={
        <>
          <Button onClick={close} data-testid="layer-options-cancel">
            Cancel
          </Button>
          <Button primary onClick={ok} data-testid="layer-options-ok">
            OK
          </Button>
        </>
      }
    >
      <form
        className="layer-options-grid"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <Label>Name</Label>
        <TextField value={name} onChange={setName} onCommit={setName} id="layer-options-name" />
        {isLayer && (
          <>
            <Label>Color</Label>
            <div className="layer-options-colors">
              {LAYER_COLORS.map((c) => (
                <button key={c} type="button" className={`lo-color ${c === color ? 'active' : ''}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />
              ))}
              <PopoverButton
                button={({ toggle, ref }) => (
                  <button ref={ref} type="button" className={`lo-color ${LAYER_COLORS.includes(color) ? '' : 'active'}`} style={{ background: LAYER_COLORS.includes(color) ? 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' : color }} title="Custom colour…" onClick={toggle} />
                )}
              >
                <ColorPicker paint={{ type: 'solid', color, opacity: 1 }} onChange={(p) => p.type === 'solid' && setColor(p.color)} allowNone={false} allowGradient={false} showSwatches={false} />
              </PopoverButton>
            </div>
          </>
        )}
        <Label>Options</Label>
        <div style={{ display: 'flex', gap: 14 }}>
          <Checkbox checked={visible} onChange={setVisible} label="Show" />
          <Checkbox checked={locked} onChange={setLocked} label="Lock" />
        </div>
        <button type="submit" hidden />
      </form>
    </DialogFrame>
  );
}

registerDialog<{ id: ID }>('layerOptions', LayerOptionsDialog);

void React;
