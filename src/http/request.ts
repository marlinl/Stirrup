import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SiteConfig } from '../config/site.ts';
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

/** Derive an exact loopback origin for the bound port, including IPv6 and HTTP's implicit port 80. */
export function localOrigin(
  host: string | undefined,
  port: number | undefined,
): string | undefined {
  if (!host || !port) return;
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (names.some((name) => host === `${name}:${port}` || (port === 80 && host === name)))
    return new URL(`http://${host}`).origin;
}

/** Match the configured external authority; development defaults retain loopback aliases for page/API access. */
export function validHost(request: IncomingMessage, site?: SiteConfig): boolean {
  if (site?.origin) return request.headers.host === new URL(site.origin).host;
  return !!localOrigin(request.headers.host, request.socket.localPort);
}

/** Check the canonical exact origin for state-changing requests and ACP upgrades. */
export function sameOrigin(request: IncomingMessage, site?: SiteConfig): boolean {
  if (!validHost(request, site)) return false;
  const origin = site?.origin ?? localOrigin(request.headers.host, request.socket.localPort);
  return !!origin && request.headers.origin === origin;
}

/** Extract a named opaque cookie without persisting or logging its value. */
export function cookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
