import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import { sessionOptions } from '../web/acp/agents';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpClient } from '../web/acp/client';
import type { WorkspaceController } from '../web/domain/workspace';

/** Supply opaque grouped values, a real speed mapping and an unrelated boolean with a misleading name. */
function options(): SessionConfigOption[] {
  return [
    {
      id: 'opaque-model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: '["provider","one"]',
      options: [
        {
          group: 'provider',
          name: 'Provider',
          options: [
            { value: '["provider","one"]', name: 'Model One' },
            { value: '["provider","two"]', name: 'Model Two' },
          ],
        },
      ],
    },
    {
      id: 'opaque-effort',
      category: 'thought_level',
      name: 'Reasoning',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'Normal' },
        { value: 'b', name: 'Deep' },
      ],
    },
    {
      id: 'fast-mode',
      category: 'speed',
      name: 'Fast',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
    { id: 'fast-approval', name: 'Fast approval', type: 'boolean', currentValue: false },
  ];
}

test('semantic mapping preserves opaque values and never infers speed from an unrelated name or another agent', () => {
  const values = options();
  assert.equal(sessionOptions('codex', values).model?.id, 'opaque-model');
  assert.equal(sessionOptions('codex', values).effort?.id, 'opaque-effort');
  assert.equal(sessionOptions('codex', values).fast?.id, 'fast-mode');
  assert.equal(sessionOptions('codex', values).other[0].id, 'fast-approval');
  assert.equal(sessionOptions('dsh', values).fast, undefined);
  values[2] = {
    id: 'fast-mode',
    name: 'Fast',
    type: 'select',
    currentValue: 'turbo',
    options: [{ value: 'turbo', name: 'Turbo' }],
  };
  assert.equal(sessionOptions('codex', values).fast, undefined);
  values[2] = { id: 'fast-mode', name: 'Fast', type: 'boolean', currentValue: true };
  assert.equal(sessionOptions('codex', values).fast?.currentValue, true);
});

/** Wait for scheduled UI updates without relying on fixed sleeps. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Composer UI timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('inline controls retain confirmed values, drafts and ownership across failures, navigation and reconnects', async (t) => {
  const entry = 'virtual:composer-test';
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: entry } },
    plugins: [
      {
        name: entry,
        /** Resolve the isolated fixture entry. */
        resolveId(id) {
          if (id === entry) return id;
        },
        /** Bundle real production views/controllers; only data and transport are supplied by the test. */
        load(id) {
          if (id === entry)
            return `
      import {createWorkspacePage} from '/web/ui/pages/workspace.ts';
      import {WorkspaceController} from '/web/domain/workspace.ts';
      import {loadPreferences} from '/web/app/preferences.ts';
      const controller=new WorkspaceController(async()=>({revision:1,updatedAt:1}),()=>page?.scheduleRender());
      controller.projects=[{id:'p',name:'Project',cwd:'/project'}];
      controller.conversations=['codex','dsh'].map((agentId,i)=>({id:'c'+i,projectId:'p',agentId,title:agentId,draft:'draft '+agentId,messages:[],revision:0,updatedAt:1}));
      const prefs=loadPreferences();prefs.selected={codex:'c0',dsh:'c1'};
      let page=createWorkspacePage(controller,prefs,{configured:true,authenticated:true},async()=>{},async()=>({}));
      window.harness={controller,page};`;
        },
      },
    ],
  });
  assert.ok(!Array.isArray(output) && 'output' in output);
  const script = output.output.find((item) => item.type === 'chunk' && item.isEntry);
  assert.ok(script?.type === 'chunk');
  const dom = new JSDOM('<div id="app"></div><div id="toast" hidden></div>', {
    url: 'http://localhost:5173/?agent=codex&session=c0',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof w.matchMedia;
  w.eval(script.code);
  const { controller, page } = (
    w as unknown as {
      harness: {
        controller: WorkspaceController;
        page: { scheduleRender(): void; dispose(): void };
      };
    }
  ).harness;
  t.after(() => {
    page.dispose();
    controller.dispose();
    w.close();
  });
  const doc = w.document;
  /** Find a required control in the current view. */
  function control<T extends HTMLElement = HTMLButtonElement>(selector: string): T {
    const node = doc.querySelector<T>(selector);
    assert.ok(node, selector);
    return node;
  }
  /** Select the exact opaque protocol value and invoke the normal change handler. */
  function change(selector: string, value: string): void {
    const node = control<HTMLSelectElement>(selector);
    node.value = value;
    node.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  control('[data-agent="codex"]').click();
  assert.equal(doc.querySelector('#configure-session'), null);
  assert.equal(doc.querySelector('#composer-caption'), null);
  assert.equal(control('#option-model').textContent, '连接后可用');
  const calls: Array<[string, string | boolean]> = [];
  let complete!: () => void;
  let reject!: (error: Error) => void;
  const client = {
    phase: 'ready',
    sessionId: 's0',
    configOptions: options(),
    modes: { currentModeId: 'read', availableModes: [{ id: 'read', name: 'Read only' }] },
    /** Hold a simulated ACP write until the test delivers a response; replace the full advertised set on success. */
    async setConfigOption(id: string, value: string | boolean) {
      calls.push([id, value]);
      this.phase = 'configuring';
      page.scheduleRender();
      try {
        await new Promise<void>((resolve, rejectPromise) => {
          complete = resolve;
          reject = rejectPromise;
        });
        this.configOptions = this.configOptions.map((option) =>
          option.id === id ? { ...option, currentValue: value } : option,
        ) as SessionConfigOption[];
        if (id === 'opaque-model')
          this.configOptions = this.configOptions.filter((option) => option.id === 'opaque-model');
      } finally {
        if (this.phase !== 'closed') this.phase = 'ready';
        page.scheduleRender();
      }
    },
    /** Close only the fixture transport. */
    close() {
      this.phase = 'closed';
    },
  };
  controller.state('c0').client = client as unknown as AcpClient;
  controller.state('c1').client = {
    phase: 'ready',
    sessionId: 's1',
    configOptions: [],
    close() {},
  } as unknown as AcpClient;
  page.scheduleRender();
  await until(() => !!doc.querySelector('#option-model optgroup'));
  assert.equal(control<HTMLSelectElement>('#option-model').value, '["provider","one"]');
  assert.equal(control('#option-fast').getAttribute('aria-checked'), 'false');
  assert.equal(control<HTMLSelectElement>('#option-mode').disabled, true);
  assert.equal(control('#session-options').closest('form')?.id, 'composer');
  const prompt = control<HTMLTextAreaElement>('#prompt');
  change('#option-effort', 'b');
  assert.equal(control<HTMLSelectElement>('#option-effort').value, 'a');
  assert.equal(control('#send').disabled, true);
  assert.equal(prompt.disabled, false);
  prompt.value = 'retained while applying';
  prompt.dispatchEvent(new w.Event('input'));
  prompt.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(controller.record('c0').messages.length, 0);
  assert.match(control('#config-status').textContent!, /正在应用/);
  control('[data-agent="dsh"]').click();
  assert.equal(control('#option-fast').textContent, 'Agent 未提供');
  reject(new w.Error('rejected effort'));
  await until(() => client.phase === 'ready');
  assert.equal(control('#config-error').hidden, true);
  assert.equal(prompt.value, 'draft dsh');
  control('[data-agent="codex"]').click();
  assert.match(control('#config-error').textContent!, /rejected effort/);
  assert.equal(prompt.value, 'retained while applying');
  control('#config-error button').click();
  complete();
  await until(() => control<HTMLSelectElement>('#option-effort').value === 'b');
  assert.equal(control('#config-error').hidden, true);
  assert.equal(control('#option-fast').getAttribute('aria-checked'), 'false');
  control('#option-fast').click();
  complete();
  await until(() => control('#option-fast').getAttribute('aria-checked') === 'true');
  assert.equal(control<HTMLSelectElement>('#option-effort').value, 'b');
  change('#option-model', '["provider","two"]');
  complete();
  await until(() => control('#option-effort').textContent === 'Agent 未提供');
  assert.equal(control('#option-fast').textContent, 'Agent 未提供');
  assert.deepEqual(calls.at(-1), ['opaque-model', '["provider","two"]']);
  assert.equal(controller.record('c0').messages.length, 0);
  // A stale failure from a closed connection must not erase a new connection's pending action.
  client.configOptions = options();
  page.scheduleRender();
  await until(() => !!doc.querySelector('select#option-effort'));
  change('#option-effort', 'b');
  const rejectOld = reject;
  client.close();
  const replacement = { ...client, phase: 'ready', sessionId: 's2', configOptions: options() };
  controller.state('c0').client = replacement as unknown as AcpClient;
  page.scheduleRender();
  await until(() => !control<HTMLSelectElement>('#option-effort').disabled);
  change('#option-effort', 'b');
  rejectOld(new w.Error('old connection'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(control('#send').disabled, true);
  assert.equal(control('#config-error').hidden, true);
  complete();
  await until(() => !control('#send').disabled);
  for (const phase of ['prompting', 'cancelling']) {
    replacement.phase = phase;
    page.scheduleRender();
    await until(() => control<HTMLSelectElement>('#option-effort').disabled);
    assert.equal(control('#send').disabled, true);
    assert.equal(control('#cancel').hidden, false);
    replacement.phase = 'ready';
    page.scheduleRender();
    await until(() => !control('#send').disabled);
  }
  const hint = control('#session-hint').textContent!;
  assert.ok(!hint.includes('右上角'));
  controller.addMessage('c0', 'error', 'model failed');
  controller.update('c0', {
    sessionUpdate: 'plan',
    entries: [{ content: 'Inspect', priority: 'high', status: 'pending' }],
  });
  controller.update('c0', {
    sessionUpdate: 'plan',
    entries: [{ content: 'Inspect', priority: 'high', status: 'completed' }],
  });
  await until(() => !!doc.querySelector('.plan-steps'));
  assert.equal(doc.querySelectorAll('.message.plan').length, 1);
  assert.match(control('.plan-steps').textContent!, /已完成/);
  assert.equal(control('.message.error .message-author').textContent, '系统错误');
  // Authentication stays beside the composer and completes for its original record after navigation.
  let authenticated = '';
  let finishAuth!: () => void;
  const authClient = {
    phase: 'ready',
    sessionId: undefined,
    configOptions: [],
    info: { authMethods: [{ id: 'local-login', name: 'Sign in locally' }] },
    /** Simulate a provider-owned authentication flow with a deferred result. */
    async authenticate(method: string) {
      authenticated = method;
      this.phase = 'authenticating';
      await new Promise<void>((resolve) => {
        finishAuth = resolve;
      });
      this.phase = 'ready';
    },
    /** No actual transport is used. */
    close() {},
  };
  controller.state('c0').client = authClient as unknown as AcpClient;
  let resumed = '';
  controller.connect = async (id: string) => {
    resumed = id;
  };
  page.scheduleRender();
  await until(() => !!doc.querySelector('#session-auth button'));
  control('#session-auth button').click();
  assert.equal(authenticated, 'local-login');
  control('[data-agent="dsh"]').click();
  finishAuth();
  await until(() => resumed === 'c0');
  assert.equal(prompt.value, 'draft dsh');
  assert.equal(control('[data-agent="dsh"]').getAttribute('aria-pressed'), 'true');
});
