import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentId } from '../src/acp/agents.ts';
import type { Conversation } from '../src/domain/models.ts';
import { PasskeyAuth } from './auth/passkey-auth.ts';
import { SessionManager } from './auth/sessions.ts';
import { ApiRouter } from './http/routes.ts';
import { sameOrigin } from './http/request.ts';
import { WorkspaceStore } from './storage/workspace-store.ts';

export interface BridgeGrant {
  cwd: string;
  /** Bind a socket to its login lifetime and return its cleanup callback. */
  bind(close: () => void): () => void;
}

/** Compose one local application's services and authorize ACP upgrades against those same services. */
export class WebRuntime {
  private readonly passkeys: PasskeyAuth;
  private readonly sessions: SessionManager;
  private readonly workspace: WorkspaceStore;
  private readonly routes: ApiRouter;
  private readonly active = new Set<string>();

  /** Assemble authentication and an exclusive SQLite store; legacy JSON requires explicit offline migration. */
  constructor(root: string, dataDir?: string) {
    this.workspace = new WorkspaceStore(root, dataDir);
    this.passkeys = new PasskeyAuth(root);
    this.sessions = new SessionManager(root);
    this.routes = new ApiRouter(root, this.passkeys, this.sessions, this.workspace);
  }

  /** Delegate HTTP handling to the explicit route module used by both development and preview. */
  middleware(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    this.routes.middleware(request, response, next);
  }

  /** Authorize a registered conversation's fixed Agent and project, preventing duplicate live connections. */
  authorize(request: IncomingMessage, agentId: AgentId): BridgeGrant | undefined {
    if (!sameOrigin(request)) return;
    const login = this.sessions.login(request);
    if (!login) return;
    const id = new URL(request.url!, 'http://localhost').searchParams.get('conversation');
    if (!id || this.active.has(id)) return;
    let conversation: Conversation;
    try {
      conversation = this.workspace.conversation(id);
    } catch {
      return;
    }
    const project = this.workspace.projects.find(
      (project) => project.id === conversation.projectId,
    );
    if (!project || conversation.agentId !== agentId) return;
    return {
      cwd: project.cwd,
      /** Tie the socket and exclusive conversation slot to the authenticated login's lifetime. */
      bind: (close) => {
        this.active.add(id);
        login.connections.add(close);
        return () => {
          this.active.delete(id);
          login.connections.delete(close);
        };
      },
    };
  }

  /** Release WebAuthn challenges, login timers and all owned ACP sockets on shutdown. */
  close(): void {
    this.passkeys.close();
    this.sessions.close();
    this.workspace.close();
  }
}
