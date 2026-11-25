import { SchemaMigration } from '../src/storage/schema.ts';
import { lockStorage } from '../src/storage/lock.ts';
import { prepareStorage } from '../src/storage/prepare.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/storage/workspace-store.ts';
import { DatabaseConnection, DATABASE_NAME } from '../src/storage/database.ts';
import { migrateStorage, exportStorage, readLegacy } from '../src/storage/legacy-json.ts';
import type { Workspace } from '../shared/models.ts';

/** Allocate a private fixture root and remove only that isolated test directory afterward. */
function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'stirrup-sqlite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
/** Write representative legacy records including optional JSON values and paths that are currently offline. */
function fixture(root: string): { directory: string; data: Workspace } {
  const directory = join(root, '.local/web');
  const projectId = randomUUID();
  const data: Workspace = {
    projects: [{ id: projectId, name: '离线项目', cwd: '/offline/project' }],
    conversations: [
      {
        id: randomUUID(),
        projectId,
        agentId: 'dsh',
        title: '中文对话',
        providerSessionId: 'opaque-context',
        draft: '未发送',
        updatedAt: 123,
        revision: 7,
        messages: [
          {
            id: 'm2',
            kind: 'tool',
            text: '工具',
            title: '',
            details: { array: [1, '二'], nested: { ok: true } },
          },
          { id: 'm1', kind: 'user', text: '你好' },
        ],
      },
    ],
  };
  mkdirSync(join(directory, 'conversations'), { recursive: true });
  writeFileSync(join(directory, 'projects.json'), JSON.stringify(data.projects));
  writeFileSync(
    join(directory, 'conversations', `${data.conversations[0].id}.json`),
    JSON.stringify(data.conversations[0]),
  );
  return { directory, data };
}

test('SQLite round-trip, transaction failure rollback, stale revisions, foreign keys and durable reopen', (t) => {
  const root = rootFor(t);
  prepareStorage(root);
  const store = new WorkspaceStore(root);
  t.after(() => store.close());
  const c = store.createConversation({
    projectId: store.projects[0].id,
    agentId: 'codex',
  });
  store.saveConversation(c.id, {
    ...c,
    title: 'saved',
    providerSessionId: 'ctx',
    messages: [{ id: 'one', kind: 'tool', text: '原始', details: { ok: true } }],
  });
  const original = store.conversation(c.id);
  store.connection.db
    .exec(`CREATE TEMP TRIGGER fail_message BEFORE INSERT ON messages WHEN new.id='fail'
    BEGIN SELECT RAISE(ABORT, 'injected disk/write failure'); END;`);
  assert.throws(
    () =>
      store.saveConversation(c.id, {
        ...original,
        messages: [
          { id: 'first', kind: 'user', text: 'partial' },
          { id: 'fail', kind: 'assistant', text: 'bad' },
        ],
      }),
    /injected/,
  );
  assert.deepEqual(store.conversation(c.id), original);
  assert.throws(() => store.saveConversation(c.id, { ...original, revision: 0 }), /另一窗口/);
  const { providerSessionId, ...withoutProvider } = original;
  store.saveConversation(c.id, {
    ...withoutProvider,
    agentId: 'dsh',
    projectId: 'tamper',
    draft: '草稿',
  });
  assert.equal(store.conversation(c.id).providerSessionId, 'ctx');
  assert.equal(store.conversation(c.id).agentId, 'codex');
  assert.throws(() =>
    store.connection.db.prepare('DELETE FROM projects WHERE id=?').run(c.projectId),
  );
  assert.deepEqual(store.connection.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(store.connection.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(root, '.local/web', DATABASE_NAME + suffix);
    if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  store.close();
  const reopened = new WorkspaceStore(root);
  t.after(() => reopened.close());
  assert.equal(reopened.conversation(c.id).draft, '草稿');
  assert.equal(reopened.conversation(c.id).revision, 2);
});

test('migration preserves exact records, backs up source, is idempotent and exports post-migration writes', (t) => {
  const root = rootFor(t);
  const { directory, data } = fixture(root);
  writeFileSync(join(root, '.env'), 'LOCAL_SENTINEL=unchanged\n');
  writeFileSync(join(directory, 'passkey-enrollment.json'), 'auth-sentinel');
  assert.throws(() => prepareStorage(root), /storage:migrate/);
  const before = readLegacy(directory).digest;
  const result = migrateStorage(directory);
  assert.equal(result.migrated, true);
  assert.equal(readLegacy(result.backup!).digest, before);
  assert.equal(readLegacy(directory).digest, before);
  assert.equal(migrateStorage(directory).migrated, false);
  prepareStorage(root);
  const store = new WorkspaceStore(root);
  assert.deepEqual(store.list(), data);
  store.saveConversation(data.conversations[0].id, {
    ...data.conversations[0],
    draft: '切换后的新草稿',
  });
  const updated = store.list();
  store.close();
  const exported = exportStorage(directory);
  assert.deepEqual(readLegacy(exported).data, updated);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'LOCAL_SENTINEL=unchanged\n');
  assert.equal(readFileSync(join(directory, 'passkey-enrollment.json'), 'utf8'), 'auth-sentinel');
});

test('corrupt, unknown-field and duplicate legacy data fail without publishing or losing source', (t) => {
  const root = rootFor(t);
  const { directory, data } = fixture(root);
  const file = join(directory, 'conversations', `${data.conversations[0].id}.json`);
  for (const body of [
    '{broken',
    JSON.stringify({ ...data.conversations[0], unknown: 'keep me' }),
    JSON.stringify({
      ...data.conversations[0],
      messages: [data.conversations[0].messages[0], data.conversations[0].messages[0]],
    }),
  ]) {
    writeFileSync(file, body);
    assert.throws(() => migrateStorage(directory));
    assert.equal(existsSync(join(directory, DATABASE_NAME)), false);
    assert.equal(readFileSync(file, 'utf8'), body);
    assert.equal(existsSync(join(directory, '.storage.lock')), false);
  }
});

test('migration ownership ends before runtime; existing database is never overwritten', (t) => {
  const root = rootFor(t);
  const { directory } = fixture(root);
  const unlock = lockStorage(directory);
  assert.throws(() => migrateStorage(directory), /锁定/);
  unlock();
  migrateStorage(directory);
  prepareStorage(root);
  const store = new WorkspaceStore(root);
  assert.equal(existsSync(join(directory, '.storage.lock')), false);
  const second = new WorkspaceStore(root);
  assert.deepEqual(second.projects, store.projects);
  second.close();
  store.close();
  writeFileSync(join(directory, 'projects.json'), '[]');
  assert.throws(() => migrateStorage(directory));
  const reopened = new WorkspaceStore(root);
  assert.equal(reopened.projects.length, 1);
  reopened.close();
});

test('SQLite busy timeout produces retryable 503 without changing a snapshot', (t) => {
  const root = rootFor(t);
  prepareStorage(root);
  const store = new WorkspaceStore(root);
  t.after(() => store.close());
  const c = store.createConversation({
    projectId: store.projects[0].id,
    agentId: 'dsh',
  });
  const second = new DatabaseConnection(join(root, '.local/web', DATABASE_NAME));
  second.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(
      () => store.saveConversation(c.id, { ...c, draft: 'busy' }),
      (error) => (error as { status: number }).status === 503,
    );
  } finally {
    second.db.exec('ROLLBACK');
    second.close();
  }
  assert.equal(store.conversation(c.id).draft, '');
});

test('partial candidate is ignored and incomplete final database is rejected', (t) => {
  const root = rootFor(t);
  const { directory } = fixture(root);
  writeFileSync(join(directory, '.migration-interrupted.sqlite'), 'incomplete candidate');
  migrateStorage(directory);
  prepareStorage(root);
  const store = new WorkspaceStore(root);
  store.close();
  const other = rootFor(t);
  const dir = join(other, '.local/web');
  mkdirSync(dir, { recursive: true });
  const empty = new DatabaseConnection(join(dir, DATABASE_NAME), true);
  empty.close();
  assert.throws(() => new WorkspaceStore(other));
  assert.equal(existsSync(join(dir, '.storage.lock')), false);
});

test('v1 upgrade preserves old messages and revisions and permits AGY after reopen', (t) => {
  const root = rootFor(t);
  const directory = join(root, '.local/web');
  const filename = join(directory, DATABASE_NAME);
  const db = new DatabaseConnection(filename, true);
  const schema = readFileSync(
    new URL('../migration/001_workspace.sql', import.meta.url),
    'utf8',
  ).replace("'codex', 'dsh', 'agy'", "'codex', 'dsh'");
  db.db.exec(schema);
  const project = randomUUID();
  const conversation = randomUUID();
  db.db.prepare('INSERT INTO schema_migrations VALUES (1, 123, ?)').run('original-digest');
  db.db.prepare('INSERT INTO projects VALUES (?, ?, ?, 0)').run(project, 'project', root);
  db.db
    .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(conversation, project, 'codex', 'history', 'provider-context', 'draft', 123, 7);
  db.db
    .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
    .run(conversation, 'm1', 0, 'assistant', JSON.stringify({ text: 'retained' }));
  db.db.exec(`CREATE TRIGGER fail_upgrade BEFORE INSERT ON schema_migrations
    WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  db.close();
  assert.throws(() => new WorkspaceStore(root), /injected migration failure/);
  const failed = new DatabaseConnection(filename);
  assert.equal(failed.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 1);
  assert.equal(failed.db.prepare('SELECT count(*) AS n FROM messages').get()?.n, 1);
  assert.match(
    String(
      failed.db.prepare("SELECT sql FROM sqlite_master WHERE name='conversations'").get()?.sql,
    ),
    /'codex', 'dsh'\)/,
  );
  failed.db.exec('DROP TRIGGER fail_upgrade');
  failed.close();
  const store = new WorkspaceStore(root);
  const old = store.conversation(conversation);
  assert.equal(old.messages[0].text, 'retained');
  assert.equal(old.revision, 7);
  assert.equal(old.draft, 'draft');
  assert.equal(old.providerSessionId, 'provider-context');
  assert.equal(
    store.connection.db.prepare('SELECT legacy_digest FROM schema_migrations WHERE version=1').get()
      ?.legacy_digest,
    'original-digest',
  );
  for (const agentId of ['agy']) {
    const c = store.createConversation({ projectId: project, agentId });
    store.saveConversation(c.id, {
      ...c,
      messages: [{ id: 'reply', kind: 'assistant', text: agentId }],
    });
  }
  assert.throws(() => store.createConversation({ projectId: project, agentId: 'toString' }));
  assert.equal(store.connection.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  store.close();
  const reopened = new WorkspaceStore(root);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.conversation(conversation), old);
  assert.equal(
    reopened.connection.db.prepare('SELECT count(*) AS n FROM conversations').get()?.n,
    2,
  );
  reopened.connection.verify();
});

test('v2 migration creates an empty personal table atomically and rejects missing or future migration versions', (t) => {
  const root = rootFor(t);
  const filename = join(root, '.local/web', DATABASE_NAME);
  const connection = new DatabaseConnection(filename, true);
  for (const [index, name] of ['001_workspace.sql', '002_agents.sql'].entries()) {
    connection.db.exec(
      readFileSync(new URL(`../migration/${name}`, import.meta.url), 'utf8'),
    );
    connection.db.prepare('INSERT INTO schema_migrations VALUES (?, 123, NULL)').run(index + 1);
  }
  connection.db.exec(`CREATE TRIGGER fail_personal BEFORE INSERT ON schema_migrations
    WHEN NEW.version=3 BEGIN SELECT RAISE(ABORT, 'personal migration failure'); END`);
  assert.throws(() => new SchemaMigration(connection).upgrade(), /personal migration failure/);
  assert.equal(
    connection.db.prepare("SELECT name FROM sqlite_master WHERE name='personal_settings'").get(),
    undefined,
  );
  assert.equal(
    connection.db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version,
    2,
  );
  assert.equal(connection.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  connection.db.exec('DROP TRIGGER fail_personal');
  new SchemaMigration(connection).upgrade();
  connection.verify();
  assert.equal(connection.db.prepare('SELECT count(*) AS n FROM personal_settings').get()?.n, 0);
  new SchemaMigration(connection).upgrade();
  assert.equal(connection.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 3);
  connection.db.exec('INSERT INTO schema_migrations VALUES (4, 123, NULL)');
  assert.throws(() => new SchemaMigration(connection).upgrade(), /版本/);
  connection.db.exec('DELETE FROM schema_migrations WHERE version=4 OR version=2');
  assert.throws(() => new SchemaMigration(connection).upgrade(), /版本/);
  connection.close();
});

test('startup initializes SQLite automatically and reopening preserves data and migration records', (t) => {
  const root = rootFor(t);
  const filename = join(root, '.local/web', DATABASE_NAME);
  assert.equal(existsSync(filename), false);
  const first = new WorkspaceStore(root);
  const projects = first.projects;
  const versions = first.connection.db.prepare('SELECT * FROM schema_migrations').all();
  first.close();
  const second = new WorkspaceStore(root);
  assert.deepEqual(second.projects, projects);
  assert.deepEqual(second.connection.db.prepare('SELECT * FROM schema_migrations').all(), versions);
  assert.equal(existsSync(join(root, '.local/web/.storage.lock')), false);
  second.close();
});
