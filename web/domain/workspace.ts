import type * as acp from '@agentclientprotocol/sdk';
import { AcpClient, type Permission } from '../acp/client';
import { AGENTS, type AgentId } from '../acp/agents';
import { openWebSocket } from '../acp/websocket';
import type { Conversation, Message, Project, Workspace } from '../../shared/models.ts';

import type { Api } from '../api/client';
export interface LiveConversation {
  client?: AcpClient;
  opening?: Promise<void>;
  permissions: Permission[];
  chunks: Map<string, string>;
  tools: Map<string, string>;
  connectionError?: string;
  saveError?: string;
  saveTimer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
  dirty: boolean;
}

/** Keep one independent client and persistence queue per conversation, separate from visible selection. */
export class WorkspaceController {
  projects: Project[] = [];
  conversations: Conversation[] = [];
  readonly live = new Map<string, LiveConversation>();
  private disposed = false;

  /** Wire the data API and view invalidation callback without owning any DOM or selected agent. */
  constructor(
    private readonly api: Api,
    private readonly changed: (id?: string) => void,
  ) {}

  /** Load saved application history without automatically launching agents or replaying prompts. */
  async load(): Promise<void> {
    const data = await this.api<Workspace>('/api/workspace');
    this.projects = data.projects;
    this.conversations = data.conversations;
    this.changed();
  }

  /** Lazily allocate transient state; history rows alone never allocate agent processes. */
  state(id: string): LiveConversation {
    let state = this.live.get(id);
    if (!state) {
      state = { permissions: [], chunks: new Map(), tools: new Map(), dirty: false };
      this.live.set(id, state);
    }
    return state;
  }

  /** Retrieve the authoritative application record for a UI action. */
  record(id: string): Conversation {
    const record = this.conversations.find((item) => item.id === id);
    if (!record) throw new Error('会话不存在');
    return record;
  }

  /** Register a validated local project; canonical duplicates are reused by the server. */
  async addProject(name: string, cwd: string): Promise<Project> {
    const project = await this.api<Project>('/api/projects', 'POST', { name, cwd });
    if (!this.projects.some((item) => item.id === project.id)) this.projects.push(project);
    this.changed();
    return project;
  }

  /** Create a saved empty conversation; connecting is explicit and can be retried independently. */
  async create(projectId: string, agentId: AgentId): Promise<Conversation> {
    const record = await this.api<Conversation>('/api/conversations', 'POST', {
      projectId,
      agentId,
    });
    this.conversations.unshift(record);
    this.changed();
    return record;
  }

  /** Connect and create or restore this record's agent context, retaining authentication options on failure. */
  async connect(id: string): Promise<void> {
    const state = this.state(id);
    if (state.opening) return state.opening;
    state.connectionError = undefined;
    const record = this.record(id);
    const project = this.projects.find((item) => item.id === record.projectId)!;
    state.opening = (async () => {
      if (!state.client || state.client.phase === 'closed') {
        const url = new URL(AGENTS[record.agentId].endpoint, location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('conversation', id);
        const transport = await openWebSocket(url.href);
        if (this.disposed) {
          transport.close();
          return;
        }
        state.client = new AcpClient(transport, {
          /** Publish only this connection's status so background turns cannot replace the active view. */
          state: () => this.changed(id),
          /** Route notifications to their owning application conversation, never a global selection. */
          update: (notification) => this.update(id, notification.update),
          /** Keep independent approvals, including for conversations not currently visible. */
          permissions: (items) => {
            state.permissions = items;
            this.changed(id);
          },
        });
        await state.client.initialize();
      }
      if (!state.client.sessionId) {
        if (record.providerSessionId)
          await state.client.restoreSession(project.cwd, record.providerSessionId);
        else {
          const result = await state.client.newSession(project.cwd);
          record.providerSessionId = result.sessionId;
          this.touch(id);
          await this.flush(id);
        }
      }
    })();
    this.changed(id);
    try {
      await state.opening;
    } catch (error) {
      state.connectionError = error instanceof Error ? error.message : '连接失败';
      throw error;
    } finally {
      state.opening = undefined;
      this.changed(id);
    }
  }

  /** Append a stable message and schedule a durable snapshot of the owning conversation. */
  addMessage(id: string, kind: Message['kind'], text: string, title?: string): Message {
    const message: Message = { id: crypto.randomUUID(), kind, text, ...(title ? { title } : {}) };
    this.record(id).messages.push(message);
    this.touch(id);
    return message;
  }

  /** Merge ACP messages and tool events into this conversation's current turn using stable IDs. */
  update(id: string, update: acp.SessionUpdate): void {
    const state = this.state(id);
    const record = this.record(id);
    const type = update.sessionUpdate;
    if (
      type === 'agent_message_chunk' ||
      type === 'agent_thought_chunk' ||
      type === 'user_message_chunk'
    ) {
      let message = record.messages.find((item) => item.id === state.chunks.get(type));
      if (!message) {
        message = this.addMessage(
          id,
          type === 'agent_thought_chunk'
            ? 'thought'
            : type === 'user_message_chunk'
              ? 'notice'
              : 'assistant',
          '',
        );
        state.chunks.set(type, message.id);
      }
      message.text +=
        update.content.type === 'text' ? update.content.text : `\n[${update.content.type}]\n`;
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      let message = record.messages.find((item) => item.id === state.tools.get(update.toolCallId));
      if (!message) {
        message = this.addMessage(id, 'tool', '');
        message.toolCallId = update.toolCallId;
        message.details = {};
        state.tools.set(update.toolCallId, message.id);
      }
      Object.assign(
        message.details!,
        Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)),
      );
      message.title = String(message.details!.title ?? '工具调用');
      message.status = String(message.details!.status ?? 'pending');
      message.text = JSON.stringify(message.details, null, 2);
    } else if (type === 'plan') {
      let message = record.messages.find((item) => item.id === state.chunks.get('plan'));
      if (!message) {
        message = this.addMessage(id, 'plan', '', '执行计划');
        state.chunks.set('plan', message.id);
      }
      message.details = { entries: update.entries };
      message.text = update.entries.map((entry) => `${entry.status} · ${entry.content}`).join('\n');
    } else if (type !== 'config_option_update' && type !== 'current_mode_update') {
      this.addMessage(id, 'event', JSON.stringify(update, null, 2), type);
    }
    this.touch(id);
  }

  /** Submit one idle turn to its owning record; preserve the submitted draft on failure without overwriting later edits. */
  async send(id: string, text: string): Promise<void> {
    const state = this.state(id);
    if (
      !text.trim() ||
      !state.client?.sessionId ||
      state.client.phase !== 'ready' ||
      state.opening ||
      state.permissions.length
    )
      throw new Error('请先连接会话，或等待当前操作结束');
    const record = this.record(id);
    state.chunks.clear();
    state.tools.clear();
    if (!record.messages.some((item) => item.kind === 'user'))
      record.title = text.trim().slice(0, 48);
    record.draft = '';
    this.addMessage(id, 'user', text);
    try {
      const result = await state.client.prompt(text);
      this.addMessage(
        id,
        'notice',
        result.stopReason === 'end_turn' ? '本轮完成' : `本轮结束 · ${result.stopReason}`,
      );
    } catch (error) {
      if (!record.draft) record.draft = text;
      this.addMessage(id, 'error', error instanceof Error ? error.message : '对话失败');
    } finally {
      await this.flush(id);
    }
  }

  /** Update a conversation draft without starting an agent or touching other drafts. */
  draft(id: string, text: string): void {
    this.record(id).draft = text;
    this.touch(id, false);
  }

  /** Mark changed state and coalesce streaming writes; the final turn explicitly flushes. */
  private touch(id: string, notify = true): void {
    const state = this.state(id);
    state.dirty = true;
    if (!state.saveTimer)
      state.saveTimer = setTimeout(() => {
        state.saveTimer = undefined;
        void this.flush(id);
      }, 500);
    if (notify) this.changed(id);
  }

  /** Serialize snapshots with optimistic revisions; report failures instead of silently losing history. */
  async flush(id: string): Promise<void> {
    const state = this.state(id);
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = undefined;
    }
    if (state.saving) {
      await state.saving;
      if (state.dirty && !state.saveError) await this.flush(id);
      return;
    }
    if (!state.dirty || this.disposed) return;
    state.dirty = false;
    const snapshot = structuredClone(this.record(id));
    state.saving = (async () => {
      try {
        const result = await this.api<{ revision: number; updatedAt: number }>(
          `/api/conversations/${id}`,
          'PUT',
          snapshot,
        );
        Object.assign(this.record(id), result);
        state.saveError = undefined;
      } catch (error) {
        state.dirty = true;
        state.saveError = error instanceof Error ? error.message : '会话保存失败';
      }
    })();
    await state.saving;
    state.saving = undefined;
    this.changed(id);
    if (state.dirty && !state.saveError) await this.flush(id);
  }

  /** Save pending drafts and messages before an intentional logout. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.flush(id)));
  }

  /** Stop all transient clients and save timers on logout or page teardown, retaining saved records. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.live.values()) {
      clearTimeout(state.saveTimer);
      state.client?.close();
    }
    this.live.clear();
  }
}
