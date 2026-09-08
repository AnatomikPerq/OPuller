/**
 * Shared UI widgets: number fields with scrubbing & expressions, selects,
 * buttons, popovers, tooltips, sliders, segmented controls, panel sections.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { parseLength, formatNumber, pxToUnit, UNIT_LABELS } from '@/util/units';
import type { Units } from '@/model/types';

// ---------------------------------------------------------------------------
// NumberField
// ---------------------------------------------------------------------------

export interface NumberFieldProps {
  value: number | null | undefined;
  onChange: (v: number) => void;
  /** called on drag end / enter (for history commits) */
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** step with shift */
  bigStep?: number;
  decimals?: number;
  /** show/convert a length unit */
  unit?: Units | 'deg' | '%' | 'none' | 'px';
  /** suffix label */
  suffix?: string;
  label?: ReactNode;
  title?: string;
  width?: number | string;
  disabled?: boolean;
  placeholder?: string;
  /** base for percent expressions */
  percentBase?: number;
  className?: string;
  /** allow scrubbing by dragging the label */
  scrub?: boolean;
  /** mixed values in multi-selection */
  mixed?: boolean;
  id?: string;
  'data-testid'?: string;
}

export function NumberField(props: NumberFieldProps) {
  const { value, onChange, onCommit, min = -Infinity, max = Infinity, step = 1, bigStep, decimals, unit = 'none', label, title, width, disabled, mixed, suffix } = props;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isLength = unit !== 'none' && unit !== 'deg' && unit !== '%';
  const dec = decimals ?? (unit === 'deg' ? 1 : isLength && unit !== 'px' ? 2 : 2);

  const display = useCallback(
    (v: number | null | undefined) => {
      if (mixed) return '';
      if (v === null || v === undefined || !Number.isFinite(v)) return '';
      if (isLength) return formatNumber(pxToUnit(v, unit as Units), dec);
      return formatNumber(v, dec);
    },
    [mixed, isLength, unit, dec],
  );

  useEffect(() => {
    if (!editing) setText(display(value));
  }, [value, editing, display]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commitText = (t: string, viaEnter: boolean) => {
    let v: number | null;
    if (isLength) v = parseLength(t, unit as Units, props.percentBase);
    else {
      const raw = t.replace(/[°%]/g, '');
      v = parseLength(raw, 'px', props.percentBase);
    }
    if (v !== null && Number.isFinite(v)) {
      const c = clamp(v);
      // unchanged value (e.g. blur without edits): do not emit, avoids phantom undo steps
      const unchanged = !mixed && value !== null && value !== undefined && Math.abs(c - value) < 1e-9;
      if (!unchanged) {
        onChange(c);
        onCommit?.(c);
      }
      setText(display(c));
    } else setText(display(value));
    if (viaEnter) inputRef.current?.blur();
  };

  const nudge = (dir: number, big: boolean) => {
    const base = value ?? 0;
    const s = big ? (bigStep ?? step * 10) : step;
    const c = clamp(+(base + dir * s).toFixed(6));
    onChange(c);
    onCommit?.(c);
    setText(display(c));
  };

  // scrubbing on the label
  const scrubRef = useRef<{ startX: number; startV: number; pointerId: number; moved: boolean } | null>(null);
  const onScrubDown = (e: React.PointerEvent) => {
    if (disabled || props.scrub === false) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubRef.current = { startX: e.clientX, startV: value ?? 0, pointerId: e.pointerId, moved: false };
  };
  const onScrubMove = (e: React.PointerEvent) => {
    const s = scrubRef.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    if (Math.abs(dx) > 2) s.moved = true;
    if (!s.moved) return;
    const mul = e.shiftKey ? (bigStep ?? step * 10) : e.altKey ? step / 10 : step;
    const v = clamp(+(s.startV + dx * mul * (isLength ? 1 : 1)).toFixed(6));
    onChange(v);
    setText(display(v));
  };
  const onScrubUp = () => {
    const s = scrubRef.current;
    scrubRef.current = null;
    if (s?.moved) onCommit?.(value ?? 0);
  };

  const unitLabel = suffix ?? (isLength ? UNIT_LABELS[unit as Units] : unit === 'deg' ? '°' : unit === '%' ? '%' : '');

  return (
    <label className={`field number-field ${props.className ?? ''} ${disabled ? 'disabled' : ''}`} title={title} style={{ width }}>
      {label !== undefined && (
        <span className="field-label scrub" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp}>
          {label}
        </span>
      )}
      <span className="field-input-wrap">
        <input
          ref={inputRef}
          id={props.id}
          data-testid={props['data-testid']}
          type="text"
          inputMode="decimal"
          value={text}
          placeholder={mixed ? '—' : props.placeholder}
          disabled={disabled}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setEditing(false);
            commitText(text, false);
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitText(text, true);
              e.preventDefault();
            } else if (e.key === 'Escape') {
              setText(display(value));
              (e.currentTarget as HTMLInputElement).blur();
              e.preventDefault();
            } else if (e.key === 'ArrowUp') {
              nudge(1, e.shiftKey);
              e.preventDefault();
            } else if (e.key === 'ArrowDown') {
              nudge(-1, e.shiftKey);
              e.preventDefault();
            }
            e.stopPropagation();
          }}
        />
        {unitLabel && <span className="field-unit">{unitLabel}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

export function TextField({ value, onChange, onCommit, label, placeholder, width, disabled, className, mono, id, title }: {
  value: string;
  onChange?: (v: string) => void;
  onCommit?: (v: string) => void;
  label?: ReactNode;
  placeholder?: string;
  width?: number | string;
  disabled?: boolean;
  className?: string;
  mono?: boolean;
  id?: string;
  title?: string;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  return (
    <label className={`field text-field ${className ?? ''} ${disabled ? 'disabled' : ''}`} style={{ width }} title={title}>
      {label !== undefined && <span className="field-label">{label}</span>}
      <span className="field-input-wrap">
        <input
          id={id}
          type="text"
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          style={mono ? { fontFamily: 'var(--font-mono)' } : undefined}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setEditing(false);
            onCommit?.(text);
          }}
          onChange={(e) => {
            setText(e.target.value);
            onChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onCommit?.(text);
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setText(value);
              (e.currentTarget as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
        />
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function Select<T extends string | number = string>({ value, options, onChange, label, width, disabled, title, className, mixed, id }: {
  value: T | null | undefined;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  label?: ReactNode;
  width?: number | string;
  disabled?: boolean;
  title?: string;
  className?: string;
  mixed?: boolean;
  id?: string;
}) {
  const isNumber = typeof options[0]?.value === 'number';
  return (
    <label className={`field select-field ${className ?? ''} ${disabled ? 'disabled' : ''}`} style={{ width }} title={title}>
      {label !== undefined && <span className="field-label">{label}</span>}
      <span className="select-wrap">
        <select
          id={id}
          value={mixed || value === null || value === undefined ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => onChange((isNumber ? Number(e.target.value) : e.target.value) as T)}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {(mixed || value === null || value === undefined) && <option value="">—</option>}
          {options.map((o) => (
            <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
              {typeof o.label === 'string' ? o.label : String(o.value)}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="select-chevron" />
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Checkbox / Toggle
// ---------------------------------------------------------------------------

export function Checkbox({ checked, onChange, label, disabled, title, className, indeterminate }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  indeterminate?: boolean;
}) {
  return (
    <label className={`checkbox ${className ?? ''} ${disabled ? 'disabled' : ''}`} title={title}>
      <span className={`checkbox-box ${checked ? 'checked' : ''} ${indeterminate ? 'indeterminate' : ''}`} onClick={() => !disabled && onChange(!checked)} role="checkbox" aria-checked={checked}>
        {checked && !indeterminate && <Check size={11} strokeWidth={3} />}
        {indeterminate && <span className="dash" />}
      </span>
      {label !== undefined && <span onClick={() => !disabled && onChange(!checked)}>{label}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export function Button({ children, onClick, primary, small, disabled, title, className, type = 'button', danger, style, id, 'data-testid': testId }: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
  style?: CSSProperties;
  id?: string;
  'data-testid'?: string;
}) {
  return (
    <button
      type={type}
      className={`btn ${primary ? 'primary' : ''} ${danger ? 'danger' : ''} ${small ? 'small' : ''} ${className ?? ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={style}
      id={id}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export function IconButton({ icon, onClick, active, disabled, title, className, size = 16, label, style, 'data-testid': testId, onPointerDown }: {
  icon: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  size?: number;
  label?: ReactNode;
  style?: CSSProperties;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'active' : ''} ${className ?? ''}`}
      onClick={onClick}
      onPointerDown={onPointerDown}
      disabled={disabled}
      title={title}
      aria-label={typeof title === 'string' ? title : undefined}
      aria-pressed={active}
      style={{ ...style, ['--icon-size' as any]: `${size}px` }}
      data-testid={testId}
    >
      {icon}
      {label !== undefined && <span className="icon-btn-label">{label}</span>}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, title, className, disabled }: {
  value: T | null | undefined;
  options: Array<{ value: T; label?: ReactNode; icon?: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  title?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`segmented ${className ?? ''} ${disabled ? 'disabled' : ''}`} title={title} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`segment ${value === o.value ? 'active' : ''}`}
          onClick={() => !disabled && onChange(o.value)}
          title={o.title}
          disabled={disabled}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export function Slider({ value, onChange, onCommit, min = 0, max = 100, step = 1, label, width, disabled, unit, decimals, className }: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
  width?: number | string;
  disabled?: boolean;
  unit?: NumberFieldProps['unit'];
  decimals?: number;
  className?: string;
}) {
  return (
    <div className={`slider-field ${className ?? ''} ${disabled ? 'disabled' : ''}`} style={{ width }}>
      {label !== undefined && <span className="field-label">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={() => onCommit?.(value)}
        onKeyUp={() => onCommit?.(value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <NumberField value={value} onChange={onChange} onCommit={onCommit} min={min} max={max} step={step} unit={unit ?? 'none'} decimals={decimals ?? 0} width={unit ? 64 : 52} disabled={disabled} scrub={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Popover / Tooltip
// ---------------------------------------------------------------------------

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  children: ReactNode;
  /** placement preference */
  placement?: 'bottom' | 'top' | 'left' | 'right' | 'bottom-end';
  className?: string;
  width?: number;
  /** close when clicking inside a [data-close-popover] element */
  offset?: number;
}

export function Popover({ open, onClose, anchor, children, placement = 'bottom', className, width, offset = 4 }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current!;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = a.left;
      let top = a.bottom + offset;
      if (placement === 'bottom-end') left = a.right - w;
      if (placement === 'top') top = a.top - h - offset;
      if (placement === 'left') {
        left = a.left - w - offset;
        top = a.top;
      }
      if (placement === 'right') {
        left = a.right + offset;
        top = a.top;
      }
      if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
      if (left < 8) left = 8;
      if (top + h > vh - 8) top = Math.max(8, (placement === 'bottom' || placement === 'bottom-end' ? a.top - h - offset : vh - h - 8));
      if (top < 8) top = 8;
      setPos({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(ref.current);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, anchor, placement, offset]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      if (t.closest?.('.popover')) return; // nested popovers
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className={`popover ${className ?? ''}`} style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, visibility: pos ? 'visible' : 'hidden' }} data-keyboard-scope>
      {children}
    </div>,
    document.body,
  );
}

/** Button that toggles a popover. */
export function PopoverButton({ button, children, className, width, placement, onOpenChange }: {
  button: (props: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
  width?: number;
  placement?: PopoverProps['placement'];
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  return (
    <>
      {button({ open, toggle: () => setOpen(!open), ref })}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} className={className} width={width} placement={placement}>
        {typeof children === 'function' ? children(() => setOpen(false)) : children}
      </Popover>
    </>
  );
}

export function Tooltip({ text, children, shortcut }: { text: ReactNode; shortcut?: string; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const timer = useRef<number | null>(null);
  const enter = () => {
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left + r.width / 2, top: r.bottom + 6 });
      setShow(true);
    }, 500);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setShow(false);
  };
  return (
    <span ref={ref} className="tooltip-anchor" onPointerEnter={enter} onPointerLeave={leave} onPointerDown={leave}>
      {children}
      {show &&
        createPortal(
          <div className="tooltip" style={{ left: pos.left, top: pos.top }}>
            {text}
            {shortcut && <span className="tooltip-shortcut">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function Row({ children, className, gap, align, style, wrap }: { children: ReactNode; className?: string; gap?: number; align?: CSSProperties['alignItems']; style?: CSSProperties; wrap?: boolean }) {
  return (
    <div className={`row ${className ?? ''}`} style={{ gap, alignItems: align, flexWrap: wrap ? 'wrap' : undefined, ...style }}>
      {children}
    </div>
  );
}

export function Section({ title, children, right, collapsible, defaultOpen = true, className }: { title?: ReactNode; children: ReactNode; right?: ReactNode; collapsible?: boolean; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${className ?? ''} ${open ? '' : 'collapsed'}`}>
      {title !== undefined && (
        <div className={`section-title ${collapsible ? 'collapsible' : ''}`} onClick={() => collapsible && setOpen(!open)}>
          {collapsible && <ChevronDown size={12} className={`section-chevron ${open ? '' : 'closed'}`} />}
          <span>{title}</span>
          {right && <span className="section-right" onClick={(e) => e.stopPropagation()}>{right}</span>}
        </div>
      )}
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Divider() {
  return <div className="divider" />;
}

export function Spacer() {
  return <div style={{ flex: 1 }} />;
}

export function Label({ children, htmlFor, className }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label className={`plain-label ${className ?? ''}`} htmlFor={htmlFor}>
      {children}
    </label>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange, className, right }: { value: T; tabs: Array<{ id: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; className?: string; right?: ReactNode }) {
  return (
    <div className={`tabs ${className ?? ''}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)} title={t.title}>
          {t.label}
        </button>
      ))}
      {right && <span className="tabs-right">{right}</span>}
    </div>
  );
}

/** Generates a stable DOM id for label/inputs. */
export function useFieldId(prefix = 'f'): string {
  const id = useId();
  return `${prefix}-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
