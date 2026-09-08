import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/source-code-pro/400.css';
import './styles.css';
import './modules';
import { App } from './ui/App';
import { useStore } from './store/store';
import { runCommand, allCommands } from './commands/registry';
import { worldBounds, localBounds, worldMatrix } from './model/document';
import { getTool, allTools } from './tools/registry';
import * as documentApi from './model/document';
import * as nodesApi from './model/nodes';
import * as pathApi from './geometry/path';
import * as paperApi from './geometry/paperBridge';

// Expose internals for e2e tests and debugging (window.__opuller).
(window as any).__opuller = {
  ...((window as any).__opuller ?? {}),
  store: useStore,
  runCommand,
  allCommands,
  worldBounds,
  localBounds,
  worldMatrix,
  getTool,
  allTools,
  api: { document: documentApi, nodes: nodesApi, path: pathApi, paper: paperApi },
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
