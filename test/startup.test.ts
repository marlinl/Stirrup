import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readStartupConfig, parsePort } from '../src/config/startup.ts';
import { validHost, sameOrigin } from '../src/http/request.ts';
import { isAllowedOrigin } from '../src/acp/bridge.ts';
import { readSiteConfig } from '../src/config/site.ts';

const repository = resolve(import.meta.dirname, '..');

/** Allocate isolated application configuration and history; never read or modify the real account. */
function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'stirrup-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('startup defaults and .env-only settings reject malformed values without exposing their content', (t) => {
  const root = fixture(t);
  assert.deepEqual(readStartupConfig(root), { host: '127.0.0.1', port: 5173 });
  const original = process.env.STIRRUP_PORT;
  t.after(() => {
    if (original === undefined) delete process.env.STIRRUP_PORT;
    else process.env.STIRRUP_PORT = original;
  });
  process.env.STIRRUP_PORT = '8888';
  writeFileSync(join(root, '.env.local'), 'STIRRUP_PORT=9999\n');
  assert.equal(readStartupConfig(root).port, 5173);
  writeFileSync(join(root, '.env'), 'STIRRUP_HOST="::1"\nSTIRRUP_PORT=6081\n');
  assert.deepEqual(readStartupConfig(root), { host: '::1', port: 6081 });
  for (const host of [
    '127.0.0.1',
    'localhost',
    '::1',
    '0.0.0.0',
    '::',
    '192.168.1.2',
    'outside.example',
  ]) {
    writeFileSync(join(root, '.env'), `STIRRUP_HOST=${host}\nSTIRRUP_PORT=65535`);
    assert.equal(readStartupConfig(root).host, host);
  }
  for (const host of ['', 'http://localhost', '[::1]', 'localhost:5173', 'host/path', 'bad host']) {
    writeFileSync(join(root, '.env'), `STIRRUP_HOST=${host}\n`);
    assert.throws(() => readStartupConfig(root), /STIRRUP_HOST/);
  }
  for (const port of ['', '0', '-1', '65536', '5173x', '1.5', '5e3', '0x1435', 'private-value']) {
    writeFileSync(join(root, '.env'), `STIRRUP_PORT=${port}\n`);
    assert.throws(
      () => readStartupConfig(root),
      (error: Error) =>
        /STIRRUP_PORT/.test(error.message) && !error.message.includes('private-value'),
    );
  }
  assert.equal(parsePort('1'), 1);
  rmSync(join(root, '.env'));
  mkdirSync(join(root, '.env'));
  assert.throws(() => readStartupConfig(root), /无法读取/);
});

test('HTTP and ACP validate loopback authorities against actual ports, including IPv6 and implicit port 80', () => {
  for (const port of [80, 6081]) {
    for (const host of [
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      ...(port === 80 ? ['localhost', '127.0.0.1', '[::1]'] : []),
    ]) {
      const request = {
        headers: { host, origin: new URL(`http://${host}`).origin },
        socket: { localPort: port },
      } as IncomingMessage;
      assert.equal(validHost(request), true);
      assert.equal(sameOrigin(request), true);
      assert.equal(isAllowedOrigin(request), true);
      request.headers.origin = 'http://outside.example';
      assert.equal(sameOrigin(request), false);
      assert.equal(isAllowedOrigin(request), false);
    }
    for (const host of [
      'localhost:1',
      '[::1]:1',
      'localhost.evil:6081',
      'evil@localhost:6081',
      'localhost:6081/path',
      undefined,
    ]) {
      const request = {
        headers: { host, origin: `http://${host}` },
        socket: { localPort: port },
      } as IncomingMessage;
      assert.equal(validHost(request), false);
      assert.equal(isAllowedOrigin(request), false);
    }
  }
});

/** Run a repository CLI against disposable cwd and collect only its fixture output with a bounded deadline. */
function command(root: string, args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = once(child, 'exit').then(([code]) => {
    clearTimeout(timer);
    return code;
  });
  return { child, done, output: () => output };
}

/** Reserve a real loopback port for listen tests; closing the returned server makes the port available. */
async function reserve(host = '127.0.0.1') {
  const server = createServer();
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

/** Wait for a CLI startup outcome without opening the user's app or launching any real Agent. */
async function ready(run: ReturnType<typeof command>): Promise<void> {
  const end = Date.now() + 10000;
  while (!run.output().includes('Local:')) {
    assert.equal(run.child.exitCode, null, run.output());
    if (Date.now() > end) throw new Error(`Startup timeout: ${run.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  'real Node development and production listeners honor .env, CLI overrides and strict occupied-port cleanup',
  { timeout: 30000 },
  async (t) => {
    const root = fixture(t);
    mkdirSync(join(root, 'web'));
    writeFileSync(
      join(root, 'web/index.html'),
      '<main>fixture</main><script type="module" src="/main.ts"></script>',
    );
    mkdirSync(join(root, 'web/api'));
    writeFileSync(
      join(root, 'web/main.ts'),
      "import { value } from './api/client.ts'; console.log(value);",
    );
    writeFileSync(join(root, 'web/api/client.ts'), 'export const value = 1;');
    mkdirSync(join(root, 'dist/web'), { recursive: true });
    writeFileSync(join(root, 'dist/web/index.html'), '<main>fixture preview</main>');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/private.ts'), 'PRIVATE_FIXTURE_CONTENT');
    for (const directory of ['web', 'dist/web']) {
      writeFileSync(join(root, directory, 'fixture.css'), 'body { color: red; }');
      symlinkSync(join(root, 'src/private.ts'), join(root, directory, 'escape.txt'));
    }
    const entry = join(repository, 'src/main.ts');
    const config = ['--import', join(repository, 'node_modules/tsx/dist/loader.mjs'), entry];
    for (const { mode, host } of [
      { mode: ['--dev'], host: '127.0.0.1' },
      { mode: [], host: '127.0.0.1' },
      { mode: ['--dev'], host: '::1' },
      { mode: [], host: '::1' },
      { mode: ['--dev'], host: '0.0.0.0' },
      { mode: [], host: '0.0.0.0' },
    ]) {
      const authority = host === '::1' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host;
      const reserved = await reserve(host);
      await new Promise<void>((resolve) => reserved.server.close(() => resolve()));
      writeFileSync(join(root, '.env'), `STIRRUP_HOST=${host}\nSTIRRUP_PORT=${reserved.port}\n`);
      const run = command(root, [...config, ...mode]);
      try {
        await ready(run);
        const response = await fetch(`http://${authority}:${reserved.port}/api/auth`);
        for (const path of ['/', '/login', '/chat', '/settings/account']) {
          const page = await fetch(`http://${authority}:${reserved.port}${path}`);
          assert.equal(page.status, 200);
          assert.match(await page.text(), /fixture/);
        }
        for (const [path, status] of [
          ['/api/missing', 401],
          ['/acp/missing', 404],
          ['/assets/missing.js', 404],
        ] as const) {
          assert.equal((await fetch(`http://${authority}:${reserved.port}${path}`)).status, status);
        }
        const frontendBase = mode.length ? '/web' : '';
        const asset = await fetch(
          `http://${authority}:${reserved.port}${frontendBase}/fixture.css?direct`,
        );
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('content-type') ?? '', /text\/css/);
        for (const path of [
          '/.env',
          '/.local/web/stirrup.sqlite',
          '/src/private.ts',
          `${frontendBase}/escape.txt`,
          `${frontendBase}/@fs${root}/src/private.ts`,
        ]) {
          const denied = await fetch(`http://${authority}:${reserved.port}${path}`);
          assert.ok([403, 404].includes(denied.status), `${path}: ${denied.status}`);
          assert.ok(!(await denied.text()).includes('PRIVATE_FIXTURE_CONTENT'));
        }
        if (mode.length) {
          for (const path of ['/web/main.ts', '/web/api/client.ts', '/web/@vite/client']) {
            assert.equal(
              (await fetch(`http://${authority}:${reserved.port}${path}`)).status,
              200,
              path,
            );
          }
        }
        assert.equal(response.status, 200);
        assert.equal((await response.json()).authenticated, false);
        const protectedResponse = await fetch(`http://${authority}:${reserved.port}/api/workspace`);
        assert.equal(protectedResponse.status, 401);
      } finally {
        run.child.kill('SIGTERM');
        await run.done;
      }
      assert.equal(existsSync(join(root, '.local/web/.storage.lock')), false);
      const busy = await reserve();
      writeFileSync(join(root, '.env'), `STIRRUP_PORT=${busy.port}\n`);
      try {
        const blocked = command(root, [...config, ...mode]);
        assert.notEqual(await blocked.done, 0);
        assert.match(blocked.output(), /already in use/);
        assert.equal(existsSync(join(root, '.local/web/.storage.lock')), false);
      } finally {
        await new Promise<void>((resolve) => busy.server.close(() => resolve()));
      }
    }
    const port = await reserve();
    await new Promise<void>((resolve) => port.server.close(() => resolve()));
    writeFileSync(join(root, '.env'), 'STIRRUP_PORT=5173\n');
    const overridden = command(root, [
      ...config,
      '--host',
      'localhost',
      '--port',
      String(port.port),
    ]);
    try {
      await ready(overridden);
      assert.equal((await fetch(`http://localhost:${port.port}/api/auth`)).status, 200);
    } finally {
      overridden.child.kill('SIGTERM');
      await overridden.done;
    }
    assert.equal(existsSync(join(root, '.local/web/.storage.lock')), false);
    const invalid = command(root, [...config, '--host', 'http://localhost']);
    assert.notEqual(await invalid.done, 0);
    assert.match(invalid.output(), /STIRRUP_HOST/);
    assert.equal(existsSync(join(root, '.local/web/.storage.lock')), false);
  },
);

test('external site URL is independent of listener and accepts only valid WebAuthn site origins', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.env'), 'STIRRUP_SITE_URL=https://chat.example.com:8443/\n');
  const site = readSiteConfig(root);
  assert.deepEqual(site, {
    origin: 'https://chat.example.com:8443',
    rpId: 'chat.example.com',
    secure: true,
  });
  const request = {
    headers: { host: 'chat.example.com:8443', origin: site.origin },
    socket: { localPort: 5173 },
  } as IncomingMessage;
  assert.equal(validHost(request, site), true);
  assert.equal(sameOrigin(request, site), true);
  assert.equal(isAllowedOrigin(request, site), true);
  request.headers.origin = 'http://chat.example.com:8443';
  assert.equal(sameOrigin(request, site), false);
  request.headers.host = 'localhost:5173';
  request.headers.origin = site.origin;
  request.headers['x-forwarded-host'] = 'chat.example.com:8443';
  assert.equal(validHost(request, site), false);
  for (const value of [
    '',
    'http://chat.example.com',
    'https://192.168.1.2',
    'https://chat.example.com/path',
    'https://user:secret@chat.example.com',
    'https://chat.example.com?q=1',
  ]) {
    writeFileSync(join(root, '.env'), `STIRRUP_SITE_URL=${value}\n`);
    assert.throws(() => readSiteConfig(root), /STIRRUP_SITE_URL/);
  }
});
