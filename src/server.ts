import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { WebRuntime } from './runtime.ts';
import { attachAcpBridge } from './acp/bridge.ts';
import { agentLaunch } from './acp/launch.ts';
import { readSiteConfig } from './config/site.ts';
import type { StartupConfig } from './config/startup.ts';
import { allowDevelopmentFile, isPageRoute, serveStatic } from './http/static.ts';

/** Prepare one application, then listen on its exact port; release all resources on startup failure or close. */
export async function startServer(root: string, config: StartupConfig, development = false) {
  const site = readSiteConfig(root);
  if (!development) await access(resolve(root, 'dist/web/index.html'));
  const runtime = new WebRuntime(root);
  const server = createServer();
  let frontend: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | undefined;
  let disposeBridge: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  /** Stop receiving requests, close Agent connections and frontend tooling, and release SQLite exactly once. */
  function close(): Promise<void> {
    return (closing ??= (async () => {
      const stopped = new Promise<void>((done) => server.close(() => done()));
      disposeBridge?.();
      runtime.close();
      await frontend?.close();
      server.closeAllConnections();
      await stopped;
    })());
  }

  try {
    if (development) {
      const { createServer: createFrontend } = await import('vite');
      frontend = await createFrontend({
        configFile: false,
        root: resolve(root, 'web'),
        base: '/web/',
        appType: 'mpa',
        server: {
          middlewareMode: true,
          hmr: { server },
          allowedHosts: [site.rpId],
          fs: {
            allow: ['web', 'shared', 'node_modules'].map((path) => resolve(root, path)),
            deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**'],
          },
        },
      });
    }
    disposeBridge = attachAcpBridge(server, root, agentLaunch, runtime.authorize.bind(runtime));
    server.on('request', (request, response) => {
      runtime.middleware(request, response, () => {
        let path: string;
        try {
          path = new URL(request.url ?? '/', 'http://localhost').pathname;
        } catch {
          response.writeHead(400).end();
          return;
        }
        if (/^\/(?:api|acp)(?:\/|$)/.test(path)) {
          response.writeHead(404).end();
        } else if (frontend) {
          if (isPageRoute(path) && ['GET', 'HEAD'].includes(request.method ?? ''))
            request.url = '/web/index.html';
          const filePath = request.url!.split('?')[0].replace(/^\/web\//, '/');
          void allowDevelopmentFile(root, filePath).then((allowed) => {
            if (!allowed) response.writeHead(403).end();
            else frontend!.middlewares(request, response, () => response.writeHead(404).end());
          });
        } else {
          void serveStatic(resolve(root, 'dist/web'), request, response);
        }
      });
    });
    await new Promise<void>((ready, fail) => {
      server.once('error', fail);
      server.listen(config.port, config.host, () => {
        server.off('error', fail);
        ready();
      });
    });
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}
