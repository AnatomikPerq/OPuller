/**
 * Character panel: font family / style / size / leading / tracking / baseline
 * shift / case / decorations. Applies to the selected range while editing, to
 * the selected text objects, or to the defaults for new text.
 */
import React from 'react';
import { ChevronDown, Underline, Strikethrough } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { NumberField, Row, Select, Segmented, Checkbox, IconButton, PopoverButton } from '@/ui/widgets';
import { weightsFor, faceLabel, useFontRegistry } from '@/text/fonts';
import { useTextStyleInfo, applyTextStyle, MIXED, num } from '@/tools/text/textStyle';
import { nearestFacePatch } from '@/tools/text/TextOptions';
import { FontFamilyPicker } from './FontFamilyPicker';
import './character.css';

const SIZE_PRESETS = [6, 8, 9, 10, 11, 12, 14, 18, 21, 24, 36, 48, 60, 72, 96, 144];
const AUTO_LEADING = 1.2;

export function CharacterPanel() {
  const info = useTextStyleInfo();
  useFontRegistry();
  const editingTextId = useStore((s) => s.editingTextId);
  const v = info.values;
  const commit = (label: string) => getState().commit(label);

  const family = typeof v.fontFamily === 'string' ? v.fontFamily : '';
  const faces = weightsFor(family || 'Inter');
  const faceValue = typeof v.fontWeight === 'number' && typeof v.fontStyle === 'string' ? `${v.fontWeight}|${v.fontStyle}` : '';
  const faceOptions = faces.map((f) => ({ value: `${f.weight}|${f.style}`, label: f.label }));
  if (faceValue && !faceOptions.some((o) => o.value === faceValue)) faceOptions.push({ value: faceValue, label: faceLabel(v.fontWeight as number, v.fontStyle as 'normal' | 'italic') });

  const size = num(v.fontSize);
  const lineHeight = num(v.lineHeight);
  const leadingPx = size !== null && lineHeight !== null ? Math.round(size * lineHeight * 100) / 100 : null;
  const leadingMixed = v.fontSize === MIXED || v.lineHeight === MIXED;
  const autoLeading = lineHeight !== null && Math.abs(lineHeight - AUTO_LEADING) < 1e-6;

  const targetLabel =
    info.target === 'range' ? 'Selected text' : info.target === 'caret' ? (editingTextId ? 'Insertion point' : '') : info.target === 'nodes' ? (info.ids.length === 1 ? '1 text object' : `${info.ids.length} text objects`) : 'Defaults for new text';

  return (
    <div className="character-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="character-panel">
      <Row>
        <FontFamilyPicker value={family} mixed={v.fontFamily === MIXED} onChange={(f) => applyTextStyle({ fontFamily: f, ...nearestFacePatch(f, v) })} />
      </Row>
      <Row>
        <Select
          value={faceValue}
          mixed={!faceValue}
          options={faceOptions}
          title="Font style"
          id="character-face"
          onChange={(val) => {
            const [w, st] = val.split('|');
            applyTextStyle({ fontWeight: Number(w), fontStyle: st as 'normal' | 'italic' });
          }}
        />
      </Row>
      <div className="grid-2">
        <Row gap={2}>
          <NumberField
            label={<span title="Font size">Size</span>}
            value={size}
            mixed={v.fontSize === MIXED}
            min={1}
            max={2000}
            step={1}
            unit="px"
            onChange={(n) => applyTextStyle({ fontSize: n }, false)}
            onCommit={() => commit('Font size')}
            data-testid="character-size"
            title="Font size (Ctrl+Shift+. / Ctrl+Shift+,)"
          />
          <PopoverButton
            width={150}
            placement="bottom-end"
            button={({ toggle, ref }) => (
              <button ref={ref} type="button" className="icon-btn" style={{ width: 18 }} onClick={toggle} title="Size presets">
                <ChevronDown size={12} />
              </button>
            )}
          >
            {(close) => (
              <div className="size-presets">
                {SIZE_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={size === p ? 'active' : ''}
                    onClick={() => {
                      applyTextStyle({ fontSize: p });
                      close();
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </PopoverButton>
        </Row>
        <NumberField
          label={<span title="Tracking (letter spacing)">Tracking</span>}
          value={num(v.letterSpacing)}
          mixed={v.letterSpacing === MIXED}
          step={0.5}
          decimals={2}
          unit="px"
          onChange={(n) => applyTextStyle({ letterSpacing: n }, false)}
          onCommit={() => commit('Tracking')}
          data-testid="character-tracking"
          title="Tracking — extra space after each character"
        />
      </div>
      <Row gap={8}>
        <NumberField
          label={<span title="Leading (line height)">Leading</span>}
          value={autoLeading ? null : leadingPx}
          mixed={leadingMixed}
          placeholder={autoLeading ? 'Auto' : undefined}
          min={0}
          step={1}
          unit="px"
          width={150}
          disabled={size === null}
          onChange={(px) => size && applyTextStyle({ lineHeight: px / size }, false)}
          onCommit={() => commit('Leading')}
          data-testid="character-leading"
          title="Leading — distance between baselines (Auto = 120%)"
        />
        <Checkbox checked={autoLeading} onChange={(a) => applyTextStyle({ lineHeight: a ? AUTO_LEADING : (lineHeight ?? AUTO_LEADING) })} label="Auto" title="Auto leading (120% of the font size)" />
      </Row>
      <Row gap={8}>
        <NumberField
          label={<span title="Baseline shift">Baseline</span>}
          value={num(v.baselineShift)}
          mixed={v.baselineShift === MIXED}
          step={1}
          decimals={2}
          unit="px"
          width={150}
          onChange={(n) => applyTextStyle({ baselineShift: n }, false)}
          onCommit={() => commit('Baseline shift')}
          data-testid="character-baseline"
          title="Baseline shift — positive values raise the text"
        />
        <span className="char-decor">
          <IconButton icon={<Underline size={15} />} active={v.textDecoration === 'underline'} title="Underline (Ctrl+Shift+U)" onClick={() => applyTextStyle({ textDecoration: v.textDecoration === 'underline' ? 'none' : 'underline' })} data-testid="character-underline" />
          <IconButton icon={<Strikethrough size={15} />} active={v.textDecoration === 'line-through'} title="Strikethrough" onClick={() => applyTextStyle({ textDecoration: v.textDecoration === 'line-through' ? 'none' : 'line-through' })} data-testid="character-strike" />
        </span>
      </Row>
      <Row gap={8}>
        <Segmented
          value={typeof v.textTransform === 'string' ? v.textTransform : null}
          onChange={(t) => applyTextStyle({ textTransform: t })}
          title="Text case"
          options={[
            { value: 'none', label: '–', title: 'As typed' },
            { value: 'uppercase', label: 'AA', title: 'All caps' },
            { value: 'lowercase', label: 'aa', title: 'Lowercase' },
            { value: 'capitalize', label: 'Aa', title: 'Capitalize words' },
          ]}
        />
      </Row>
      {targetLabel && <div className="char-target">{targetLabel}</div>}
    </div>
  );
}

void React;
