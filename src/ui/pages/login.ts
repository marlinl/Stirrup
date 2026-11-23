import type { Identity } from '../../domain/models';
import { icon } from '../icons';
import { el } from '../dom';

/** Render the public connection-error state without mounting private workspace content. */
export function renderUnavailable(): void {
  el('app').innerHTML =
    '<div class="boot"><h1>暂时无法连接工作空间</h1><p>请确认本地服务已启动，然后刷新页面重试。</p></div>';
}
/** Render first-use initialization when no personal record exists, otherwise show Passkey-only login. */
export function renderLogin(
  identity: Identity,
  enrolling: boolean,
  available: boolean,
  submit: () => Promise<void>,
): void {
  const label = enrolling ? '创建 Passkey' : '使用 Passkey 登录';
  el('app').innerHTML = /* HTML */ `<main class="login-page">
    <div class="login-brand">${icon('logo')}<span>Stirrup</span></div>
    <section class="login-card glass">
      <div class="login-symbol">${icon('sparkle')}</div>
      <p class="eyebrow">YOUR LOCAL WORKSPACE</p>
      <h1>${enrolling ? '绑定你的通行密钥' : '欢迎回来'}</h1>
      <p class="intro">使用你的设备，安全进入工作空间。</p>
      <form id="login-form">
        <p id="login-error" class="inline-error" role="alert" hidden></p>
        <button class="primary login-submit" id="login-submit">${label}</button>
      </form>
      <p class="login-note" id="passkey-note"></p>
    </section>
    <p class="login-footer">
      Codex <span>·</span> DeepSeek Harness <span>·</span> Antigravity <span>·</span> 一个专注的空间
    </p>
  </main>`;
  el('passkey-note').textContent = !available
    ? '请使用支持 Passkey 的浏览器，通过受信任的 HTTPS 站点（或开发用 localhost）打开工作空间。'
    : enrolling
      ? '按系统提示创建通行密钥。绑定完成后即可使用 Passkey 登录。'
      : identity.configured
        ? '单用户 · Passkey 登录'
        : '首次使用，创建 Passkey 后初始化个人设置。';
  el<HTMLButtonElement>('login-submit').disabled =
    !available || (!enrolling && !identity.configured);
  el('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = el<HTMLButtonElement>('login-submit');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '等待设备确认…';
    el('login-error').hidden = true;
    try {
      await submit();
    } catch (error) {
      if (button.isConnected) {
        el('login-error').textContent = error instanceof Error ? error.message : 'Passkey 验证失败';
        el('login-error').hidden = false;
        button.disabled = false;
        button.textContent = label;
      }
    }
  });
  if (!el<HTMLButtonElement>('login-submit').disabled) el('login-submit').focus();
}
