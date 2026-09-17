/**
 * Bridge port registry: every running OPuller MCP server records the WebSocket port it
 * managed to bind (the first free one in BRIDGE_PORTS) in a small JSON file in the OS temp
 * directory. The Vite dev server serves the live entries at `/__opuller/bridge-ports`, so the
 * editor tab connects to every server that is actually running instead of assuming :5187.
 *
 * Pure Node (no MCP / ws imports) so vite.config.ts can use it too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default port and the range a server walks when the default is taken. */
export const DEFAULT_BRIDGE_PORT = 5187;
export const BRIDGE_PORTS: number[] = Array.from({ length: 11 }, (_, i) => DEFAULT_BRIDGE_PORT + i);

export interface BridgeEntry {
  port: number;
  pid: number;
  startedAt: number;
  cwd: string;
}

export function registryPath(): string {
  return path.join(os.tmpdir(), 'opuller-bridge.json');
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = exists but owned by another user; anything else = gone
    return err?.code === 'EPERM';
  }
}

export function readRegistry(): BridgeEntry[] {
  try {
    const raw = fs.readFileSync(registryPath(), 'utf8');
    const j = JSON.parse(raw);
    const list = Array.isArray(j?.servers) ? j.servers : [];
    return list.filter((e: any) => e && Number.isInteger(e.port) && Number.isInteger(e.pid));
  } catch {
    return [];
  }
}

function writeRegistry(entries: BridgeEntry[]): void {
  try {
    fs.writeFileSync(registryPath(), JSON.stringify({ servers: entries }, null, 2));
  } catch {
    /* a missing registry only costs auto-discovery */
  }
}

/** Entries whose process still exists (stale entries are pruned on every read). */
export function liveEntries(): BridgeEntry[] {
  const all = readRegistry();
  const live = all.filter((e) => processAlive(e.pid));
  if (live.length !== all.length) writeRegistry(live);
  return live;
}

/** Ports of the live servers, lowest first. */
export function livePorts(): number[] {
  return [...new Set(liveEntries().map((e) => e.port))].sort((a, b) => a - b);
}

export function registerServer(port: number): void {
  const live = liveEntries().filter((e) => e.pid !== process.pid && e.port !== port);
  live.push({ port, pid: process.pid, startedAt: Date.now(), cwd: process.cwd() });
  writeRegistry(live);
}

export function unregisterServer(): void {
  const rest = readRegistry().filter((e) => e.pid !== process.pid);
  writeRegistry(rest);
}
