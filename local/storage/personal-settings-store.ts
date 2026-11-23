import { PasskeyError, type PasskeyConfig } from '../auth/passkey-store.ts';
import { HttpError } from '../errors.ts';
import type { DatabaseConnection } from './database.ts';

/** Persist the single user's public credential and settings using the runtime's shared SQLite connection. */
export class PersonalSettingsStore {
  /** Use the existing connection without importing legacy accounts or creating an unverified user. */
  constructor(private readonly connection: DatabaseConnection) {}

  /** Return no account on first use; otherwise read its credential and configuration snapshot. */
  readConfig(): PasskeyConfig | undefined {
    const row = this.connection.db.prepare('SELECT * FROM personal_settings WHERE id=1').get();
    if (!row) return;
    return {
      revision: Number(row.revision),
      userId: String(row.user_id),
      username: String(row.user_name),
      rpId: String(row.passkey_rp_id),
      sessionTtlSeconds: Number(row.session_ttl_seconds),
      credential: JSON.parse(String(row.credential_json)),
    };
  }

  /** Create the sole account only after verification; competing initializations cannot overwrite the winner. */
  initialize(config: PasskeyConfig): void {
    this.connection.transaction(() => {
      if (this.readConfig()) throw new PasskeyError(409, '已完成初始化，请使用 Passkey 登录');
      this.connection.db
        .prepare(
          `INSERT INTO personal_settings
        (id, user_id, user_name, passkey_rp_id, credential_json, updated_at) VALUES (1, ?, ?, ?, ?, ?)`,
        )
        .run(
          config.userId,
          config.username,
          config.rpId,
          JSON.stringify(config.credential),
          Date.now(),
        );
    });
  }

  /** Compare and replace credential metadata so concurrent signature verification cannot lose a counter update. */
  writeConfig(previous: PasskeyConfig, next: PasskeyConfig): void {
    return this.connection.transaction(() => {
      const result = this.connection.db
        .prepare(
          `UPDATE personal_settings
      SET credential_json=?, revision=revision+1, updated_at=? WHERE id=1 AND revision=?`,
        )
        .run(JSON.stringify(next.credential), Date.now(), previous.revision);
      if (result.changes !== 1) throw new PasskeyError(409, '个人设置刚刚发生变化，请重试');
    });
  }

  /** Read display preferences without returning any credential fields. */
  preferences(): { values: Record<string, unknown>; revision: number } {
    const row = this.connection.db
      .prepare(
        'SELECT preferences_json, preferences_revision AS revision FROM personal_settings WHERE id=1',
      )
      .get();
    if (!row) throw new HttpError(401, '请先初始化 Passkey');
    return { values: JSON.parse(String(row.preferences_json)), revision: Number(row.revision) };
  }

  /** Save validated display configuration with optimistic concurrency and no access to credential columns. */
  savePreferences(input: Record<string, unknown>): { revision: number } {
    const value = input.values as Record<string, unknown> | undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Number.isSafeInteger(input.revision) ||
      Object.keys(value).some((key) => !['theme', 'opaque', 'motion', 'ratio'].includes(key)) ||
      !['system', 'light', 'dark'].includes(String(value.theme)) ||
      typeof value.opaque !== 'boolean' ||
      typeof value.motion !== 'boolean' ||
      typeof value.ratio !== 'number' ||
      !Number.isFinite(value.ratio) ||
      value.ratio <= 0 ||
      value.ratio > 0.5
    )
      throw new HttpError(400, '个人设置格式无效');
    return this.connection.transaction(() => {
      const result = this.connection.db
        .prepare(
          `UPDATE personal_settings
      SET preferences_json=?, preferences_revision=preferences_revision+1, updated_at=? WHERE id=1 AND preferences_revision=?`,
        )
        .run(JSON.stringify(value), Date.now(), Number(input.revision));
      if (result.changes !== 1) throw new HttpError(409, '个人设置已更新，请刷新后重试');
      return { revision: Number(input.revision) + 1 };
    });
  }

  /** Update the display name and next-login lifetime; existing sessions retain their absolute expiry. */
  saveAccount(input: Record<string, unknown>): void {
    const seconds = input.sessionTtlSeconds;
    if (
      Object.keys(input).some(
        (key) => !['username', 'sessionTtlSeconds', 'revision'].includes(key),
      ) ||
      typeof input.username !== 'string' ||
      !input.username.trim() ||
      input.username.length > 64 ||
      typeof seconds !== 'number' ||
      !Number.isSafeInteger(seconds) ||
      seconds < 1 ||
      seconds > 31_536_000
    )
      throw new HttpError(400, '名称须为 1–64 字符，登录有效期须为 1–31536000 的整数秒');
    if (!Number.isSafeInteger(input.revision)) throw new HttpError(400, '个人设置版本无效');
    const username = input.username.trim();
    return this.connection.transaction(() => {
      const result = this.connection.db
        .prepare(
          `UPDATE personal_settings
      SET user_name=?, session_ttl_seconds=?, revision=revision+1, updated_at=? WHERE id=1 AND revision=?`,
        )
        .run(username, seconds, Date.now(), Number(input.revision));
      if (result.changes !== 1) throw new HttpError(409, '个人设置已更新，请刷新后重试');
    });
  }
}
