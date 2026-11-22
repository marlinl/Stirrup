import type { SettingsSummary } from '../../domain/models';
import type { WorkspaceController } from '../../domain/workspace';

/** Render read-only Passkey/session metadata and inline logout confirmation with explicit save/error handling. */
export function renderAccount(
  host: HTMLElement,
  summary: SettingsSummary,
  workspace: WorkspaceController,
  logout: () => Promise<void>,
): () => void {
  host.innerHTML = `<section class="settings-card glass"><h3>账号与安全</h3>
    <dl class="settings-facts"><dt>本地账号</dt><dd id="account-name"></dd><dt>认证方式</dt><dd>Passkey</dd>
    <dt>本次登录到期</dt><dd id="session-expiry"></dd><dt>后续登录有效期</dt><dd id="session-ttl"></dd></dl>
    <p class="muted">账号与 Passkey 由本机 .env 管理。修改登录有效期对下次登录生效，不延长本次会话。</p>
    <button id="logout" class="quiet-button danger">退出登录</button>
    <section id="logout-confirmation" class="logout-confirmation" hidden><h3>退出工作空间</h3><p id="logout-copy"></p>
      <p class="muted">已保存的项目和对话保留在本机。</p><div class="setting-actions">
      <button id="cancel-logout" class="quiet-button">取消</button><button id="confirm-logout" class="primary">确认退出</button></div>
      <p id="logout-error" role="alert"></p></section></section>`;
  host.querySelector('#account-name')!.textContent = summary.account.username;
  host.querySelector('#session-expiry')!.textContent = new Date(
    summary.account.currentSessionExpiresAt,
  ).toLocaleString();
  host.querySelector('#session-ttl')!.textContent =
    `${summary.account.configuredSessionTtlSeconds} 秒`;
  const confirmation = host.querySelector<HTMLElement>('#logout-confirmation')!;
  const confirm = host.querySelector<HTMLButtonElement>('#confirm-logout')!;
  const cancel = host.querySelector<HTMLButtonElement>('#cancel-logout')!;
  host.querySelector('#logout')!.addEventListener('click', () => {
    confirmation.hidden = false;
    refresh();
    cancel.focus();
  });
  cancel.addEventListener('click', () => {
    confirmation.hidden = true;
    host.querySelector<HTMLElement>('#logout')!.focus();
  });
  confirm.addEventListener('click', async () => {
    confirm.disabled = cancel.disabled = true;
    host.querySelector('#logout-error')!.textContent = '';
    try {
      await logout();
    } catch (error) {
      host.querySelector('#logout-error')!.textContent =
        `${error instanceof Error ? error.message : '退出失败'}；已停止的操作不会自动重启。`;
    } finally {
      confirm.disabled = cancel.disabled = false;
    }
  });
  /** Keep the inline interruption warning accurate while background conversations change. */
  function refresh(): void {
    const states = [...workspace.live.values()];
    const active = states.filter(
      (s) => s.opening || (s.client && !['ready', 'closed'].includes(s.client.phase)),
    ).length;
    const pending = states.reduce((sum, s) => sum + s.permissions.length, 0);
    host.querySelector('#logout-copy')!.textContent =
      `退出将关闭当前登录的连接，中断 ${active} 个操作并取消 ${pending} 项待审批。`;
  }
  refresh();
  return refresh;
}
