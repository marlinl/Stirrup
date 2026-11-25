import { cpSync } from 'node:fs';

// Preserve the SQL resource location relative to compiled storage modules.
cpSync(
  new URL('../migration/', import.meta.url),
  new URL('../dist/server/migration/', import.meta.url),
  {
    recursive: true,
  },
);
