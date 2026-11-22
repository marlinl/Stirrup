import type { AgentId } from '../acp/agents';
import type { Preferences } from './preferences';

/** Read the terminal enrollment grant once; the login route removes it from the visible URL. */
export function readEnrollmentToken(): string | undefined {
  return new URLSearchParams(location.hash.slice(1)).get('enroll') ?? undefined;
}

/** Normalize local navigation to the fixed WebAuthn RP host, preserving path, query and enrollment fragment. */
export function redirectToLocalhost(): boolean {
  if (location.hostname !== '127.0.0.1') return false;
  const url = new URL(location.href);
  url.hostname = 'localhost';
  location.replace(url.href);
  return true;
}

/** Select the requested Agent and opaque conversation ID, falling back to saved UI preferences. */
export function readChatRoute(preferences: Preferences): {
  agent: AgentId;
  session?: string;
} {
  const params = new URLSearchParams(location.search);
  const requested = params.get('agent');
  const agent = requested === 'codex' || requested === 'dsh' ? requested : preferences.agent;
  return {
    agent,
    session: params.get('session') ?? preferences.selected[agent],
  };
}

/** Navigate to the existing login page without exposing an enrollment grant in browser history. */
export function writeLoginRoute(): void {
  history.replaceState({}, '', '/login');
  document.title = '登录 · Stirrup';
}

/** Update only opaque workspace identifiers in the chat URL; never include paths or credentials. */
export function writeChatRoute(
  agent: AgentId,
  projectId?: string,
  selected?: string,
  push = false,
): void {
  const params = new URLSearchParams({ agent });
  if (projectId) params.set('project', projectId);
  if (selected) params.set('session', selected);
  history[push ? 'pushState' : 'replaceState']({}, '', `/chat?${params}`);
}

export const SETTINGS_SECTIONS = {
  appearance: '外观',
  agents: 'Agent',
  account: '账号与安全',
  storage: '数据存储',
} as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/** Read only supported workbench views, normalizing unknown settings categories without accepting arbitrary URLs. */
export function readWorkspaceView():
  { kind: 'chat' } | { kind: 'settings'; section: SettingsSection } {
  if (location.pathname === '/settings' || location.pathname.startsWith('/settings/')) {
    const key = location.pathname.slice('/settings/'.length);
    const section = Object.hasOwn(SETTINGS_SECTIONS, key) ? (key as SettingsSection) : 'appearance';
    return { kind: 'settings', section };
  }
  return { kind: 'chat' };
}

/** Navigate to a settings category, adding history only when entering settings from chat. */
export function writeSettingsRoute(section: SettingsSection, push = false): void {
  history[push ? 'pushState' : 'replaceState']({}, '', `/settings/${section}`);
}

/** Retain a validated private destination across login; never forward an external return URL. */
export function workspaceDestination(): string {
  const view = readWorkspaceView();
  if (view.kind === 'settings') return `/settings/${view.section}`;
  const params = new URLSearchParams(location.search);
  const safe = new URLSearchParams();
  const agent = params.get('agent');
  if (agent === 'codex' || agent === 'dsh') safe.set('agent', agent);
  const session = params.get('session');
  if (session && /^[a-zA-Z0-9-]{1,128}$/.test(session)) safe.set('session', session);
  return `/chat${safe.size ? `?${safe}` : ''}`;
}
