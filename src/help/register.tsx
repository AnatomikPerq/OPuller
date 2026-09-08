/**
 * Help & preferences: Edit > Preferences, Help menu (Welcome, Keyboard
 * Shortcuts, About, documentation hints) and the start-up Welcome screen.
 */
import React, { useMemo, useState, useEffect } from 'react';
import { FilePlus, FolderOpen, Bot, Sparkles, Clock, Keyboard, BookOpen } from 'lucide-react';
import { useStore, getState, DEFAULT_PREFS, DEFAULT_VIEW, type Preferences } from '@/store/store';
import { registerCommands, allCommands, runCommand, MENU_ORDER } from '@/commands/registry';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, NumberField, Select, Checkbox, Row, Segmented, TextField, Tabs, Kbd } from '@/ui/widgets';
import { allTools } from '@/tools/registry';
import { shortcutLabel } from '@/util/keys';
import { recentEntries, loadRecent, onRecentChanged } from '@/io/recent';
import { loadDocument, confirmDiscard } from '@/io/fileOps';
import { SAMPLES, openSample } from '@/samples/register';
import { TIPS } from '@/home/tips';
import { useHomeStore } from '@/home/store';
import './help.css';

const WELCOME_KEY = 'opuller.welcome.v1';
const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

registerCommands([
  { id: 'edit.preferences', label: 'Preferences…', menu: 'Edit', shortcut: 'mod+k', order: 900, separatorBefore: true, run: () => getState().openDialog('preferences', {}), allowInTextEdit: false },
  { id: 'help.welcome', label: 'Home Screen', menu: 'Help', order: 1, run: () => useHomeStore.getState().setOpen(true, 'home') },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts…', menu: 'Help', shortcut: 'mod+/', order: 2, run: () => getState().openDialog('shortcuts', {}) },
  { id: 'help.tour', label: 'Quick Tips', menu: 'Help', order: 3, run: () => useHomeStore.getState().setOpen(true, 'learn') },
  { id: 'help.about', label: 'About OPuller', menu: 'Help', order: 100, separatorBefore: true, run: () => getState().openDialog('about', {}) },
]);

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

type PrefTab = 'general' | 'display' | 'snapping' | 'files';

function PreferencesDialog({ close }: { close: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const view = useStore((s) => s.view);
  const setPrefs = useStore((s) => s.setPrefs);
  const setView = useStore((s) => s.setView);
  const [tab, setTab] = useState<PrefTab>('general');
  const set = (patch: Partial<Preferences>) => setPrefs(patch);
  return (
    <DialogFrame
      title="Preferences"
      onClose={close}
      width={560}
      className="prefs-dialog"
      footer={
        <>
          <Button
            onClick={() => {
              setPrefs({ ...DEFAULT_PREFS });
              setView({ ...DEFAULT_VIEW });
            }}
            title="Restore the default preferences and view settings"
          >
            Reset to Defaults
          </Button>
          <Button primary onClick={close} data-testid="prefs-close">
            Done
          </Button>
        </>
      }
    >
      <Tabs<PrefTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'display', label: 'Interface' },
          { id: 'snapping', label: 'Snapping & Guides' },
          { id: 'files', label: 'Files & AI' },
        ]}
      />
      {tab === 'general' && (
        <div className="prefs-grid">
          <Select label="Units" value={prefs.units} options={[{ value: 'px', label: 'Pixels' }, { value: 'pt', label: 'Points' }, { value: 'mm', label: 'Millimeters' }, { value: 'cm', label: 'Centimeters' }, { value: 'in', label: 'Inches' }]} onChange={(v) => set({ units: v as Preferences['units'] })} width={200} id="pref-units" />
          <NumberField label="Keyboard increment" value={prefs.nudge} onChange={(v) => set({ nudge: Math.max(0.01, v) })} min={0.01} unit={prefs.units} width={200} title="Arrow-key nudge distance" data-testid="pref-nudge" />
          <NumberField label="Shift increment" value={prefs.bigNudge} onChange={(v) => set({ bigNudge: Math.max(0.01, v) })} min={0.01} unit={prefs.units} width={200} title="Nudge distance with Shift" />
          <NumberField label="Constrain angle" value={prefs.constrainAngle} onChange={(v) => set({ constrainAngle: Math.max(1, Math.min(90, v)) })} min={1} max={90} unit="deg" width={200} title="Angle step used with Shift" />
          <NumberField label="Corner radius" value={prefs.cornerRadius} onChange={(v) => set({ cornerRadius: Math.max(0, v) })} min={0} unit={prefs.units} width={200} title="Default radius for rounded rectangles" />
          <Checkbox checked={prefs.scaleStrokes} onChange={(v) => set({ scaleStrokes: v })} label="Scale strokes & effects when scaling objects" />
          <Checkbox checked={prefs.showTooltips} onChange={(v) => set({ showTooltips: v })} label="Show tool tips" />
        </div>
      )}
      {tab === 'display' && (
        <div className="prefs-grid">
          <Row gap={8}>
            <span className="field-label">Theme</span>
            <Segmented<'dark' | 'light'>
              value={prefs.theme}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(v) => set({ theme: v })}
            />
          </Row>
          <NumberField label="UI scale" value={Math.round(prefs.uiScale * 100)} onChange={(v) => set({ uiScale: Math.max(70, Math.min(160, v)) / 100 })} min={70} max={160} unit="%" width={200} />
          <NumberField label="Anchor / handle size" value={prefs.handleSize} onChange={(v) => set({ handleSize: Math.max(4, Math.min(14, Math.round(v))) })} min={4} max={14} unit="px" width={200} />
          <Row gap={8} align="center">
            <span className="field-label">Canvas colour</span>
            <input type="color" value={prefs.canvasColor} onChange={(e) => set({ canvasColor: e.target.value })} className="prefs-color" title="Colour of the pasteboard around artboards" />
            <Button small onClick={() => set({ canvasColor: DEFAULT_PREFS.canvasColor })}>
              Default
            </Button>
          </Row>
          <Checkbox checked={view.transparencyGrid} onChange={(v) => setView({ transparencyGrid: v })} label="Show transparency grid on transparent artboards" />
          <Checkbox checked={view.showBounds} onChange={(v) => setView({ showBounds: v })} label="Show bounding box of the selection" />
          <Checkbox checked={view.showAnchors} onChange={(v) => setView({ showAnchors: v })} label="Show anchor points of selected paths" />
          <Checkbox checked={view.rulers} onChange={(v) => setView({ rulers: v })} label="Show rulers" />
        </div>
      )}
      {tab === 'snapping' && (
        <div className="prefs-grid">
          <NumberField label="Snap tolerance" value={prefs.snapTolerance} onChange={(v) => set({ snapTolerance: Math.max(1, Math.min(30, v)) })} min={1} max={30} unit="px" width={200} title="Screen distance at which snapping engages" />
          <Checkbox checked={view.snapToPoint} onChange={(v) => setView({ snapToPoint: v })} label="Snap to point (anchors, centres, intersections)" />
          <Checkbox checked={view.smartGuides} onChange={(v) => setView({ smartGuides: v })} label="Smart guides (object edges, artboards)" />
          <Checkbox checked={view.snapToGuides} onChange={(v) => setView({ snapToGuides: v })} label="Snap to guides" />
          <Checkbox checked={view.snapToGrid} onChange={(v) => setView({ snapToGrid: v })} label="Snap to grid" />
          <Checkbox checked={view.snapToPixel} onChange={(v) => setView({ snapToPixel: v })} label="Snap to pixel (align to whole pixels)" />
          <Checkbox checked={view.lockGuides} onChange={(v) => setView({ lockGuides: v })} label="Lock guides" />
        </div>
      )}
      {tab === 'files' && (
        <div className="prefs-grid">
          <Checkbox checked={prefs.autosave} onChange={(v) => set({ autosave: v })} label="Autosave a recovery copy in the browser while editing" />
          <Select label="Language" value={prefs.language} options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский (частично)' }]} onChange={(v) => set({ language: v as Preferences['language'] })} width={200} />
          <div className="dim small">Project files (.opuller) are plain JSON and keep everything, including images. SVG export keeps the drawing editable in other tools.</div>
          <Button small onClick={() => getState().openDialog('mcpSetup', {})}>
            <Bot size={13} /> Connect an AI (MCP)…
          </Button>
        </div>
      )}
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

function ShortcutsDialog({ close }: { close: () => void }) {
  const [filter, setFilter] = useState('');
  const tools = allTools();
  const commands = allCommands().filter((c) => c.shortcut && !c.hidden);
  const q = filter.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const byMenu = useMemo(() => {
    const map = new Map<string, typeof commands>();
    for (const c of commands) {
      const top = (c.menu ?? 'Other').split('/')[0];
      if (!map.has(top)) map.set(top, []);
      map.get(top)!.push(c);
    }
    return Array.from(map.entries()).sort((a, b) => MENU_ORDER.indexOf(a[0]) - MENU_ORDER.indexOf(b[0]));
  }, [commands]);
  const generic: Array<[string, string]> = [
    ['Space + drag', 'Pan the canvas'],
    ['Ctrl + wheel / Alt + wheel', 'Zoom at the cursor'],
    ['Shift + wheel', 'Scroll horizontally'],
    ['Shift while drawing', 'Constrain proportions / angles'],
    ['Alt while drawing', 'Draw from the centre'],
    ['Alt + drag (Selection)', 'Duplicate'],
    ['Ctrl while dragging', 'Disable snapping'],
    ['Double-click a group', 'Isolation mode (Esc exits)'],
    ['Double-click text', 'Edit text'],
    ['Enter (Selection tool)', 'Transform dialog'],
    ['Delete / Backspace', 'Delete selection (or selected anchors)'],
    ['Arrow keys', 'Nudge (Shift = ×10)'],
    ['[ / ]', 'Brush size'],
  ];
  return (
    <DialogFrame
      title="Keyboard Shortcuts"
      onClose={close}
      width={720}
      className="shortcuts-dialog"
      footer={
        <Button primary onClick={close}>
          Close
        </Button>
      }
    >
      <TextField value={filter} onChange={setFilter} placeholder="Filter…" width={260} />
      <div className="shortcuts-columns">
        <div>
          <h4>Tools</h4>
          <table className="shortcut-table">
            <tbody>
              {tools
                .filter((t) => match(t.name) || match(t.shortcut ?? ''))
                .map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.shortcut ? <Kbd>{shortcutLabel(t.shortcut)}</Kbd> : <span className="dim">—</span>}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <h4>Canvas</h4>
          <table className="shortcut-table">
            <tbody>
              {generic
                .filter(([k, v]) => match(k) || match(v))
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{v}</td>
                    <td>
                      <Kbd>{k}</Kbd>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div>
          {byMenu.map(([menu, list]) => {
            const rows = list.filter((c) => match(c.label) || match(menu));
            if (!rows.length) return null;
            return (
              <React.Fragment key={menu}>
                <h4>{menu}</h4>
                <table className="shortcut-table">
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id}>
                        <td>
                          {c.menu && c.menu.includes('/') ? <span className="dim">{c.menu.split('/')[1]} › </span> : null}
                          {c.label}
                        </td>
                        <td>
                          <Kbd>{Array.isArray(c.shortcut) ? c.shortcut.map(shortcutLabel).join(', ') : shortcutLabel(c.shortcut)}</Kbd>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutDialog({ close }: { close: () => void }) {
  const commands = allCommands().length;
  const tools = allTools().length;
  return (
    <DialogFrame
      title="About OPuller"
      onClose={close}
      width={460}
      className="about-dialog"
      footer={
        <Button primary onClick={close}>
          Close
        </Button>
      }
    >
      <div className="about-hero">
        <img src="/favicon.svg" alt="" width={64} height={64} />
        <div>
          <div className="about-name">OPuller</div>
          <div className="muted small">Vector editor for the web · version {VERSION}</div>
        </div>
      </div>
      <p className="small">
        A full-featured vector graphics editor: live shapes, Bézier pens, Pathfinder and Shape Builder, gradients, variable-width strokes, effects, type, blends, artboards, image trace, SVG/PDF/PNG export — and an MCP server so an AI can drive every tool.
      </p>
      <div className="small muted">
        {tools} tools · {commands} commands · React, paper.js, opentype.js, jsPDF, imagetracer. Made with ❤ and a burgundy OP.
      </div>
    </DialogFrame>
  );
}

// ---------------------------------------------------------------------------
// Welcome screen
// ---------------------------------------------------------------------------

type WelcomeTab = 'start' | 'tips';

function WelcomeDialog({ props, close }: { props: { tab?: WelcomeTab }; close: () => void }) {
  const [tab, setTab] = useState<WelcomeTab>(props.tab ?? 'start');
  const [showAtStart, setShowAtStart] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const [recent, setRecent] = useState(recentEntries());
  useEffect(() => onRecentChanged(() => setRecent(recentEntries())), []);
  const toggleStart = (v: boolean) => {
    setShowAtStart(v);
    try {
      localStorage.setItem(WELCOME_KEY, v ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  };
  const openRecent = async (id: string) => {
    if (!(await confirmDiscard('open another document'))) return;
    const doc = await loadRecent(id);
    if (doc) {
      loadDocument(doc, { fileName: recent.find((r) => r.id === id)?.fileName ?? null, remember: true });
      close();
    }
  };
  const tips = TIPS;
  return (
    <DialogFrame
      title="Welcome to OPuller"
      onClose={close}
      width={760}
      className="welcome-dialog"
      footer={
        <>
          <Checkbox checked={showAtStart} onChange={toggleStart} label="Show at startup" />
          <span style={{ flex: 1 }} />
          <Button primary onClick={close}>
            Start drawing
          </Button>
        </>
      }
    >
      <Tabs<WelcomeTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'start', label: 'Start' },
          { id: 'tips', label: 'Quick tips' },
        ]}
      />
      {tab === 'start' && (
        <div className="welcome-grid">
          <div className="welcome-col">
            <h4>Create</h4>
            <button type="button" className="welcome-card" onClick={() => { close(); getState().openDialog('newDocument'); }} data-testid="welcome-new">
              <FilePlus size={18} />
              <span>
                <b>New document…</b>
                <small>Presets for print, web, mobile, social and icons</small>
              </span>
            </button>
            <button type="button" className="welcome-card" onClick={() => { close(); runCommand('file.open'); }}>
              <FolderOpen size={18} />
              <span>
                <b>Open…</b>
                <small>.opuller projects, SVG and images</small>
              </span>
            </button>
            <button type="button" className="welcome-card" onClick={() => { close(); getState().openDialog('mcpSetup', {}); }}>
              <Bot size={18} />
              <span>
                <b>Connect an AI</b>
                <small>Let Claude draw and edit with you (MCP)</small>
              </span>
            </button>
            <button type="button" className="welcome-card" onClick={() => { close(); getState().openDialog('shortcuts', {}); }}>
              <Keyboard size={18} />
              <span>
                <b>Keyboard shortcuts</b>
                <small>Illustrator-compatible where possible</small>
              </span>
            </button>
          </div>
          <div className="welcome-col">
            <h4>
              <Sparkles size={13} /> Samples
            </h4>
            {SAMPLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className="welcome-card"
                data-testid={`welcome-sample-${s.id}`}
                onClick={async () => {
                  if (await openSample(s.id, true)) close();
                }}
              >
                <BookOpen size={18} />
                <span>
                  <b>{s.name}</b>
                  <small>{s.description}</small>
                </span>
              </button>
            ))}
            <h4>
              <Clock size={13} /> Recent
            </h4>
            {recent.length ? (
              recent.slice(0, 6).map((r) => (
                <button key={r.id} type="button" className="welcome-card compact" onClick={() => openRecent(r.id)}>
                  <span>
                    <b>{r.name}</b>
                    <small>{new Date(r.time).toLocaleString()}</small>
                  </span>
                </button>
              ))
            ) : (
              <div className="dim small">No recent documents yet.</div>
            )}
          </div>
        </div>
      )}
      {tab === 'tips' && (
        <div className="welcome-tips">
          {tips.map(([k, v]) => (
            <div key={k} className="tip">
              <b>{k}</b>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </DialogFrame>
  );
}

registerDialog('preferences', ({ close }) => <PreferencesDialog close={close} />);
registerDialog('shortcuts', ({ close }) => <ShortcutsDialog close={close} />);
registerDialog('about', ({ close }) => <AboutDialog close={close} />);
registerDialog<{ tab?: WelcomeTab }>('welcome', WelcomeDialog);
