import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { livePorts } from './mcp/registry';

/**
 * Security headers of the production nginx config (deploy/nginx-opuller-headers.conf), applied
 * by `vite preview` so the Content-Security-Policy can be exercised locally before a deploy.
 */
function productionHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const conf = readFileSync(fileURLToPath(new URL('./deploy/nginx-opuller-headers.conf', import.meta.url)), 'utf8');
    for (const m of conf.matchAll(/^add_header\s+([\w-]+)\s+"([^"]*)"/gm)) if (m[1] !== 'Strict-Transport-Security') out[m[1]] = m[2];
  } catch {
    /* no snippet: preview without the headers */
  }
  return out;
}

/**
 * The static site pages live in public/<page>/index.html and are served by nginx (and
 * `vite preview`) at /<page>/. The dev server only knows public files by exact path, so map
 * directory requests to their index.html there too.
 */
function publicDirIndex(): Plugin {
  return {
    name: 'opuller-public-dir-index',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        const pathname = url.split('?')[0];
        if (pathname.length > 1 && pathname.endsWith('/') && existsSync(join(server.config.publicDir, pathname, 'index.html'))) req.url = `${pathname}index.html${url.slice(pathname.length)}`;
        next();
      });
    },
  };
}

/**
 * `/__opuller/bridge-ports` → `{ ports: [5187, ...] }`: the WebSocket ports of the OPuller MCP
 * servers currently running on this machine (mcp/registry.ts). The AI bridge in the page polls
 * it so a server that had to skip a busy port is still found; a built copy served elsewhere
 * has no such endpoint and falls back to the default port.
 */
function bridgePorts(): Plugin {
  return {
    name: 'opuller-bridge-ports',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/__opuller/bridge-ports') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ ports: livePorts() }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), publicDirIndex(), bridgePorts()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // paper-core = paper without PaperScript; the full build's parser calls `new Function` at
      // load time, which the production Content-Security-Policy forbids (no 'unsafe-eval').
      paper: 'paper/dist/paper-core.js',
    },
  },
  server: { port: 5180, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5181, strictPort: true, headers: productionHeaders() },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    // paperjs-offset imports `paper` itself: transform it through Vite so the alias above applies
    // and both sides share one paper instance (otherwise its instanceof checks fail).
    server: { deps: { inline: ['paperjs-offset'] } },
  },
} as any);
