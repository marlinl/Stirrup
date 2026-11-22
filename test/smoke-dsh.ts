import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { attachAcpBridge } from '../local/acp/bridge.ts';
import { AcpClient } from '../src/acp/client.ts';
import { openWebSocket } from '../src/acp/websocket.ts';

/** Exercise the real DSH process through the same bridge and byte transport used by the page. */
async function main(): Promise<void> {
  const server = createServer();
  const dispose = attachAcpBridge(server, process.cwd(), undefined, () => ({
    cwd: process.cwd(),
    bind: () => () => {},
  }));
  let client: AcpClient | undefined;
  let output = '';
  const native = globalThis.WebSocket;
  const timer = setTimeout(() => client?.close(new Error('DSH smoke test timeout')), 60_000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    /** Supply the Origin header which a browser normally supplies automatically. */
    class BrowserSocket extends WebSocket {
      /** Connect only to the test's actual local HTTP origin. */
      constructor(url: string) {
        super(url, { origin });
      }
    }
    globalThis.WebSocket = BrowserSocket as unknown as typeof native;
    client = new AcpClient(await openWebSocket(`ws://127.0.0.1:${address.port}/acp/dsh`), {
      /** State is checked after each operation instead of logging identifiers or credentials. */
      state() {},
      /** Collect only assistant text to verify the fixed harmless reply. */
      update({ update }) {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
          output += update.content.text;
      },
      /** This smoke test never permits tools to read or modify files. */
      permissions(items) {
        for (const item of items) client?.answerPermission(item.id);
      },
    });
    const info = await client.initialize();
    console.log('DSH initialize:', info.protocolVersion, info.agentInfo?.name);
    await client.newSession(process.cwd());
    console.log(
      'DSH session/new: OK; config IDs:',
      client.configOptions.map((option) => option.id).join(', '),
    );
    const option = client.configOptions.find((option) => option.type === 'select');
    if (option) {
      await client.setConfigOption(option.id, option.currentValue);
      console.log('DSH session/set_config_option: OK');
    }
    if (process.argv.includes('--prompt')) {
      const result = await client.prompt(
        'This is a transport smoke test. Do not inspect the workspace, read files, or invoke tools. Reply with only STIRRUP_DSH_OK.',
      );
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(output.trim(), 'STIRRUP_DSH_OK');
      console.log('DSH session/prompt: expected reply received');
    }
    client.close();
    client.close();
    assert.equal(client.phase, 'closed');
    console.log('DSH close: OK');
  } finally {
    clearTimeout(timer);
    client?.close();
    globalThis.WebSocket = native;
    dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error: unknown) => {
  // Avoid printing upstream request/account details; the local agent logs its own diagnostics.
  console.error('DSH smoke failed:', error instanceof Error ? error.name : 'unknown error');
  process.exitCode = 1;
});
