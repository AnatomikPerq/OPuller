/**
 * Invisible textarea positioned at the caret while editing text. It receives
 * keyboard focus so IME composition, dead keys and the system clipboard work;
 * plain keys are handled by the Type tool's onKeyDown (through the global
 * shortcut dispatcher), composition/paste results arrive here.
 */
import React, { useEffect, useRef } from 'react';
import { useStore, getState } from '@/store/store';
import { applyToPoint } from '@/geometry/matrix';
import { nodeScreenMatrix } from '@/canvas/SelectionOverlay';
import { isEditableTarget } from '@/util/keys';
import { layoutText, caretAt, xAtIndex } from '@/text/layout';
import { pathGlyphPositions } from '@/text/outline';
import { useTextEdit, setInputFocusImpl, insertText, selectedText, hasRangeSelection, deleteForward, isEditing } from './session';

function caretScreen(): { x: number; y: number } | null {
  const st = useTextEdit.getState();
  if (!st.id) return null;
  const s = getState();
  const n = s.doc.nodes[st.id];
  if (!n || n.type !== 'text') return null;
  const m = nodeScreenMatrix(s, n.id);
  if (n.kind === 'path') {
    const placed = pathGlyphPositions(s.doc, n);
    if (!placed) return null;
    const line = placed.layout.lines[0];
    const x = line ? xAtIndex(line, st.caret) : 0;
    const { point } = placed.sampler.at(placed.start + x);
    return applyToPoint(m, point);
  }
  const c = caretAt(layoutText(n), st.caret, n.style);
  return applyToPoint(m, { x: c.x, y: c.y + c.height });
}

export function TextInputProxy() {
  const sessionId = useTextEdit((s) => s.id);
  const caret = useTextEdit((s) => s.caret);
  const editingTextId = useStore((s) => s.editingTextId);
  useStore((s) => s.docVersion);
  useStore((s) => s.zoom);
  useStore((s) => s.pan.x);
  useStore((s) => s.pan.y);
  const size = useStore((s) => s.viewportSize);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    setInputFocusImpl(() => {
      const el = ref.current;
      if (!el) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    });
    return () => setInputFocusImpl(null);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const el = ref.current;
    if (el) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }, [sessionId]);

  // system clipboard: handle copy/cut/paste for the edited text wherever focus is
  useEffect(() => {
    if (!sessionId) return;
    const ours = (e: ClipboardEvent) => {
      if (!isEditing()) return false;
      const t = e.target as HTMLElement | null;
      if (t && t !== ref.current && isEditableTarget(t)) return false;
      return true;
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!ours(e)) return;
      const text = selectedText();
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (!ours(e)) return;
      const text = selectedText();
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
      if (hasRangeSelection()) deleteForward();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e)) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      insertText(text.replace(/\r\n?/g, '\n'));
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [sessionId]);

  if (!sessionId || editingTextId !== sessionId) return null;
  const p = caretScreen() ?? { x: 0, y: 0 };
  void caret;
  const left = Math.max(0, Math.min(size.width - 2, p.x));
  const top = Math.max(0, Math.min(size.height - 2, p.y));
  return (
    <div className="text-input-proxy" data-viewport-html style={{ left, top }}>
      <textarea
        ref={ref}
        aria-label="Text input"
        data-testid="text-input-proxy"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={-1}
        onCompositionStart={() => {
          composing.current = true;
          useTextEdit.setState({ composing: true });
          if (hasRangeSelection()) deleteForward();
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          useTextEdit.setState({ composing: false });
          const data = e.data;
          const el = e.currentTarget;
          el.value = '';
          if (data) insertText(data);
        }}
        onInput={(e) => {
          if (composing.current) return;
          const el = e.currentTarget;
          const v = el.value;
          el.value = '';
          if (v) insertText(v.replace(/\r\n?/g, '\n'));
        }}
      />
    </div>
  );
}
