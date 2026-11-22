import { createApi } from '../api/client';
import { passkeySupported, usePasskey } from '../auth/passkey';
import type { Identity } from '../domain/models';
import { WorkspaceController } from '../domain/workspace';
import { run, toast } from '../ui/dom';
import { renderLogin, renderUnavailable } from '../ui/pages/login';
import { createWorkspacePage } from '../ui/pages/workspace';
import { appearance, loadPreferences } from './preferences';
import {
  readEnrollmentToken,
  redirectToLocalhost,
  writeLoginRoute,
  workspaceDestination,
} from './routes';

/** Own browser startup, authenticated page transitions and teardown; rendering lives in ui/. */
export class Application {
  private readonly preferences = loadPreferences();
  private readonly api = createApi(() => {
    if (this.workspace) this.showLogin({ configured: true, authenticated: false });
  });
  private destination = workspaceDestination();
  private enrollmentToken = readEnrollmentToken();
  private generation = 0;
  private workspace?: WorkspaceController;
  private view?: ReturnType<typeof createWorkspacePage>;

  /** Install page lifecycle hooks and check authentication before mounting private workspace state. */
  async start(): Promise<void> {
    if (redirectToLocalhost()) return;
    appearance(this.preferences);
    window.addEventListener('resize', () => this.view?.resize());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
      appearance(this.preferences),
    );
    window.addEventListener('pagehide', () => {
      void this.workspace?.flushAll();
      this.disposeWorkspace();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.workspace?.flushAll();
    });
    window.addEventListener('focus', () => {
      if (this.workspace)
        void run(async () => {
          const identity = await this.api<Identity>('/api/auth');
          if (!identity.authenticated) this.showLogin(identity);
        });
    });
    try {
      const identity = await this.api<Identity>('/api/auth');
      if (identity.authenticated) await this.showWorkspace(identity);
      else this.showLogin(identity);
    } catch (error) {
      renderUnavailable();
      toast(error instanceof Error ? error.message : '启动失败');
    }
  }

  /** Mount the public login view and handle its explicit Passkey action without leaking private workspace state. */
  private showLogin(identity: Identity): void {
    if (this.workspace) this.destination = workspaceDestination();
    this.disposeWorkspace();
    writeLoginRoute();
    if (identity.configured) this.enrollmentToken = undefined;
    renderLogin(identity, !!this.enrollmentToken, passkeySupported(), async () => {
      const result = await usePasskey(this.api, this.enrollmentToken);
      if (result.authenticated) await this.showWorkspace(result);
      else {
        this.enrollmentToken = undefined;
        this.showLogin(result);
        toast('Passkey 已绑定，请使用它登录');
      }
    });
  }

  /** Load application history and mount the workspace view without automatically launching Agent sessions. */
  private async showWorkspace(identity: Identity): Promise<void> {
    const generation = ++this.generation;
    const controller = new WorkspaceController(this.api, () => this.view?.scheduleRender());
    await controller.load();
    if (generation !== this.generation) {
      controller.dispose();
      return;
    }
    this.workspace = controller;
    history.replaceState({}, '', this.destination);
    this.view = createWorkspacePage(
      controller,
      this.preferences,
      identity,
      () => this.logout(),
      this.api,
    );
  }

  /** Finish pending saves, revoke the server login and return to the Passkey page after confirmed logout. */
  private async logout(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    for (const state of workspace.live.values()) state.client?.close();
    await workspace.flushAll();
    if ([...workspace.live.values()].some((state) => state.saveError))
      throw new Error('有会话尚未保存，请先处理保存错误后再退出');
    await this.api('/api/logout', 'POST', {});
    this.showLogin({ configured: true, authenticated: false });
  }

  /** Release mounted view state and its independent ACP clients when leaving the authenticated page. */
  private disposeWorkspace(): void {
    this.generation++;
    this.view?.dispose();
    this.view = undefined;
    this.workspace?.dispose();
    this.workspace = undefined;
  }
}
