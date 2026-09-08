import { registerPanel } from '@/ui/panels/registry';
import { PropertiesPanel } from './PropertiesPanel';

registerPanel({ id: 'properties', title: 'Properties', component: PropertiesPanel, order: 1, defaultVisible: true });
