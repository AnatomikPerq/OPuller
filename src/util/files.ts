/** File helpers: download, open, File System Access API, images. */

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, fileName: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export interface SaveOptions {
  suggestedName: string;
  mime: string;
  extension: string;
  description?: string;
}

export const hasFSAccess = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/**
 * Save using the File System Access API when available (returns the handle for
 * subsequent silent saves), otherwise triggers a download.
 */
export async function saveFile(blob: Blob, opts: SaveOptions, existing?: FileSystemFileHandle | null): Promise<FileSystemFileHandle | null> {
  if (hasFSAccess) {
    try {
      let handle = existing ?? null;
      if (!handle) {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: opts.suggestedName,
          types: [{ description: opts.description ?? opts.mime, accept: { [opts.mime]: [opts.extension] } }],
        });
      }
      const writable = await handle!.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      // fall through to download
    }
  }
  downloadBlob(blob, opts.suggestedName);
  return null;
}

export interface OpenedFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

/** Open a file via the File System Access API or an <input type=file>. */
export async function openFile(accept: string, multiple = false): Promise<OpenedFile[]> {
  if (hasFSAccess) {
    try {
      const handles: FileSystemFileHandle[] = await (window as any).showOpenFilePicker({ multiple });
      const out: OpenedFile[] = [];
      for (const h of handles) out.push({ file: await h.getFile(), handle: h });
      return out;
    } catch (e: any) {
      if (e?.name === 'AbortError') return [];
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []).map((file) => ({ file, handle: null }));
      document.body.removeChild(input);
      resolve(files);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve([]);
    });
    input.click();
  });
}

export function readAsText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function readAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function extensionOf(name: string): string {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}
