/**
 * ada battles — Lobby Runner
 *
 * A single-lobby server. One container per match. Boots with:
 *
 *   LOBBY_ID            the matchmaker-assigned UUID
 *   MAX_PLAYERS         3..5
 *   PORT                defaults to 3000
 *   IDLE_SHUTDOWN_MS    shut down the process after this much time empty
 *   AUTH_SECRET         shared HMAC secret with the matchmaker
 *   HYDRA_SIDECAR_URL   ws://hydra-<id>:4001/?history=no — optional in
 *                       slice 1 (runner continues if unreachable)
 *
 * Wires player WebSockets to the same Lobby class the monolith uses.
 * Adds:
 *
 *   GET /status      heartbeat for the matchmaker's poll loop
 *   GET /healthz     liveness for the orchestrator
 *
 * Slice 1 / Hydra: spawns a HydraObserver pointing at the per-runner
 * sidecar container. The observer logs Head state alongside Lobby
 * status; it does NOT influence gameplay. In-memory Lobby remains the
 * sole authority. The observer is owned by this process — boot it
 * after the HTTP server is up, shut it down before exit.
 *
 * Exits cleanly when the lobby ends and stays empty for IDLE_SHUTDOWN_MS.
 */

import express from 'express';
import http from 'http';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from '../../shared/types';
import { Lobby, type ServerPlayer } from './Lobby';
import { WebSocketHub } from './WebSocketHub';
import { verifyWalletChallenge } from './auth/walletChallenge';
import { HydraObserver } from './hydra';

const AUTH_SECRET = required('AUTH_SECRET');

// ── Config ──────────────────────────────────────────────────────────

const LOBBY_ID         = required('LOBBY_ID');
const MAX_PLAYERS      = parseIntStrict(required('MAX_PLAYERS'));
const PORT             = Number(process.env.PORT ?? 3000);
const IDLE_SHUTDOWN_MS = Number(process.env.IDLE_SHUTDOWN_MS ?? 5 * 60_000);
const HYDRA_SIDECAR_URL = process.env.HYDRA_SIDECAR_URL; // optional in slice 1

if (MAX_PLAYERS < 3 || MAX_PLAYERS > 5) {
  console.error(`MAX_PLAYERS=${MAX_PLAYERS} out of range [3, 5]`);
  process.exit(2);
}

// ── HTTP + WS ───────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const hub    = new WebSocketHub<ClientToServerEvents, ServerToClientEvents>(server);

app.use(express.json());

// ── The one Lobby this process owns ────────────────────────────────

const lobby = new Lobby(LOBBY_ID, MAX_PLAYERS, hub);

// ── Hydra observer (now gates game start: see beginWhenHeadOpen) ────

let hydraObserver: HydraObserver | null = null;

// Guard so the Head is opened/awaited at most once per lobby, even if the
// auto-fill and explicit request-start paths both reach the start edge.
let awaitingHead = false;

// ── Status / health for the matchmaker ─────────────────────────────

app.get('/status', (_req, res) => {
  res.json({
    lobbyId:     LOBBY_ID,
    status:      lobby.status,
    playerCount: lobby.players.size,
    maxPlayers:  MAX_PLAYERS,
    uptimeMs:    Math.round(process.uptime() * 1000),
    // Slice 1: surface the hydra status so it's visible to the
    // matchmaker's poll loop. Not used for routing decisions yet.
    hydraStatus: hydraObserver?.status ?? 'disabled',
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Idle shutdown ──────────────────────────────────────────────────
//
// This is what makes the per-lobby container model affordable: the
// runner exits when the match is over and nobody's reconnected. The
// orchestrator's `AutoRemove: true` then cleans up the container.

let lastNonEmptyAt = Date.now();
let emptyShutdownTimer: NodeJS.Timeout | undefined;

function trackOccupancy(): void {
  const empty = lobby.connectedCount === 0;
  if (!empty) {
    lastNonEmptyAt = Date.now();
    if (emptyShutdownTimer) {
      clearTimeout(emptyShutdownTimer);
      emptyShutdownTimer = undefined;
    }
    return;
  }
  if (emptyShutdownTimer) return;
  emptyShutdownTimer = setTimeout(() => {
    if (lobby.connectedCount === 0 && Date.now() - lastNonEmptyAt >= IDLE_SHUTDOWN_MS) {
      console.log(`[${LOBBY_ID}] idle for ${IDLE_SHUTDOWN_MS}ms, exiting`);
      void shutdown(0);
    }
  }, IDLE_SHUTDOWN_MS);
}

// ── WS event wiring ────────────────────────────────────────────────
//
// This is the entire join/play/leave loop from the monolith's app.ts,
// minus the lobby-discovery logic. Since this process only owns ONE
// lobby there's no `join-lobby` shopping — the client is implicitly
// joining `LOBBY_ID` by connecting to this runner at all.

hub.on('connection', (socket) => {
  const authResult = verifyWalletChallenge(socket.url, LOBBY_ID, AUTH_SECRET);
  if (!authResult) {
    console.warn(`[${LOBBY_ID}] rejected unauthed connection`);
    socket.disconnect();
    return;
  }

  let player: ServerPlayer | null = null;

  // Auto-join on connect. The matchmaker has already vetted the size.
  if (lobby.players.size < MAX_PLAYERS && lobby.status === 'lobby') {
    socket.join(LOBBY_ID);
    // The player's own Hydra vk rides the same upgrade URL as the auth
    // params. It's been through verifyWalletChallenge already (the
    // connection wouldn't be here otherwise); the vk itself isn't part
    // of auth, just participant identity, so parse it leniently.
    const hydraVk = parseHydraVk(socket.url);
    player = lobby.addPlayer(socket.id, hydraVk, authResult.pubKeyHash);
    socket.emit('player-id', player.slot);
    socket.emit('joined-matched-lobby', LOBBY_ID);
    hub.to(LOBBY_ID).emit('player-joined', {
      slot:        player.slot,
      playerCount: lobby.players.size,
      lobbyId:     LOBBY_ID,
    });
    if (lobby.players.size >= MAX_PLAYERS) {
      // Lobby is full: open the Head, then start the countdown once it
      // reaches HeadIsOpen. beginWhenHeadOpen() owns that wait + fallbacks.
      void beginWhenHeadOpen();
    } else {
      lobby.broadcastState();
    }
    trackOccupancy();
  } else {
    // Spectator: full lobby or match already started.
    socket.join(LOBBY_ID);
    socket.emit('joined-matched-lobby', LOBBY_ID);
    lobby.broadcastState();
  }

  // ── In-game ────────────────────────────────────────────────────

  socket.on('request-start', () => {
    if (lobby.status === 'lobby' && lobby.players.size >= MAX_PLAYERS) {
      // Same edge as auto-fill above. beginWhenHeadOpen() is idempotent
      // (awaitingHead guard), so a manual start during the wait is a no-op.
      void beginWhenHeadOpen();
    }
  });

  socket.on('request-revive',   ()     => lobby.requestRevive(socket.id));
  socket.on('player-input',     (data) => lobby.setPlayerInput(socket.id, data.keys, data.rotation));
  socket.on('shoot',            (data) => lobby.tryShoot(socket.id, data.rotation));
  socket.on('self-hit',         (data) => lobby.applySelfHit(socket.id, data));
  socket.on('bullet-inactive',  (data) => lobby.deactivateOwnedBullet(socket.id, data.bulletId));

  // ── Leave ──────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    if (!player) return;
    const leavingSlot = player.slot;
     // Capture before removePlayer(): once the Head is open the avatar
    // persists (ghost), so we DON'T tell clients to drop it — it keeps
    // rendering and stays a valid target. removePlayer() has already
    // re-broadcast the state in that case.
    const postOpen = lobby.status === 'countdown' || lobby.status === 'playing';

    lobby.removePlayer(socket.id);

    if (!postOpen) {
      hub.to(LOBBY_ID).emit('player-left', {
        slot:        leavingSlot,
        playerCount: lobby.players.size,
        lobbyId:     LOBBY_ID,
      });
    }
    trackOccupancy();
  });
});

// ── Head-gated game start ───────────────────────────────────────────
//
// Called from both start edges (auto-fill on lobby-full and explicit
// request-start). Seeds the Head, waits for HeadIsOpen, THEN starts the
// countdown. Idempotent via the module-level awaitingHead guard.

async function beginWhenHeadOpen(): Promise<void> {
  if (awaitingHead) return;            // request-start can re-enter while we wait
  awaitingHead = true;

  // No sidecar configured → no Head to open; go straight to the countdown.
  if (!hydraObserver) {
    lobby.startCountdown();
    return;
  }

  // Show the "Opening Hydra head…" screen, then seed + wait for HeadIsOpen.
  lobby.enterOpening();
  hydraObserver.initHead(lobby.hydraRoster());   // idempotent (headSeeded guard)

  try {
    await hydraObserver.waitUntilOpen();          // resolves on HeadIsOpen
    if (lobby.status === 'opening') lobby.startCountdown();
  } catch (err) {
    // Hard gate: the Head never opened, so the game does NOT start. The
    // lobby stays on the "Opening Hydra head…" screen; it's torn down when
    // a player leaves (opening → ended) and idle-reaped once empty.
    console.warn(`[${LOBBY_ID}] head did not open: ${(err as Error).message}; not starting`);
  }
}

// ── Boot + signal handling ─────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[${LOBBY_ID}] runner listening on :${PORT} (max ${MAX_PLAYERS})`);

  // Slice 1: bring up the Hydra observer AFTER the HTTP server is
  // listening (so /status is responsive while we wait on the sidecar)
  // but it is not strictly required to be ready before accepting WS
  // upgrades — the observer is non-authoritative. start() is
  // tolerant of sidecar-unreachable (logs and returns).
  if (HYDRA_SIDECAR_URL) {
    hydraObserver = new HydraObserver({
      lobbyId:    LOBBY_ID,
      sidecarUrl: HYDRA_SIDECAR_URL,
    });
    await hydraObserver.start();
  } else {
    console.log(`[${LOBBY_ID}] HYDRA_SIDECAR_URL not set, observer disabled`);
  }
});

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT',  () => void shutdown(0));

async function shutdown(code: number): Promise<void> {
  // Runner owns sidecar lifecycle: close the Head BEFORE tearing down
  // the WS observer client. closeHead() drives Close → Fanout → Finalized
  // and resolves on terminal status; stop() then closes the WS cleanly.
  if (hydraObserver) {
    try { await hydraObserver.closeHead(); } catch (err) {
      console.warn(`[${LOBBY_ID}] hydra closeHead failed: ${(err as Error).message}`);
    }
    try { await hydraObserver.stop(); } catch (err) {
      console.warn(`[${LOBBY_ID}] hydra observer stop failed: ${(err as Error).message}`);
    }
  }
  // Give in-flight WS frames a chance to flush, then exit. The backstop
  // timeout is generous because a full close+fanout on preprod takes
  // ~contestation-period + a few L1 blocks (~2-3 minutes with our 60s CP).
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 5 * 60_000).unref();
}

// ── Utils ──────────────────────────────────────────────────────────

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} env var is required`);
    process.exit(2);
  }
  return v;
}

function parseIntStrict(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) {
    console.error(`Expected integer, got "${s}"`);
    process.exit(2);
  }
  return n;
}

/**
 * Pull the player's Hydra vk envelope off the WS upgrade URL. Leniently
 * — the vk is participant identity, not auth (auth already passed to
 * reach this point), so a missing or malformed vk yields '' rather than
 * rejecting the connection. The roster tolerates empty slots and logs
 * them; offline/slice-1 doesn't depend on the vk being present.
 */
function parseHydraVk(socketUrl: string): string {
  try {
    const parsed = new URL(socketUrl, 'http://placeholder');
    return parsed.searchParams.get('hydraVk') ?? '';
  } catch {
    return '';
  }
}