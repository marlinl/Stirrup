import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasskeyAuth } from '../local/auth/passkey-auth.ts';
import { WorkspaceStore } from '../local/storage/workspace-store.ts';
import { PersonalSettingsStore } from '../local/storage/personal-settings-store.ts';
import { readSiteConfig } from '../local/config/site.ts';
import { testAuthenticator } from './fixtures/passkey.ts';

/** Allocate disposable account state and a controllable clock; never touch the user's .env. */
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'stirrup-passkey-'));
  let now = Date.now();
  const workspace = new WorkspaceStore(root);
  const settings = new PersonalSettingsStore(workspace.connection);
  const auth = new PasskeyAuth(settings, readSiteConfig(root), () => now);
  const device = testAuthenticator();
  const origin = 'http://localhost:5173';
  t.after(() => {
    auth.close();
    workspace.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    settings,
    workspace,
    auth,
    device,
    origin,
    /** Advance only authentication challenge time for deterministic expiration tests. */
    advance(ms: number) {
      now += ms;
    },
    /** Register a real test key through first-use verified WebAuthn registration. */
    async enroll() {
      const options = await auth.begin('register', origin, 'browser');
      await auth.finish('register', origin, 'browser', device.register(options.challenge, origin));
    },
  };
}

test('empty personal table initializes once after verification and ignores old .env identity', async (t) => {
  const h = setup(t);
  const original = 'STIRRUP_PASSKEY_CREDENTIAL=not-valid-json\nSTIRRUP_SESSION_TTL_SECONDS=1\n';
  writeFileSync(join(h.root, '.env'), original);
  assert.equal(h.settings.readConfig(), undefined);
  await h.enroll();
  const config = h.settings.readConfig()!;
  assert.equal(config.credential.id, h.device.id);
  assert.equal(config.username, 'Stirrup');
  assert.equal(config.rpId, 'localhost');
  assert.equal(config.sessionTtlSeconds, 43200);
  assert.equal(readFileSync(join(h.root, '.env'), 'utf8'), original);
  await assert.rejects(h.auth.begin('register', h.origin, 'browser'), /已完成初始化/);
  const options = await h.auth.begin('login', h.origin, 'browser');
  const result = await h.auth.finish(
    'login',
    h.origin,
    'browser',
    h.device.authenticate(options.challenge, h.origin, 1, 5, 'localhost', config.userId),
  );
  assert.equal(result?.username, 'Stirrup');
  assert.equal(h.settings.readConfig()!.credential.counter, 1);
});

test('login rejects replay, foreign browser, expired challenge, wrong origin, RP, UV, signature and user handle', async (t) => {
  const h = setup(t);
  await h.enroll();
  for (const attack of [
    'browser',
    'expired',
    'origin',
    'rp',
    'uv',
    'signature',
    'user',
    'challenge',
    'credential',
  ]) {
    const options = await h.auth.begin('login', h.origin, 'browser');
    const assertion = h.device.authenticate(
      attack === 'challenge' ? 'invalid' : options.challenge,
      attack === 'origin' ? 'https://outside.example' : h.origin,
      1,
      attack === 'uv' ? 1 : 5,
      attack === 'rp' ? 'outside.example' : 'localhost',
      attack === 'user' ? 'wrong-user' : undefined,
    );
    if (attack === 'signature')
      assertion.response.signature = Buffer.alloc(64).toString('base64url');
    if (attack === 'credential') assertion.id = 'unknown';
    if (attack === 'expired') h.advance(300_001);
    await assert.rejects(
      h.auth.finish(
        'login',
        h.origin,
        attack === 'browser' ? 'other-browser' : 'browser',
        assertion,
      ),
    );
  }
  const options = await h.auth.begin('login', h.origin, 'browser');
  const assertion = h.device.authenticate(options.challenge, h.origin);
  await h.auth.finish('login', h.origin, 'browser', assertion);
  await assert.rejects(h.auth.finish('login', h.origin, 'browser', assertion), /失效/);
  const next = await h.auth.begin('login', h.origin, 'browser');
  await assert.rejects(
    h.auth.finish('login', h.origin, 'browser', h.device.authenticate(next.challenge, h.origin, 1)),
    /验证失败/,
  );
});

test('failed initialization leaves no row; competing verified registrations create exactly one account', async (t) => {
  const h = setup(t);
  const options = await h.auth.begin('register', h.origin, 'browser');
  await assert.rejects(
    h.auth.finish(
      'register',
      h.origin,
      'browser',
      h.device.register(options.challenge, h.origin, 0x41),
    ),
    /验证失败/,
  );
  assert.equal(h.settings.readConfig(), undefined);
  const a = await h.auth.begin('register', h.origin, 'a');
  const b = await h.auth.begin('register', h.origin, 'b');
  const other = testAuthenticator();
  const results = await Promise.allSettled([
    h.auth.finish('register', h.origin, 'a', h.device.register(a.challenge, h.origin)),
    h.auth.finish('register', h.origin, 'b', other.register(b.challenge, h.origin)),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    h.workspace.connection.db.prepare('SELECT count(*) AS n FROM personal_settings').get()?.n,
    1,
  );
});

test('external HTTPS RP verifies its own domain and rejects wrong origins and localhost credentials', async (t) => {
  const h = setup(t);
  const site = { origin: 'https://chat.example.com:8443', rpId: 'chat.example.com', secure: true };
  const auth = new PasskeyAuth(h.settings, site);
  t.after(() => auth.close());
  await assert.rejects(auth.begin('register', 'http://localhost:5173', 'bad'), /不匹配/);
  const failed = await auth.begin('register', site.origin, 'bad-rp');
  await assert.rejects(
    auth.finish(
      'register',
      site.origin,
      'bad-rp',
      h.device.register(failed.challenge, site.origin),
    ),
    /验证失败/,
  );
  assert.equal(h.settings.readConfig(), undefined);
  const options = await auth.begin('register', site.origin, 'a');
  assert.equal('rp' in options && options.rp.id, site.rpId);
  await auth.finish(
    'register',
    site.origin,
    'a',
    h.device.register(options.challenge, site.origin, 0x45, site.rpId),
  );
  const login = await auth.begin('login', site.origin, 'a');
  await auth.finish(
    'login',
    site.origin,
    'a',
    h.device.authenticate(login.challenge, site.origin, 1, 5, site.rpId),
  );
  await assert.rejects(h.auth.begin('login', h.origin, 'a'), /已绑定 Passkey 不匹配/);
});

test('reopening SQLite retains public credentials and personal settings without consulting the old env', async (t) => {
  const h = setup(t);
  await h.enroll();
  const config = h.settings.readConfig()!;
  h.settings.saveAccount({
    username: 'Personal',
    sessionTtlSeconds: 600,
    revision: config.revision,
  });
  h.settings.savePreferences({
    values: { theme: 'dark', opaque: true, motion: false, ratio: 0.4 },
    revision: 0,
  });
  h.workspace.close();
  writeFileSync(join(h.root, '.env'), 'STIRRUP_PASSKEY_CREDENTIAL=invalid-old-value\n');
  const reopened = new WorkspaceStore(h.root);
  t.after(() => reopened.close());
  const settings = new PersonalSettingsStore(reopened.connection);
  assert.deepEqual(settings.readConfig()!.credential, config.credential);
  assert.equal(settings.readConfig()!.username, 'Personal');
  assert.equal(settings.readConfig()!.sessionTtlSeconds, 600);
  assert.deepEqual(settings.preferences().values, {
    theme: 'dark',
    opaque: true,
    motion: false,
    ratio: 0.4,
  });
});
