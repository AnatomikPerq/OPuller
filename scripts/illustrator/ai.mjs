/**
 * Node side of the Illustrator bridge: run ExtendScript in the installed Illustrator
 * (Windows COM automation, see run-jsx.ps1) and get the script's return value back.
 *
 *   import { runJsx } from './ai.mjs';
 *   const version = await runJsx('return app.version;');
 *
 * The code runs inside a function body, so `return` hands a string back; anything else
 * is stringified. ExtendScript is ES3: no JSON, no `const`, no arrow functions.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function runJsx(code, { timeout = 600_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opuller-jsx-'));
  const file = join(dir, 'script.jsx');
  writeFileSync(file, code, 'utf8');
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'run-jsx.ps1'), '-File', file], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error(`Illustrator script timed out after ${timeout} ms`));
    }, timeout);
    ps.on('close', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      const text = out.replace(/\r\n/g, '\n').replace(/\n$/, '');
      if (code !== 0 || text.startsWith('JSX ERROR:')) reject(new Error(text || err || `powershell exited with ${code}`));
      else resolve(text);
    });
  });
}

/** ES3-safe JSON serialiser to prepend to scripts that need to return structured data. */
export const JSX_JSON = String.raw`
function __json(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return '"' + v.split('\\').join('\\\\').split('"').join('\\"').split('\n').join('\\n') + '"';
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(__json(v[i])); return '[' + a.join(',') + ']'; }
  var o = []; for (var k in v) if (v.hasOwnProperty(k)) o.push('"' + k + '":' + __json(v[k])); return '{' + o.join(',') + '}';
}
`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = process.argv.slice(2).join(' ') || 'return app.version;';
  runJsx(code).then((r) => console.log(r), (e) => { console.error(e.message); process.exit(1); });
}
