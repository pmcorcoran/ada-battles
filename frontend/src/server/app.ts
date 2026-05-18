/**
 * ada battles — Server Entry Point
 *
 * Sets up Express for static files and a native-WebSocket hub for real-time
 * comms. All game logic lives in Lobby; matchmaking lives in LobbyManager.
 * This file only wires socket events to the right lobby methods.
 */

import express from 'express';
import http from 'http';
import path from 'path';
import type { ServerToClientEvents, ClientToServerEvents } from '../shared/types';
import { LobbyManager } from './LobbyManager';
import type { Lobby, ServerPlayer } from './Lobby';
import { WebSocketHub } from './WebSocketHub';
import { AuthService } from './auth/authService';
import { createAuthRouter } from './auth/authRoutes';

// ── HTTP + WebSocket hub ─────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const hub    = new WebSocketHub<ClientToServerEvents, ServerToClientEvents>(server);

const auth = new AuthService();

app.use(express.json());
app.use('/api/auth', createAuthRouter(auth));
app.use(express.static(path.join(__dirname, '../../public')));

//  Lobby registry 

const lobbyManager = new LobbyManager(hub);

//  REST: list active lobbies (for SDK / browser spectate) 

app.get('/api/lobbies', (_req, res) => {
  const lobbies = lobbyManager.listAll().map((l) => ({
    id: l.id,
    maxPlayers: l.maxPlayers,
    playerCount: l.players.size,
    status: l.status,
  }));
  res.json(lobbies);
});

//  Per-connection state 

hub.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  let currentLobby: Lobby | null = null;
  let currentPlayer: ServerPlayer | null = null;

  //  Join 

  socket.on('join-lobby', (targetSize) => {
    // Leave previous lobby if switching
    if (currentLobby && currentPlayer) {
      const leavingSlot = currentPlayer.slot;
      const leavingLobby = currentLobby;
      leavingLobby.removePlayer(socket.id);
      socket.leave(leavingLobby.id);

      hub.to(leavingLobby.id).emit('player-left', {
        slot: leavingSlot,
        playerCount: leavingLobby.players.size,
        lobbyId: leavingLobby.id,
      });

      lobbyManager.cleanupIfEmpty(leavingLobby);
    }

    const lobby = lobbyManager.getAvailable(targetSize);
    currentLobby = lobby;

    socket.join(lobby.id);
    currentPlayer = lobby.addPlayer(socket.id);

    socket.emit('player-id', currentPlayer.slot);
    socket.emit('joined-matched-lobby', lobby.id);

    hub.to(lobby.id).emit('player-joined', {
      slot: currentPlayer.slot,
      playerCount: lobby.players.size,
      lobbyId: lobby.id,
    });

    // Auto-start if full
    if (lobby.status === 'lobby' && lobby.players.size >= lobby.maxPlayers) {
      lobby.startCountdown();
    } else {
      lobby.broadcastState();
    }
  });

  // Spectate 

  socket.on('join-spectate', (lobbyId) => {
    if (currentLobby) {
      socket.leave(currentLobby.id);
    }

    const lobby = lobbyManager.get(lobbyId);
    if (lobby) {
      currentLobby = lobby;
      socket.join(lobby.id);
      socket.emit('joined-matched-lobby', lobby.id);
      lobby.broadcastState();
    }
  });

  // In-game actions 

  socket.on('request-start', () => {
    if (currentLobby && currentLobby.status === 'lobby' && currentLobby.players.size >= currentLobby.maxPlayers) {
      currentLobby.startCountdown();
    }
  });

  socket.on('request-restart', () => {
    if (currentLobby && currentLobby.status === 'ended') {
      currentLobby.reset();
    }
  });

  socket.on('player-input', (data) => {
    currentLobby?.setPlayerInput(socket.id, data.keys, data.rotation);
  });

  socket.on('shoot', (data) => {
    currentLobby?.tryShoot(socket.id, data.rotation);
  });

  socket.on('self-hit', (data) => {
    currentLobby?.applySelfHit(socket.id, data);
  });

  socket.on('bullet-inactive', (data) => {
    currentLobby?.deactivateOwnedBullet(socket.id, data.bulletId);
  });

  socket.on('request-revive', () => {
    currentLobby?.requestRevive(socket.id);
  });

  //  Disconnect 

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);

    if (currentLobby && currentPlayer) {
      const leavingSlot = currentPlayer.slot;
      const leavingLobby = currentLobby;
      leavingLobby.removePlayer(socket.id);

      hub.to(leavingLobby.id).emit('player-left', {
        slot: leavingSlot,
        playerCount: leavingLobby.players.size,
        lobbyId: leavingLobby.id,
      });

      lobbyManager.cleanupIfEmpty(leavingLobby);
      currentLobby = null;
      currentPlayer = null;
    }
  });
});

//  Listen 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Triangle Shooter server running on http://localhost:${PORT}`);
});
