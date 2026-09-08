import { registerPanel } from '@/ui/panels/registry';
import { NavigatorPanel } from './NavigatorPanel';

registerPanel({ id: 'navigator', title: 'Navigator', component: NavigatorPanel, order: 13, defaultVisible: true });
