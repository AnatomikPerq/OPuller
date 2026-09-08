import { registerPanel } from '@/ui/panels/registry';
import { GradientPanel } from './GradientPanel';

registerPanel({ id: 'gradient', title: 'Gradient', component: GradientPanel, order: 32, defaultVisible: true, shortcut: 'mod+f9' });
