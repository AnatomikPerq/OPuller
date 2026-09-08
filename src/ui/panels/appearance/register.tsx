import { registerPanel } from '@/ui/panels/registry';
import { AppearancePanel } from './AppearancePanel';

registerPanel({ id: 'appearance', title: 'Appearance', component: AppearancePanel, order: 42, defaultVisible: true, shortcut: 'shift+f6' });
