import { isAgentId, type AgentId } from '../acp/agents';
export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  opaque: boolean;
  motion: boolean;
  ratio: number;
  agent: AgentId;
  selected: Partial<Record<AgentId, string>>;
}
const defaults: Preferences = {
  theme: 'system',
  opaque: false,
  motion: false,
  ratio: 0.2,
  agent: 'codex',
  selected: {},
};

/** Read local display preferences and opaque selections without storing credentials or message bodies. */
export function loadPreferences(): Preferences {
  let preferences: Preferences;
  try {
    preferences = {
      ...defaults,
      ...JSON.parse(localStorage.getItem('stirrup.preferences') ?? '{}'),
    };
  } catch {
    preferences = { ...defaults };
  }
  if (!isAgentId(preferences.agent)) preferences.agent = 'codex';
  return preferences;
}

/** Persist appearance and opaque selection IDs only, never credentials or message content. */
export function savePreferences(preferences: Preferences): boolean {
  try {
    localStorage.setItem('stirrup.preferences', JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

/** Apply system-aware appearance and accessible material fallbacks. */
export function appearance(preferences: Preferences): void {
  document.documentElement.dataset.theme =
    preferences.theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preferences.theme;
  document.documentElement.classList.toggle('opaque', preferences.opaque);
  document.documentElement.classList.toggle('reduce-motion', preferences.motion);
}
