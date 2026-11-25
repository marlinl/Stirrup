import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configIdentity } from './passkey-store.ts';
import type { PersonalSettingsStore } from '../storage/personal-settings-store.ts';
import type { SiteConfig } from '../config/site.ts';
import { HttpError } from '../errors.ts';
import { cookie } from '../http/request.ts';

const COOKIE = 'stirrup_session';
interface Login {
  identity: string;
  username: string;
  expires: number;
  connections: Set<() => void>;
  timer: ReturnType<typeof setTimeout>;
}

/** Own authenticated logins, their cookies, expiration timers and attached ACP connections. */
export class SessionManager {
  private readonly logins = new Map<string, Login>();

  /** Share the persisted account and external HTTPS cookie policy. */
  constructor(
    private readonly settings: PersonalSettingsStore,
    private readonly site: SiteConfig,
  ) {}

  /** Return a live login, expiring both its HTTP access and attached ACP connections together. */
  login(request: IncomingMessage): Login | undefined {
    const token = cookie(request, COOKIE);
    if (!token) return;
    const login = this.logins.get(token);
    if (login) {
      try {
        const config = this.settings.readConfig();
        if (login.expires <= Date.now() || !config || login.identity !== configIdentity(config)) {
          this.revoke(token);
          return;
        }
      } catch {
        this.revoke(token);
        return;
      }
    }
    return login;
  }

  /** Invalidate a login and synchronously terminate all of its agent connections. */
  private revoke(token: string): void {
    const login = this.logins.get(token);
    if (!login) return;
    this.logins.delete(token);
    clearTimeout(login.timer);
    for (const close of [...login.connections]) close();
  }

  /** Schedule absolute expiry in bounded intervals so long lifetimes cannot overflow Node's timer limit. */
  private scheduleExpiry(token: string, expires: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => {
        const login = this.logins.get(token);
        if (!login) return;
        if (expires <= Date.now()) this.revoke(token);
        else login.timer = this.scheduleExpiry(token, expires);
      },
      Math.max(1, Math.min(expires - Date.now(), 2_147_483_647)),
    );
    timer.unref();
    return timer;
  }

  /** Mint a cookie and server session using the personal table's lifetime, fixed without sliding renewal. */
  signIn(
    request: IncomingMessage,
    response: ServerResponse,
    identity: { username: string; identity: string },
  ): void {
    const config = this.settings.readConfig();
    if (!config || configIdentity(config) !== identity.identity)
      throw new HttpError(401, '登录身份已变化');
    const seconds = config.sessionTtlSeconds;
    const previous = cookie(request, COOKIE);
    if (previous) this.revoke(previous);
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + seconds * 1000;
    const timer = this.scheduleExpiry(token, expires);
    this.logins.set(token, { ...identity, expires, connections: new Set(), timer });
    response.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.site.secure ? '; Secure' : ''}`,
    );
  }

  /** Reject unauthenticated private requests after any asynchronous request-body read. */
  require(request: IncomingMessage): void {
    if (!this.login(request)) throw new HttpError(401, '登录已失效，请重新登录');
  }

  /** Revoke this browser's login and expire its cookie, closing associated ACP connections. */
  logout(request: IncomingMessage, response: ServerResponse): void {
    const token = cookie(request, COOKIE);
    if (token) this.revoke(token);
    response.setHeader(
      'Set-Cookie',
      `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.site.secure ? '; Secure' : ''}`,
    );
  }

  /** Release all login timers and owned sockets when the local runtime stops. */
  close(): void {
    for (const token of [...this.logins.keys()]) this.revoke(token);
  }
}
