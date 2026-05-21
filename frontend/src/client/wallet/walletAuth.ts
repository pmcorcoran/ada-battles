/**
 * WalletAuth (per-connection signature model)
 *
 * Page load: just enable the wallet and remember its address+API.
 * No server interaction.
 *
 * Per match: signChallenge(challenge) — invoked by NetworkClient.match
 * once it has a matchmaker-issued challenge to sign.
 */

import type { Cip30Api, Cip30WalletInfo } from './cip30';
import { hexEncode } from './cip30';

export interface WalletSession {
  api:        Cip30Api;
  addressHex: string;
}

export async function connectWallet(
  walletMeta: Cip30WalletInfo,
): Promise<WalletSession> {
  const api = await walletMeta.enable();
  const addressHex = await api.getChangeAddress();
  sessionStorage.setItem('walletAddress', addressHex);
  return { api, addressHex };
}

export async function signChallenge(
  session: WalletSession,
  challenge: string,
): Promise<{ signature: string; key: string }> {
  // signData takes hex-encoded payload. The matchmaker gave us a
  // base64url-encoded string; we feed it through hexEncode unchanged
  // (the verification on the runner uses the same string verbatim).
  const sig = await session.api.signData(session.addressHex, hexEncode(challenge));
  return sig;
}

export interface WalletSession {
  api:        import('./cip30').Cip30Api;
  addressHex: string;
}