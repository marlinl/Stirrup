import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** Read only root/.env without exporting secrets into process.env; a missing file has no overrides. */
export function readAppEnv(root: string): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('无法读取项目 .env 配置');
  }
}
