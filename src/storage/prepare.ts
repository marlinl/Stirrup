import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATABASE_NAME, DatabaseConnection } from './database.ts';
import { lockStorage } from './lock.ts';
import { SchemaMigration } from './schema.ts';

/** Prepare storage before the server starts; release migration ownership before runtime begins. */
export function prepareStorage(root: string, directory = join(root, '.local/web')): void {
  const unlock = lockStorage(directory);
  const target = join(directory, DATABASE_NAME);
  const candidate = join(directory, `.migration-${randomUUID()}.sqlite`);
  let connection: DatabaseConnection | undefined;
  try {
    if (existsSync(target)) {
      connection = new DatabaseConnection(target);
      new SchemaMigration(connection).upgrade();
      connection.verify();
    } else {
      if (existsSync(join(directory, 'projects.json')) || existsSync(join(directory, 'conversations')))
        throw new Error('发现旧 JSON 数据，请停止服务后运行 npm run storage:migrate');
      connection = new DatabaseConnection(candidate, true);
      new SchemaMigration(connection).initialize(() => {
        connection!.db.prepare('INSERT INTO projects VALUES (?, ?, ?, 0)')
          .run(randomUUID(), basename(root), realpathSync(root));
      });
      connection.verify();
      connection.close();
      connection = undefined;
      linkSync(candidate, target);
      unlinkSync(candidate);
    }
  } finally {
    try {
      connection?.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(candidate + suffix, { force: true });
      unlock();
    }
  }
}
