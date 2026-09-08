/**
 * System clipboard integration:
 *  - copying a selection also writes it as SVG (text/plain + image/svg+xml)
 *  - pasting brings in images, SVG markup, project JSON or plain text from
 *    other applications
 */
import { getState } from '@/store/store';
import type { ID, Vec } from '@/model/types';
import { setExternalCopyHandler, hasClipboard, pasteClipboard } from '@/commands/core';
import { registerCommand, getCommand } from '@/commands/registry';
import { isEditing } from '@/tools/text/session';
import { isEditableTarget } from '@/util/keys';
import { exportSvg } from './svgExport';
import { looksLikeSvg } from './svgImport';
import { isProjectJson, parseProject } from './project';
import { placeSvgText, placeImageBlob, placeText, placeFiles, viewCenter, placeItems } from './fileOps';
import { makeGroup } from '@/model/nodes';
import type { Node } from '@/model/types';

/** SVG text of the last selection copied by OPuller (to recognise our own clipboard content). */
let lastCopiedText: string | null = null;
export const MAX_PASTED_TEXT = 5000;

export function lastCopiedSvg(): string | null {
  return lastCopiedText;
}

/** Selection → SVG markup (used for copy and "Copy SVG"). */
export function selectionSvg(ids = getState().selection): string | null {
  const s = getState();
  if (!ids.length) return null;
  try {
    return exportSvg(s.doc, { scope: 'selection', ids, precision: 3, xmlDeclaration: false }).svg;
  } catch {
    return null;
  }
}

export async function writeTextToClipboard(text: string, mime: string | null = null): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  if (mime && typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), [mime]: new Blob([text], { type: mime }) });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      /* fall back to plain text */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Write the selection as SVG to the system clipboard (best effort). */
export function copySelectionToSystemClipboard(ids: ID[]): void {
  const svg = selectionSvg(ids);
  if (!svg) return;
  lastCopiedText = svg;
  void writeTextToClipboard(svg, 'image/svg+xml');
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export interface PasteTarget {
  /** world position for the pasted content (default: view centre) */
  at?: Vec;
  /** when true, text equal to our last copy is left to the internal clipboard */
  preferInternal?: boolean;
}

function extractSvg(html: string): string | null {
  const m = html.match(/<svg[\s\S]*<\/svg>/i);
  return m ? m[0] : null;
}

function placeProjectJson(text: string, at: Vec): ID[] {
  const doc = parseProject(text);
  const items = doc.layers.map((lid) => {
    const layer = doc.nodes[lid];
    const g = makeGroup([], { name: layer.name });
    const nodes: Node[] = [g];
    if (layer.type === 'layer') {
      const collect = (n: Node) => {
        nodes.push(n);
        if (n.type === 'group') for (const c of n.children) collect(doc.nodes[c]);
      };
      for (const cid of layer.children) {
        doc.nodes[cid].parent = g.id;
        g.children.push(cid);
        collect(doc.nodes[cid]);
      }
    }
    return { root: g, nodes };
  });
  return placeItems(items, { at, fit: false, label: 'Paste', name: doc.name });
}

/** Paste text content (SVG / project JSON / plain text). Returns true when something was placed. */
export function pasteTextContent(text: string, target: PasteTarget = {}): boolean {
  const t = text.trim();
  if (!t) return false;
  const at = target.at ?? viewCenter();
  if (target.preferInternal && lastCopiedText && t === lastCopiedText.trim() && hasClipboard()) return false;
  if (looksLikeSvg(t)) {
    placeSvgText(t, { at, fit: true, label: 'Paste', name: 'Pasted SVG' });
    return true;
  }
  if (isProjectJson(t)) {
    placeProjectJson(t, at);
    return true;
  }
  if (target.preferInternal && hasClipboard()) return false;
  if (t.length > MAX_PASTED_TEXT) {
    getState().toast('The pasted text is too long for a text object.', 'info');
    return false;
  }
  placeText(text.trim(), { at, label: 'Paste' });
  return true;
}

/** Handle a DataTransfer from a paste or drop event. */
export async function handleDataTransfer(dt: DataTransfer | null, target: PasteTarget = {}): Promise<boolean> {
  if (!dt) return false;
  const at = target.at ?? viewCenter();
  const files = Array.from(dt.files ?? []);
  const items = Array.from(dt.items ?? []);
  // image / svg files (screenshots, copied images)
  const fileList = files.length ? files : items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
  if (fileList.length) {
    const ids = await placeFiles(fileList, { at, label: 'Paste' });
    return ids.length > 0;
  }
  const svg = dt.getData('image/svg+xml');
  if (svg && looksLikeSvg(svg)) return pasteTextContent(svg, { ...target, at });
  const text = dt.getData('text/plain');
  if (text && pasteTextContent(text, { ...target, at })) return true;
  const html = dt.getData('text/html');
  if (html) {
    const inline = extractSvg(html);
    if (inline) return pasteTextContent(inline, { ...target, at });
  }
  return false;
}

/** Read the async clipboard (navigator.clipboard.read) and paste its content. */
export async function pasteFromSystemClipboard(target: PasteTarget = {}): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  const at = target.at ?? viewCenter();
  let items: ClipboardItem[] = [];
  try {
    if (navigator.clipboard.read) items = await navigator.clipboard.read();
  } catch {
    items = [];
  }
  if (!items.length) {
    try {
      const text = await navigator.clipboard.readText();
      return text ? pasteTextContent(text, { ...target, at }) : false;
    } catch {
      return false;
    }
  }
  for (const item of items) {
    const types = item.types;
    const image = types.find((t) => t.startsWith('image/') && t !== 'image/svg+xml');
    if (types.includes('image/svg+xml')) {
      try {
        const text = await (await item.getType('image/svg+xml')).text();
        if (looksLikeSvg(text) && pasteTextContent(text, { ...target, at })) return true;
      } catch {
        /* ignore */
      }
    }
    if (image) {
      try {
        const blob = await item.getType(image);
        const ids = await placeImageBlob(blob, { at, label: 'Paste', name: 'Pasted Image' });
        if (ids.length) return true;
      } catch {
        /* ignore */
      }
    }
    if (types.includes('text/plain')) {
      try {
        const text = await (await item.getType('text/plain')).text();
        if (pasteTextContent(text, { ...target, at })) return true;
      } catch {
        /* ignore */
      }
    }
    if (types.includes('text/html')) {
      try {
        const html = await (await item.getType('text/html')).text();
        const inline = extractSvg(html);
        if (inline && pasteTextContent(inline, { ...target, at })) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * Smart paste used by Edit › Paste: prefers newer external clipboard content
 * (images, SVG from other apps), otherwise pastes the internal clipboard.
 */
export async function smartPaste(): Promise<void> {
  const internal = hasClipboard();
  const handled = await pasteFromSystemClipboard({ preferInternal: internal });
  if (handled) return;
  if (internal) pasteClipboard();
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export function installClipboard(): () => void {
  setExternalCopyHandler(copySelectionToSystemClipboard);
  const onPaste = (e: ClipboardEvent) => {
    if (isEditing()) return; // the text editor handles its own paste
    const t = e.target as HTMLElement | null;
    if (t && isEditableTarget(t) && !t.closest?.('[data-testid="viewport"]')) return;
    if (getState().dialog) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const hasFiles = dt.files?.length > 0 || Array.from(dt.items ?? []).some((i) => i.kind === 'file');
    const text = dt.getData('text/plain');
    const svg = dt.getData('image/svg+xml');
    const html = dt.getData('text/html');
    if (!hasFiles && !text && !svg && !html) return;
    e.preventDefault();
    void handleDataTransfer(dt, { preferInternal: true }).then((handled) => {
      if (!handled && hasClipboard()) pasteClipboard();
    });
  };
  document.addEventListener('paste', onPaste);
  // Edit › Paste: system clipboard aware (the core command only pastes the internal clipboard)
  const core = getCommand('edit.paste');
  if (core) registerCommand({ ...core, run: () => smartPaste(), enabled: () => true });
  return () => {
    document.removeEventListener('paste', onPaste);
    setExternalCopyHandler(null);
    if (core) registerCommand(core);
  };
}
