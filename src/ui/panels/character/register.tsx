import { registerPanel } from '@/ui/panels/registry';
import { CharacterPanel } from './CharacterPanel';

registerPanel({ id: 'character', title: 'Character', component: CharacterPanel, order: 40, defaultVisible: true, shortcut: 'mod+t' });
