import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';
import type { Plugin } from 'vite';

export interface StartupConfig {
  host: string;
  port: number;
}

/** Validate a numeric TCP port without accepting auto-allocation, fractions or partial numeric strings. */
export function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('STIRRUP_PORT / --port 必须为 1–65535 的整数');
  return port;
}

/** Validate address syntax without restricting network scope; Vite's bare --host enables wildcard binding. */
export function validateHost(host: unknown): asserts host is string | true {
  if (host === true) return;
  if (typeof host !== 'string' || !host || (!isIP(host) && /[\s/:?#@\[\]]/.test(host)))
    throw new Error('STIRRUP_HOST / --host 必须为非空 IP 地址或主机名，不含协议、端口和路径');
}

/** Read startup settings only from root/.env; missing files use defaults, unreadable or invalid settings fail safely. */
export function readStartupConfig(root: string): StartupConfig {
  let source: string;
  try {
    source = readFileSync(join(root, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('无法读取项目 .env 启动配置');
    source = '';
  }
  const env = parseEnv(source);
  const host = env.STIRRUP_HOST ?? '127.0.0.1';
  const port = parsePort(env.STIRRUP_PORT ?? '5173');
  validateHost(host);
  return { host, port };
}

/** Revalidate Vite's merged CLI/config values before runtime creation and prohibit silent port fallback. */
export function startupConfigPlugin(): Plugin {
  return {
    name: 'stirrup-startup-config',
    /** Apply the same binding contract to dev and preview after Vite merges command-line overrides. */
    configResolved(config) {
      for (const options of [config.server, config.preview]) {
        validateHost(options.host);
        parsePort(String(options.port));
        options.strictPort = true;
      }
    },
  };
}
