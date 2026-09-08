/**
 * AI bridge: a WebSocket client that connects the running editor to the local
 * OPuller MCP server (`npm run mcp`, ws://127.0.0.1:5187). The server forwards
 * tool calls as `{type:'request', id, method, params}` and receives
 * `{type:'response', id, result | error}`.
 */
import { create } from 'zustand';
import { mcpApi } from './api';

export const BRIDGE_URL = 'ws://127.0.0.1:5187';

export interface BridgeState {
  enabled: boolean;
  connected: boolean;
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

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let stopped = false;

function sessionInfo() {
  return { id: sessionId, title: document.title, url: location.href, userAgent: navigator.userAgent };
}

const sessionId = Math.random().toString(36).slice(2, 10);

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

export function connect(): void {
  stopped = false;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    retryDelay = 1000;
    useBridgeStore.setState({ connected: true, lastError: null });
    ws.send(JSON.stringify({ type: 'hello', session: sessionInfo(), methods: Object.keys(mcpApi) }));
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
    if (socket === ws) socket = null;
    useBridgeStore.setState({ connected: false });
    if (!stopped) scheduleRetry();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function scheduleRetry(): void {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!stopped && useBridgeStore.getState().enabled) connect();
  }, retryDelay);
  // back off quickly to a slow poll so an absent server does not spam the console
  retryDelay = Math.min(45000, retryDelay * 2);
}

export function disconnect(): void {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  useBridgeStore.setState({ connected: false });
}

export function startBridge(): void {
  if (useBridgeStore.getState().enabled) connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && useBridgeStore.getState().enabled && !socket) connect();
  });
}
