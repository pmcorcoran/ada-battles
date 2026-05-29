/**
 * Wallet challenge verification.
 *
 * Combines two checks for per-connection auth:
 *   1. The challenge is a valid matchmaker-issued HMAC for this lobby.
 *   2. The wallet signature verifies the challenge under the given address.
 *
 * Used by the runner at WS upgrade time. When ticket-NFT verification
 * lands for Hydra, a third check composes here without touching callers.
 */

import { bech32 } from 'bech32';
import verifyDataSignature from '@cardano-foundation/cardano-verify-datasignature';
import { verifyChallenge } from '../../../shared/authChallenge';

export interface AuthResult {
  addressHex: string;
  pubKeyHash: string;
}

/**
 * Verify the auth parameters carried on a WS upgrade URL.
 *
 * @param socketUrl  The path + query string from the upgrade request,
 *                   e.g. "/?address=…&challenge=…&sig=…".
 * @param lobbyId    The lobby this runner serves; the challenge must
 *                   have been issued for this lobby.
 * @param authSecret Shared HMAC secret (matchmaker mints, runner verifies).
 * @returns The verified wallet address on success, null on any failure.
 */
export function verifyWalletChallenge(
  socketUrl: string,
  lobbyId: string,
  authSecret: string,
): AuthResult | null {
  let parsed: URL;
  try {
    parsed = new URL(socketUrl, 'http://placeholder');
  } catch {
    return null;
  }

  const address   = parsed.searchParams.get('address');
  const challenge = parsed.searchParams.get('challenge');
  const sigJson   = parsed.searchParams.get('sig');
  if (!address || !challenge || !sigJson) return null;

  // 1. Challenge must be a valid matchmaker-issued HMAC for this lobby.
  const payload = verifyChallenge(challenge, lobbyId, authSecret);
  if (!payload) return null;

  // 2. Wallet signature must verify the challenge string under `address`.
  let signature: { signature: string; key: string };
  try {
    signature = JSON.parse(sigJson);
  } catch {
    return null;
  }

  const addressBech32 = hexAddressToBech32(address);
  const ok = verifyDataSignature(
    signature.signature,
    signature.key,
    challenge,
    addressBech32,
  );
  if (!ok) return null;

  const pubKeyHash = pubKeyHashFromAddress(address);
  if (!pubKeyHash) return null;   // script-based payment cred — can't addSignerKey

  return { addressHex: address, pubKeyHash };
}

function hexAddressToBech32(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  const networkId = bytes[0] & 0x0f;
  const prefix = networkId === 1 ? 'addr' : 'addr_test';
  const words = bech32.toWords(bytes);
  return bech32.encode(prefix, words, 1000);
}

function pubKeyHashFromAddress(hex: string): string | null {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 29) return null;
  const type = (bytes[0] >> 4) & 0x0f;
  if (type & 0x01) return null;   // 1,3,5,7 = script payment cred
  if (type >= 8)   return null;   // 8 = Byron, 14/15 = reward
  return bytes.slice(1, 29).toString('hex');
}