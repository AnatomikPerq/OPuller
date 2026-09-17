/**
 * Regenerates the keyboard-shortcut tables of public/guide/index.html from the live
 * editor's registries (tools, commands, panels) so the guide never drifts from the app.
 * Needs the dev server (npm run dev) — or set OPULLER_URL. Run: node scripts/gen-shortcuts.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const URL = process.env.OPULLER_URL ?? 'http://127.0.0.1:5180/';
const FILE = 'public/guide/index.html';
const START = '<!-- shortcuts:start -->';
const END = '<!-- shortcuts:end -->';
const MENU_ORDER = ['File', 'Edit', 'Object', 'Type', 'Select', 'Effect', 'View', 'Window', 'Help'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(URL);
await page.waitForFunction(() => !!window.__opuller?.allCommands && window.__opuller.allCommands().length > 50);
const data = await page.evaluate(() => {
  const o = window.__opuller;
  const keys = (sc) => (Array.isArray(sc) ? sc : [sc]).map((k) => o.shortcutLabel(k));
  return {
    tools: o
      .allTools()
      .filter((t) => t.shortcut)
      .map((t) => ({ name: t.name, keys: keys(t.shortcut) })),
    commands: o
      .allCommands()
      .filter((c) => c.shortcut)
      .map((c) => ({ id: c.id, label: c.label, menu: c.menu ?? '', hidden: !!c.hidden, order: c.order ?? 0, keys: keys(c.shortcut) })),
    panels: o
      .allPanels()
      .filter((p) => p.shortcut)
      .map((p) => ({ title: p.title, keys: keys(p.shortcut) })),
  };
});
await browser.close();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kbd = (label) =>
  label
    .split('+')
    .map((k) => `<kbd>${esc(k)}</kbd>`)
    .join('+');
const keysCell = (keys) => keys.map(kbd).join(' <span class="muted">or</span> ');
const row = (name, keys) => `            <tr><td>${esc(name)}</td><td class="keys">${keysCell(keys)}</td></tr>`;
const table = (id, title, rows) =>
  `      <h3 id="${id}">${esc(title)}</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Action</th><th>Shortcut</th></tr></thead>
          <tbody>
${rows.join('\n')}
          </tbody>
        </table>
      </div>`;

const sections = [];
sections.push(table('shortcuts-tools', 'Tools', data.tools.map((t) => row(t.name, t.keys))));

const byMenu = new Map();
const other = [];
for (const c of data.commands) {
  const top = c.menu.split('/')[0];
  if (c.hidden || !top) {
    other.push(c);
    continue;
  }
  if (!byMenu.has(top)) byMenu.set(top, []);
  byMenu.get(top).push(c);
}
const menus = [...MENU_ORDER.filter((m) => byMenu.has(m)), ...[...byMenu.keys()].filter((m) => !MENU_ORDER.includes(m))];
for (const top of menus) {
  const list = byMenu.get(top).sort((a, b) => a.order - b.order);
  const rows = list.map((c) => {
    const sub = c.menu.split('/').slice(1).join(' › ');
    return row(sub ? `${sub} › ${c.label}` : c.label, c.keys);
  });
  if (top === 'Window') rows.push(...data.panels.map((p) => row(`${p.title} panel`, p.keys)));
  sections.push(table(`shortcuts-${top.toLowerCase()}`, `${top} menu`, rows));
}
if (other.length) sections.push(table('shortcuts-other', 'Other keys', other.map((c) => row(c.label, c.keys))));

const html = fs.readFileSync(FILE, 'utf8');
const a = html.indexOf(START);
const b = html.indexOf(END);
if (a < 0 || b < 0) throw new Error(`${FILE}: markers ${START} / ${END} not found`);
const out = `${html.slice(0, a + START.length)}\n${sections.join('\n\n')}\n      ${html.slice(b)}`;
fs.writeFileSync(FILE, out);
const total = data.tools.length + data.commands.length + data.panels.length;
console.log(`wrote ${FILE}: ${total} shortcuts (${data.tools.length} tools, ${data.commands.length} commands, ${data.panels.length} panels)`);
