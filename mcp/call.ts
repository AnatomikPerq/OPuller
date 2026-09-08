/**
 * Command-line helper: call one OPuller MCP tool and print the result.
 *
 *   node mcp/call.ts opuller_status
 *   node mcp/call.ts opuller_render_png '{"scope":"artboard","scale":0.5,"file":"out/artboard.png"}'
 *   node mcp/call.ts opuller_create_shape '{"kind":"circle","cx":300,"cy":300,"r":100,"fill":"#1da1f2"}'
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , name, json] = process.argv;
if (!name) {
  console.error('usage: node mcp/call.ts <tool> [json-args]');
  process.exit(2);
}
const args = json ? JSON.parse(json) : {};
const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'server.ts')], stderr: 'pipe' });
const client = new Client({ name: 'opuller-call', version: '0.1.0' });
await client.connect(transport);
try {
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content as any[]) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') console.log(`[image ${c.mimeType}, ${Math.round((c.data.length * 3) / 4 / 1024)} KB]`);
  }
  if (r.isError) process.exitCode = 1;
} finally {
  await client.close();
}
process.exit();
