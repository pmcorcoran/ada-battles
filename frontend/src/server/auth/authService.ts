/**
 * AuthService
 *
 * Owns the wallet-auth state machine:
 *   1. issueNonce(address) → random string for the wallet to sign
 *   2. verify(address, signature) → session token if signature valid
 *   3. verifyToken(token) → address if token still valid
 *
 * State lives in-memory. Swap the Maps for Redis if multiple
 * server instances.
 */

import crypto from 'crypto';
import { bech32 } from 'bech32';
import verifyDataSignature from '@cardano-foundation/cardano-verify-datasignature';

const NONCE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

interface NonceEntry { nonce: string; expires: number; }
interface TokenEntry { address: string; expires: number; }


function hexAddressToBech32(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  //   first byte determines mainnet/testnet
  //   0x0... or 0x1... = testnet
  //   0x2... or 0x3... = testnet (script)
  //   0x4... or 0x5... = mainnet (legacy)
  //   but the bottom 4 bits of byte 0 are the network ID
  const networkId = bytes[0] & 0x0f;
  const prefix = networkId === 1 ? 'addr' : 'addr_test';
  const words = bech32.toWords(bytes);
  return bech32.encode(prefix, words, 1000); // 1000 = no length limit
}


export class AuthService {
  private readonly pendingNonces = new Map<string, NonceEntry>();
  private readonly validTokens   = new Map<string, TokenEntry>();

  issueNonce(addressHex: string): string | null {
    console.log('[auth] issueNonce called, length:', addressHex?.length);
    if (!addressHex || addressHex.length < 20) {
        console.log('[auth] FAILED length check');
        return null;
    }

    try {
        console.log('[auth] generating nonce...');
        const nonce = `Sign to play ADA BATTLES: ${crypto.randomBytes(16).toString('hex')}`;
        console.log('[auth] nonce generated, storing...');
        this.pendingNonces.set(addressHex, { nonce, expires: Date.now() + NONCE_TTL_MS });
        console.log('[auth] SUCCESS, returning nonce');
        return nonce;
    } catch (err) {
        console.log('[auth] EXCEPTION in issueNonce:', err);
        throw err;  // re-throw so route handler sees it
    }
    }

  verify(addressHex: string, signature: { signature: string; key: string }): string | null {
    const pending = this.pendingNonces.get(addressHex);
    if (!pending || pending.expires < Date.now()) return null;

    const addressBech32 = hexAddressToBech32(addressHex);

    const valid = verifyDataSignature(
      signature.signature,
      signature.key,
      pending.nonce,
      addressBech32
    );
    if (!valid) {
        console.log('not valid signature');
        return null;
    }

    this.pendingNonces.delete(addressHex);
    const token = crypto.randomBytes(32).toString('hex');
    this.validTokens.set(token, { address: addressHex, expires: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  verifyToken(token: string): string | null {
    const entry = this.validTokens.get(token);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.validTokens.delete(token);
      return null;
    }
    return entry.address;
  }

  /** Optional housekeeping — call from a setInterval if required. 
  sweepExpired(now = Date.now()): void {
    for (const [k, v] of this.pendingNonces) if (v.expires < now) this.pendingNonces.delete(k);
    for (const [k, v] of this.validTokens)   if (v.expires < now) this.validTokens.delete(k);
  }
  */
} 
