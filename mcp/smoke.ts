/**
 * Smoke test for the OPuller MCP server: spawns the server over stdio, waits for
 * the editor tab to connect, then calls a few tools.
 *
 *   node mcp/smoke.ts            (the editor must be open at http://localhost:5180)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'server.ts')], stderr: 'inherit' });
const client = new Client({ name: 'opuller-smoke', version: '0.1.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);

async function callText(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await client.callTool({ name, arguments: args });
  const c = (r.content as any[])[0];
  if (r.isError) throw new Error(`${name}: ${c?.text}`);
  if (c?.type === 'text') {
    try {
      return JSON.parse(c.text);
    } catch {
      return c.text;
    }
  }
  return c;
}

const status = await callText('opuller_status');
console.log('document:', status.document.name, 'artboards:', status.document.artboards.length, 'tool:', status.activeTool);

const circle = await callText('opuller_create_shape', { kind: 'circle', cx: 300, cy: 300, r: 120, fill: '#1da1f2', stroke: 'none', name: 'smoke-circle' });
console.log('created', circle.id, circle.bounds);
const cutter = await callText('opuller_create_shape', { kind: 'circle', cx: 380, cy: 260, r: 110, fill: '#ff0000', stroke: 'none', name: 'smoke-cutter' });
const pf = await callText('opuller_pathfinder', { op: 'minusFront', ids: [circle.id, cutter.id] });
console.log('pathfinder ->', pf.selection);
const shot = await client.callTool({ name: 'opuller_render_png', arguments: { scope: 'selection', scale: 0.5 } });
const img = (shot.content as any[]).find((c) => c.type === 'image');
console.log('image bytes:', img ? Math.round((img.data.length * 3) / 4) : 0, (shot.content as any[]).find((c) => c.type === 'text')?.text);
await callText('opuller_undo', { steps: 3 });
const after = await callText('opuller_status');
console.log('after undo, nodes:', after.document.nodeCount, 'undo depth:', after.history.undo);
await client.close();
process.exit(0);
