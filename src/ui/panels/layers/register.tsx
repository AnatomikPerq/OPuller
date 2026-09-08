import { registerPanel } from '@/ui/panels/registry';
import { LayersPanel } from './LayersPanel';

registerPanel({ id: 'layers', title: 'Layers', component: LayersPanel, order: 10, defaultVisible: true, shortcut: 'f7', minHeight: 200 });
