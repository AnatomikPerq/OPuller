/**
 * Drag & drop of files onto the viewport: shows the drop-zone hint while files
 * are dragged over the canvas and places images / SVG / .opuller files at the
 * drop point.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { getState, screenToWorld } from '@/store/store';
import { placeFiles } from './fileOps';
import { handleDataTransfer } from './clipboard';

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types ?? []);
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('image/svg+xml');
}

function viewportEl(): HTMLElement | null {
  return document.querySelector('[data-testid="viewport"]');
}

function worldAt(e: DragEvent): { x: number; y: number } | undefined {
  const el = viewportEl();
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return undefined;
  return screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
}

export function DropOverlay() {
  const [over, setOver] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const arm = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOver(false), 250);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const inside = !!worldAt(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = inside ? 'copy' : 'none';
      setOver(inside);
      arm();
    };
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (timer.current) window.clearTimeout(timer.current);
      setOver(false);
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const at = worldAt(e);
      if (!at) return;
      const dt = e.dataTransfer!;
      const files = Array.from(dt.files ?? []);
      if (files.length) {
        void placeFiles(files, { at, label: 'Place' });
        return;
      }
      void handleDataTransfer(dt, { at }).then((handled) => {
        if (!handled) getState().toast('Nothing to place from the dropped content.', 'info');
      });
    };
    const onDragEnd = () => setOver(false);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragEnd);
    window.addEventListener('blur', onDragEnd);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('blur', onDragEnd);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="dropzone-hint io-dropzone" data-viewport-html data-testid="dropzone-hint">
      <div className="io-dropzone-card">
        <Download size={22} />
        <span>Drop to place</span>
        <span className="io-dropzone-sub">Images, SVG or .opuller files</span>
      </div>
    </div>
  );
}
