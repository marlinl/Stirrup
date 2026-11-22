import { appearance, savePreferences, type Preferences } from '../../app/preferences';

/** Render immediate browser-local appearance controls and report persistence failures without discarding other preferences. */
export function renderAppearance(
  host: HTMLElement,
  preferences: Preferences,
  resize: () => void,
): void {
  host.innerHTML = `<section class="settings-card glass"><h3>外观</h3>
    <label class="setting-row" for="theme">主题<select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
    <label class="setting-row" for="opaque">减少透明效果<input id="opaque" type="checkbox"></label>
    <label class="setting-row" for="motion">减少动态效果<input id="motion" type="checkbox"></label>
    <div class="setting-row"><span>默认栏宽</span><button id="reset-width" class="quiet-button">恢复为 20%</button></div>
    <p class="muted">外观即时生效，仅保存到当前浏览器。系统减少动态效果偏好同样生效。</p>
    <p id="appearance-feedback" role="status"></p></section>`;
  /** Apply all current preferences and announce whether they were durably saved to this browser. */
  function commit(): void {
    appearance(preferences);
    host.querySelector('#appearance-feedback')!.textContent = savePreferences(preferences)
      ? '已保存到此浏览器'
      : '本次生效，但未能保存到此浏览器';
  }
  const theme = host.querySelector<HTMLSelectElement>('#theme')!;
  theme.value = preferences.theme;
  theme.addEventListener('change', () => {
    preferences.theme = theme.value as Preferences['theme'];
    commit();
  });
  for (const key of ['opaque', 'motion'] as const) {
    const input = host.querySelector<HTMLInputElement>(`#${key}`)!;
    input.checked = preferences[key];
    input.addEventListener('change', () => {
      preferences[key] = input.checked;
      commit();
    });
  }
  host.querySelector('#reset-width')!.addEventListener('click', () => {
    preferences.ratio = 0.2;
    resize();
    commit();
  });
}
