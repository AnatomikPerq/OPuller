import { registerPanel } from '@/ui/panels/registry';
import { StrokePanel } from './StrokePanel';

registerPanel({ id: 'stroke', title: 'Stroke', component: StrokePanel, order: 33, defaultVisible: true, shortcut: 'mod+f10' });
