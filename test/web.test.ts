import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { WorkspaceStore } from '../local/storage/workspace-store.ts';
import { WebRuntime } from '../local/runtime.ts';
import { attachAcpBridge } from '../local/acp/bridge.ts';
import { testAuthenticator } from './fixtures/passkey.ts';
import type { Conversation, Workspace } from '../src/domain/models.ts';

/** Start an isolated web API and harmless stdio child, never configuring the user's real account. */
async function setup(t: TestContext, externalOrigin?: string) {
  const root = mkdtempSync(join(tmpdir(), 'stirrup-web-'));
  if (externalOrigin) writeFileSync(join(root, '.env'), `STIRRUP_SITE_URL=${externalOrigin}\n`);
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
  const transport = `http://localhost:${address.port}`;
  const origin = externalOrigin ?? transport;
  const rpId = new URL(origin).hostname;
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
    transport,
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
      const headers = {
        Host: new URL(origin).host,
        ...(method !== 'GET'
          ? { Origin: options.origin ?? origin, 'Content-Type': 'application/json' }
          : {}),
        ...(options.anonymous ? {} : { Cookie: harness.cookie }),
      };
      const body = data === undefined ? undefined : JSON.stringify(data);
      // Node fetch normalizes Host; use HTTP transport to model the headers sent by a reverse proxy.
      const response = await new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest(transport + path, { method, headers }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('error', reject);
          incoming.on('end', () => {
            const responseHeaders = new Headers();
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
                headers: responseHeaders,
              }),
            );
          });
        });
        outgoing.on('error', reject);
        outgoing.end(body);
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
        const options = await harness.request('/api/passkey/register/options', 'POST', {});
        assert.equal(options.response.status, 200);
        const registered = await harness.request('/api/passkey/register/verify', 'POST', {
          response: device.register(options.data.challenge, origin, 0x45, rpId),
        });
        assert.equal(registered.response.status, 200);
        assert.equal(registered.data.authenticated, false);
        assert.equal((await harness.request('/api/workspace')).response.status, 401);
        enrolled = true;
      }
      const options = await harness.request('/api/passkey/login/options', 'POST', {});
      assert.equal(options.response.status, 200);
      const result = await harness.request('/api/passkey/login/verify', 'POST', {
        response: device.authenticate(options.data.challenge, origin, ++counter, 5, rpId),
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
      200,
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
  'replacing the stored public key revokes existing HTTP access and its active ACP socket',
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
    const config = h.runtime.settings.readConfig()!;
    h.runtime.settings.writeConfig(config, {
      ...config,
      credential: { ...config.credential, id: 'changed-key' },
    });
    assert.equal((await h.request('/api/workspace')).response.status, 401);
    await closed;
  },
);

test('personal-table lifetime defaults to twelve hours, rejects invalid values and ignores old env', async (t) => {
  const h = await setup(t);
  writeFileSync(join(h.root, '.env'), 'STIRRUP_SESSION_TTL_SECONDS=1\n');
  const first = await h.login();
  assert.match(first.response.headers.get('set-cookie')!, /Max-Age=43200/);
  const account = (await h.request('/api/settings')).data.account;
  for (const value of [0, -1, 1.5, 'abc', 31536001]) {
    assert.equal(
      (
        await h.request('/api/settings/account', 'PUT', {
          username: 'Stirrup',
          sessionTtlSeconds: value,
          revision: account.revision,
        })
      ).response.status,
      400,
    );
  }
  assert.equal(
    (
      await h.request('/api/settings/account', 'PUT', {
        username: 'Stirrup',
        sessionTtlSeconds: 31536000,
        revision: account.revision,
      })
    ).response.status,
    200,
  );
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
    await h.login();
    h.runtime.settings.saveAccount({
      username: 'Stirrup',
      sessionTtlSeconds: 1,
      revision: h.runtime.settings.readConfig()!.revision,
    });
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
    h.runtime.settings.saveAccount({
      username: 'Stirrup',
      sessionTtlSeconds: 3600,
      revision: h.runtime.settings.readConfig()!.revision,
    });
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
  assert.equal(
    (
      await h.request('/api/settings/account', 'PUT', {
        username: 'New name',
        sessionTtlSeconds: 120,
        revision: first.data.account.revision,
      })
    ).response.status,
    200,
  );
  const next = (await h.request('/api/settings')).data;
  assert.equal(next.account.configuredSessionTtlSeconds, 120);
  assert.equal(next.account.currentSessionExpiresAt, first.data.account.currentSessionExpiresAt);
  const foreign = await fetch(h.origin + '/api/settings', {
    headers: { Cookie: h.cookie, Origin: 'https://outside.example' },
  });
  assert.equal(foreign.status, 403);
});

test('personal preferences require authentication, reject stale writes and never expose or overwrite the Passkey', async (t) => {
  const h = await setup(t);
  assert.equal((await h.request('/api/settings/preferences')).response.status, 401);
  await h.login();
  const config = h.runtime.settings.readConfig()!;
  const first = await h.request('/api/settings/preferences');
  assert.deepEqual(first.data.values, {
    theme: 'system',
    opaque: false,
    motion: false,
    ratio: 0.2,
  });
  const update = {
    values: { theme: 'dark', opaque: true, motion: true, ratio: 0.4 },
    revision: first.data.revision,
  };
  assert.equal((await h.request('/api/settings/preferences', 'PUT', update)).response.status, 200);
  assert.equal((await h.request('/api/settings/preferences', 'PUT', update)).response.status, 409);
  assert.equal(
    (
      await h.request('/api/settings/preferences', 'PUT', {
        values: { ...update.values, credential: {} },
        revision: first.data.revision + 1,
      })
    ).response.status,
    400,
  );
  assert.deepEqual(h.runtime.settings.readConfig(), config);
  assert.deepEqual((await h.request('/api/settings/preferences')).data.values, update.values);
  const account = (await h.request('/api/settings')).data.account;
  const change = { username: 'Personal', sessionTtlSeconds: 600, revision: account.revision };
  assert.equal((await h.request('/api/settings/account', 'PUT', change)).response.status, 200);
  assert.equal((await h.request('/api/settings/account', 'PUT', change)).response.status, 409);
  assert.deepEqual(h.runtime.settings.readConfig()!.credential, config.credential);
  assert.equal(
    JSON.stringify((await h.request('/api/settings')).data).includes(config.credential.publicKey),
    false,
  );
});

test('HTTPS external origin registers, logs in and connects ACP through an HTTP proxy hop with Secure cookies', async (t) => {
  const h = await setup(t, 'https://chat.example.com:8443');
  const result = await h.login();
  assert.match(result.response.headers.get('set-cookie')!, /; Secure/);
  assert.equal(h.runtime.settings.readConfig()!.rpId, 'chat.example.com');
  assert.equal((await h.request('/api/passkey/register/options', 'POST', {})).response.status, 409);
  const foreign = await h.request(
    '/api/logout',
    'POST',
    {},
    { origin: 'https://attacker.example' },
  );
  assert.equal(foreign.response.status, 403);
  const forged = await fetch(h.transport + '/api/auth', {
    headers: {
      Host: new URL(h.transport).host,
      'X-Forwarded-Host': 'chat.example.com:8443',
      'X-Forwarded-Proto': 'https',
    },
  });
  assert.equal(forged.status, 403);
  const data = (await h.request('/api/workspace')).data as Workspace;
  const record = (
    await h.request('/api/conversations', 'POST', {
      projectId: data.projects[0].id,
      agentId: 'codex',
    })
  ).data as Conversation;
  const socket = new WebSocket(
    h.transport.replace('http:', 'ws:') + `/acp/codex?conversation=${record.id}`,
    {
      origin: h.origin,
      headers: { Host: new URL(h.origin).host, Cookie: h.cookie },
    },
  );
  t.after(() => socket.terminate());
  await once(socket, 'open');
  assert.equal(h.launches.length, 1);
  const closed = once(socket, 'close');
  await h.request('/api/logout', 'POST', {});
  await closed;
});
