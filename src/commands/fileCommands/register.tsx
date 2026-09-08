/**
 * File menu: New, Open, Open Recent, Save, Save As, Revert, Place, Export,
 * Export Selection, Copy SVG, Document Setup.
 */
import { getState } from '@/store/store';
import { registerCommand, registerCommands, when } from '@/commands/registry';
import { openFile } from '@/util/files';
import { OPEN_ACCEPT, PLACE_ACCEPT, openFiles, placeFiles, saveDocument, revertDocument, canRevert, confirmDiscard, loadDocument } from '@/io/fileOps';
import { recentEntries, loadRecent, clearRecent, removeRecent, onRecentChanged, MAX_RECENT } from '@/io/recent';
import { selectionSvg, writeTextToClipboard } from '@/io/clipboard';

async function openRecent(id: string): Promise<void> {
  const entry = recentEntries().find((e) => e.id === id);
  if (!entry) return;
  if (!(await confirmDiscard('open another document'))) return;
  const doc = await loadRecent(id);
  if (!doc) {
    getState().toast(`"${entry.name}" is no longer available.`, 'error');
    await removeRecent(id);
    return;
  }
  loadDocument(doc, { fileName: entry.fileName, remember: true });
}

function timeAgo(t: number): string {
  const d = Date.now() - t;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(t).toLocaleDateString();
}

/** Keep one command slot per recent entry (the registry has no unregister; unused slots are hidden). */
function syncRecentCommands(): void {
  const list = recentEntries();
  for (let i = 0; i < MAX_RECENT; i++) {
    const e = list[i];
    registerCommand({
      id: `file.recent.${i}`,
      label: e ? `${e.name}  —  ${timeAgo(e.time)}` : '',
      menu: 'File/Open Recent',
      order: 3 + i / 100,
      hidden: !e,
      run: () => (e ? openRecent(e.id) : undefined),
    });
  }
  registerCommand({ id: 'file.recent.empty', label: 'No recent documents', menu: 'File/Open Recent', order: 3.5, hidden: list.length > 0, enabled: () => false, run: () => undefined });
  registerCommand({ id: 'file.recent.clear', label: 'Clear Menu', menu: 'File/Open Recent', order: 3.6, hidden: !list.length, run: () => clearRecent() });
}

registerCommands([
  {
    id: 'file.new',
    label: 'New…',
    menu: 'File',
    shortcut: 'mod+n',
    order: 1,
    run: async () => {
      if (await confirmDiscard('create a new document')) getState().openDialog('newDocument');
    },
  },
  {
    id: 'file.open',
    label: 'Open…',
    menu: 'File',
    shortcut: 'mod+o',
    order: 2,
    run: async () => {
      if (!(await confirmDiscard('open another document'))) return;
      const files = await openFile(OPEN_ACCEPT, true);
      if (files.length) await openFiles(files);
    },
  },
  { id: 'file.save', label: 'Save', menu: 'File', shortcut: 'mod+s', order: 10, separatorBefore: true, run: () => saveDocument(false), allowInTextEdit: true },
  { id: 'file.saveAs', label: 'Save As…', menu: 'File', shortcut: 'mod+shift+s', order: 11, run: () => saveDocument(true) },
  {
    id: 'file.revert',
    label: 'Revert',
    menu: 'File',
    order: 12,
    run: async () => {
      const s = getState();
      const ok = await new Promise<boolean>((resolve) =>
        s.openDialog('io.unsavedChanges', { action: 'revert to the saved version', name: s.fileName ?? s.doc.name, onChoice: (c: string) => resolve(c === 'discard') }),
      );
      if (!ok) return;
      if (!(await revertDocument())) getState().toast('No saved version to revert to.', 'error');
    },
    enabled: canRevert,
  },
  {
    id: 'file.place',
    label: 'Place…',
    menu: 'File',
    shortcut: 'mod+shift+p',
    order: 20,
    separatorBefore: true,
    run: async () => {
      const files = await openFile(PLACE_ACCEPT, true);
      if (files.length) await placeFiles(files.map((f) => f.file));
    },
  },
  { id: 'file.export', label: 'Export…', menu: 'File', shortcut: 'mod+e', order: 30, separatorBefore: true, run: () => getState().openDialog('export', {}) },
  { id: 'file.exportSelection', label: 'Export Selection…', menu: 'File', shortcut: 'mod+alt+e', order: 31, run: () => getState().openDialog('export', { scope: 'selection' }), enabled: when.hasSelection },
  {
    id: 'file.copySvg',
    label: 'Copy Selection as SVG',
    menu: 'File',
    order: 32,
    run: async () => {
      const svg = selectionSvg();
      if (!svg) return;
      const ok = await writeTextToClipboard(svg, 'image/svg+xml');
      getState().toast(ok ? 'SVG copied to the clipboard' : 'Clipboard access was denied', ok ? 'success' : 'error');
    },
    enabled: when.hasSelection,
  },
  { id: 'file.documentSetup', label: 'Document Setup…', menu: 'File', shortcut: 'mod+alt+p', order: 40, separatorBefore: true, run: () => getState().openDialog('documentSetup', {}) },
]);

syncRecentCommands();
onRecentChanged(syncRecentCommands);
