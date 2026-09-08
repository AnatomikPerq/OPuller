/**
 * "Connect an AI" dialog: explains how to run the MCP server and connect
 * Claude (or any MCP client) to this editor.
 */
import React from 'react';
import { registerDialog } from '@/ui/dialogs/registry';
import { DialogFrame } from '@/ui/DialogHost';
import { Button, Checkbox, Row } from '@/ui/widgets';
import { getState } from '@/store/store';
import { useBridgeStore, BRIDGE_URL } from './bridge';
import { mcpApi } from './api';

const CONFIG = JSON.stringify({ mcpServers: { opuller: { command: 'node', args: ['mcp/server.ts'] } } }, null, 2);

function McpSetupDialog({ close }: { close: () => void }) {
  const enabled = useBridgeStore((s) => s.enabled);
  const connected = useBridgeStore((s) => s.connected);
  const requests = useBridgeStore((s) => s.requests);
  const setEnabled = useBridgeStore((s) => s.setEnabled);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      getState().toast('Copied', 'success');
    } catch {
      getState().toast('Clipboard access denied', 'error');
    }
  };
  return (
    <DialogFrame
      title="Connect an AI (MCP)"
      onClose={close}
      width={560}
      className="mcp-setup"
      footer={
        <>
          <Button onClick={() => copy(CONFIG)}>Copy .mcp.json</Button>
          <Button primary onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <Row gap={10} align="center">
        <Checkbox checked={enabled} onChange={setEnabled} label="Enable the AI bridge in this browser" />
        <span className={connected ? 'small' : 'small muted'} data-testid="mcp-status">
          {connected ? `Connected · ${requests} calls served` : enabled ? `Waiting for the MCP server on ${BRIDGE_URL}…` : 'Disabled'}
        </span>
      </Row>
      <p className="small">
        OPuller ships an <strong>MCP server</strong> that lets an AI assistant (Claude Code, Claude Desktop, Cursor, …) drive this editor: read the document, create and edit objects, run every menu
        command and tool, simulate mouse gestures, and look at the result as an image.
      </p>
      <ol className="small">
        <li>
          Keep this tab open (dev server or a built copy). The bridge connects to <code>{BRIDGE_URL}</code> automatically.
        </li>
        <li>
          Register the server with your AI client. For Claude Code the repository already contains <code>.mcp.json</code>; for other clients use this config:
        </li>
      </ol>
      <pre>{CONFIG}</pre>
      <ol className="small" start={3}>
        <li>
          Or start it by hand: <code>npm run mcp</code> (stdio transport). The server waits for the editor tab and forwards tool calls.
        </li>
        <li>
          Try: "Draw the Twitter bird from circles and show me a screenshot" — the AI will use <code>opuller_create_shape</code>, <code>opuller_pathfinder</code> and <code>opuller_screenshot</code>.
        </li>
      </ol>
      <p className="small muted">
        {Object.keys(mcpApi).length} scripting methods are also available in the console as <code>window.__opuller.mcp</code>.
      </p>
    </DialogFrame>
  );
}

registerDialog('mcpSetup', ({ close }) => <McpSetupDialog close={close} />);
