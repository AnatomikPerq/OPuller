/**
 * Font embedding for export: collects the font faces used by the text nodes of
 * a document and produces `@font-face` CSS with data-URL sources so that the
 * SVG renders identically when loaded into an <img> (rasterisation) or opened
 * elsewhere. Bundled @fontsource fonts are discovered through the page's
 * CSSFontFaceRules; uploaded fonts come from the font registry.
 */
import type { Document, TextNode, TextStyle } from '@/model/types';
import { uploadedFonts, sameFamily, parseUnicodeRange, inRanges } from '@/text/fonts';

export interface UsedFace {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** characters rendered with this face (for subset selection) */
  text: string;
}

interface CssFace {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  urls: Array<{ url: string; format: string }>;
  ranges: Array<[number, number]> | null;
  cssText: string;
}

/** All font faces referenced by text nodes (base style and run overrides). */
export function usedFaces(doc: Document, ids?: string[]): UsedFace[] {
  const map = new Map<string, UsedFace>();
  const add = (st: TextStyle, text: string) => {
    const style = st.fontStyle === 'italic' ? 'italic' : 'normal';
    const key = `${st.fontFamily.toLowerCase()}|${st.fontWeight}|${style}`;
    const cur = map.get(key);
    if (cur) cur.text += text;
    else map.set(key, { family: st.fontFamily, weight: st.fontWeight, style, text });
  };
  const nodes = ids ? ids.map((id) => doc.nodes[id]).filter(Boolean) : Object.values(doc.nodes);
  for (const n of nodes) {
    if (!n || n.type !== 'text') continue;
    const t = n as TextNode;
    add(t.style, t.text);
    for (const r of t.runs ?? []) {
      if (!r.style) continue;
      add({ ...t.style, ...r.style }, r.text);
    }
  }
  return Array.from(map.values());
}

function parseSrc(src: string): Array<{ url: string; format: string }> {
  const out: Array<{ url: string; format: string }> = [];
  const re = /url\((["']?)(.*?)\1\)(?:\s*format\((["']?)(.*?)\3\))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let format = (m[4] ?? '').toLowerCase();
    if (!format) format = m[2].split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    out.push({ url: m[2], format });
  }
  return out;
}

function scanCssFaces(): CssFace[] {
  if (typeof document === 'undefined') return [];
  const faces: CssFace[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (typeof CSSFontFaceRule === 'undefined' || !(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const family = st.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
      if (!family) continue;
      const weight = parseInt(st.getPropertyValue('font-weight'), 10) || 400;
      const style = /italic|oblique/i.test(st.getPropertyValue('font-style')) ? 'italic' : 'normal';
      faces.push({ family, weight, style, urls: parseSrc(st.getPropertyValue('src')), ranges: parseUnicodeRange(st.getPropertyValue('unicode-range')), cssText: rule.cssText });
    }
  }
  return faces;
}

const dataUrlCache = new Map<string, Promise<string | null>>();

function fetchAsDataUrl(url: string): Promise<string | null> {
  let p = dataUrlCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(
        (blob) =>
          new Promise<string | null>((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
          }),
      )
      .catch(() => null);
    dataUrlCache.set(url, p);
  }
  return p;
}

function arrayBufferToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return `data:${mime};base64,${btoa(bin)}`;
}

function closestWeight(available: number[], weight: number): number {
  let best = available[0];
  for (const w of available) if (Math.abs(w - weight) < Math.abs(best - weight) || (Math.abs(w - weight) === Math.abs(best - weight) && w > best)) best = w;
  return best;
}

function mimeFor(format: string): string {
  switch (format) {
    case 'woff2':
      return 'font/woff2';
    case 'woff':
      return 'font/woff';
    case 'truetype':
    case 'ttf':
      return 'font/ttf';
    case 'opentype':
    case 'otf':
      return 'font/otf';
    default:
      return 'application/octet-stream';
  }
}

export interface EmbedResult {
  css: string;
  /** families that could not be embedded (system fonts) */
  missing: string[];
}

/**
 * Build @font-face CSS (data URLs) for the faces used in the document. Only
 * subsets that cover the characters actually used are included.
 */
export async function fontFaceCss(doc: Document, ids?: string[]): Promise<EmbedResult> {
  const used = usedFaces(doc, ids);
  if (!used.length) return { css: '', missing: [] };
  const cssFaces = scanCssFaces();
  const uploaded = uploadedFonts();
  const rules: string[] = [];
  const missing = new Set<string>();
  const done = new Set<string>();
  for (const face of used) {
    const cps = Array.from(new Set(Array.from(face.text).map((c) => c.codePointAt(0) ?? 0))).filter((cp) => cp > 32);
    // uploaded fonts first
    const ups = uploaded.filter((u) => sameFamily(u.family, face.family));
    if (ups.length) {
      const sameStyle = ups.filter((u) => u.style === face.style);
      const pool = sameStyle.length ? sameStyle : ups;
      const w = closestWeight(pool.map((u) => u.weight), face.weight);
      for (const u of pool.filter((u) => u.weight === w)) {
        const key = `up:${u.id}`;
        if (done.has(key)) continue;
        done.add(key);
        const ext = u.fileName.split('.').pop()?.toLowerCase() ?? 'ttf';
        const fmt = ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'otf' ? 'opentype' : 'truetype';
        rules.push(`@font-face{font-family:"${u.family}";font-weight:${u.weight};font-style:${u.style};src:url(${arrayBufferToDataUrl(u.data, mimeFor(fmt))}) format("${fmt}")}`);
      }
      continue;
    }
    const fam = cssFaces.filter((f) => sameFamily(f.family, face.family));
    if (!fam.length) {
      missing.add(face.family);
      continue;
    }
    const sameStyle = fam.filter((f) => f.style === face.style);
    const pool = sameStyle.length ? sameStyle : fam;
    const w = closestWeight(Array.from(new Set(pool.map((f) => f.weight))), face.weight);
    const chosen = pool.filter((f) => f.weight === w);
    for (const f of chosen) {
      // skip subsets that cover none of the used characters
      if (f.ranges && cps.length && !cps.some((cp) => inRanges(f.ranges, cp))) continue;
      const src = f.urls.find((u) => u.format === 'woff2') ?? f.urls.find((u) => u.format === 'woff') ?? f.urls[0];
      if (!src) continue;
      const key = `css:${src.url}`;
      if (done.has(key)) continue;
      done.add(key);
      const abs = new URL(src.url, typeof location !== 'undefined' ? location.href : 'http://localhost/').href;
      const data = await fetchAsDataUrl(abs);
      if (!data) continue;
      const range = f.ranges ? `unicode-range:${f.ranges.map(([a, b]) => (a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`)).join(',')};` : '';
      rules.push(`@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:${f.style};${range}src:url(${data}) format("${src.format || 'woff2'}")}`);
    }
  }
  return { css: rules.join('\n'), missing: Array.from(missing) };
}

/** Wait for the browser's font loading to settle (best effort). */
export async function fontsReady(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
  } catch {
    /* ignore */
  }
}
