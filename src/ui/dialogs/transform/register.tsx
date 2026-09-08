import React from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { TransformDialog, type TransformDialogProps, type TransformTab } from './TransformDialog';

const single = (tab: TransformTab) =>
  function SingleTransformDialog({ props, close }: { props: TransformDialogProps; close: () => void }) {
    return <TransformDialog props={{ ...props, tab, tabs: false }} close={close} />;
  };

registerDialog<TransformDialogProps>('transform', ({ props, close }) => <TransformDialog props={{ tabs: true, ...props }} close={close} />);
registerDialog<TransformDialogProps>('transform.move', single('move'));
registerDialog<TransformDialogProps>('transform.rotate', single('rotate'));
registerDialog<TransformDialogProps>('transform.reflect', single('reflect'));
registerDialog<TransformDialogProps>('transform.scale', single('scale'));
registerDialog<TransformDialogProps>('transform.shear', single('shear'));
registerDialog<TransformDialogProps>('transform.each', single('each'));

void React;
