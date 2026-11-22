import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { AgentId } from '../../src/acp/agents.ts';
import type { Conversation, Message, Project, Workspace } from '../../src/domain/models.ts';
import { HttpError } from '../errors.ts';
import { string } from '../validation.ts';
import { DATABASE_NAME, DatabaseConnection, lockStorage, SCHEMA_VERSION } from './database.ts';
import { parseMessage } from './records.ts';

/** Map application snapshots to SQLite; HTTP, credentials and live Agent connections remain outside storage. */
export class WorkspaceStore {
  readonly connection: DatabaseConnection;
  private readonly unlock: () => void;

  /** Open one exclusively owned store, refusing to hide old JSON behind a new empty database. */
  constructor(root: string, dataDir = join(root, '.local/web')) {
    this.unlock = lockStorage(dataDir);
    let connection: DatabaseConnection | undefined;
    try {
      const file = join(dataDir, DATABASE_NAME);
      const fresh = !existsSync(file);
      if (
        fresh &&
        (existsSync(join(dataDir, 'projects.json')) || existsSync(join(dataDir, 'conversations')))
      )
        throw new Error('发现旧 JSON 数据，请停止服务后运行 npm run storage:migrate');
      connection = new DatabaseConnection(file, fresh);
      if (fresh)
        connection.initialize(() => {
          connection!.db
            .prepare('INSERT INTO projects VALUES (?, ?, ?, 0)')
            .run(randomUUID(), basename(root), realpathSync(root));
        });
      connection.verify();
      this.connection = connection;
    } catch (error) {
      try {
        connection?.close();
      } finally {
        this.unlock();
      }
      throw error;
    }
  }

  /** Return fresh project rows in the original registration order without caching mutable data. */
  get projects(): Project[] {
    return this.connection.db
      .prepare('SELECT id, name, cwd FROM projects ORDER BY position')
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        cwd: String(row.cwd),
      }));
  }

  /** Retrieve an opaque UUID conversation and reconstruct its ordered JSON message payloads. */
  conversation(id: string): Conversation {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, '会话不存在');
    const row = this.connection.db
      .prepare(
        `SELECT id, project_id AS projectId, agent_id AS agentId,
      title, provider_session_id AS providerSessionId, draft, updated_at AS updatedAt, revision
      FROM conversations WHERE id=?`,
      )
      .get(id);
    if (!row) throw new HttpError(404, '会话不存在');
    const { providerSessionId, ...record } = row;
    const messages = this.connection.db
      .prepare(
        'SELECT id, kind, payload_json FROM messages WHERE conversation_id=? ORDER BY ordinal',
      )
      .all(id)
      .map(
        ({ id, kind, payload_json }) =>
          ({ ...JSON.parse(String(payload_json)), id, kind }) as Message,
      );
    return {
      ...record,
      ...(providerSessionId !== null ? { providerSessionId } : {}),
      messages,
    } as unknown as Conversation;
  }

  /** Load saved history in stable project/message order without starting any Agent processes. */
  list(): Workspace {
    return {
      projects: this.projects,
      conversations: this.connection.db
        .prepare('SELECT id FROM conversations ORDER BY updated_at DESC, id')
        .all()
        .map((row) => this.conversation(String(row.id))),
    };
  }

  /** Return metadata counts only for the authenticated settings projection. */
  summary() {
    const db = this.connection.db;
    return {
      backend: 'sqlite' as const,
      location: '.local/web/stirrup.sqlite',
      schemaVersion: SCHEMA_VERSION,
      projectCount: Number(db.prepare('SELECT count(*) AS n FROM projects').get()!.n),
      conversationCount: Number(db.prepare('SELECT count(*) AS n FROM conversations').get()!.n),
      messageCount: Number(db.prepare('SELECT count(*) AS n FROM messages').get()!.n),
    };
  }

  /** Register a canonical existing directory once and append its stable position transactionally. */
  addProject(input: Record<string, unknown>): {
    project: Project;
    created: boolean;
  } {
    const path = string(input.cwd, 4096);
    if (!isAbsolute(path)) throw new HttpError(400, '请输入本地绝对目录');
    let cwd: string;
    try {
      cwd = realpathSync(path);
      if (!statSync(cwd).isDirectory()) throw new Error();
    } catch {
      throw new HttpError(400, '目录不存在或不可访问');
    }
    const project = {
      id: randomUUID(),
      name: string(input.name || basename(cwd), 80).trim(),
      cwd,
    };
    return this.connection.transaction(() => {
      const existing = this.projects.find((item) => item.cwd === cwd);
      if (existing) return { project: existing, created: false };
      this.connection.db
        .prepare('INSERT INTO projects SELECT ?, ?, ?, coalesce(max(position), -1)+1 FROM projects')
        .run(project.id, project.name, cwd);
      return { project, created: true };
    });
  }

  /** Create one empty record permanently bound to its registered project and supported Agent. */
  createConversation(input: Record<string, unknown>): Conversation {
    if (
      !this.projects.some((item) => item.id === input.projectId) ||
      !['codex', 'dsh'].includes(String(input.agentId))
    )
      throw new HttpError(400, '项目或 Agent 无效');
    const record: Conversation = {
      id: randomUUID(),
      projectId: input.projectId as string,
      agentId: input.agentId as AgentId,
      title: '新对话',
      draft: '',
      messages: [],
      updatedAt: Date.now(),
      revision: 0,
    };
    this.connection.transaction(() =>
      this.connection.db
        .prepare(
          `INSERT INTO conversations
      (id, project_id, agent_id, title, draft, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.agentId,
          record.title,
          record.draft,
          record.updatedAt,
          record.revision,
        ),
    );
    return record;
  }

  /** Replace a validated full snapshot atomically, rejecting stale revisions and preserving immutable binding. */
  saveConversation(
    id: string,
    input: Record<string, unknown>,
  ): { revision: number; updatedAt: number } {
    if (!Array.isArray(input.messages) || input.messages.length > 5000)
      throw new HttpError(400, '消息数量无效');
    const messages = input.messages.map(parseMessage);
    if (new Set(messages.map((item) => item.id)).size !== messages.length)
      throw new HttpError(400, '消息 ID 重复');
    const payloads = messages.map(({ id, kind, ...payload }) => ({
      id,
      kind,
      json: JSON.stringify(payload),
    }));
    const title = string(input.title, 120);
    const draft = string(input.draft, 100_000, true);
    const provider =
      input.providerSessionId === undefined ? undefined : string(input.providerSessionId, 256);
    return this.connection.transaction(() => {
      const current = this.conversation(id);
      if (input.revision !== current.revision)
        throw new HttpError(409, '此会话已在另一窗口更新，请刷新后继续');
      const updatedAt = Date.now();
      const result = this.connection.db
        .prepare(
          `UPDATE conversations SET title=?, draft=?, provider_session_id=?,
        updated_at=?, revision=revision+1 WHERE id=? AND revision=?`,
        )
        .run(
          title,
          draft,
          provider ?? current.providerSessionId ?? null,
          updatedAt,
          id,
          current.revision,
        );
      if (result.changes !== 1) throw new HttpError(409, '此会话已在另一窗口更新，请刷新后继续');
      this.connection.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
      const insert = this.connection.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
      payloads.forEach((item, index) => insert.run(id, item.id, index, item.kind, item.json));
      return { revision: current.revision + 1, updatedAt };
    });
  }

  /** Close the database before releasing exclusive directory ownership. */
  close(): void {
    try {
      this.connection.close();
    } finally {
      this.unlock();
    }
  }
}
