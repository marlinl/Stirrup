import type { Api } from '../../api/client';
import type { AgentId } from '../../acp/agents';
import type { Preferences } from '../../app/preferences';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../app/routes';
import type { SettingsSummary } from '../../domain/models';
import type { WorkspaceController } from '../../domain/workspace';
import { el } from '../dom';
import { drawer } from '../components/sidebar-resizer';
import { renderAppearance } from '../settings/appearance';
import { renderAgents } from '../settings/agents';
import { renderAccount } from '../settings/account';
import { renderStorage } from '../settings/storage';

/** Own settings category rendering inside the persistent workbench, never a dialog or a second conversation controller. */
export function createSettingsPage(
  api: Api,
  workspace: WorkspaceController,
  preferences: Preferences,
  resize: () => void,
  chooseAgent: (id: AgentId) => void,
  chooseSection: (section: SettingsSection) => void,
  logout: () => Promise<void>,
) {
  let generation = 0;
  let current: SettingsSection | undefined;
  let refresh: (() => void) | undefined;
  const navigation = el('settings-navigation');
  for (const [section, label] of Object.entries(SETTINGS_SECTIONS)) {
    const button = document.createElement('button');
    button.className = 'settings-category';
    button.dataset.section = section;
    button.textContent = label;
    button.addEventListener('click', () => {
      chooseSection(section as SettingsSection);
      drawer(false);
    });
    navigation.append(button);
  }
  el('open-settings-drawer').addEventListener('click', () => drawer(true));

  /** Mount a selected category once; discard stale asynchronous responses after navigation, logout or expiry. */
  function show(section: SettingsSection): void {
    if (current === section) return;
    current = section;
    refresh = undefined;
    const request = ++generation;
    for (const button of navigation.querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute('aria-current', button.dataset.section === section ? 'page' : 'false');
    el('settings-title').textContent = SETTINGS_SECTIONS[section];
    document.title = `设置 / ${SETTINGS_SECTIONS[section]} · Stirrup`;
    const host = el('settings-content');
    if (section === 'appearance') renderAppearance(host, preferences, resize);
    else if (section === 'agents') refresh = renderAgents(host, workspace, chooseAgent);
    else {
      host.innerHTML = '<p role="status">正在读取本地设置…</p>';
      void api<SettingsSummary>('/api/settings')
        .then((summary) => {
          if (request !== generation) return;
          if (section === 'account') refresh = renderAccount(host, summary, workspace, logout, api);
          else renderStorage(host, summary);
        })
        .catch((error) => {
          if (request !== generation) return;
          host.innerHTML =
            '<p class="inline-error" role="alert"></p><button class="quiet-button">重试</button>';
          host.querySelector('p')!.textContent =
            error instanceof Error ? error.message : '读取设置失败';
          host.querySelector('button')!.addEventListener('click', () => {
            current = undefined;
            show(section);
          });
        });
    }
  }
  /** Invalidate pending reads on leaving settings while retaining all shared conversation state. */
  function hide(): void {
    generation++;
    current = undefined;
    refresh = undefined;
  }
  return { show, hide, update: () => refresh?.() };
}
