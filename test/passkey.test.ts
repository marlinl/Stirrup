import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasskeyAuth } from '../local/auth/passkey-auth.ts';
import { prepareEnrollment, readPasskeyConfig, writePasskeyConfig } from '../local/auth/passkey-store.ts';
import { testAuthenticator } from './fixtures/passkey.ts';

/** Allocate disposable account state and a controllable clock; never touch the user's .env. */
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'stirrup-passkey-'));
  let now = Date.now();
  const auth = new PasskeyAuth(root, () => now);
  const device = testAuthenticator();
  const origin = 'http://localhost:5173';
  t.after(() => {
    auth.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    auth,
    device,
    origin,
    /** Advance only authentication challenge time for deterministic expiration tests. */
    advance(ms: number) {
      now += ms;
    },
    /** Register a real test key through terminal-granted, verified WebAuthn registration. */
    async enroll() {
      const token = prepareEnrollment(root, now);
      const options = await auth.begin('register', origin, 'browser', token);
      await auth.finish('register', origin, 'browser', device.register(options.challenge, origin));
    },
  };
}

test('terminal enrollment verifies and stores only the public credential in .env, preserving unrelated configuration', async (t) => {
  const h = setup(t);
  writeFileSync(join(h.root, '.env'), '# Existing local settings\nMODEL_SETTING="keep-this"\n');
  await assert.rejects(h.auth.begin('register', h.origin, 'browser'), /一次性/);
  await assert.rejects(h.auth.begin('register', h.origin, 'browser', 'wrong'), /绑定入口/);
  await h.enroll();
  const config = readPasskeyConfig(h.root);
  assert.equal(config.credential?.id, h.device.id);
  assert.equal(config.username, 'Stirrup');
  assert.ok(config.source.includes('MODEL_SETTING="keep-this"'));
  assert.ok(!config.source.includes('PRIVATE KEY'));
  assert.equal(statSync(join(h.root, '.env')).mode & 0o777, 0o600);
  assert.throws(() => prepareEnrollment(h.root), /不会覆盖/);
  assert.throws(() => readFileSync(join(h.root, '.local/web/passkey-enrollment.json')), /ENOENT/);
  const options = await h.auth.begin('login', h.origin, 'browser');
  const result = await h.auth.finish(
    'login',
    h.origin,
    'browser',
    h.device.authenticate(options.challenge, h.origin, 1, 5, 'localhost', config.userId),
  );
  assert.equal(result?.username, 'Stirrup');
  assert.equal(readPasskeyConfig(h.root).credential?.counter, 1);
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
    if (attack === 'signature') assertion.response.signature = Buffer.alloc(64).toString('base64url');
    if (attack === 'credential') assertion.id = 'unknown';
    if (attack === 'expired') h.advance(300_001);
    await assert.rejects(
      h.auth.finish('login', h.origin, attack === 'browser' ? 'other-browser' : 'browser', assertion),
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

test('registration requires user verification and a still-valid terminal grant; .env changes invalidate pending login', async (t) => {
  const h = setup(t);
  const token = prepareEnrollment(h.root);
  const options = await h.auth.begin('register', h.origin, 'browser', token);
  await assert.rejects(
    h.auth.finish('register', h.origin, 'browser', h.device.register(options.challenge, h.origin, 0x41)),
    /验证失败/,
  );
  assert.equal(readPasskeyConfig(h.root).credential, undefined);
  const second = await h.auth.begin('register', h.origin, 'browser', token);
  prepareEnrollment(h.root); // Replacing the terminal grant invalidates registration already in flight.
  await assert.rejects(
    h.auth.finish('register', h.origin, 'browser', h.device.register(second.challenge, h.origin)),
    /绑定入口/,
  );
  await h.enroll();
  const login = await h.auth.begin('login', h.origin, 'browser');
  const config = readPasskeyConfig(h.root);
  writePasskeyConfig(h.root, config, { ...config, credential: undefined });
  await assert.rejects(
    h.auth.finish('login', h.origin, 'browser', h.device.authenticate(login.challenge, h.origin)),
    /失效/,
  );
});
