import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createWebSocketStream, WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { AGENTS, type AgentId } from '../../shared/agents.ts';
import { agentLaunch, type AgentLaunch } from './launch.ts';
import { sameOrigin } from '../http/request.ts';
import { readSiteConfig, type SiteConfig } from '../config/site.ts';
import type { BridgeGrant } from '../runtime.ts';

/** Check the browser-facing origin for both direct development and HTTPS reverse-proxy upgrades. */
export function isAllowedOrigin(request: IncomingMessage, site?: SiteConfig): boolean {
  return sameOrigin(request, site);
}

/** Stop the adapter and its descendants; force termination if graceful exit stalls. */
function stopProcess(child: ChildProcess): void {
  if (!child.pid) return;
  const pid = child.pid;
  /** Signal the dedicated process group on POSIX, tolerating an already exited process. */
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform === 'win32') child.kill(value);
      else process.kill(-pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error('ACP cleanup failed:', error);
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 1500).unref();
}

/** Attach the fixed ACP routes to a local server; injected launches are only for local tests. */
export function attachAcpBridge(
  server: HttpServer,
  cwd: string,
  launch: typeof agentLaunch = agentLaunch,
  authorize: (request: IncomingMessage, id: AgentId) => BridgeGrant | undefined = () => undefined,
): () => void {
  const site = readSiteConfig(cwd);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const cleanups = new Set<() => void>();
  /** Authorize the upgrade before spawning a fixed local adapter for this connection. */
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const id = (Object.keys(AGENTS) as AgentId[]).find((id) => AGENTS[id].endpoint === path);
    if (!id) {
      if (request.url?.startsWith('/acp/'))
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const address = server.address();
    if (!address || typeof address === 'string' || !isAllowedOrigin(request, site)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const grant = authorize(request, id);
    if (!grant) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let config: AgentLaunch;
      try {
        config = launch(id, cwd);
      } catch {
        console.error(
          `Unable to start ${AGENTS[id].name}; check installed dependencies and local configuration.`,
        );
        ws.close(1011, 'ACP agent unavailable');
        return;
      }
      const args = config.command;
      const child = spawn(args[0], args.slice(1), {
        cwd: grant.cwd,
        env: config.env,
        stdio: ['pipe', 'pipe', 'inherit'],
        detached: process.platform !== 'win32',
      });
      const stream = createWebSocketStream(ws);
      let stopped = false;
      let unbind = (): void => {};
      /** Idempotently release streams and the entire child process group on either side's exit. */
      const cleanup = (): void => {
        if (stopped) return;
        stopped = true;
        cleanups.delete(cleanup);
        unbind();
        stream.destroy();
        ws.terminate();
        stopProcess(child);
      };
      cleanups.add(cleanup);
      unbind = grant.bind(cleanup);
      child.once('error', cleanup);
      child.once('exit', cleanup);
      child.stdin.on('error', cleanup);
      child.stdout.on('error', cleanup);
      stream.on('error', cleanup);
      ws.on('error', cleanup);
      ws.once('close', cleanup);
      stream.pipe(child.stdin);
      child.stdout.pipe(stream);
    });
  };
  server.on('upgrade', upgrade);
  /** Close owned sockets and detach the bridge without affecting frontend development upgrades. */
  const dispose = (): void => {
    server.off('upgrade', upgrade);
    for (const cleanup of [...cleanups]) cleanup();
    wss.close();
  };
  server.once('close', dispose);
  return dispose;
}
