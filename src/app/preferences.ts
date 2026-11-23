import { isAgentId, type AgentId } from '../acp/agents';
import type { Api } from '../api/client';
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
const persistence = new WeakMap<Preferences, (value: Preferences) => Promise<boolean>>();

/** Read only browser-specific navigation; personal appearance starts with defaults until authenticated loading. */
export function loadPreferences(): Preferences {
  let preferences: Preferences;
  try {
    const saved = JSON.parse(localStorage.getItem('stirrup.preferences') ?? '{}');
    preferences = { ...defaults, selected: saved.selected ?? {}, agent: saved.agent ?? 'codex' };
  } catch {
    preferences = { ...defaults, selected: {} };
  }
  if (!isAgentId(preferences.agent)) preferences.agent = 'codex';
  return preferences;
}

/** Load the personal display settings and serialize versioned writes until the authenticated view is disposed. */
export async function connectPreferences(
  preferences: Preferences,
  api: Api,
  isCurrent: () => boolean = () => true,
): Promise<() => void> {
  const saved = await api<{
    values: Pick<Preferences, 'theme' | 'opaque' | 'motion' | 'ratio'>;
    revision: number;
  }>('/api/settings/preferences');
  if (!isCurrent()) return () => {};
  Object.assign(preferences, saved.values);
  let revision = saved.revision;
  let active = true;
  let previous = JSON.stringify(saved.values);
  let pending: Promise<boolean> = Promise.resolve(true);
  /** Queue an immutable display snapshot; navigation-only changes do not write the personal record. */
  const persist = (value: Preferences): Promise<boolean> => {
    const values = {
      theme: value.theme,
      opaque: value.opaque,
      motion: value.motion,
      ratio: value.ratio,
    };
    const snapshot = JSON.stringify(values);
    pending = pending.then(async () => {
      if (!active) return false;
      if (snapshot === previous) return true;
      try {
        const result = await api<{ revision: number }>('/api/settings/preferences', 'PUT', {
          values,
          revision,
        });
        revision = result.revision;
        previous = snapshot;
        return true;
      } catch {
        return false;
      }
    });
    return pending;
  };
  persistence.set(preferences, persist);
  return () => {
    active = false;
    if (persistence.get(preferences) === persist) persistence.delete(preferences);
  };
}

/** Persist navigation locally and display settings in SQLite, reporting failure without leaking personal data. */
export async function savePreferences(preferences: Preferences): Promise<boolean> {
  try {
    localStorage.setItem(
      'stirrup.preferences',
      JSON.stringify({ agent: preferences.agent, selected: preferences.selected }),
    );
  } catch {
    // Browser navigation caching is optional; personal configuration can still be saved on the server.
  }
  const persist = persistence.get(preferences);
  return persist ? persist(preferences) : false;
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
