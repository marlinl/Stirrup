import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/** Build a test-only ES256 authenticator; real verifier code checks its CBOR and cryptographic signatures. */
export function testAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]),
  );
  const rawId = randomBytes(32);
  const id = rawId.toString('base64url');
  /** Encode an authenticator data header for the selected RP, presence flags and counter. */
  function authenticatorData(rpId: string, flags: number, counter: number): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), count]);
  }
  return {
    id,
    /** Emit a none-attestation registration, allowing negative UV/RP tests without stubbing verification. */
    register(challenge: string, origin: string, flags = 0x45, rpId = 'localhost'): RegistrationResponseJSON {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(rawId.length);
      const authData = Buffer.concat([
        authenticatorData(rpId, flags, 0),
        Buffer.alloc(16),
        length,
        rawId,
        cose,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ['fmt', 'none'],
          ['authData', new Uint8Array(authData)],
          ['attStmt', new Map()],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({ type: 'webauthn.create', challenge, origin }),
          ).toString('base64url'),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    /** Sign a real assertion with optional flags, RP and user handle for protocol rejection tests. */
    authenticate(
      challenge: string,
      origin: string,
      counter = 1,
      flags = 5,
      rpId = 'localhost',
      userHandle?: string,
    ): AuthenticationResponseJSON {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const authData = authenticatorData(rpId, flags, counter);
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
        privateKey,
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          ...(userHandle ? { userHandle } : {}),
        },
      };
    },
  };
}
