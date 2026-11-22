import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WorkspaceStore } from '../local/storage/workspace-store.ts';
import { WebRuntime } from '../local/runtime.ts';
import { readSessionTtlSeconds } from '../local/auth/sessions.ts';
import { attachAcpBridge } from '../local/acp/bridge.ts';
import {
  prepareEnrollment,
  readPasskeyConfig,
  writePasskeyConfig,
} from '../local/auth/passkey-store.ts';
import { testAuthenticator } from './fixtures/passkey.ts';
import type { Conversation, Workspace } from '../src/domain/models.ts';

/** Start an isolated web API and harmless stdio child, never configuring the user's real account. */
async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'stirrup-web-'));
  const runtime = new WebRuntime(root);
  const server = createServer((request, response) =>
    runtime.middleware(request, response, () => {
      response.writeHead(404);
      response.end();
    }),
  );
  const launches: string[] = [];
  const dispose = attachAcpBridge(
    server,
    root,
    () => ({
      command: [
        process.execPath,
        fileURLToPath(new URL('./fixtures/echo-agent.mjs', import.meta.url)),
      ],
      env: process.env,
    }),
    (request, id) => {
      const grant = runtime.authorize(request, id);
      if (grant) launches.push(grant.cwd);
      return grant;
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://localhost:${address.port}`;
  t.after(async () => {
    runtime.close();
    dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const cookies = new Map<string, string>();
  const device = testAuthenticator();
  let enrolled = false;
  let counter = 0;
  const harness = {
    root,
    origin,
    launches,
    runtime,
    /** Read the currently authenticated test cookie without logging it. */
    get cookie() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    /** Exercise real HTTP requests and retain cookies set by the runtime. */
    async request(
      path: string,
      method = 'GET',
      data?: unknown,
      options: { origin?: string; anonymous?: boolean } = {},
    ) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          ...(method !== 'GET'
            ? {
                Origin: options.origin ?? origin,
                'Content-Type': 'application/json',
              }
            : {}),
          ...(options.anonymous ? {} : { Cookie: harness.cookie }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!options.anonymous)
        for (const entry of response.headers.getSetCookie()) {
          const [name, ...value] = entry.split(';')[0].split('=');
          cookies.set(name, value.join('='));
        }
      return { response, data: await response.json() };
    },
    /** Exercise real signature verification and retain its login cookie; registration itself grants no access. */
    async login() {
      if (!enrolled) {
        const token = prepareEnrollment(root);
        const options = await harness.request('/api/passkey/register/options', 'POST', { token });
        assert.equal(options.response.status, 200);
        const registered = await harness.request('/api/passkey/register/verify', 'POST', {
          response: device.register(options.data.challenge, origin),
        });
        assert.equal(registered.response.status, 200);
        assert.equal(registered.data.authenticated, false);
        assert.equal((await harness.request('/api/workspace')).response.status, 401);
        enrolled = true;
      }
      const options = await harness.request('/api/passkey/login/options', 'POST', {});
      assert.equal(options.response.status, 200);
      const result = await harness.request('/api/passkey/login/verify', 'POST', {
        response: device.authenticate(options.data.challenge, origin, ++counter),
      });
      assert.equal(result.response.status, 200);
      return result;
    },
  };
  return harness;
}

test(
  'Passkey-only login rejects legacy passwords, protects origins and uses an HttpOnly cookie',
  { timeout: 10000 },
  async (t) => {
    const h = await setup(t);
    assert.equal((await h.request('/api/workspace')).response.status, 401);
    assert.equal(
      (
        await h.request('/api/setup', 'POST', {
          username: 'old',
          password: 'password',
        })
      ).response.status,
      410,
    );
    assert.equal(
      (
        await h.request('/api/login', 'POST', {
          username: 'old',
          password: 'password',
        })
      ).response.status,
      410,
    );
    assert.equal(
      (
        await h.request(
          '/api/passkey/login/options',
          'POST',
          {},
          { origin: 'https://outside.example' },
        )
      ).response.status,
      403,
    );
    assert.equal(
      (await h.request('/api/passkey/register/options', 'POST', {})).response.status,
      403,
    );
    const result = await h.login();
    assert.match(result.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal((await h.request('/api/workspace')).response.status, 200);
    assert.equal((await h.request('/api/logout', 'POST', {})).response.status, 200);
    assert.equal((await h.request('/api/workspace')).response.status, 401);
    const invalid = await h.request('/api/passkey/login/verify', 'POST', {
      response: {},
    });
    assert.equal(invalid.response.status, 401);
    await h.login();
    assert.equal((await h.request('/api/workspace')).response.status, 200);
  },
);

test(
  'canonical projects, durable transcripts, revision conflicts and immutable agent/project binding',
  { timeout: 10000 },
  async (t) => {
    const h = await setup(t);
    await h.login();
    const cwd = join(h.root, 'second');
    mkdirSync(cwd);
    assert.equal(
      (
        await h.request('/api/projects', 'POST', {
          cwd: 'relative',
          name: 'No',
        })
      ).response.status,
      400,
    );
    const project = (await h.request('/api/projects', 'POST', { cwd, name: 'Second' })).data;
    const duplicate = (
      await h.request('/api/projects', 'POST', {
        cwd: join(cwd, '.'),
        name: 'Alias',
      })
    ).data;
    assert.equal(project.id, duplicate.id);
    const record = (
      await h.request('/api/conversations', 'POST', {
        projectId: project.id,
        agentId: 'dsh',
      })
    ).data as Conversation;
    const saved = await h.request(`/api/conversations/${record.id}`, 'PUT', {
      ...record,
      projectId: 'tamper',
      agentId: 'codex',
      title: 'History',
      draft: 'keep me',
      messages: [{ id: 'm1', kind: 'assistant', text: 'saved output' }],
    });
    assert.equal(saved.response.status, 200);
    assert.equal(
      (await h.request(`/api/conversations/${record.id}`, 'PUT', record)).response.status,
      409,
    );
    const data = (await h.request('/api/workspace')).data as Workspace;
    assert.equal(data.conversations[0].agentId, 'dsh');
    assert.equal(data.conversations[0].projectId, project.id);
    assert.equal(data.conversations[0].messages[0].text, 'saved output');
    assert.equal(data.conversations[0].draft, 'keep me');
    h.runtime.close();
    const reload = new WorkspaceStore(h.root);
    t.after(() => reload.close());
    const persisted = reload.conversation(record.id);
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.messages[0].text, 'saved output');
  },
);

test(
  'ACP upgrades require login, correct conversation agent and project; logout terminates sockets',
  { timeout: 10000 },
  async (t) => {
    const h = await setup(t);
    await h.login();
    const data = (await h.request('/api/workspace')).data as Workspace;
    const record = (
      await h.request('/api/conversations', 'POST', {
        projectId: data.projects[0].id,
        agentId: 'codex',
      })
    ).data as Conversation;
    const endpoint = h.origin.replace('http:', 'ws:') + `/acp/codex?conversation=${record.id}`;
    const anonymous = new WebSocket(endpoint, { origin: h.origin });
    assert.match((await once(anonymous, 'error'))[0].message, /401/);
    const wrongAgent = new WebSocket(endpoint.replace('/codex?', '/dsh?'), {
      origin: h.origin,
      headers: { Cookie: h.cookie },
    });
    assert.match((await once(wrongAgent, 'error'))[0].message, /401/);
    assert.equal(h.launches.length, 0);
    const socket = new WebSocket(endpoint, {
      origin: h.origin,
      headers: { Cookie: h.cookie },
    });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    assert.equal(h.launches[0], realpathSync(h.root));
    const duplicate = new WebSocket(endpoint, {
      origin: h.origin,
      headers: { Cookie: h.cookie },
    });
    assert.match((await once(duplicate, 'error'))[0].message, /401/);
    const closed = once(socket, 'close');
    await h.request('/api/logout', 'POST', {});
    await closed;
  },
);

test(
  'removing the .env public key revokes existing HTTP access and its active ACP socket',
  { timeout: 10000 },
  async (t) => {
    const h = await setup(t);
    await h.login();
    const data = (await h.request('/api/workspace')).data as Workspace;
    const record = (
      await h.request('/api/conversations', 'POST', {
        projectId: data.projects[0].id,
        agentId: 'codex',
      })
    ).data as Conversation;
    const socket = new WebSocket(
      h.origin.replace('http:', 'ws:') + `/acp/codex?conversation=${record.id}`,
      {
        origin: h.origin,
        headers: { Cookie: h.cookie },
      },
    );
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const config = readPasskeyConfig(h.root);
    writePasskeyConfig(h.root, config, { ...config, credential: undefined });
    assert.equal((await h.request('/api/workspace')).response.status, 401);
    await closed;
  },
);

test('session lifetime reads .env only, defaults to twelve hours and rejects invalid values', async (t) => {
  const h = await setup(t);
  assert.equal(readSessionTtlSeconds(h.root), 43200);
  for (const value of ['', '0', '-1', '1.5', 'Infinity', 'abc', '31536001']) {
    writeFileSync(join(h.root, '.env'), `STIRRUP_SESSION_TTL_SECONDS=${value}\n`);
    assert.throws(() => readSessionTtlSeconds(h.root), /STIRRUP_SESSION_TTL_SECONDS/);
  }
  writeFileSync(join(h.root, '.env'), 'STIRRUP_SESSION_TTL_SECONDS=31536000\n');
  const login = await h.login();
  assert.match(login.response.headers.get('set-cookie')!, /Max-Age=31536000/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await h.request('/api/workspace')).response.status, 200);
});

test(
  'configured expiry closes ACP and rejects HTTP; edits apply to the next login without restarting',
  { timeout: 10000 },
  async (t) => {
    const h = await setup(t);
    appendFileSync(join(h.root, '.env'), 'STIRRUP_SESSION_TTL_SECONDS=1\n');
    const login = await h.login();
    assert.match(login.response.headers.get('set-cookie')!, /Max-Age=1/);
    const data = (await h.request('/api/workspace')).data as Workspace;
    const record = (
      await h.request('/api/conversations', 'POST', {
        projectId: data.projects[0].id,
        agentId: 'codex',
      })
    ).data as Conversation;
    const socket = new WebSocket(
      h.origin.replace('http:', 'ws:') + `/acp/codex?conversation=${record.id}`,
      {
        origin: h.origin,
        headers: { Cookie: h.cookie },
      },
    );
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const path = join(h.root, '.env');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'STIRRUP_SESSION_TTL_SECONDS=1\n',
        'STIRRUP_SESSION_TTL_SECONDS=3600\n',
      ),
    );
    await closed;
    assert.equal((await h.request('/api/workspace')).response.status, 401);
    const next = await h.login();
    assert.match(next.response.headers.get('set-cookie')!, /Max-Age=3600/);
    assert.equal((await h.request('/api/workspace')).response.status, 200);
  },
);

test('settings metadata requires login, omits credentials and distinguishes current expiry from next login TTL', async (t) => {
  const h = await setup(t);
  assert.equal((await h.request('/api/settings')).response.status, 401);
  await h.login();
  const first = await h.request('/api/settings');
  assert.equal(first.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(first.data).sort(), ['account', 'storage']);
  assert.equal(first.data.storage.backend, 'sqlite');
  assert.equal(first.data.storage.projectCount, 1);
  assert.equal(first.data.storage.messageCount, 0);
  assert.equal(first.data.account.authMethod, 'passkey');
  assert.equal(JSON.stringify(first.data).includes('credential'), false);
  const path = join(h.root, '.env');
  const source = readFileSync(path, 'utf8');
  writeFileSync(
    path,
    source.replace(/^STIRRUP_SESSION_TTL_SECONDS=.*\n?/m, '') +
      '\nSTIRRUP_SESSION_TTL_SECONDS=120\n',
  );
  const next = (await h.request('/api/settings')).data;
  assert.equal(next.account.configuredSessionTtlSeconds, 120);
  assert.equal(next.account.currentSessionExpiresAt, first.data.account.currentSessionExpiresAt);
  const foreign = await fetch(h.origin + '/api/settings', {
    headers: { Cookie: h.cookie, Origin: 'https://outside.example' },
  });
  assert.equal(foreign.status, 403);
});
