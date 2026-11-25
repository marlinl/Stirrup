import { isIP } from 'node:net';
import { readAppEnv } from './env.ts';

export interface SiteConfig {
  origin?: string;
  rpId: string;
  secure: boolean;
}

/** Parse the browser-facing site, independent of Node's listener and untrusted proxy headers. */
export function readSiteConfig(root: string): SiteConfig {
  const value = readAppEnv(root).STIRRUP_SITE_URL;
  if (value === undefined) return { rpId: 'localhost', secure: false };
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && url.hostname !== 'localhost') ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !/^[a-z0-9.-]+$/.test(url.hostname) ||
      url.hostname.endsWith('.')
    )
      throw new Error();
    return { origin: url.origin, rpId: url.hostname, secure: url.protocol === 'https:' };
  } catch {
    throw new Error(
      'STIRRUP_SITE_URL 必须为 HTTPS 站点域名地址（开发时可用 http://localhost），不含路径、查询或用户信息',
    );
  }
}

/** Resolve the development default against the actual port; explicit external origins never use the listener port. */
export function siteOrigin(site: SiteConfig, port = 5173): string {
  return site.origin ?? new URL(`http://localhost:${port}`).origin;
}
