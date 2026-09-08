import { registerPanel } from '@/ui/panels/registry';
import { HistoryPanel } from './HistoryPanel';

registerPanel({ id: 'history', title: 'History', component: HistoryPanel, order: 12, defaultVisible: true });
