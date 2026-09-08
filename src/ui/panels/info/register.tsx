import { registerPanel } from '@/ui/panels/registry';
import { InfoPanel } from './InfoPanel';

registerPanel({ id: 'info', title: 'Info', component: InfoPanel, order: 14, defaultVisible: false, shortcut: 'mod+f8' });
