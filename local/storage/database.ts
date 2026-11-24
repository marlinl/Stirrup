import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from '../errors.ts';

export const DATABASE_NAME = 'stirrup.sqlite';
export const SCHEMA_VERSION = 3;

/** Own one SQLite connection, PRAGMA policy and synchronous atomic transactions; schema changes belong to the startup migration tool. */
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

  /** Reject incomplete, newer or corrupt databases instead of presenting an empty workspace. */
  verify(): void {
    const versions = this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all();
    if (
      versions.length !== SCHEMA_VERSION ||
      versions.some((row, index) => row.version !== index + 1)
    )
      throw new Error('数据库结构版本不受支持或迁移未完成');
    if (
      this.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      this.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('数据库完整性校验失败');
    this.db.prepare('SELECT id, name, cwd, position FROM projects').all();
    this.db
      .prepare(
        'SELECT user_id, user_name, passkey_rp_id, credential_json, session_ttl_seconds, preferences_json, preferences_revision, revision, updated_at FROM personal_settings LIMIT 0',
      )
      .all();
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
