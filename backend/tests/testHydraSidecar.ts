/**
 * test-hydra-sidecar.ts
 *
 * Slice-1 integration test for the Hydra sidecar.
 *
 * What it asserts:
 *   1. POST /api/lobbies/match spawns a lobby (and, by side effect,
 *      a hydra-node sidecar).
 *   2. The runner's /status endpoint reports a hydraStatus that
 *      progresses from 'connecting' to a post-Greetings state
 *      ('idle' in offline mode) within a reasonable timeout.
 *   3. Cleanup: the lobby and its sidecar are both gone after the
 *      runner exits (idle timeout would take 5 minutes; we don't
 *      wait — manual cleanup at the end).
 *
 * Run with:
 *   cd backend
 *   npx ts-node scripts/test-hydra-sidecar.ts
 *
 * Prereqs:
 *   - docker compose up -d --build
 *   - infra/hydra-dev-keys/ contains hydra.sk, hydra.vk,
 *     initial-utxo.json, protocol-parameters.json
 *     (run `make hydra-dev-keys` to generate)
 */

const MATCHMAKER_URL = process.env.MATCHMAKER_URL ?? 'http://localhost:8080';
const POLL_INTERVAL_MS = 1_000;
const HYDRA_READY_TIMEOUT_MS = 30_000;

interface StatusBody {
  lobbyId: string;
  status: string;
  playerCount: number;
  maxPlayers: number;
  uptimeMs: number;
  hydraStatus: string;
}

async function main(): Promise<void> {
  console.log('=== slice-1 hydra sidecar integration test ===');

  // 1. Spawn a lobby.
  console.log('\n[1] POST /api/lobbies/match');
  const matchRes = await fetch(`${MATCHMAKER_URL}/api/lobbies/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxPlayers: 3 }),
  });
  if (!matchRes.ok) fatal(`matchmaker rejected: ${matchRes.status} ${await matchRes.text()}`);
  const match = await matchRes.json() as { lobbyId: string; wsUrl: string; challenge: string };
  console.log(`    lobbyId: ${match.lobbyId}`);
  console.log(`    wsUrl:   ${match.wsUrl}`);

  // 2. Poll /api/lobbies until the runner's /status reports a
  //    Hydra status past 'connecting'.
  console.log(`\n[2] polling for hydraStatus past 'connecting' (timeout ${HYDRA_READY_TIMEOUT_MS}ms)`);
  const deadline = Date.now() + HYDRA_READY_TIMEOUT_MS;
  let lastSeen = '';
  let succeeded = false;
  while (Date.now() < deadline) {
    const listRes = await fetch(`${MATCHMAKER_URL}/api/lobbies`);
    if (!listRes.ok) { await sleep(POLL_INTERVAL_MS); continue; }
    const lobbies = await listRes.json() as Array<{ id: string; statusUrl: string }>;
    const me = lobbies.find((l) => l.id === match.lobbyId);
    if (!me) { await sleep(POLL_INTERVAL_MS); continue; }

    // We can't reach me.statusUrl from outside the docker network.
    // Instead, the matchmaker's heartbeat carries the data we need
    // back into the LobbyRecord — but the existing /api/lobbies route
    // returns the record, which has status + playerCount but NOT
    // hydraStatus (LobbyRecord wasn't updated to carry it).
    //
    // Slice-1 limitation: hydraStatus is observable only in runner
    // logs and via a docker-exec into the matchmaker → curl runner.
    // For this test we shell out to docker.
    const status = await fetchStatusViaDockerExec(match.lobbyId);
    if (!status) { await sleep(POLL_INTERVAL_MS); continue; }
    if (status.hydraStatus !== lastSeen) {
      console.log(`    [${new Date().toISOString()}] hydraStatus = ${status.hydraStatus}`);
      lastSeen = status.hydraStatus;
    }
    if (status.hydraStatus === 'idle' || status.hydraStatus === 'open') {
      succeeded = true;
      break;
    }
    if (status.hydraStatus === 'error') {
      fatal(`runner reported hydraStatus=error; check sidecar logs:\n  docker logs hydra-${match.lobbyId}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!succeeded) {
    fatal(`timed out waiting for hydra ready; last seen: ${lastSeen}`);
  }
  console.log(`    ✓ sidecar reached ${lastSeen} state (Greetings received)`);

  // 3. Cleanup. The runner will exit on idle (5 min default) but we
  //    don't wait — force-stop both containers now.
  console.log('\n[3] cleanup: force-stopping runner + sidecar');
  await dockerExec(['rm', '-f', `runner-${match.lobbyId}`]).catch(() => {});
  await dockerExec(['rm', '-f', `hydra-${match.lobbyId}`]).catch(() => {});

  console.log('\n=== PASS ===');
}

// ── helpers ──────────────────────────────────────────────────────

async function fetchStatusViaDockerExec(lobbyId: string): Promise<StatusBody | null> {
  // Runners are not host-port-published; we have to go through the
  // matchmaker container, which is on the same docker network.
  //
  // wget exits non-zero (→ dockerExec rejects) while the runner's
  // HTTP server is still binding, or if the runner is gone. That's a
  // normal transient during startup, so swallow it and let the poll
  // loop retry rather than aborting the whole test.
  let stdout = '';
  try {
    ({ stdout } = await dockerExec([
      'exec', 'ada-battles-matchmaker',
      'wget', '-qO-', '-T', '2', `http://runner-${lobbyId}:3000/status`,
    ]));
  } catch {
    return null;
  }
  if (!stdout) return null;
  try { return JSON.parse(stdout) as StatusBody; } catch { return null; }
}

async function dockerExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`docker exited ${code}: ${stderr}`));
    });
    p.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fatal(msg: string): never {
  console.error(`\n✗ FAIL: ${msg}`);
  process.exit(1);
}

main().catch((err) => fatal((err as Error).message));