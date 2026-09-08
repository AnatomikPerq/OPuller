import { registerPanel } from '@/ui/panels/registry';
import { ColorPanel } from './ColorPanel';

registerPanel({ id: 'color', title: 'Color', component: ColorPanel, order: 30, defaultVisible: true, shortcut: 'f6' });
