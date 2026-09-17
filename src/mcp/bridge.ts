/**
 * AI bridge: WebSocket client(s) that connect the running editor to the local OPuller MCP
 * server(s) (`npm run mcp`). A server forwards tool calls as
 * `{type:'request', id, method, params}` and receives `{type:'response', id, result | error}`.
 *
 * Port discovery: every MCP server binds the first free port of 5187–5197 and records it in a
 * registry the dev server exposes at `/__opuller/bridge-ports`. The page polls that endpoint
 * and keeps one socket per live server (two AI sessions can drive the same tab). Without the
 * endpoint (a built copy behind nginx) it falls back to the default port, plus any ports
 * given as `?bridgePort=5188` / `?bridgePort=5187,5188` in the URL.
 */
import { create } from 'zustand';
import { mcpApi } from './api';

export const DEFAULT_BRIDGE_PORT = 5187;
export const BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
const PORTS_ENDPOINT = '/__opuller/bridge-ports';
/** Poll cadence for the registry: fast while nothing is connected, relaxed once it is. */
const POLL_IDLE = 2000;
const POLL_CONNECTED = 5000;

export interface BridgeState {
  enabled: boolean;
  connected: boolean;
  /** ports with an open connection */
  ports: number[];
  /** number of requests served in this session */
  requests: number;
  lastMethod: string | null;
  lastError: string | null;
  setEnabled: (v: boolean) => void;
}

const PERSIST = 'opuller.mcpBridge';

export const useBridgeStore = create<BridgeState>((set) => ({
  enabled: (() => {
    try {
      const v = localStorage.getItem(PERSIST);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  })(),
  connected: false,
  ports: [],
  requests: 0,
  lastMethod: null,
  lastError: null,
  setEnabled: (v) => {
    try {
      localStorage.setItem(PERSIST, v ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ enabled: v });
    if (v) connect();
    else disconnect();
  },
}));

/** port → socket (connecting or open) */
const sockets = new Map<number, WebSocket>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
/** null until the first poll; false = no registry (built copy), true = dev server answers */
let registryAvailable: boolean | null = null;
/** fallback backoff for the default port when there is no registry */
let fallbackDelay = 1000;

const sessionId = Math.random().toString(36).slice(2, 10);

function sessionInfo() {
  return { id: sessionId, title: document.title, url: location.href, userAgent: navigator.userAgent };
}

function publish(): void {
  const open = [...sockets.entries()].filter(([, ws]) => ws.readyState === WebSocket.OPEN).map(([p]) => p);
  useBridgeStore.setState({ connected: open.length > 0, ports: open.sort((a, b) => a - b) });
}

async function handle(msg: any, ws: WebSocket): Promise<void> {
  if (msg.type !== 'request') return;
  const method = String(msg.method);
  const fn = mcpApi[method];
  const reply = (payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', id: msg.id, ...payload }));
  };
  if (!fn) {
    reply({ error: `Unknown method "${method}". Available: ${Object.keys(mcpApi).join(', ')}` });
    return;
  }
  useBridgeStore.setState((s) => ({ requests: s.requests + 1, lastMethod: method }));
  try {
    const result = await fn(msg.params ?? {});
    reply({ result: result === undefined ? null : result });
  } catch (err: any) {
    const message = String(err?.message ?? err);
    useBridgeStore.setState({ lastError: message });
    reply({ error: message });
  }
}

/** Ports named in the page URL (`?bridgePort=5188` or `5187,5188`). */
function urlPorts(): number[] {
  try {
    const raw = new URLSearchParams(location.search).get('bridgePort');
    if (!raw) return [];
    return raw
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  } catch {
    return [];
  }
}

/**
 * Which ports to connect to right now. With a registry: exactly the live servers (no
 * connection attempts to dead ports, so no console noise). Without: the default port.
 */
async function discoverPorts(): Promise<number[]> {
  const ports = new Set<number>(urlPorts());
  try {
    const res = await fetch(PORTS_ENDPOINT, { cache: 'no-store' });
    const ct = res.headers.get('content-type') ?? '';
    if (res.ok && ct.includes('application/json')) {
      const j = await res.json();
      if (Array.isArray(j?.ports)) {
        registryAvailable = true;
        for (const p of j.ports) if (Number.isInteger(p)) ports.add(p);
        return [...ports];
      }
    }
  } catch {
    /* no dev server endpoint */
  }
  registryAvailable = false;
  ports.add(DEFAULT_BRIDGE_PORT);
  return [...ports];
}

function openSocket(port: number): void {
  const existing = sockets.get(port);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    return;
  }
  sockets.set(port, ws);
  ws.onopen = () => {
    fallbackDelay = 1000;
    useBridgeStore.setState({ lastError: null });
    ws.send(JSON.stringify({ type: 'hello', session: sessionInfo(), methods: Object.keys(mcpApi) }));
    publish();
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    void handle(msg, ws);
  };
  ws.onclose = () => {
    if (sockets.get(port) === ws) sockets.delete(port);
    publish();
    if (!stopped) schedulePoll();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

/** One discovery round: connect to every live port, drop sockets to ports no longer listed. */
async function poll(): Promise<void> {
  if (stopped || !useBridgeStore.getState().enabled) return;
  const ports = await discoverPorts();
  if (stopped) return;
  for (const p of ports) openSocket(p);
  schedulePoll();
}

function schedulePoll(): void {
  if (stopped || pollTimer) return;
  let delay: number;
  if (registryAvailable === false) {
    // no registry: retry the default port with the old exponential backoff (a missing
    // server must not spam the console with failed connections)
    const anyOpen = [...sockets.values()].some((ws) => ws.readyState === WebSocket.OPEN);
    delay = anyOpen ? POLL_CONNECTED * 6 : fallbackDelay;
    if (!anyOpen) fallbackDelay = Math.min(45000, fallbackDelay * 2);
  } else {
    delay = useBridgeStore.getState().connected ? POLL_CONNECTED : POLL_IDLE;
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void poll();
  }, delay);
}

export function connect(): void {
  stopped = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  void poll();
}

export function disconnect(): void {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  for (const ws of sockets.values()) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
  publish();
}

export function startBridge(): void {
  if (useBridgeStore.getState().enabled) connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && useBridgeStore.getState().enabled && !useBridgeStore.getState().connected) connect();
  });
}
