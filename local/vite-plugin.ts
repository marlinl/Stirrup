import type { Plugin } from 'vite';
import { WebRuntime } from './runtime.ts';
import { attachAcpBridge } from './acp/bridge.ts';
import { agentLaunch } from './acp/launch.ts';

/** Provide the same local ACP transport in Vite development and built-page preview. */
export function acpPlugin(): Plugin {
  let dispose: (() => void) | undefined;
  let runtime: WebRuntime | undefined;
  return {
    name: 'stirrup-acp',
    /** Bind the development server transport to the current workspace. */
    configureServer(server) {
      runtime = new WebRuntime(process.cwd());
      server.middlewares.use(runtime.middleware.bind(runtime));
      server.httpServer?.once('close', () => {
        dispose?.();
        runtime?.close();
      });
      if (server.httpServer)
        dispose = attachAcpBridge(
          server.httpServer,
          process.cwd(),
          agentLaunch,
          runtime.authorize.bind(runtime),
        );
    },
    /** Bind the preview server so a built page can still access the local adapter. */
    configurePreviewServer(server) {
      runtime = new WebRuntime(process.cwd());
      server.middlewares.use(runtime.middleware.bind(runtime));
      server.httpServer?.once('close', () => {
        dispose?.();
        runtime?.close();
      });
      dispose = attachAcpBridge(
        server.httpServer,
        process.cwd(),
        agentLaunch,
        runtime.authorize.bind(runtime),
      );
    },
    /** Reap owned child processes when Vite closes. */
    closeBundle() {
      runtime?.close();
      dispose?.();
    },
  };
}
