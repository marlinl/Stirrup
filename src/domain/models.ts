import type { AgentId } from '../acp/agents';

export interface Project {
  id: string;
  name: string;
  cwd: string;
}
export interface Message {
  id: string;
  kind: 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'notice' | 'error' | 'event';
  text: string;
  title?: string;
  toolCallId?: string;
  status?: string;
  details?: Record<string, unknown>;
}
export interface Conversation {
  id: string;
  projectId: string;
  agentId: AgentId;
  title: string;
  providerSessionId?: string;
  messages: Message[];
  draft: string;
  updatedAt: number;
  revision: number;
}
export interface Workspace {
  projects: Project[];
  conversations: Conversation[];
}
export interface Identity {
  configured: boolean;
  authenticated: boolean;
  username?: string;
}

export interface SettingsSummary {
  account: {
    username: string;
    authMethod: 'passkey';
    revision: number;
    rpId: string;
    configuredSessionTtlSeconds: number;
    currentSessionExpiresAt: number;
  };
  storage: {
    backend: 'sqlite' | 'json';
    location: string;
    schemaVersion: number | null;
    projectCount: number;
    conversationCount: number;
    messageCount: number;
  };
}
