import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Exclusively own a data directory during startup migration and offline tools; stale locks require operator inspection. */
export function lockStorage(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lock = join(directory, '.storage.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      '存储目录已锁定。请先停止 其他迁移命令；遗留锁须确认原进程结束后再清理。',
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

