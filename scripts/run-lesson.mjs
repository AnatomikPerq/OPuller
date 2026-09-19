/**
 * Build one of the Illustrator lessons (tests/e2e/lessons/lessons.ts) in the open editor tab
 * and render the artboard, for iterating on a builder without running the Playwright spec:
 *
 *   node scripts/run-lesson.mjs landscape [out.png] [--scale 0.5] [--keep]
 *
 * The builder is transpiled with Vite's TypeScript transform and executed through the MCP
 * server (opuller_eval), so it runs exactly the code the spec ships into the page. Without
 * --keep the document is replaced by a new 800×600 one first (like the spec does).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { transformWithOxc } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--scale');
const name = positional[0];
if (!name) {
  console.error('usage: node scripts/run-lesson.mjs <lesson> [out.png] [--scale 0.5] [--keep]');
  process.exit(2);
}
const out = positional[1] ?? path.join(ROOT, 'test-results', `lesson-${name}.png`);
const scaleIdx = args.indexOf('--scale');
const scale = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : 0.5;

/** The builder's JavaScript source: `export function buildX` / `export async function buildX` of lessons.ts. */
async function builderSource(lesson) {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'lessons', 'lessons.ts'), 'utf8');
  const { code } = await transformWithOxc(src, 'lessons.ts', { lang: 'ts', target: 'es2022' });
  const table = code.match(/const LESSONS = \{([^}]*)\}/);
  const entry = table && new RegExp(`\\b${lesson}: (\\w+)`).exec(table[1]);
  if (!entry) throw new Error(`No lesson "${lesson}" in LESSONS (${table ? table[1].trim() : '?'})`);
  const fnName = entry[1];
  const start = code.indexOf(`function ${fnName}()`);
  const from = code.lastIndexOf('\n', start) + 1;
  const end = code.indexOf('\n}\n', start) + 2;
  return code.slice(from, end).replace(/^export /, '');
}

const fn = await builderSource(name);
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp', 'server.ts')], stderr: 'pipe' });
const client = new Client({ name: 'opuller-run-lesson', version: '0.1.0' });
await client.connect(transport);
const call = async (tool, a = {}) => {
  const r = await client.callTool({ name: tool, arguments: a });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${tool}: ${text}`);
  return text;
};
try {
  if (!args.includes('--keep')) {
    await call('opuller_new_document', { name, width: 800, height: 600 });
    await call('opuller_projects', { op: 'home', open: false });
  }
  const t0 = Date.now();
  const nodes = await call('opuller_eval', { code: `await (${fn})(); return Object.keys(getState().doc.nodes).length;` });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await call('opuller_render_png', { scope: 'artboard', scale, file: out });
  console.log(`${name}: ${nodes.trim()} nodes in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${out}`);
} finally {
  await client.close();
}
process.exit();
