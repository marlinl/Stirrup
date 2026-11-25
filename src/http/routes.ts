import type { PersonalSettingsStore } from '../storage/personal-settings-store.ts';
import { siteOrigin, type SiteConfig } from '../config/site.ts';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PasskeyAuth } from '../auth/passkey-auth.ts';
import { PasskeyError } from '../auth/passkey-store.ts';
import { SessionManager } from '../auth/sessions.ts';
import { WorkspaceStore } from '../storage/workspace-store.ts';
import { HttpError } from '../errors.ts';
import { cookie, validHost, readBody, reply, sameOrigin } from './request.ts';

/** Dispatch the application's HTTP API; authentication, persistence and transport have separate owners. */
export class ApiRouter {
  private attempts: number[] = [];

  /** Receive the services owned by one local runtime, keeping route handlers free of persistence internals. */
  constructor(
    private readonly settings: PersonalSettingsStore,
    private readonly site: SiteConfig,
    private readonly passkeys: PasskeyAuth,
    private readonly sessions: SessionManager,
    private readonly workspace: WorkspaceStore,
  ) {}

  /** Handle only API paths and turn expected failures into safe JSON without leaking internal details. */
  middleware(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    if (!request.url?.startsWith('/api/')) {
      next();
      return;
    }
    void this.handle(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        reply(
          response,
          error instanceof HttpError || error instanceof PasskeyError ? error.status : 500,
          {
            error:
              error instanceof HttpError || error instanceof PasskeyError
                ? error.message
                : '本地数据操作失败，请检查启动终端',
          },
        );
    });
  }

  /** Apply request-origin guards, dispatch public authentication routes, then require a session for workspace routes. */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!validHost(request, this.site)) throw new HttpError(403, '访问地址与站点配置不匹配');
    const path = new URL(request.url!, 'http://localhost').pathname;
    const method = request.method;
    if ((method !== 'GET' || request.headers.origin) && !sameOrigin(request, this.site))
      throw new HttpError(403, '请求来源不匹配');
    if (path === '/api/auth' && method === 'GET') {
      const login = this.sessions.login(request);
      reply(response, 200, {
        configured: !!this.settings.readConfig(),
        authenticated: !!login,
        username: login?.username,
      });
      return;
    }
    if (path === '/api/setup' || path === '/api/login')
      throw new HttpError(410, '仅支持 Passkey 登录，密码入口已移除');
    const ceremony = path.match(/^\/api\/passkey\/(register|login)\/(options|verify)$/);
    if (ceremony && method === 'POST') {
      await this.passkey(request, response, ceremony[1] as 'register' | 'login', ceremony[2]);
      return;
    }
    this.sessions.require(request);
    if (path === '/api/logout' && method === 'POST') {
      this.sessions.logout(request, response);
      reply(response, 200, {});
      return;
    }
    if (path === '/api/settings/preferences' && method === 'GET') {
      reply(response, 200, this.settings.preferences());
      return;
    }
    if (path === '/api/settings/preferences' && method === 'PUT') {
      reply(response, 200, this.settings.savePreferences(await this.privateBody(request)));
      return;
    }
    if (path === '/api/settings/account' && method === 'PUT') {
      this.settings.saveAccount(await this.privateBody(request));
      reply(response, 200, {});
      return;
    }
    if (path === '/api/settings' && method === 'GET') {
      if (request.headers.origin && !sameOrigin(request, this.site))
        throw new HttpError(403, '请求来源不匹配');
      const login = this.sessions.login(request)!;
      const account = this.settings.readConfig()!;
      reply(response, 200, {
        account: {
          username: account.username,
          revision: account.revision,
          rpId: account.rpId,
          authMethod: 'passkey',
          configuredSessionTtlSeconds: account.sessionTtlSeconds,
          currentSessionExpiresAt: login.expires,
        },
        storage: this.workspace.summary(),
      });
      return;
    }
    if (path === '/api/workspace' && method === 'GET') {
      reply(response, 200, this.workspace.list());
      return;
    }
    if (path === '/api/projects' && method === 'POST') {
      const result = this.workspace.addProject(await this.privateBody(request));
      reply(response, result.created ? 201 : 200, result.project);
      return;
    }
    if (path === '/api/conversations' && method === 'POST') {
      reply(response, 201, this.workspace.createConversation(await this.privateBody(request)));
      return;
    }
    if (path.startsWith('/api/conversations/') && method === 'PUT') {
      const input = await this.privateBody(request);
      reply(
        response,
        200,
        this.workspace.saveConversation(path.slice('/api/conversations/'.length), input),
      );
      return;
    }
    throw new HttpError(404, '接口不存在');
  }

  /** Recheck authentication after receiving an asynchronous body, before any private mutation is committed. */
  private async privateBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const input = await readBody(request);
    this.sessions.require(request);
    return input;
  }

  /** Bind WebAuthn challenges to a browser cookie and mint a login only after successful assertion verification. */
  private async passkey(
    request: IncomingMessage,
    response: ServerResponse,
    kind: 'register' | 'login',
    step: string,
  ): Promise<void> {
    this.attempts = this.attempts.filter((time) => time > Date.now() - 60_000);
    if (this.attempts.length >= 30) throw new HttpError(429, '尝试过于频繁，请稍后再试');
    this.attempts.push(Date.now());
    const input = await readBody(request);
    const origin = siteOrigin(this.site, request.socket.localPort);
    if (step === 'options') {
      const browser = randomBytes(32).toString('base64url');
      const options = await this.passkeys.begin(kind, origin, browser);
      response.setHeader(
        'Set-Cookie',
        `stirrup_webauthn=${browser}; Path=/api/passkey; HttpOnly; SameSite=Strict; Max-Age=300${this.site.secure ? '; Secure' : ''}`,
      );
      reply(response, 200, options);
    } else {
      const browser = cookie(request, 'stirrup_webauthn');
      if (!browser) throw new HttpError(401, 'Passkey 请求已失效，请重新开始');
      const identity = await this.passkeys.finish(kind, origin, browser, input.response);
      if (identity) this.sessions.signIn(request, response, identity);
      reply(response, 200, {
        configured: true,
        authenticated: !!identity,
        username: identity?.username,
      });
    }
  }
}
