import { readFileSync } from 'node:fs';
import { DatabaseConnection, SCHEMA_VERSION } from './database.ts';

const MIGRATIONS = ['001_workspace.sql', '002_agents.sql', '003_personal_settings.sql'];

/** Execute schema changes only during startup preparation or offline migration. */
export class SchemaMigration {
  /** Bind the connection used for schema transactions and validate the migration manifest. */
  constructor(private readonly connection: DatabaseConnection) {
    if (MIGRATIONS.length !== SCHEMA_VERSION) throw new Error('迁移清单与应用结构版本不一致');
  }

  /** Build a fresh database with the same ordered migrations used for upgrades and atomically insert initial data. */
  initialize(insert: () => void, legacyDigest: string | null = null): void {
    this.applyMigrations(0, insert, legacyDigest);
  }

  /** Reject missing/future versions before applying the remaining SQL files as one atomic upgrade. */
  upgrade(): void {
    const versions = this.connection.db
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
      this.connection.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      this.connection.db.prepare('PRAGMA foreign_key_check').all().length
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
    this.connection.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.connection.transaction(() => {
        for (let index = from; index < MIGRATIONS.length; index++) {
          this.connection.db.exec(
            readFileSync(new URL(`../../migration/${MIGRATIONS[index]}`, import.meta.url), 'utf8'),
          );
          this.connection.db
            .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)')
            .run(index + 1, Date.now(), index === 0 ? legacyDigest : null);
        }
        insert?.();
        if (this.connection.db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('数据库迁移外键校验失败');
      });
    } finally {
      this.connection.db.exec('PRAGMA foreign_keys=ON');
    }
  }
}
