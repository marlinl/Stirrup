import { isAgentId } from '../src/acp/agents.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  linkSync,
  unlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Workspace, Conversation, Project } from '../src/domain/models.ts';
import { string } from '../local/validation.ts';
import { parseMessage } from '../local/storage/records.ts';
import { DATABASE_NAME, DatabaseConnection } from '../local/storage/database.ts';

import { lockStorage } from './lock.ts';
import { SchemaMigration } from './schema.ts';

const uuid = /^[a-f0-9-]{36}$/;
/** Reject unknown keys or non-object records so migrations cannot silently discard source fields. */
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('记录含未知字段或格式无效');
  return value as Record<string, unknown>;
}
/** Validate legacy records without requiring historical project directories to be currently online. */
export function validateLegacy(input: Workspace): Workspace {
  if (!Array.isArray(input.projects) || !Array.isArray(input.conversations))
    throw new Error('项目或对话索引无效');
  const projects = input.projects.map((value) => {
    const row = object(value, ['id', 'name', 'cwd']);
    const project = {
      id: string(row.id, 128),
      name: string(row.name, 80),
      cwd: string(row.cwd, 4096),
    };
    if (!uuid.test(project.id) || !isAbsolute(project.cwd)) throw new Error('项目 ID 或路径无效');
    return project;
  });
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    new Set(projects.map((p) => p.cwd)).size !== projects.length
  )
    throw new Error('项目 ID 或路径重复');
  const conversations = input.conversations.map((value) => {
    const row = object(value, [
      'id',
      'projectId',
      'agentId',
      'title',
      'providerSessionId',
      'messages',
      'draft',
      'updatedAt',
      'revision',
    ]);
    if (
      !uuid.test(String(row.id)) ||
      !projects.some((p) => p.id === row.projectId) ||
      !isAgentId(row.agentId) ||
      !Number.isSafeInteger(row.updatedAt) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 0 ||
      !Array.isArray(row.messages) ||
      row.messages.length > 5000
    )
      throw new Error('对话归属、版本或消息格式无效');
    const messages = row.messages.map((value) => {
      const item = object(value, [
        'id',
        'kind',
        'text',
        'title',
        'toolCallId',
        'status',
        'details',
      ]);
      if (
        item.details !== undefined &&
        (!item.details || typeof item.details !== 'object' || Array.isArray(item.details))
      )
        throw new Error('消息 details 格式无效');
      return parseMessage(item);
    });
    if (new Set(messages.map((m) => m.id)).size !== messages.length)
      throw new Error('会话内消息 ID 重复');
    return {
      id: row.id,
      projectId: row.projectId,
      agentId: row.agentId,
      title: string(row.title, 120),
      draft: string(row.draft, 100_000, true),
      updatedAt: row.updatedAt,
      revision: row.revision,
      ...(row.providerSessionId !== undefined
        ? { providerSessionId: string(row.providerSessionId, 256) }
        : {}),
      messages,
    } as Conversation;
  });
  if (new Set(conversations.map((c) => c.id)).size !== conversations.length)
    throw new Error('对话 ID 重复');
  return {
    projects,
    conversations: conversations.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Parse a source file without including any private JSON content in diagnostics. */
function parseSource(file: { name: string; bytes: Buffer }): unknown {
  try {
    return JSON.parse(file.bytes.toString());
  } catch {
    throw new Error(`旧 JSON 无法解析：${file.name}`);
  }
}

/** Read only project/conversation source files and fingerprint their exact ordered bytes for repeatable migration. */
export function readLegacy(directory: string) {
  const names = ['projects.json'];
  const folder = join(directory, 'conversations');
  if (existsSync(folder))
    for (const name of readdirSync(folder).sort()) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error(`旧对话目录含未识别文件：${name}`);
      names.push(`conversations/${name}`);
    }
  const files = names.map((name) => ({
    name,
    bytes: readFileSync(join(directory, name)),
  }));
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(file.name).update('\0').update(createHash('sha256').update(file.bytes).digest());
  const data = validateLegacy({
    projects: parseSource(files[0]) as Project[],
    conversations: files.slice(1).map((file) => {
      const row = object(parseSource(file), [
        'id',
        'projectId',
        'agentId',
        'title',
        'providerSessionId',
        'messages',
        'draft',
        'updatedAt',
        'revision',
      ]);
      if (file.name !== `conversations/${row.id}.json`)
        throw new Error(`文件与对话 ID 不一致：${file.name}`);
      return row as unknown as Conversation;
    }),
  });
  return { data, files, digest: hash.digest('hex') };
}

/** Insert a validated workspace into a caller-owned initialization transaction, preserving every ID and version. */
function insertWorkspace(connection: DatabaseConnection, workspace: Workspace): void {
  const db = connection.db;
  const project = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)');
  workspace.projects.forEach((p, index) => project.run(p.id, p.name, p.cwd, index));
  const record = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const message = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
  for (const c of workspace.conversations) {
    record.run(
      c.id,
      c.projectId,
      c.agentId,
      c.title,
      c.providerSessionId ?? null,
      c.draft,
      c.updatedAt,
      c.revision,
    );
    c.messages.forEach(({ id, kind, ...payload }, index) =>
      message.run(c.id, id, index, kind, JSON.stringify(payload)),
    );
  }
}

/** Reconstruct database records for independent migration comparison or a validated offline JSON export. */
function readDatabase(connection: DatabaseConnection): Workspace {
  const db = connection.db;
  return validateLegacy({
    projects: db
      .prepare('SELECT id,name,cwd FROM projects ORDER BY position')
      .all() as unknown as Project[],
    conversations: db
      .prepare('SELECT * FROM conversations ORDER BY id')
      .all()
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        agentId: row.agent_id,
        title: row.title,
        draft: row.draft,
        updatedAt: row.updated_at,
        revision: row.revision,
        ...(row.provider_session_id !== null ? { providerSessionId: row.provider_session_id } : {}),
        messages: db
          .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY ordinal')
          .all(row.id)
          .map((m) => ({
            ...JSON.parse(String(m.payload_json)),
            id: m.id,
            kind: m.kind,
          })),
      })) as Conversation[],
  });
}

/** Migrate under exclusive ownership using a private backup and verified candidate, publishing without overwriting any database. */
export function migrateStorage(directory: string): {
  migrated: boolean;
  projects: number;
  conversations: number;
  backup?: string;
} {
  const unlock = lockStorage(directory);
  let connection: DatabaseConnection | undefined;
  const candidate = join(directory, `.migration-${randomUUID()}.sqlite`);
  try {
    const source = readLegacy(directory);
    const target = join(directory, DATABASE_NAME);
    if (existsSync(target)) {
      connection = new DatabaseConnection(target);
      new SchemaMigration(connection).upgrade();
      connection.verify();
      const marker = connection.db
        .prepare('SELECT legacy_digest FROM schema_migrations WHERE version=1')
        .get();
      if (marker?.legacy_digest !== source.digest) throw new Error('已有数据库来源不同，拒绝覆盖');
      return {
        migrated: false,
        projects: source.data.projects.length,
        conversations: source.data.conversations.length,
      };
    }
    const backup = join(directory, 'backups', `json-${Date.now()}-${randomUUID()}`);
    mkdirSync(join(backup, 'conversations'), { recursive: true, mode: 0o700 });
    for (const file of source.files)
      writeFileSync(join(backup, file.name), file.bytes, {
        mode: 0o600,
        flag: 'wx',
      });
    writeFileSync(
      join(backup, 'manifest.json'),
      JSON.stringify({
        digest: source.digest,
        files: source.files.map((file) => file.name),
      }),
      { mode: 0o600, flag: 'wx' },
    );
    if (readLegacy(backup).digest !== source.digest) throw new Error('源文件备份校验失败');
    connection = new DatabaseConnection(candidate, true);
    new SchemaMigration(connection).initialize(() => insertWorkspace(connection!, source.data), source.digest);
    connection.verify();
    if (!isDeepStrictEqual(readDatabase(connection), source.data))
      throw new Error('导入内容校验失败');
    if (readLegacy(directory).digest !== source.digest) throw new Error('迁移期间源数据发生变化');
    connection.close();
    connection = undefined;
    // A same-filesystem hard link publishes a fully closed candidate atomically and fails if the target exists.
    linkSync(candidate, target);
    unlinkSync(candidate);
    return {
      migrated: true,
      projects: source.data.projects.length,
      conversations: source.data.conversations.length,
      backup,
    };
  } finally {
    try {
      connection?.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(candidate + suffix, { force: true });
      unlock();
    }
  }
}

/** Export all committed records into a new private backup directory, verifying round-trip before reporting success. */
export function exportStorage(directory: string): string {
  const unlock = lockStorage(directory);
  let connection: DatabaseConnection | undefined;
  try {
    connection = new DatabaseConnection(join(directory, DATABASE_NAME));
    new SchemaMigration(connection).upgrade();
    connection.verify();
    const data = readDatabase(connection);
    const output = join(directory, 'backups', `export-${Date.now()}-${randomUUID()}`);
    mkdirSync(join(output, 'conversations'), { recursive: true, mode: 0o700 });
    writeFileSync(join(output, 'projects.json'), JSON.stringify(data.projects), {
      mode: 0o600,
      flag: 'wx',
    });
    for (const c of data.conversations)
      writeFileSync(join(output, 'conversations', `${c.id}.json`), JSON.stringify(c), {
        mode: 0o600,
        flag: 'wx',
      });
    if (!isDeepStrictEqual(readLegacy(output).data, data)) throw new Error('回退导出校验失败');
    return output;
  } finally {
    try {
      connection?.close();
    } finally {
      unlock();
    }
  }
}
