import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Identify browser history routes that may receive the application HTML shell. */
export function isPageRoute(path: string): boolean {
  return /^\/(?:login|chat|settings(?:\/(?:appearance|agents|account|storage))?)?\/?$/.test(path);
}

/** Check real files before Vite follows symlinks; virtual module requests remain subject to Vite's own allowlist. */
export async function allowDevelopmentFile(root: string, pathname: string): Promise<boolean> {
  try {
    const path = decodeURIComponent(pathname);
    const requested = path.startsWith('/@fs/') ? path.slice(4) : resolve(root, 'web', `.${path}`);
    let file: string;
    try {
      file = await realpath(requested);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    for (const directory of ['web', 'shared', 'node_modules']) {
      try {
        const allowed = await realpath(resolve(root, directory));
        if (file.startsWith(allowed + sep)) return true;
      } catch {
        // A fixture or production-only installation can omit an unused development directory.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Serve build assets and known UI routes only; reject traversal, hidden files and symlink escapes. */
export async function serveStatic(
  directory: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (
      !['GET', 'HEAD'].includes(request.method ?? '') ||
      path.split('/').some((part) => part.startsWith('.')) ||
      path.includes('\\')
    ) {
      response.writeHead(404).end();
      return;
    }
    const page = isPageRoute(path);
    const root = await realpath(directory);
    const file = await realpath(resolve(root, page ? 'index.html' : `.${path}`));
    if (!file.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': page ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(404).end();
  }
}
