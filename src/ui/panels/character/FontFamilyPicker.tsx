/**
 * Font family picker: a button showing the current family (rendered in that
 * font) opening a searchable list where every family is previewed in its own
 * face. Includes uploaded fonts, bundled fonts, common system fonts, any family
 * used in the document, free-form family names and an "Upload font…" entry.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Upload, Check } from 'lucide-react';
import { Popover } from '@/ui/widgets';
import { useStore, getState } from '@/store/store';
import { listFamilies, useFontRegistry, sameFamily, type FontFamilyDef, type FontCategory } from '@/text/fonts';
import './character.css';

const CATEGORY_LABEL: Record<FontCategory, string> = {
  uploaded: 'Uploaded',
  'sans-serif': 'Sans serif',
  serif: 'Serif',
  display: 'Display',
  handwriting: 'Handwriting',
  monospace: 'Monospace',
  system: 'System',
};

const CATEGORY_ORDER: FontCategory[] = ['uploaded', 'sans-serif', 'serif', 'display', 'handwriting', 'monospace', 'system'];

export interface FontFamilyPickerProps {
  value: string;
  mixed?: boolean;
  onChange: (family: string) => void;
  width?: number | string;
  compact?: boolean;
  title?: string;
  disabled?: boolean;
}

/** Families used by text objects in the document (so they always appear in the list). */
function useDocumentFamilies(): string[] {
  const docVersion = useStore((s) => s.docVersion);
  return useMemo(() => {
    const out = new Set<string>();
    for (const n of Object.values(getState().doc.nodes)) {
      if (n.type !== 'text') continue;
      out.add(n.style.fontFamily);
      for (const r of n.runs ?? []) if (r.style?.fontFamily) out.add(r.style.fontFamily);
    }
    return Array.from(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion]);
}

export function FontFamilyPicker({ value, mixed, onChange, width, compact, title, disabled }: FontFamilyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFontRegistry();
  const docFamilies = useDocumentFamilies();

  const families = useMemo(() => listFamilies(docFamilies), [docFamilies, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => (q ? families.filter((f) => f.family.toLowerCase().includes(q)) : families), [families, q]);
  const customEntry = q && !families.some((f) => sameFamily(f.family, query.trim())) ? query.trim() : null;

  // flat list of selectable entries (grouped by category)
  const entries = useMemo(() => {
    const out: Array<{ kind: 'family'; def: FontFamilyDef } | { kind: 'custom'; family: string } | { kind: 'upload' }> = [];
    for (const cat of CATEGORY_ORDER) for (const f of filtered) if (f.category === cat) out.push({ kind: 'family', def: f });
    if (customEntry) out.push({ kind: 'custom', family: customEntry });
    out.push({ kind: 'upload' });
    return out;
  }, [filtered, customEntry]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const idx = families.findIndex((f) => sameFamily(f.family, value));
    setActive(Math.max(0, idx));
    setTimeout(() => inputRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (i: number) => {
    const e = entries[i];
    if (!e) return;
    if (e.kind === 'upload') {
      setOpen(false);
      getState().openDialog('fontUpload', { applyToSelection: true });
      return;
    }
    onChange(e.kind === 'family' ? e.def.family : e.family);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      setActive((a) => Math.min(entries.length - 1, a + 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setActive((a) => Math.max(0, a - 1));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      choose(active);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      setOpen(false);
      e.preventDefault();
    }
    e.stopPropagation();
  };

  let lastCat: FontCategory | null = null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`font-picker-btn ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''}`}
        style={{ width, fontFamily: mixed || !value ? undefined : `"${value}", sans-serif` }}
        onClick={() => !disabled && setOpen(!open)}
        title={title ?? 'Font family'}
        data-testid="font-family-picker"
        disabled={disabled}
      >
        <span className="font-picker-name">{mixed ? '—' : value || 'Font'}</span>
        <ChevronDown size={12} className="font-picker-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btnRef.current} className="font-picker-popover" width={280}>
        <input
          ref={inputRef}
          className="font-picker-search"
          type="text"
          placeholder="Search fonts or type a family name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          data-testid="font-family-search"
        />
        <div className="font-picker-list" ref={listRef} data-testid="font-family-list">
          {entries.map((e, i) => {
            if (e.kind === 'upload') {
              return (
                <button key="upload" type="button" data-index={i} className={`font-picker-item upload ${i === active ? 'active' : ''}`} onClick={() => choose(i)} onMouseEnter={() => setActive(i)}>
                  <Upload size={13} />
                  <span>Upload font…</span>
                </button>
              );
            }
            if (e.kind === 'custom') {
              return (
                <button key="custom" type="button" data-index={i} className={`font-picker-item ${i === active ? 'active' : ''}`} onClick={() => choose(i)} onMouseEnter={() => setActive(i)} style={{ fontFamily: `"${e.family}", sans-serif` }}>
                  <span className="font-picker-item-name">Use “{e.family}”</span>
                  <span className="font-picker-item-cat">system</span>
                </button>
              );
            }
            const header = e.def.category !== lastCat ? <div className="font-picker-group">{CATEGORY_LABEL[e.def.category]}</div> : null;
            lastCat = e.def.category;
            const selected = !mixed && sameFamily(e.def.family, value);
            return (
              <React.Fragment key={e.def.family + e.def.source}>
                {header}
                <button
                  type="button"
                  data-index={i}
                  data-family={e.def.family}
                  className={`font-picker-item ${i === active ? 'active' : ''} ${selected ? 'selected' : ''}`}
                  onClick={() => choose(i)}
                  onMouseEnter={() => setActive(i)}
                  title={e.def.outlines ? e.def.family : `${e.def.family} — outlines not available (system font)`}
                >
                  <span className="font-picker-item-name" style={{ fontFamily: `"${e.def.family}", sans-serif` }}>
                    {e.def.family}
                  </span>
                  {selected && <Check size={12} className="font-picker-check" />}
                </button>
              </React.Fragment>
            );
          })}
          {!entries.length && <div className="empty-hint">No fonts</div>}
        </div>
      </Popover>
    </>
  );
}
