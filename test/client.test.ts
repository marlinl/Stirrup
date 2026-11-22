import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { AcpClient, type Permission } from '../src/acp/client';

/** Provide a controllable promise for deterministic turn, notification, and approval timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Connect a real SDK agent and client over byte streams, and release both after each test. */
async function setup(
  t: TestContext,
  configure?: (app: acp.AgentApp) => void,
  options: {
    session?: acp.NewSessionResponse;
    authMethods?: acp.AuthMethod[];
    capabilities?: acp.AgentCapabilities;
  } = {},
) {
  const upstream = new TransformStream<Uint8Array>();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const downstream = {
    readable: new ReadableStream<Uint8Array>({
      /** Keep the agent output controller to simulate a real transport EOF. */
      start(controller) {
        output = controller;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      /** Forward each encoded agent response to the client byte reader. */
      write(bytes) {
        output.enqueue(bytes);
      },
    }),
  };
  const received: acp.SessionNotification[] = [];
  let approvals: Permission[] = [];
  let onPermissions: (() => void) | undefined;
  let init: acp.InitializeRequest | undefined;
  let cwd: string | undefined;
  const app = acp
    .agent()
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      init = params;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: options.capabilities ?? {},
        authMethods: options.authMethods ?? [{ id: 'local', name: 'Local login' }],
      };
    })
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      cwd = params.cwd;
      assert.deepEqual(params.mcpServers, []);
      return (
        options.session ?? {
          sessionId: 's1',
          modes: {
            currentModeId: 'read-only',
            availableModes: [
              { id: 'read-only', name: 'Read only' },
              { id: 'write', name: 'Write' },
            ],
          },
        }
      );
    })
    .onRequest(acp.methods.agent.session.setMode, () => ({}));
  configure?.(app);
  const agent = app.connect(acp.ndJsonStream(downstream.writable, upstream.readable));
  const client = new AcpClient(
    {
      readable: downstream.readable,
      writable: upstream.writable,
      /** Stop the simulated peer when the client releases its transport. */
      close() {
        agent.close();
      },
    },
    {
      /** State is asserted directly in these protocol tests. */
      state() {},
      /** Collect ordered notifications for routing and streaming assertions. */
      update(value) {
        received.push(value);
      },
      /** Expose current approvals and wake a test waiting for their arrival. */
      permissions(value) {
        approvals = value;
        onPermissions?.();
      },
    },
  );
  t.after(() => {
    client.close();
    agent.close();
  });
  await client.initialize();
  return {
    client,
    agent,
    received,
    /** Read the negotiated request captured by the simulated agent. */
    get init() {
      return init;
    },
    /** Read the requested working directory. */
    get cwd() {
      return cwd;
    },
    /** Read currently visible approval cards. */
    get approvals() {
      return approvals;
    },
    /** Simulate the peer process exiting and closing its stdout pipe. */
    disconnectAgent(): void {
      agent.close();
      output.close();
    },
    /** Await the exact number of approval cards without timing-dependent sleeps. */
    waitPermissions(count: number): Promise<void> {
      if (approvals.length === count) return Promise.resolve();
      return new Promise((resolve) => {
        onPermissions = () => {
          if (approvals.length === count) resolve();
        };
      });
    },
  };
}

test('negotiation, authentication, absolute cwd, and advertised modes', { timeout: 5000 }, async (t) => {
  const h = await setup(t);
  assert.equal(h.init?.clientCapabilities?.fs?.readTextFile, false);
  assert.equal(h.init?.clientCapabilities?.fs?.writeTextFile, false);
  assert.equal(h.init?.clientCapabilities?.terminal, false);
  await assert.rejects(h.client.authenticate('invented'), /未知/);
  await h.client.authenticate('local');
  await assert.rejects(h.client.newSession('relative'), /绝对/);
  await h.client.newSession('/workspace');
  assert.equal(h.cwd, '/workspace');
  assert.equal(h.client.sessionId, 's1');
  await assert.rejects(h.client.newSession('/workspace'), /已有会话/);
  await assert.rejects(h.client.setMode('unknown'), /不支持/);
  await h.client.setMode('write');
  assert.equal(h.client.modes?.currentModeId, 'write');
});

test(
  'streaming updates route by session and a turn stays exclusive until its response',
  { timeout: 5000 },
  async (t) => {
    const finish = deferred<acp.PromptResponse>();
    const sent = deferred<void>();
    const h = await setup(t, (app) =>
      app.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        assert.deepEqual(params.prompt, [{ type: 'text', text: '你好' }]);
        await client.notify(acp.methods.client.session.update, {
          sessionId: 'other',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignore' } },
        });
        for (const text of ['你', '好'])
          await client.notify(acp.methods.client.session.update, {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          });
        await client.notify(acp.methods.client.session.update, {
          sessionId: 's1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'List files',
            status: 'pending',
          },
        });
        await client.notify(acp.methods.client.session.update, {
          sessionId: 's1',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
        });
        sent.resolve();
        return finish.promise;
      }),
    );
    await h.client.newSession('/workspace');
    const turn = h.client.prompt('你好');
    await sent.promise;
    await assert.rejects(h.client.prompt('duplicate'), /尚未结束/);
    finish.resolve({ stopReason: 'end_turn' });
    assert.equal((await turn).stopReason, 'end_turn');
    assert.equal(h.received.length, 4);
    assert.equal(h.client.phase, 'ready');
  },
);

test('concurrent approvals retain request identity and validate option IDs', { timeout: 5000 }, async (t) => {
  const results: acp.RequestPermissionResponse[] = [];
  const h = await setup(t, (app) =>
    app.onRequest(acp.methods.agent.session.prompt, async ({ client }) => {
      results.push(
        ...(await Promise.all(
          ['a', 'b'].map((id) =>
            client.request(acp.methods.client.session.requestPermission, {
              sessionId: 's1',
              toolCall: { toolCallId: id, title: id },
              options: [{ optionId: `allow-${id}`, name: 'Allow once', kind: 'allow_once' }],
            }),
          ),
        )),
      );
      return { stopReason: 'end_turn' };
    }),
  );
  await h.client.newSession('/workspace');
  const turn = h.client.prompt('tools');
  await h.waitPermissions(2);
  const [a, b] = h.approvals;
  assert.throws(() => h.client.answerPermission(a.id, 'invented'), /无效/);
  h.client.answerPermission(b.id);
  h.client.answerPermission(a.id, 'allow-a');
  await turn;
  assert.deepEqual(results, [
    { outcome: { outcome: 'selected', optionId: 'allow-a' } },
    { outcome: { outcome: 'cancelled' } },
  ]);
  assert.equal(h.approvals.length, 0);
});

test('cancel dismisses approvals but waits for the final prompt response', { timeout: 5000 }, async (t) => {
  const cancelled = deferred<void>();
  const finish = deferred<acp.PromptResponse>();
  const permission = deferred<acp.RequestPermissionResponse>();
  const h = await setup(t, (app) => {
    app.onNotification(acp.methods.agent.session.cancel, () => {
      cancelled.resolve();
    });
    app.onRequest(acp.methods.agent.session.prompt, async ({ client }) => {
      permission.resolve(
        await client.request(acp.methods.client.session.requestPermission, {
          sessionId: 's1',
          toolCall: { toolCallId: 'a' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        }),
      );
      return finish.promise;
    });
  });
  await h.client.newSession('/workspace');
  const turn = h.client.prompt('work');
  await h.waitPermissions(1);
  await h.client.cancel();
  await cancelled.promise;
  assert.equal(h.client.phase, 'cancelling');
  assert.deepEqual(await permission.promise, { outcome: { outcome: 'cancelled' } });
  assert.equal(h.approvals.length, 0);
  await assert.rejects(h.client.prompt('next'), /尚未结束/);
  finish.resolve({ stopReason: 'cancelled' });
  assert.equal((await turn).stopReason, 'cancelled');
  assert.equal(h.client.phase, 'ready');
});

test('disconnect rejects an in-flight turn and clears permission cards', { timeout: 5000 }, async (t) => {
  const h = await setup(t, (app) =>
    app.onRequest(acp.methods.agent.session.prompt, async ({ client }) => {
      await client.request(acp.methods.client.session.requestPermission, {
        sessionId: 's1',
        toolCall: { toolCallId: 'a' },
        options: [],
      });
      return { stopReason: 'cancelled' };
    }),
  );
  await h.client.newSession('/workspace');
  const turn = h.client.prompt('work');
  const rejected = assert.rejects(turn);
  await h.waitPermissions(1);
  h.client.close();
  await rejected;
  assert.equal(h.approvals.length, 0);
  assert.equal(h.client.phase, 'closed');
  assert.equal(h.client.sessionId, undefined);
});

test(
  'RPC failure releases busy state and agent disconnect closes the client',
  { timeout: 5000 },
  async (t) => {
    const h = await setup(t, (app) =>
      app.onRequest(acp.methods.agent.session.prompt, () => {
        throw acp.RequestError.authRequired();
      }),
    );
    await h.client.newSession('/workspace');
    await assert.rejects(
      h.client.prompt('work'),
      (error: unknown) => error instanceof acp.RequestError && error.code === -32000,
    );
    assert.equal(h.client.phase, 'ready');
    h.disconnectAgent();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.client.phase, 'closed');
  },
);

test('permissions for another session are cancelled without showing a card', { timeout: 5000 }, async (t) => {
  const h = await setup(t);
  await h.client.newSession('/workspace');
  const response = await h.agent.client.request(acp.methods.client.session.requestPermission, {
    sessionId: 'other',
    toolCall: { toolCallId: 'a' },
    options: [],
  });
  assert.deepEqual(response, { outcome: { outcome: 'cancelled' } });
  assert.equal(h.approvals.length, 0);
});

test(
  'history restoration requires advertised capability and does not duplicate agent replay',
  { timeout: 5000 },
  async (t) => {
    const unavailable = await setup(t);
    await assert.rejects(unavailable.client.restoreSession('/workspace', 'saved'), /不支持恢复/);
    const loaded = await setup(
      t,
      (app) =>
        app.onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
          assert.equal(params.sessionId, 'saved');
          assert.equal(params.cwd, '/workspace');
          await client.notify(acp.methods.client.session.update, {
            sessionId: 'saved',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replay' } },
          });
          return {};
        }),
      { capabilities: { loadSession: true } },
    );
    await loaded.client.restoreSession('/workspace', 'saved');
    assert.equal(loaded.client.sessionId, 'saved');
    assert.equal(loaded.received.length, 0);
    await loaded.agent.client.notify(acp.methods.client.session.update, {
      sessionId: 'saved',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new content' } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(loaded.received.length, 1);
    const resumed = await setup(
      t,
      (app) =>
        app.onRequest(acp.methods.agent.session.resume, ({ params }) => {
          assert.equal(params.sessionId, 'saved');
          return {};
        }),
      { capabilities: { sessionCapabilities: { resume: {} } } },
    );
    await resumed.client.restoreSession('/workspace', 'saved');
    assert.equal(resumed.client.sessionId, 'saved');
  },
);

/** Return opaque grouped model IDs and a reasoning selector like those supplied by DSH. */
function dshOptions(model = 'deepseek/opaque-pro'): acp.SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: [
        {
          group: 'deepseek-official',
          name: 'DeepSeek',
          options: [
            { value: 'deepseek/opaque-pro', name: 'Pro' },
            { value: 'deepseek/opaque-flash', name: 'Flash' },
          ],
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'high', name: 'High' },
        { value: 'low', name: 'Low' },
      ],
    },
  ];
}

test(
  'DSH-style sessions omit modes and accept only their advertised configuration values',
  { timeout: 5000 },
  async (t) => {
    const submitted: acp.SetSessionConfigOptionRequest[] = [];
    const h = await setup(
      t,
      (app) => {
        app.onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
          submitted.push(params);
          // Switching model may replace the entire selector set, including removal of reasoning.
          return { configOptions: dshOptions(params.value as string).slice(0, 1) };
        });
      },
      { session: { sessionId: 's1', configOptions: dshOptions() }, authMethods: [] },
    );
    assert.deepEqual(h.client.info?.authMethods, []);
    await h.client.newSession('/workspace');
    assert.equal(h.client.modes, undefined);
    await assert.rejects(h.client.setMode('read-only'), /不支持/);
    await assert.rejects(h.client.setConfigOption('unknown', 'x'), /不支持/);
    await assert.rejects(h.client.setConfigOption('model', 'guessed-model-id'), /无效/);
    await assert.rejects(h.client.setConfigOption('model', true), /无效/);
    assert.equal(submitted.length, 0);
    await h.client.setConfigOption('model', 'deepseek/opaque-flash');
    assert.deepEqual(submitted, [{ sessionId: 's1', configId: 'model', value: 'deepseek/opaque-flash' }]);
    assert.equal(h.client.configOptions.length, 1);
    assert.equal(h.client.configOptions[0].currentValue, 'deepseek/opaque-flash');
    h.client.close();
    assert.deepEqual(h.client.configOptions, []);
  },
);

test(
  'configuration changes exclude concurrent turns and retain confirmed values after RPC failure',
  { timeout: 5000 },
  async (t) => {
    const finish = deferred<void>();
    const h = await setup(
      t,
      (app) => {
        app.onRequest(acp.methods.agent.session.setConfigOption, async () => {
          await finish.promise;
          throw acp.RequestError.invalidParams();
        });
      },
      { session: { sessionId: 's1', configOptions: dshOptions() } },
    );
    await h.client.newSession('/workspace');
    const change = h.client.setConfigOption('reasoning_effort', 'low');
    const rejected = assert.rejects(change, (error: unknown) => error instanceof acp.RequestError);
    assert.equal(h.client.phase, 'configuring');
    await assert.rejects(h.client.prompt('racing prompt'), /尚未结束/);
    finish.resolve();
    await rejected;
    assert.equal(h.client.phase, 'ready');
    assert.equal(h.client.configOptions[1].currentValue, 'high');
  },
);

test(
  'configuration update notifications replace only the matching session state',
  { timeout: 5000 },
  async (t) => {
    const h = await setup(t, undefined, { session: { sessionId: 's1', configOptions: dshOptions() } });
    await h.client.newSession('/workspace');
    await h.agent.client.notify(acp.methods.client.session.update, {
      sessionId: 'other',
      update: { sessionUpdate: 'config_option_update', configOptions: [] },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.client.configOptions.length, 2);
    await h.agent.client.notify(acp.methods.client.session.update, {
      sessionId: 's1',
      update: { sessionUpdate: 'config_option_update', configOptions: dshOptions('deepseek/opaque-flash') },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.client.configOptions[0].currentValue, 'deepseek/opaque-flash');
  },
);
