/**
 * Bad-signature rejection test.
 *
 * Spawns a runner via POST /api/lobbies/match, then opens three WS
 * connections that should each be rejected by verifyWalletChallenge:
 *
 *   A1: valid challenge, garbage signature
 *   A2: tampered challenge, garbage signature
 *   A3: missing sig param entirely
 *
 * Expected: each WS closes shortly after open. Watch the runner's
 * stderr in another terminal for "rejected unauthed connection".
 *
 * Run with:  npx ts-node backend/scripts/test-bad-sig.ts
 * Or:        node --loader ts-node/esm backend/scripts/test-bad-sig.ts
 *
 * Env:
 *   MATCHMAKER_URL  defaults to http://localhost:8080
 */

import WebSocket from 'ws';

const MATCHMAKER_URL = process.env.MATCHMAKER_URL ?? 'http://localhost:8080';

interface MatchResponse {
  lobbyId:   string;
  wsUrl:     string;
  challenge: string;
}

interface CaseResult {
  name:      string;
  closed:    boolean;
  closeCode: number | null;
  openedOk:  boolean;
  errorMsg:  string | null;
  elapsedMs: number;
}

async function main(): Promise<void> {
  console.log(`[test] matchmaker at ${MATCHMAKER_URL}`);

  // 1. Get a fresh lobby + challenge.
  const matchRes = await fetch(`${MATCHMAKER_URL}/api/lobbies/match`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ maxPlayers: 3 }),
  });
  if (!matchRes.ok) {
    console.error(`[test] match request failed: ${matchRes.status}`);
    process.exit(1);
  }
  const { lobbyId, wsUrl, challenge } = (await matchRes.json()) as MatchResponse;
  console.log(`[test] got lobby ${lobbyId}`);
  console.log(`[test] wsUrl=${wsUrl}`);
  console.log(`[test] challenge=${challenge.slice(0, 16)}...`);

  // Address has to look like a bech32 stake/payment address. We're not
  // testing address validation, just signature validation, so any
  // syntactically reasonable string works — verifyWalletChallenge
  // will reject on the HMAC/sig check before it gets to address
  // parsing for cases A1 and A2. For A3 it'll reject on missing sig.
  const fakeAddress = 'addr_test1qz' + 'a'.repeat(50);

  // Tampered challenge: flip the last character so the HMAC fails.
  const tamperedChallenge =
    challenge.slice(0, -1) + (challenge.slice(-1) === '0' ? '1' : '0');

  const results: CaseResult[] = [];

  // A1: valid challenge, garbage signature
  results.push(await tryConnect('A1 valid-challenge bad-sig', wsUrl, {
    address:   fakeAddress,
    challenge,
    sig:       'deadbeefdeadbeefdeadbeefdeadbeef',
  }));

  // A2: tampered challenge, garbage signature
  results.push(await tryConnect('A2 tampered-challenge', wsUrl, {
    address:   fakeAddress,
    challenge: tamperedChallenge,
    sig:       'deadbeefdeadbeefdeadbeefdeadbeef',
  }));

  // A3: missing sig param entirely
  results.push(await tryConnect('A3 missing-sig', wsUrl, {
    address:   fakeAddress,
    challenge,
    // no sig
  }));

  // ── Report ─────────────────────────────────────────────────────

  console.log('\n[test] results:');
  for (const r of results) {
    const pass = r.closed && !r.openedOk
      ? 'PASS (closed without ever delivering an app event)'
      : r.closed && r.openedOk
        ? 'PASS (opened then closed)'
        : 'FAIL (did not close in time)';
    console.log(
      `  ${r.name.padEnd(32)} ${pass}  ` +
      `closeCode=${r.closeCode ?? '-'}  ` +
      `elapsed=${r.elapsedMs}ms  ` +
      `${r.errorMsg ? `err=${r.errorMsg}` : ''}`,
    );
  }

  const allClosed = results.every((r) => r.closed);
  process.exit(allClosed ? 0 : 1);
}

function tryConnect(
  name:   string,
  wsUrl:  string,
  params: Record<string, string>,
): Promise<CaseResult> {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = `${wsUrl}?${qs}`;
    const start = Date.now();

    console.log(`\n[test] ${name}`);
    console.log(`[test]   url=${fullUrl.slice(0, 80)}...`);

    const ws = new WebSocket(fullUrl);
    let openedOk = false;
    let closed   = false;
    let closeCode: number | null = null;
    let errorMsg: string | null  = null;

    // Hard timeout — if the server doesn't close us in 3s, something
    // is wrong (or the auth check passed, which is the real failure).
    const timeout = setTimeout(() => {
      if (!closed) {
        errorMsg = 'timeout — connection still open after 3s';
        try { ws.terminate(); } catch { /* noop */ }
        resolve({
          name, closed: false, closeCode: null, openedOk,
          errorMsg, elapsedMs: Date.now() - start,
        });
      }
    }, 3_000);

    ws.on('open', () => {
      openedOk = true;
      console.log(`[test]   ws opened (proxy hop succeeded — auth check happens server-side)`);
    });

    ws.on('close', (code) => {
      closed    = true;
      closeCode = code;
      clearTimeout(timeout);
      console.log(`[test]   ws closed code=${code}`);
      resolve({
        name, closed, closeCode, openedOk,
        errorMsg, elapsedMs: Date.now() - start,
      });
    });

    ws.on('error', (err) => {
      // Errors are expected if the proxy refuses the upgrade or the
      // server hangs up mid-handshake. We treat any error as "the
      // server rejected us", which is what we want.
      errorMsg = err.message;
      console.log(`[test]   ws error: ${err.message}`);
      // Don't resolve here — the 'close' event will fire next.
    });
  });
}

main().catch((e) => {
  console.error('[test] fatal:', e);
  process.exit(1);
});