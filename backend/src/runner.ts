/**
 * ada battles — Lobby Runner
 *
 * A single-lobby server. One container per match. Boots with:
 *
 *   LOBBY_ID         the matchmaker-assigned UUID
 *   MAX_PLAYERS      3..5
 *   PORT             defaults to 3000
 *   IDLE_SHUTDOWN_MS shut down the process after this much time empty
 *
 * Wires player WebSockets to the same Lobby class the monolith uses.
 * Adds:
 *
 *   GET /status      heartbeat for the matchmaker's poll loop
 *   GET /healthz     liveness for the orchestrator
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

const AUTH_SECRET = required('AUTH_SECRET');

// ── Config ──────────────────────────────────────────────────────────

const LOBBY_ID         = required('LOBBY_ID');
const MAX_PLAYERS      = parseIntStrict(required('MAX_PLAYERS'));
const PORT             = Number(process.env.PORT ?? 3000);
const IDLE_SHUTDOWN_MS = Number(process.env.IDLE_SHUTDOWN_MS ?? 5 * 60_000);

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

// ── Status / health for the matchmaker ─────────────────────────────

app.get('/status', (_req, res) => {
  res.json({
    lobbyId:     LOBBY_ID,
    status:      lobby.status,
    playerCount: lobby.players.size,
    maxPlayers:  MAX_PLAYERS,
    uptimeMs:    Math.round(process.uptime() * 1000),
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
      shutdown(0);
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


  // TODO: these payload types duplicate ClientToServerEvents in shared/types.ts.
  // Removed once the WebSocketHub.on() overload resolution is fixed — contextual
  // typing currently drops through to the `any` overload here.
  socket.on('player-input',     (data: { keys: number; rotation: number }) => lobby.setPlayerInput(socket.id, data.keys, data.rotation));
  socket.on('shoot',            (data: { rotation: number })                => lobby.tryShoot(socket.id, data.rotation));
  socket.on('self-hit',         (data: { bulletId: number; health: number; isEliminated: boolean }) => lobby.applySelfHit(socket.id, data));
  socket.on('bullet-inactive',  (data: { bulletId: number })                => lobby.deactivateOwnedBullet(socket.id, data.bulletId));
  socket.on('request-revive',   ()     => lobby.requestRevive(socket.id));

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${LOBBY_ID}] runner listening on :${PORT} (max ${MAX_PLAYERS})`);
});

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT',  () => shutdown(0));

function shutdown(code: number): void {
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
