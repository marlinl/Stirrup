import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const RP_ID = 'localhost';
const PREFIX = 'STIRRUP_PASSKEY_';
export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}
export interface PasskeyConfig {
  source: string;
  userId: string;
  username: string;
  credential?: StoredCredential;
}

/** Describe an expected authentication failure without revealing authenticator or configuration internals. */
export class PasskeyError extends Error {
  /** Attach a safe HTTP status and message to a rejected authentication operation. */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Hash identifiers for browser sessions and one-time enrollment grants, never storing their bearer secrets. */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Read only the repository's .env; process.env and legacy password accounts cannot override this identity. */
export function readPasskeyConfig(root: string): PasskeyConfig {
  const file = join(root, '.env');
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  try {
    const env = parseEnv(source);
    const userId = env[`${PREFIX}USER_ID`] ?? '';
    const username = env[`${PREFIX}USER_NAME`] ?? '';
    if (
      (userId || username) &&
      (!/^[A-Za-z0-9_-]{22,86}$/.test(userId) ||
        !/^[\p{L}\p{N} ._@-]{1,64}$/u.test(username) ||
        !username.trim())
    )
      throw new Error();
    let credential: StoredCredential | undefined;
    if (env[`${PREFIX}CREDENTIAL`]) {
      credential = JSON.parse(env[`${PREFIX}CREDENTIAL`]!);
      if (
        !userId ||
        !credential ||
        !/^[A-Za-z0-9_-]{1,2048}$/.test(credential.id) ||
        !/^[A-Za-z0-9_-]{16,8192}$/.test(credential.publicKey) ||
        !Number.isSafeInteger(credential.counter) ||
        credential.counter < 0 ||
        (credential.transports !== undefined &&
          (!Array.isArray(credential.transports) ||
            credential.transports.some(
              (item) => !['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(item),
            )))
      )
        throw new Error();
    }
    return { source, userId, username, credential };
  } catch {
    throw new PasskeyError(503, '本地 Passkey 配置无效，请检查 .env');
  }
}

/** Identify the allowed user and public key independently of the authenticator's changing signature counter. */
export function configIdentity(config: PasskeyConfig): string {
  return digest(
    JSON.stringify([config.userId, config.username, config.credential?.id, config.credential?.publicKey]),
  );
}

/** Atomically update only managed, single-line .env entries, preserving unrelated values and refusing stale writes. */
export function writePasskeyConfig(root: string, previous: PasskeyConfig, next: PasskeyConfig): void {
  if (readPasskeyConfig(root).source !== previous.source)
    throw new PasskeyError(409, '配置刚刚发生变化，请重试');
  const fields = new Map([
    [`${PREFIX}USER_ID`, next.userId],
    [`${PREFIX}USER_NAME`, JSON.stringify(next.username)],
    [`${PREFIX}CREDENTIAL`, next.credential ? `'${JSON.stringify(next.credential)}'` : "''"],
  ]);
  const lines = previous.source.split(/\r?\n/).map((line) => {
    const key = line.match(/^\s*(?:export\s+)?(STIRRUP_PASSKEY_(?:USER_ID|USER_NAME|CREDENTIAL))\s*=/)?.[1];
    if (!key) return line;
    // Generated entries are one line. Reject manual multiline definitions rather than damaging nearby variables.
    if (parseEnv(line)[key] !== parseEnv(previous.source)[key])
      throw new PasskeyError(503, 'Passkey 的 .env 配置必须使用单行格式');
    const value = fields.get(key);
    fields.delete(key);
    if (value === undefined) throw new PasskeyError(503, '.env 中存在重复的 Passkey 配置');
    return `${key}=${value}`;
  });
  for (const [key, value] of fields) lines.push(`${key}=${value}`);
  const temporary = join(root, `.env.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${lines.join('\n').trimEnd()}\n`, { mode: 0o600 });
    renameSync(temporary, join(root, '.env'));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Locate the short-lived enrollment grant separately from the .env public-key configuration. */
function enrollmentFile(root: string): string {
  return join(root, '.local/web/passkey-enrollment.json');
}

/** Open a ten-minute, terminal-authorized first-key enrollment; never replace an existing Passkey. */
export function prepareEnrollment(root: string, now = Date.now()): string {
  let config = readPasskeyConfig(root);
  if (config.credential)
    throw new PasskeyError(
      409,
      '已绑定 Passkey，不会覆盖。若确需恢复访问，请先在本机备份并清空 .env 的 CREDENTIAL 项',
    );
  if (!config.userId) {
    writePasskeyConfig(root, config, {
      ...config,
      userId: randomBytes(32).toString('base64url'),
      username: 'Stirrup',
    });
    config = readPasskeyConfig(root);
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(join(root, '.local/web'), { recursive: true, mode: 0o700 });
  writeFileSync(
    enrollmentFile(root),
    JSON.stringify({ tokenHash: digest(token), identity: configIdentity(config), expires: now + 600_000 }),
    { mode: 0o600 },
  );
  return token;
}

/** Validate a terminal enrollment grant before and after the authenticator round trip. */
export function checkEnrollment(
  root: string,
  tokenHash: string,
  config: PasskeyConfig,
  now = Date.now(),
): void {
  try {
    const grant = JSON.parse(readFileSync(enrollmentFile(root), 'utf8'));
    if (
      config.credential ||
      !config.userId ||
      grant.expires <= now ||
      grant.identity !== configIdentity(config) ||
      typeof grant.tokenHash !== 'string' ||
      grant.tokenHash.length !== tokenHash.length ||
      !timingSafeEqual(Buffer.from(grant.tokenHash), Buffer.from(tokenHash))
    )
      throw new Error();
  } catch {
    throw new PasskeyError(403, '绑定入口无效或已过期，请在本机重新运行 npm run passkey:setup');
  }
}

/** Consume enrollment authorization after verified public-key persistence; it never creates a login session. */
export function finishEnrollment(root: string): void {
  rmSync(enrollmentFile(root), { force: true });
}
