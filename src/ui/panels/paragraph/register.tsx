import { registerPanel } from '@/ui/panels/registry';
import { ParagraphPanel } from './ParagraphPanel';

registerPanel({ id: 'paragraph', title: 'Paragraph', component: ParagraphPanel, order: 41, defaultVisible: true, shortcut: 'mod+alt+t' });
