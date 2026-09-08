/**
 * AI bridge wiring: connects to the MCP server, exposes the scripting API on
 * `window.__opuller.mcp`, adds Window > AI Bridge commands and a status-bar
 * indicator.
 */
import React from 'react';
import { Bot } from 'lucide-react';
import { registerCommands } from '@/commands/registry';
import { getState } from '@/store/store';
import { registerStatusItem } from '@/ui/statusItems';
import { mcpApi } from './api';
import { useBridgeStore, startBridge, BRIDGE_URL } from './bridge';
import './setupDialog';
import './mcp.css';

const MCP_CONFIG = JSON.stringify({ mcpServers: { opuller: { command: 'node', args: ['mcp/server.ts'] } } }, null, 2);

(window as any).__opuller = { ...((window as any).__opuller ?? {}), mcp: mcpApi, bridge: useBridgeStore };

registerCommands([
  {
    id: 'window.aiBridge',
    label: 'AI Bridge (MCP)',
    menu: 'Window',
    order: 900,
    separatorBefore: true,
    run: () => useBridgeStore.getState().setEnabled(!useBridgeStore.getState().enabled),
    checked: () => useBridgeStore.getState().enabled,
  },
  {
    id: 'help.mcpSetup',
    label: 'Connect an AI (MCP setup)…',
    menu: 'Help',
    order: 30,
    run: () => getState().openDialog('mcpSetup', {}),
  },
  {
    id: 'help.copyMcpConfig',
    label: 'Copy MCP Server Config',
    hidden: true,
    run: async () => {
      try {
        await navigator.clipboard.writeText(MCP_CONFIG);
        getState().toast('MCP config copied', 'success');
      } catch {
        getState().toast('Clipboard access denied', 'error');
      }
    },
  },
]);

function BridgeIndicator() {
  const enabled = useBridgeStore((s) => s.enabled);
  const connected = useBridgeStore((s) => s.connected);
  const requests = useBridgeStore((s) => s.requests);
  const last = useBridgeStore((s) => s.lastMethod);
  if (!enabled) return null;
  return (
    <button
      type="button"
      className={`status-item mcp-indicator ${connected ? 'on' : ''}`}
      title={connected ? `AI connected via MCP (${requests} calls${last ? `, last: ${last}` : ''})` : `AI bridge waiting for the MCP server on ${BRIDGE_URL}. Run "npm run mcp" or connect Claude with the .mcp.json config.`}
      onClick={() => getState().openDialog('mcpSetup', {})}
      data-testid="mcp-indicator"
    >
      <Bot size={12} />
      <span>{connected ? 'AI' : 'AI…'}</span>
    </button>
  );
}

registerStatusItem('mcp', BridgeIndicator);
startBridge();

void React;
export { MCP_CONFIG };
