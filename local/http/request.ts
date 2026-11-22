import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../errors.ts';

const MAX_BODY = 8 * 1024 * 1024;
/** Read bounded JSON, rejecting oversized or malformed requests before processing their fields. */
export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '会话内容过大，请新建对话');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求格式无效');
  }
}

/** Return private JSON with explicit no-store semantics, including for authentication failures. */
export function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

/** Require a loopback Host matching the actual listening port, including on read-only endpoints. */
export function localHost(request: IncomingMessage): boolean {
  return [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`].includes(
    request.headers.host ?? '',
  );
}

/** Check exact origin for state-changing requests and ACP upgrades. */
export function sameOrigin(request: IncomingMessage): boolean {
  return localHost(request) && request.headers.origin === `http://${request.headers.host}`;
}

/** Extract a named opaque cookie without persisting or logging its value. */
export function cookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
