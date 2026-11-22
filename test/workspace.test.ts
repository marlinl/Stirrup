import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceController } from '../src/domain/workspace';
import type { Api } from '../src/api/client';
import type { Conversation } from '../src/domain/models';
import { sidebarWidth } from '../src/ui/layout';

/** Create independent saved records without starting a process or using real account data. */
function records(): Conversation[] {
  return ['codex', 'dsh'].map((agentId, i) => ({
    id: `c${i}`,
    projectId: 'project',
    agentId: agentId as Conversation['agentId'],
    title: 'New',
    messages: [],
    draft: '',
    revision: 0,
    updatedAt: 0,
  }));
}

test('background output, same tool IDs and drafts remain isolated between agents', async (t) => {
  const controller = new WorkspaceController(
    (async () => ({ revision: 1, updatedAt: 1 })) as Api,
    () => {},
  );
  controller.conversations = records();
  t.after(() => controller.dispose());
  controller.update('c0', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Codex' },
  });
  controller.update('c1', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'DSH' },
  });
  controller.update('c0', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' reply' },
  });
  for (const id of ['c0', 'c1'])
    controller.update(id, {
      sessionUpdate: 'tool_call',
      toolCallId: 'same-id',
      title: id,
      status: 'pending',
    });
  controller.update('c1', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'same-id',
    status: 'completed',
  });
  controller.draft('c0', 'first');
  controller.draft('c1', 'second');
  assert.deepEqual(
    controller.conversations.map((r) => r.messages[0].text),
    ['Codex reply', 'DSH'],
  );
  assert.deepEqual(
    controller.conversations.map((r) => r.messages[1].status),
    ['pending', 'completed'],
  );
  assert.deepEqual(
    controller.conversations.map((r) => r.draft),
    ['first', 'second'],
  );
  assert.ok([...controller.live.values()].every((state) => !state.client));
});

test('serialized persistence saves changes arriving during an earlier write with the next revision', async (t) => {
  const writes: Conversation[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new WorkspaceController(
    (async (_path, _method, data) => {
      writes.push(data as Conversation);
      if (writes.length === 1) await gate;
      return { revision: writes.length, updatedAt: writes.length };
    }) as Api,
    () => {},
  );
  controller.conversations = records();
  t.after(() => controller.dispose());
  controller.draft('c0', 'before');
  const pending = controller.flush('c0');
  controller.draft('c0', 'after');
  controller.addMessage('c0', 'assistant', 'late output');
  release();
  await pending;
  assert.equal(writes.length, 2);
  assert.equal(writes[0].draft, 'before');
  assert.equal(writes[1].revision, 1);
  assert.equal(writes[1].draft, 'after');
  assert.equal(writes[1].messages[0].text, 'late output');
  assert.equal(controller.state('c0').dirty, false);
});

test('failed saves retain dirty state and retry without discarding unsaved content', async (t) => {
  let failing = true;
  const controller = new WorkspaceController(
    (async () => {
      if (failing) throw new Error('offline');
      return { revision: 1, updatedAt: 1 };
    }) as Api,
    () => {},
  );
  controller.conversations = records();
  t.after(() => controller.dispose());
  controller.draft('c0', 'unsaved');
  await controller.flush('c0');
  assert.equal(controller.state('c0').saveError, 'offline');
  assert.equal(controller.state('c0').dirty, true);
  failing = false;
  await controller.flush('c0');
  assert.equal(controller.record('c0').draft, 'unsaved');
  assert.equal(controller.state('c0').saveError, undefined);
});

test('sidebar defaults to twenty percent, caps at half and preserves readable chat space', () => {
  assert.equal(sidebarWidth(1440, 0.2), 288);
  assert.equal(sidebarWidth(1440, 1), 720);
  assert.equal(sidebarWidth(1000, 0.5), 476);
  assert.equal(sidebarWidth(1440, 0), 200);
  assert.equal(sidebarWidth(0, NaN), 0);
  assert.equal(sidebarWidth(1440, NaN), 288);
});

test('busy or pending approval cannot submit; failed prompts retain the draft without overwriting later edits', async (t) => {
  const controller = new WorkspaceController(
    (async () => ({ revision: 1, updatedAt: 1 })) as Api,
    () => {},
  );
  controller.conversations = records();
  t.after(() => controller.dispose());
  let calls = 0;
  const client = {
    phase: 'configuring',
    sessionId: 's',
    /** Emulate a rejected prompt without creating a new transport or sending network traffic. */
    async prompt() {
      calls++;
      throw new Error('model unavailable');
    },
    /** No transport exists in this fixture. */
    close() {},
  };
  controller.state('c0').client = client as unknown as import('../src/acp/client').AcpClient;
  controller.draft('c0', 'keep');
  await assert.rejects(controller.send('c0', 'keep'), /等待/);
  assert.equal(controller.record('c0').draft, 'keep');
  assert.equal(controller.record('c0').messages.length, 0);
  client.phase = 'ready';
  controller.state('c0').permissions = [{}] as import('../src/acp/client').Permission[];
  await assert.rejects(controller.send('c0', 'keep'), /等待/);
  controller.state('c0').permissions = [];
  await controller.send('c0', 'keep');
  assert.equal(calls, 1);
  assert.equal(controller.record('c0').draft, 'keep');
  assert.equal(controller.record('c0').messages.at(-1)?.kind, 'error');
  client.prompt = async () => {
    calls++;
    controller.draft('c0', 'later edit');
    throw new Error('failed');
  };
  await controller.send('c0', 'retry');
  assert.equal(controller.record('c0').draft, 'later edit');
  assert.equal(calls, 2);
});
