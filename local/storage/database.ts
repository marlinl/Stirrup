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
const MIGRATIONS = ['001_workspace.sql', '002_agents.sql', '003_personal_settings.sql'];
export const SCHEMA_VERSION = MIGRATIONS.length;

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

  /** Build a fresh database with the same ordered migrations used for upgrades and atomically insert initial data. */
  initialize(insert: () => void, legacyDigest: string | null = null): void {
    this.applyMigrations(0, insert, legacyDigest);
  }

  /** Reject missing/future versions before applying the remaining SQL files as one atomic upgrade. */
  upgrade(): void {
    const versions = this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all();
    if (
      !versions.length ||
      versions.length > SCHEMA_VERSION ||
      versions.some((row, index) => row.version !== index + 1)
    )
      throw new Error('数据库结构版本不受支持或迁移未完成');
    if (versions.length === SCHEMA_VERSION) return;
    if (
      this.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      this.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('数据库完整性校验失败');
    this.applyMigrations(versions.length);
  }

  /** Run pending migration SQL in order, allowing table rebuilds while checking foreign keys before commit. */
  private applyMigrations(
    from: number,
    insert?: () => void,
    legacyDigest: string | null = null,
  ): void {
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.transaction(() => {
        for (let index = from; index < MIGRATIONS.length; index++) {
          this.db.exec(
            readFileSync(new URL(`./migrations/${MIGRATIONS[index]}`, import.meta.url), 'utf8'),
          );
          this.db
            .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)')
            .run(index + 1, Date.now(), index === 0 ? legacyDigest : null);
        }
        insert?.();
        if (this.db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('数据库迁移外键校验失败');
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
