import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_IDS, isAgentId, sessionOptions } from '../web/acp/agents.ts';
import { readChatRoute, workspaceDestination } from '../web/app/routes.ts';
import type { Preferences } from '../web/app/preferences.ts';

test('AGY deep links survive login and unknown or inherited keys are rejected', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  const prefs: Preferences = { theme: 'system', opaque: false, motion: true, ratio: 0.2,
    agent: 'codex', selected: { agy: 'a1' } };
  for (const agent of AGENT_IDS) {
    Object.defineProperty(globalThis, 'location', { configurable: true,
      value: new URL(`http://localhost/chat?agent=${agent}&session=s1`) });
    assert.equal(readChatRoute(prefs).agent, agent);
    assert.equal(readChatRoute(prefs).session, 's1');
    assert.equal(workspaceDestination(), `/chat?agent=${agent}&session=s1`);
  }
  for (const agent of ['unknown', 'toString', '__proto__', '', null]) {
    assert.equal(isAgentId(agent), false);
    Object.defineProperty(globalThis, 'location', { configurable: true,
      value: new URL(`http://localhost/chat?agent=${agent}`) });
    assert.equal(readChatRoute(prefs).agent, 'codex');
    assert.equal(workspaceDestination(), '/chat');
  }
});

test('AGY options use advertised categories and do not inherit Codex Fast mode IDs', () => {
  for (const agent of ['agy'] as const) {
    const options = [
      { id: 'vendor-model', name: 'Model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] },
      { id: 'fast-mode', name: 'Vendor option', type: 'boolean', currentValue: false },
    ] as const;
    const result = sessionOptions(agent, structuredClone(options) as unknown as Parameters<typeof sessionOptions>[1]);
    assert.equal(result.model?.id, 'vendor-model');
    assert.equal(result.fast, undefined);
    assert.equal(result.other[0].id, 'fast-mode');
  }
});
