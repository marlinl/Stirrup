import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';
import { JSDOM } from 'jsdom';

/** Wait for a rendered state with a bounded timeout. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Settings UI timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('settings keeps streaming, permissions, draft and reading state; history/deep links and failed reads stay correct', async (t) => {
  const entry = 'virtual:settings-test';
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: entry } },
    plugins: [
      {
        name: 'settings-test-entry',
        /** Resolve only the test-only entry point. */
        resolveId(id) {
          if (id === entry) return entry;
        },
        /** Exercise real view/controller modules while exposing the fixture to the DOM test, never production code. */
        load(id) {
          if (id === entry)
            return `
      import {createWorkspacePage} from '/src/ui/pages/workspace.ts';
      import {WorkspaceController} from '/src/domain/workspace.ts';
      import {loadPreferences,connectPreferences} from '/src/app/preferences.ts';
      void (async () => {
      const controller=new WorkspaceController(window.fixtureApi,()=>page?.scheduleRender());
      controller.projects=[{id:'p',name:'Project',cwd:'/project'}];
      controller.conversations=['codex','dsh'].map((agentId,i)=>({id:'c'+i,projectId:'p',agentId,title:agentId,draft:'draft '+agentId,messages:[],revision:0,updatedAt:1}));
      const preferences=loadPreferences(); preferences.selected={codex:'c0',dsh:'c1'};
      await connectPreferences(preferences,window.fixtureApi);
      let page=createWorkspacePage(controller,preferences,{configured:true,authenticated:true},window.fixtureLogout,window.fixtureApi);
      window.harness={controller,page};
      })();`;
        },
      },
    ],
  });
  assert.ok(!Array.isArray(output) && 'output' in output);
  const script = output.output.find((item) => item.type === 'chunk' && item.isEntry);
  assert.ok(script?.type === 'chunk');
  const dom = new JSDOM('<div id="app"></div><div id="toast" hidden></div>', {
    url: 'http://localhost:5173/settings/storage',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  t.after(() => w.close());
  w.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof w.matchMedia;
  w.structuredClone = structuredClone;
  let fail = true;
  let requests = 0;
  let logouts = 0;
  let failPreferences = false;
  let preferenceSaves = 0;
  const summary = {
    account: {
      username: 'Local',
      authMethod: 'passkey',
      configuredSessionTtlSeconds: 43200,
      currentSessionExpiresAt: Date.now() + 100000,
    },
    storage: {
      backend: 'sqlite',
      location: '.local/web/stirrup.sqlite',
      schemaVersion: 1,
      projectCount: 1,
      conversationCount: 2,
      messageCount: 0,
    },
  };
  Object.assign(w, {
    /** Return only fixture data; emulate metadata failure and revisioned persistence independently. */
    fixtureApi: async (path: string, _method?: string, input?: { revision: number }) => {
      if (path === '/api/settings/preferences') {
        if (_method === 'PUT') {
          if (failPreferences) throw new w.Error('preferences unavailable');
          return { revision: ++preferenceSaves };
        }
        return { values: { theme: 'dark', opaque: false, motion: false, ratio: 0.3 }, revision: 0 };
      }
      if (path === '/api/settings') {
        requests++;
        if (fail) throw new w.Error('disk unavailable');
        return summary;
      }
      return { revision: (input?.revision ?? 0) + 1, updatedAt: 2 };
    },
    /** Simulate logout failure so the inline confirmation must retain the current view and display the error. */
    fixtureLogout: async () => {
      logouts++;
      throw new w.Error('save failed');
    },
  });
  w.eval(script.code);
  await until(() => !!(w as unknown as { harness?: unknown }).harness);
  const { controller, page } = (
    w as unknown as {
      harness: {
        controller: import('../src/domain/workspace').WorkspaceController;
        page: { dispose(): void };
      };
    }
  ).harness;
  t.after(() => {
    page.dispose();
    controller.dispose();
  });
  const doc = w.document;
  /** Click a mounted selector and assert the control exists. */
  function click(selector: string): void {
    const item = doc.querySelector<HTMLElement>(selector);
    assert.ok(item, selector);
    item.click();
  }
  await until(() =>
    doc.querySelector('#settings-content')!.textContent!.includes('disk unavailable'),
  );
  assert.equal(doc.querySelector('#storage-facts'), null);
  fail = false;
  click('#settings-content button');
  await until(() => !!doc.querySelector('#storage-facts'));
  assert.match(doc.querySelector('#storage-facts')!.textContent!, /SQLite/);
  assert.equal(requests, 2);
  click('[data-agent="codex"]');
  const prompt = doc.querySelector<HTMLTextAreaElement>('#prompt')!;
  assert.equal(prompt.value, 'draft codex');
  controller.update('c0', {
    sessionUpdate: 'tool_call',
    toolCallId: 't',
    title: 'inspect',
    status: 'pending',
  });
  await until(() => !!doc.querySelector('#transcript details'));
  const details = doc.querySelector<HTMLDetailsElement>('#transcript details')!;
  details.open = true;
  details.dispatchEvent(new w.Event('toggle'));
  const messages = doc.getElementById('messages')!;
  Object.defineProperties(messages, {
    scrollHeight: { value: 2000, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  messages.scrollTop = 123;
  messages.dispatchEvent(new w.Event('scroll'));
  click('#settings');
  assert.equal(w.location.pathname, '/settings/storage');
  await until(() => !!doc.querySelector('#storage-facts'));
  const before = requests;
  let closed = 0;
  controller.state('c0').client = {
    sessionId: 's',
    phase: 'prompting',
    close: () => {
      closed++;
    },
  } as unknown as import('../src/acp/client').AcpClient;
  controller.state('c0').permissions = [
    {
      id: 7,
      request: {
        sessionId: 's',
        toolCall: { toolCallId: 't', title: 'Read' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    },
  ] as unknown as import('../src/acp/client').Permission[];
  controller.update('c0', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'background reply' },
  });
  await until(() => !doc.querySelector<HTMLElement>('[data-agent="codex"] .agent-badge')!.hidden);
  assert.equal(closed, 0);
  assert.equal(requests, before);
  assert.equal(doc.querySelector<HTMLDialogElement>('#dialog')!.open, false);
  click('[data-agent="codex"]');
  assert.match(doc.querySelector('#transcript')!.textContent!, /background reply/);
  assert.equal(prompt.value, 'draft codex');
  assert.equal(messages.scrollTop, 123);
  assert.equal(details.open, true);
  assert.equal(controller.state('c0').permissions.length, 1);
  w.history.back();
  await until(
    () =>
      w.location.pathname === '/settings/storage' && !doc.getElementById('settings-panel')!.hidden,
  );
  click('[data-section="appearance"]');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(w.location.pathname, '/settings/appearance');
  assert.equal(doc.querySelector<HTMLSelectElement>('#theme')!.value, 'dark');
  click('#opaque');
  await until(() => /已保存个人设置/.test(doc.getElementById('appearance-feedback')!.textContent!));
  assert.equal(preferenceSaves, 1);
  failPreferences = true;
  click('#opaque');
  await until(() => /未能保存/.test(doc.getElementById('appearance-feedback')!.textContent!));
  click('[data-section="account"]');
  await until(() => !!doc.getElementById('logout'));
  click('#logout');
  click('#cancel-logout');
  assert.equal(logouts, 0);
  assert.equal(closed, 0);
  click('#logout');
  click('#confirm-logout');
  await until(() => doc.getElementById('logout-error')!.textContent!.includes('save failed'));
  assert.equal(logouts, 1);
  assert.equal(doc.getElementById('settings-panel')!.hidden, false);
  controller.state('c0').permissions = [];
});
