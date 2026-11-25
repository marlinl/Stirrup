import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import type { Conversation } from '../shared/models';

/** Wait for asynchronous rendering without relying on animation or arbitrary long sleeps. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('UI did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  'built UI supports Passkey login cancellation/retry, isolated agent drafts, safe Markdown and routed three-column settings',
  { timeout: 15000 },
  async (t) => {
    const output = await build({
      configFile: false,
      root: new URL('../web/', import.meta.url).pathname,
      logLevel: 'silent',
      build: { write: false },
    });
    assert.ok(!Array.isArray(output) && 'output' in output);
    const script = output.output.find((item) => item.type === 'chunk' && item.isEntry);
    assert.ok(script?.type === 'chunk');
    const dom = new JSDOM('', {
      url: 'http://localhost:5173/chat',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const window = dom.window;
    t.after(() => window.close());
    window.matchMedia = (() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    window.structuredClone = structuredClone;
    window.PublicKeyCredential = class {} as unknown as typeof window.PublicKeyCredential;
    let cancelPrompt = true;
    Object.defineProperty(window.navigator, 'credentials', {
      value: {
        /** Model only the native authenticator boundary; cryptographic verification has separate real-signature tests. */
        async get() {
          if (cancelPrompt) throw new window.DOMException('Cancelled', 'NotAllowedError');
          const bytes = new window.Uint8Array([1, 2, 3]).buffer;
          return {
            id: 'AQID',
            rawId: bytes,
            type: 'public-key',
            response: {
              clientDataJSON: bytes,
              authenticatorData: bytes,
              signature: bytes,
            },
            /** Supply empty extension results as a browser authenticator would. */
            getClientExtensionResults() {
              return {};
            },
          };
        },
      },
    });
    // jsdom does not implement native dialog presentation; exercise application wiring through its open state.
    /** Model native showModal's open state without claiming browser focus or rendering coverage. */
    window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    /** Model native close and its event for application focus-return handlers. */
    window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new window.Event('close'));
    };
    const doc = window.document;
    doc.body.innerHTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace(
      /<script[\s\S]*?<\/script>/g,
      '',
    );
    const records: Conversation[] = ['codex', 'dsh'].map((agentId, index) => ({
      id: `c${index}`,
      projectId: 'p',
      agentId: agentId as Conversation['agentId'],
      title: `${agentId} history`,
      draft: `${agentId} draft`,
      revision: 0,
      updatedAt: 1,
      messages: [
        {
          id: `m${index}`,
          kind: 'assistant',
          text: '**Hello**\n\n[bad](javascript:alert(1))\n\n<img src="x" onerror="alert(1)">\n\n![remote](https://example.com/tracker.png)',
        },
      ],
    }));
    let authenticated = false;
    const writes: Conversation[] = [];
    window.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      const path = String(input);
      let data: unknown;
      if (path === '/api/auth') data = { configured: true, authenticated };
      else if (path === '/api/settings/preferences')
        data =
          init?.method === 'PUT'
            ? { revision: 1 }
            : {
                values: { theme: 'system', opaque: false, motion: false, ratio: 0.2 },
                revision: 0,
              };
      else if (path === '/api/passkey/login/options')
        data = {
          challenge: 'AQID',
          rpId: 'localhost',
          userVerification: 'required',
          allowCredentials: [{ id: 'AQID', type: 'public-key' }],
        };
      else if (path === '/api/passkey/login/verify') {
        assert.equal(JSON.parse(init!.body!).response.id, 'AQID');
        authenticated = true;
        data = { configured: true, authenticated: true, username: 'Stirrup' };
      } else if (path === '/api/logout') {
        authenticated = false;
        data = {};
      } else if (path === '/api/settings')
        data = {
          account: {
            username: 'Stirrup',
            authMethod: 'passkey',
            configuredSessionTtlSeconds: 43200,
            currentSessionExpiresAt: Date.now() + 43200000,
          },
          storage: {
            backend: 'sqlite',
            location: '.local/web/stirrup.sqlite',
            schemaVersion: 1,
            projectCount: 1,
            conversationCount: 2,
            messageCount: 2,
          },
        };
      else if (path === '/api/workspace')
        data = {
          projects: [{ id: 'p', name: 'Project', cwd: '/project' }],
          conversations: records,
        };
      else if (init?.method === 'PUT') {
        writes.push(JSON.parse(init.body!));
        data = { revision: writes.length, updatedAt: 2 };
      } else throw new Error(`Unexpected UI request: ${path}`);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    window.eval(script.code);
    await until(() => !!doc.getElementById('login-form'));
    assert.equal(window.location.pathname, '/login');
    assert.equal(doc.querySelectorAll('input').length, 0);
    assert.match(doc.getElementById('login-submit')!.textContent, /Passkey/);
    doc
      .getElementById('login-form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !doc.getElementById('login-error')!.hidden);
    assert.match(doc.getElementById('login-error')!.textContent, /取消/);
    cancelPrompt = false;
    doc
      .getElementById('login-form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !!doc.getElementById('workspace'));
    assert.equal(window.location.pathname, '/chat');
    for (const agent of ['agy']) {
      (doc.querySelector(`[data-agent="${agent}"]`) as unknown as HTMLButtonElement).click();
      assert.equal(new URLSearchParams(window.location.search).get('agent'), agent);
      assert.equal(doc.querySelectorAll('.session-row').length, 0);
    }
    (doc.querySelector('[data-agent="codex"]') as unknown as HTMLButtonElement).click();
    (doc.querySelector('.session-row') as unknown as HTMLButtonElement).click();
    assert.equal(
      (doc.getElementById('prompt') as unknown as HTMLTextAreaElement).value,
      'codex draft',
    );
    assert.equal(doc.querySelector('.message-content strong')?.textContent, 'Hello');
    assert.equal(
      doc.querySelectorAll(
        '.message-content img, .message-content script, .message-content [href^="javascript:"]',
      ).length,
      0,
      doc.querySelector('.message-content')!.innerHTML,
    );
    const prompt = doc.getElementById('prompt') as unknown as HTMLTextAreaElement;
    prompt.value = 'unsent Codex edit';
    doc.getElementById('prompt')!.dispatchEvent(new window.Event('input'));
    (doc.querySelector('[data-agent="dsh"]') as unknown as HTMLButtonElement).click();
    assert.equal(doc.querySelectorAll('.session-row').length, 1);
    assert.match(doc.querySelector('.session-row')!.textContent, /dsh history/);
    (doc.querySelector('.session-row') as unknown as HTMLButtonElement).click();
    assert.equal(prompt.value, 'dsh draft');
    (doc.querySelector('[data-agent="codex"]') as unknown as HTMLButtonElement).click();
    assert.equal(prompt.value, 'unsent Codex edit');
    (doc.getElementById('settings') as unknown as HTMLButtonElement).click();
    assert.equal((doc.getElementById('dialog') as unknown as HTMLDialogElement).open, false);
    assert.equal(doc.getElementById('settings-panel')!.hidden, false);
    assert.equal(doc.getElementById('chat-panel')!.hidden, true);
    const theme = doc.getElementById('theme') as unknown as HTMLSelectElement;
    theme.value = 'dark';
    doc.getElementById('theme')!.dispatchEvent(new window.Event('change'));
    assert.equal(doc.documentElement.dataset.theme, 'dark');
    (doc.querySelector('[data-agent="codex"]') as unknown as HTMLButtonElement).click();
    assert.equal(window.location.pathname, '/chat');
    await until(() => writes.length > 0);
    assert.equal(writes[0].draft, 'unsent Codex edit');
    (doc.getElementById('settings') as unknown as HTMLButtonElement).click();
    (doc.querySelector('[data-section="account"]') as unknown as HTMLButtonElement).click();
    await until(() => !!doc.getElementById('logout'));
    (doc.getElementById('logout') as unknown as HTMLButtonElement).click();
    (doc.getElementById('confirm-logout') as unknown as HTMLButtonElement).click();
    await until(() => !!doc.getElementById('login-form'));
    assert.equal(doc.getElementById('workspace'), null);
    doc
      .getElementById('login-form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !!doc.getElementById('workspace'));
    assert.equal(doc.querySelectorAll('#workspace').length, 1);
    (doc.getElementById('settings') as unknown as HTMLButtonElement).click();
    assert.equal((doc.getElementById('dialog') as unknown as HTMLDialogElement).open, false);
    assert.equal(doc.getElementById('settings-panel')!.hidden, false);
    assert.equal(doc.getElementById('chat-panel')!.hidden, true);
    authenticated = false;
    window.dispatchEvent(new window.Event('focus'));
    await until(() => !!doc.getElementById('login-form'));
    assert.equal(doc.querySelectorAll('.message-content').length, 0);
  },
);

test(
  'empty-account page directly initializes Passkey and then offers normal login',
  { timeout: 15000 },
  async (t) => {
    const output = await build({
      configFile: false,
      root: new URL('../web/', import.meta.url).pathname,
      logLevel: 'silent',
      build: { write: false },
    });
    assert.ok(!Array.isArray(output) && 'output' in output);
    const script = output.output.find((item) => item.type === 'chunk' && item.isEntry);
    assert.ok(script?.type === 'chunk');
    const dom = new JSDOM('<div id="app"></div><div id="toast" hidden></div>', {
      url: 'http://localhost:5173/login',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const window = dom.window;
    t.after(() => window.close());
    /** Supply the media query API omitted by the DOM test environment. */
    window.matchMedia = (() => ({
      matches: false,
      addEventListener() {},
    })) as unknown as typeof window.matchMedia;
    window.PublicKeyCredential = class {} as unknown as typeof window.PublicKeyCredential;
    Object.defineProperty(window.navigator, 'credentials', {
      value: {
        /** Model a user-approved native registration result; the server tests validate actual attestations separately. */
        async create() {
          const bytes = new window.Uint8Array([1, 2, 3]).buffer;
          return {
            id: 'AQID',
            rawId: bytes,
            type: 'public-key',
            response: { clientDataJSON: bytes, attestationObject: bytes },
            /** Return no test authenticator extensions. */
            getClientExtensionResults() {
              return {};
            },
          };
        },
      },
    });
    const requests: string[] = [];
    window.fetch = (async (input: unknown, init?: { body?: string }) => {
      const path = String(input);
      requests.push(path);
      let data;
      if (path === '/api/auth') data = { configured: false, authenticated: false };
      else if (path === '/api/passkey/register/options') {
        assert.deepEqual(JSON.parse(init!.body!), {});
        data = {
          challenge: 'AQID',
          rp: { id: 'localhost', name: 'Stirrup' },
          user: { id: 'AQID', name: 'Stirrup', displayName: 'Stirrup' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        };
      } else if (path === '/api/passkey/register/verify')
        data = { configured: true, authenticated: false };
      else throw new Error(`Unexpected registration request: ${path}`);
      return new Response(JSON.stringify(data), { status: 200 });
    }) as typeof window.fetch;
    window.eval(script.code);
    const doc = window.document;
    await until(() => !!doc.getElementById('login-form'));
    assert.equal(window.location.hash, '');
    assert.equal(doc.querySelectorAll('input').length, 0);
    assert.match(doc.getElementById('login-submit')!.textContent, /创建 Passkey/);
    doc
      .getElementById('login-form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => doc.getElementById('login-submit')?.textContent === '使用 Passkey 登录');
    assert.equal(window.location.pathname, '/login');
    assert.ok(!requests.includes('/api/workspace'));
  },
);
