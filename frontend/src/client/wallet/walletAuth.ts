/**
 * WalletAuth
 *
 * Coordinates the wallet-side of the auth handshake:
 *   1. Enable the chosen wallet via CIP-30
 *   2. Fetch a nonce from the server for the wallet's address
 *   3. Have the wallet sign it
 *   4. POST the signature back, receive a session token
 *
 * Stores the token in sessionStorage and returns the address on success.
 * Throws on any failure; callers decide how to surface that.
 */

import type { Cip30Api, Cip30WalletInfo } from './cip30';
import { hexEncode } from './cip30';

export interface AuthResult {
  api: Cip30Api;
  addressHex: string;
  token: string;
}

export async function authenticateWithWallet(
  walletMeta: Cip30WalletInfo,
): Promise<AuthResult> {
  const api = await walletMeta.enable();
  const addressHex = await api.getChangeAddress();

  const nonceRes = await fetch(
    `/api/auth/nonce?address=${encodeURIComponent(addressHex)}`,
  );
  if (!nonceRes.ok) throw new Error('Server refused nonce request');
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  const signature = await api.signData(addressHex, hexEncode(nonce));

  const verifyRes = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addressHex, signature }),
  });
  if (!verifyRes.ok) throw new Error('Signature verification failed');
  const { token } = (await verifyRes.json()) as { token: string };

  sessionStorage.setItem('authToken', token);
  sessionStorage.setItem('walletAddress', addressHex);

  return { api, addressHex, token };
}