import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { configIdentity, PasskeyError } from './passkey-store.ts';
import type { PersonalSettingsStore } from '../storage/personal-settings-store.ts';
import type { SiteConfig } from '../config/site.ts';

type Ceremony = 'register' | 'login';
interface Challenge {
  kind: Ceremony;
  challenge: string;
  origin: string;
  identity: string;
  userId: string;
  expires: number;
}

/** Verify browser-bound WebAuthn ceremonies against the configured external site and SQLite account. */
export class PasskeyAuth {
  private readonly challenges = new Map<string, Challenge>();

  /** Share the personal store and immutable site configuration; inject a clock for expiry tests. */
  constructor(
    private readonly settings: PersonalSettingsStore,
    private readonly site: SiteConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Issue first-use registration only while the table is empty, or a login for the registered RP. */
  async begin(kind: Ceremony, origin: string, browser: string) {
    if (
      this.site.origin
        ? origin !== this.site.origin
        : new URL(origin).hostname !== this.site.rpId || new URL(origin).protocol !== 'http:'
    )
      throw new PasskeyError(400, '访问地址与 STIRRUP_SITE_URL 不匹配');
    for (const [id, challenge] of this.challenges)
      if (challenge.expires <= this.now()) this.challenges.delete(id);
    if (this.challenges.size >= 100) throw new PasskeyError(429, '请求过于频繁，请稍后再试');
    const config = this.settings.readConfig();
    if (kind === 'register' && config)
      throw new PasskeyError(409, '已完成初始化，请使用 Passkey 登录');
    if (kind === 'login' && !config) throw new PasskeyError(409, '尚未初始化，请先创建 Passkey');
    if (config && config.rpId !== this.site.rpId)
      throw new PasskeyError(409, '当前站点域名与已绑定 Passkey 不匹配，请使用原站点地址');
    const userId = config?.userId ?? randomBytes(32).toString('base64url');
    const options =
      kind === 'register'
        ? await generateRegistrationOptions({
            rpID: this.site.rpId,
            rpName: 'Stirrup',
            userID: new Uint8Array(Buffer.from(userId, 'base64url')),
            userName: 'Stirrup',
            attestationType: 'none',
            supportedAlgorithmIDs: [-7, -257],
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          })
        : await generateAuthenticationOptions({
            rpID: this.site.rpId,
            userVerification: 'required',
            allowCredentials: [
              { id: config!.credential.id, transports: config!.credential.transports },
            ],
          });
    this.challenges.set(browser, {
      kind,
      challenge: options.challenge,
      origin,
      identity: configIdentity(config),
      userId,
      expires: this.now() + 300_000,
    });
    return options;
  }

  /** Consume the challenge, verify signature/UV/origin/RP, then atomically create the account or update its counter. */
  async finish(
    kind: Ceremony,
    origin: string,
    browser: string,
    response: unknown,
  ): Promise<{ username: string; identity: string } | undefined> {
    const challenge = this.challenges.get(browser);
    this.challenges.delete(browser);
    const config = this.settings.readConfig();
    if (
      !challenge ||
      challenge.expires <= this.now() ||
      challenge.kind !== kind ||
      challenge.origin !== origin ||
      challenge.identity !== configIdentity(config)
    )
      throw new PasskeyError(401, 'Passkey 请求已失效，请重新开始');
    try {
      if (!response || typeof response !== 'object') throw new Error();
      if (kind === 'register') {
        const result = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: this.site.rpId,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257],
        });
        if (!result.verified || challenge.expires <= this.now()) throw new Error();
        const credential = result.registrationInfo.credential;
        this.settings.initialize({
          revision: 0,
          userId: challenge.userId,
          username: 'Stirrup',
          rpId: this.site.rpId,
          sessionTtlSeconds: 43200,
          credential: {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            transports: credential.transports?.filter((item) =>
              ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(item),
            ),
          },
        });
        return;
      }
      const assertion = response as AuthenticationResponseJSON;
      if (
        !config ||
        assertion.id !== config.credential.id ||
        (assertion.response.userHandle && assertion.response.userHandle !== config.userId)
      )
        throw new Error();
      const result = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: this.site.rpId,
        requireUserVerification: true,
        credential: {
          ...config.credential,
          publicKey: new Uint8Array(Buffer.from(config.credential.publicKey, 'base64url')),
        },
      });
      if (!result.verified || challenge.expires <= this.now()) throw new Error();
      this.settings.writeConfig(config, {
        ...config,
        credential: { ...config.credential, counter: result.authenticationInfo.newCounter },
      });
      return { username: config.username, identity: configIdentity(config) };
    } catch (error) {
      if (error instanceof PasskeyError) throw error;
      throw new PasskeyError(401, 'Passkey 验证失败，请重试');
    }
  }

  /** Discard outstanding ceremonies when the web process stops. */
  close(): void {
    this.challenges.clear();
  }
}
