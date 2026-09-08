import React from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { ExportDialog, type ExportDialogProps } from './ExportDialog';

registerDialog<ExportDialogProps>('export', ExportDialog);

void React;
