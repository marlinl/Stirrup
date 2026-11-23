import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { Identity } from '../domain/models';
import type { Api } from '../api/client';

/** Detect WebAuthn availability before offering a system authenticator prompt. */
export function passkeySupported(): boolean {
  return window.isSecureContext !== false && browserSupportsWebAuthn();
}

/** Complete a user-initiated registration or login; only a verified login receives a server session. */
export async function usePasskey(api: Api, enrolling = false): Promise<Identity> {
  if (!passkeySupported())
    throw new Error(
      '此浏览器无法使用 Passkey，请通过受信任的 HTTPS 站点（或开发用 localhost）访问',
    );
  const kind = enrolling ? 'register' : 'login';
  const options = await api<
    PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON
  >(`/api/passkey/${kind}/options`, 'POST', {});
  let response;
  try {
    response = enrolling
      ? await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON })
      : await startAuthentication({
          optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
        });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      (error instanceof Error && ['NotAllowedError', 'AbortError'].includes(error.name)) ||
      (cause instanceof Error && ['NotAllowedError', 'AbortError'].includes(cause.name))
    )
      throw new Error('Passkey 操作已取消或超时，可以重试');
    throw new Error('未能完成 Passkey 操作，请检查设备或浏览器中的通行密钥');
  }
  return api<Identity>(`/api/passkey/${kind}/verify`, 'POST', { response });
}
