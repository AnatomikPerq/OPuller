import { registerPanel } from '@/ui/panels/registry';
import { EffectsPanel } from './EffectsPanel';

registerPanel({ id: 'effects', title: 'Effects', component: EffectsPanel, order: 43, defaultVisible: true });
