import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpError } from '../errors.ts';

export const DATABASE_NAME = 'stirrup.sqlite';
export const SCHEMA_VERSION = 2;

/** Exclusively own a data directory across the web runtime and offline tools; stale locks require operator inspection. */
export function lockStorage(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lock = join(directory, '.storage.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      '存储目录已锁定。请先停止 dev/preview 或迁移命令；遗留锁须确认原进程结束后再清理。',
    );
  }
  try {
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (error) {
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      rmSync(lock, { recursive: true, force: true });
    }
  };
}

/** Own one SQLite connection, PRAGMA policy and synchronous atomic transactions; callers own directory locking. */
export class DatabaseConnection {
  readonly db: DatabaseSync;
  private closed = false;

  /** Open an existing database or exclusively create a new file; never create a replacement for a missing existing database. */
  constructor(
    readonly filename: string,
    create = false,
  ) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (create) closeSync(openSync(filename, 'wx', 0o600));
    else if (!existsSync(filename)) throw new Error('数据库不存在');
    chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const mode = this.db.prepare('PRAGMA journal_mode=WAL').get();
      if (
        mode?.journal_mode !== 'wal' ||
        this.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
        this.db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
        this.db.prepare('SELECT json_valid(\'{"ok":true}\') AS valid').get()?.valid !== 1
      )
        throw new Error('SQLite 配置或 JSON 功能不可用');
      for (const suffix of ['-wal', '-shm'])
        if (existsSync(filename + suffix)) chmodSync(filename + suffix, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Create schema and caller-supplied initial records together, recording the source digest only after successful import. */
  initialize(insert: () => void, legacyDigest: string | null = null): void {
    this.transaction(() => {
      this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      insert();
      this.db
        .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)')
        .run(1, Date.now(), legacyDigest);
      this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?, NULL)').run(2, Date.now());
    });
  }

  /** Expand the v1 Agent constraint atomically, preserving messages and the original import digest. */
  upgrade(): void {
    const versions = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    if (versions.length !== 1 || versions[0].version !== 1) return;
    if (
      this.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      this.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('数据库完整性校验失败');
    // SQLite table rebuild requires foreign keys disabled outside the transaction.
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.transaction(() => {
        this.db.exec(readFileSync(new URL('./002_agents.sql', import.meta.url), 'utf8'));
        if (this.db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('数据库迁移外键校验失败');
        this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?, NULL)').run(2, Date.now());
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON');
    }
  }

  /** Reject incomplete, newer or corrupt databases instead of presenting an empty workspace. */
  verify(): void {
    const versions = this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all();
    if (versions.length !== SCHEMA_VERSION || versions.some((row, index) => row.version !== index + 1))
      throw new Error('数据库结构版本不受支持或迁移未完成');
    if (
      this.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      this.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('数据库完整性校验失败');
    this.db.prepare('SELECT id, name, cwd, position FROM projects').all();
    this.db
      .prepare(
        'SELECT id, project_id, agent_id, title, provider_session_id, draft, updated_at, revision FROM conversations LIMIT 0',
      )
      .all();
    this.db
      .prepare('SELECT conversation_id, id, ordinal, kind, payload_json FROM messages LIMIT 0')
      .all();
  }

  /** Commit synchronous work as one write transaction; roll back all changes and map lock contention to retryable HTTP status. */
  transaction<T>(work: () => T): T {
    let started = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      started = true;
      const result = work();
      if (result instanceof Promise) throw new Error('SQLite 事务不得等待异步操作');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (started) this.db.exec('ROLLBACK');
      const code = (error as { errcode?: number }).errcode;
      if (code !== undefined && [5, 6].includes(code & 255))
        throw new HttpError(503, '数据库正忙，请稍后重试');
      throw error;
    }
  }

  /** Checkpoint committed WAL data before closing; safe to call again during shutdown cleanup. */
  close(): void {
    if (this.closed) return;
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (result?.busy !== 0) throw new Error('数据库 checkpoint 未完成');
    } finally {
      this.closed = true;
      this.db.close();
    }
  }
}
