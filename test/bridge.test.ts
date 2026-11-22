import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { attachAcpBridge } from '../local/acp/bridge';
import { agentLaunch } from '../local/acp/launch';
import { openWebSocket } from '../src/acp/websocket';
import { AGENTS, type AgentId } from '../src/acp/agents';

/** Start a real loopback bridge with a harmless byte-echo child in place of the chosen ACP agent. */
async function setup(t: TestContext, agentId: AgentId = 'codex') {
  const server = createServer();
  const launched: AgentId[] = [];
  const dispose = attachAcpBridge(
    server,
    process.cwd(),
    (id) => {
      launched.push(id);
      return {
        command: [process.execPath, fileURLToPath(new URL('./fixtures/echo-agent.mjs', import.meta.url))],
        env: process.env,
      };
    },
    () => ({ cwd: process.cwd(), bind: () => () => {} }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `ws://127.0.0.1:${address.port}${AGENTS[agentId].endpoint}`,
    origin: `http://127.0.0.1:${address.port}`,
    launched,
  };
}

test('bridge rejects cross-origin and missing-origin upgrades', { timeout: 5000 }, async (t) => {
  for (const id of ['codex', 'dsh'] as const) {
    const h = await setup(t, id);
    for (const origin of ['https://untrusted.example', undefined]) {
      const socket = new WebSocket(h.url, { origin });
      const [error] = await once(socket, 'error');
      assert.match(error.message, /403/);
    }
    assert.deepEqual(h.launched, []);
  }
});

for (const id of ['codex', 'dsh'] as const)
  test(
    `${id} route streams bytes and reaps its own process after disconnect`,
    { timeout: 5000 },
    async (t) => {
      const h = await setup(t, id);
      const socket = new WebSocket(h.url, { origin: h.origin });
      t.after(() => socket.terminate());
      const pidMessage = once(socket, 'message');
      await once(socket, 'open');
      assert.deepEqual(h.launched, [id]);
      const [pidData] = await pidMessage;
      const pid = Number(pidData.toString().trim());
      assert.ok(pid > 0);
      const response = once(socket, 'message');
      const bytes = Buffer.from('{"jsonrpc":"2.0","text":"你好"}\n');
      socket.send(bytes);
      const [data] = await response;
      assert.deepEqual(data, bytes);
      socket.close();
      await once(socket, 'close');
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Adapter remained alive after disconnect');
    },
  );

test('unknown ACP route cannot start an arbitrary agent', { timeout: 5000 }, async (t) => {
  const h = await setup(t);
  const socket = new WebSocket(h.url.replace('/acp/codex', '/acp/unknown'), { origin: h.origin });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /404/);
  assert.deepEqual(h.launched, []);
});

test('fixed DSH launch uses ACP profile and a project-local home; Codex preserves its own settings', () => {
  const dsh = agentLaunch('dsh', '/workspace', {});
  assert.match(dsh.command[1], /@deepseek-ai\/dsh\/lib\/bin\.js$/);
  assert.deepEqual(dsh.command.slice(2), ['--profile', 'acp']);
  assert.equal(dsh.env.DSH_HOME, '/workspace/.local/dsh');
  assert.equal(dsh.env.INITIAL_AGENT_MODE, undefined);
  assert.equal(agentLaunch('dsh', '/workspace', { DSH_HOME: '~/custom' }).env.DSH_HOME, '~/custom');
  assert.equal(agentLaunch('dsh', '/workspace', { DSH_HOME: '  ' }).env.DSH_HOME, '/workspace/.local/dsh');
  assert.equal(dsh.env.DSH_TELEMETRY_DISABLED, '1');
  const codex = agentLaunch('codex', '/workspace', {});
  assert.equal(codex.env.INITIAL_AGENT_MODE, 'read-only');
  assert.equal(codex.env.DSH_HOME, undefined);
});

test(
  'browser byte transport tolerates SDK reader cancellation followed by explicit close',
  { timeout: 5000 },
  async (t) => {
    const h = await setup(t);
    const native = globalThis.WebSocket;
    /** Emulate the automatic browser Origin header with the Node WebSocket implementation. */
    class BrowserSocket extends WebSocket {
      /** Connect only to the fixture's loopback bridge. */
      constructor(url: string) {
        super(url, { origin: h.origin });
      }
    }
    globalThis.WebSocket = BrowserSocket as unknown as typeof globalThis.WebSocket;
    t.after(() => {
      globalThis.WebSocket = native;
    });
    const transport = await openWebSocket(h.url);
    t.after(() => transport.close());
    const reader = transport.readable.getReader();
    const first = await reader.read();
    assert.ok(first.value?.length);
    const writer = transport.writable.getWriter();
    const bytes = new TextEncoder().encode('你好\n');
    await writer.write(bytes);
    assert.deepEqual((await reader.read()).value, bytes);
    await reader.cancel();
    assert.doesNotThrow(() => transport.close());
    assert.doesNotThrow(() => transport.close());
    await assert.rejects(writer.write(bytes), /断开/);
  },
);
