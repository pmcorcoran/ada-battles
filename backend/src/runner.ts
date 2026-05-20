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

// ── Hydra observer (slice 1: non-authoritative) ────────────────────

let hydraObserver: HydraObserver | null = null;

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
  const empty = lobby.players.size === 0;
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
    if (lobby.players.size === 0 && Date.now() - lastNonEmptyAt >= IDLE_SHUTDOWN_MS) {
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
    player = lobby.addPlayer(socket.id);
    socket.emit('player-id', player.slot);
    socket.emit('joined-matched-lobby', LOBBY_ID);
    hub.to(LOBBY_ID).emit('player-joined', {
      slot:        player.slot,
      playerCount: lobby.players.size,
      lobbyId:     LOBBY_ID,
    });
    if (lobby.players.size >= MAX_PLAYERS) lobby.startCountdown();
    else lobby.broadcastState();
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
      lobby.startCountdown();
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
    lobby.removePlayer(socket.id);
    hub.to(LOBBY_ID).emit('player-left', {
      slot:        leavingSlot,
      playerCount: lobby.players.size,
      lobbyId:     LOBBY_ID,
    });
    trackOccupancy();
  });
});

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
  // Decision (ii): runner owns sidecar lifecycle. Tear down observer
  // first so any in-flight Close (slice 2) has a chance to complete
  // before the HTTP server closes. In slice 1 stop() is essentially
  // a clean WS close.
  if (hydraObserver) {
    try { await hydraObserver.stop(); } catch (err) {
      console.warn(`[${LOBBY_ID}] hydra observer stop failed: ${(err as Error).message}`);
    }
  }
  // Give in-flight WS frames a chance to flush, then exit. Express
  // closes the http server which cascades to the WS upgrade handler.
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2_000).unref();
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