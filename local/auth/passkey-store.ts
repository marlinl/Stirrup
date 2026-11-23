import { createHash } from 'node:crypto';

export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}
export interface PasskeyConfig {
  revision: number;
  rpId: string;
  userId: string;
  username: string;
  sessionTtlSeconds: number;
  credential: StoredCredential;
}

/** Describe expected authentication failures without revealing credential internals. */
export class PasskeyError extends Error {
  /** Attach a safe HTTP status and message to a rejected authentication operation. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Identify the allowed user and RP/public key independently of counters, display name and preferences. */
export function configIdentity(config: PasskeyConfig | undefined): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        config
          ? [config.userId, config.rpId, config.credential.id, config.credential.publicKey]
          : null,
      ),
    )
    .digest('hex');
}
