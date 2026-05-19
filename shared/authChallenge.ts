/**
 * Stateless challenge issuance & verification.
 *
 * The matchmaker mints an HMAC-signed challenge when a player matches
 * into a lobby. The runner verifies that HMAC plus the wallet's
 * signature over the same challenge. Neither service stores anything.
 *
 * Format (base64url, no padding):
 *   challenge = base64url(payload)
 *   payload   = JSON({ lobbyId, nonce, expires })  ‖ ":" ‖ hmacHex
 *
 * The wallet signs the `challenge` string as-is; the runner pulls the
 * payload back out, recomputes the HMAC, and verifies both.
 */

import crypto from 'crypto';

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface ChallengePayload {
  lobbyId: string;
  nonce:   string;
  expires: number;
}

export function issueChallenge(lobbyId: string, secret: string): string {
  const payload: ChallengePayload = {
    lobbyId,
    nonce:   crypto.randomBytes(16).toString('hex'),
    expires: Date.now() + CHALLENGE_TTL_MS,
  };
  const body = JSON.stringify(payload);
  const mac  = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return base64url(`${body}:${mac}`);
}

export function verifyChallenge(
  challenge: string,
  expectedLobbyId: string,
  secret: string,
): ChallengePayload | null {
  let decoded: string;
  try {
    decoded = base64urlDecode(challenge);
  } catch {
    return null;
  }
  const sep = decoded.lastIndexOf(':');
  if (sep < 0) return null;
  const body = decoded.slice(0, sep);
  const mac  = decoded.slice(sep + 1);

  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (!safeEqual(mac, expected)) return null;

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (payload.lobbyId !== expectedLobbyId) return null;
  if (payload.expires < Date.now()) return null;
  return payload;
}

function base64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function base64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}