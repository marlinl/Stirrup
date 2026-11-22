import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  checkEnrollment,
  configIdentity,
  digest,
  finishEnrollment,
  PasskeyError,
  readPasskeyConfig,
  RP_ID,
  writePasskeyConfig,
} from './passkey-store.ts';

type Ceremony = 'register' | 'login';
interface Challenge {
  kind: Ceremony;
  challenge: string;
  origin: string;
  identity: string;
  expires: number;
  enrollmentHash?: string;
}

/** Verify WebAuthn ceremonies with browser-bound, expiring, single-use challenges and a single .env identity. */
export class PasskeyAuth {
  private readonly challenges = new Map<string, Challenge>();

  /** Bind authentication to the local configuration directory and an injectable test clock. */
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Issue only localhost RP challenges; registration additionally requires a grant created by the local CLI. */
  async begin(kind: Ceremony, origin: string, browser: string, enrollmentToken?: unknown) {
    if (new URL(origin).hostname !== RP_ID)
      throw new PasskeyError(400, '请通过 http://localhost 访问以使用 Passkey');
    for (const [id, challenge] of this.challenges)
      if (challenge.expires <= this.now()) this.challenges.delete(id);
    if (this.challenges.size >= 100) throw new PasskeyError(429, '请求过于频繁，请稍后再试');
    const config = readPasskeyConfig(this.root);
    let enrollmentHash: string | undefined;
    if (kind === 'register') {
      if (typeof enrollmentToken !== 'string' || enrollmentToken.length > 256)
        throw new PasskeyError(403, '请使用本机终端生成的一次性绑定入口');
      enrollmentHash = digest(enrollmentToken);
      checkEnrollment(this.root, enrollmentHash, config, this.now());
    } else if (!config.credential)
      throw new PasskeyError(409, '尚未绑定 Passkey，请先在本机运行 npm run passkey:setup');
    const options =
      kind === 'register'
        ? await generateRegistrationOptions({
            rpID: RP_ID,
            rpName: 'Stirrup',
            userID: new Uint8Array(Buffer.from(config.userId, 'base64url')),
            userName: config.username,
            attestationType: 'none',
            supportedAlgorithmIDs: [-7, -257],
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          })
        : await generateAuthenticationOptions({
            rpID: RP_ID,
            userVerification: 'required',
            allowCredentials: [{ id: config.credential!.id, transports: config.credential!.transports }],
          });
    this.challenges.set(browser, {
      kind,
      challenge: options.challenge,
      origin,
      identity: configIdentity(config),
      expires: this.now() + 300_000,
      enrollmentHash,
    });
    return options;
  }

  /** Consume a challenge before verification, enforce signature/UV/origin/RP, then persist the verified credential or counter. */
  async finish(
    kind: Ceremony,
    origin: string,
    browser: string,
    response: unknown,
  ): Promise<{ username: string; identity: string } | undefined> {
    const challenge = this.challenges.get(browser);
    this.challenges.delete(browser);
    const config = readPasskeyConfig(this.root);
    if (
      !challenge ||
      challenge.expires <= this.now() ||
      challenge.kind !== kind ||
      challenge.origin !== origin ||
      challenge.identity !== configIdentity(config)
    ) {
      throw new PasskeyError(401, 'Passkey 请求已失效，请重新开始');
    }
    try {
      if (!response || typeof response !== 'object') throw new Error();
      if (kind === 'register') {
        checkEnrollment(this.root, challenge.enrollmentHash!, config, this.now());
        const result = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: RP_ID,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257],
        });
        if (!result.verified) throw new Error();
        // Recheck the grant after async cryptographic verification; concurrent registrations cannot overwrite a key.
        checkEnrollment(this.root, challenge.enrollmentHash!, readPasskeyConfig(this.root), this.now());
        const credential = result.registrationInfo.credential;
        if (challenge.expires <= this.now()) throw new PasskeyError(401, 'Passkey 请求已失效，请重新开始');
        writePasskeyConfig(this.root, config, {
          ...config,
          credential: {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            transports: credential.transports?.filter((item) =>
              ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(item),
            ),
          },
        });
        finishEnrollment(this.root);
        return;
      }
      const assertion = response as AuthenticationResponseJSON;
      if (
        !config.credential ||
        assertion.id !== config.credential.id ||
        (assertion.response.userHandle && assertion.response.userHandle !== config.userId)
      )
        throw new Error();
      const result = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          ...config.credential,
          publicKey: new Uint8Array(Buffer.from(config.credential.publicKey, 'base64url')),
        },
      });
      if (!result.verified || challenge.expires <= this.now()) throw new Error();
      writePasskeyConfig(this.root, config, {
        ...config,
        credential: { ...config.credential, counter: result.authenticationInfo.newCounter },
      });
      return { username: config.username, identity: configIdentity(config) };
    } catch (error) {
      if (error instanceof PasskeyError) throw error;
      throw new PasskeyError(401, 'Passkey 验证失败，请重试');
    }
  }

  /** Discard outstanding ceremonies when the local web process stops. */
  close(): void {
    this.challenges.clear();
  }
}
