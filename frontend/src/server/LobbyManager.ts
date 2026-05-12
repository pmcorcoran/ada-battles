/**
 * LobbyManager
 *
 * Registry of all active Lobby instances.
 * Handles matchmaking (finding an open lobby or creating a new one)
 * and cleanup when lobbies empty out.
 */

import type { WebSocketHub } from './WebSocketHub';
import type { ServerToClientEvents, ClientToServerEvents } from '../shared/types';
import { Lobby } from './Lobby';

export class LobbyManager {
  private readonly lobbies = new Map<string, Lobby>();

  constructor(
    private readonly io: WebSocketHub<ClientToServerEvents, ServerToClientEvents>,
  ) {}

  /** Find an open lobby of the requested size, or spin up a new one. */
  getAvailable(size: number): Lobby {
    for (const lobby of this.lobbies.values()) {
      if (
        lobby.status === 'lobby' &&
        lobby.maxPlayers === size &&
        lobby.players.size < size
      ) {
        return lobby;
      }
    }

    const id = Math.random().toString(36).substring(2, 9);
    const lobby = new Lobby(id, size, this.io);
    this.lobbies.set(id, lobby);
    console.log(`Created new ${size}-player lobby: ${id}`);
    return lobby;
  }

  get(id: string): Lobby | undefined {
    return this.lobbies.get(id);
  }

  listAll(): Lobby[] {
    return [...this.lobbies.values()];
  }

  /** Remove a lobby if it's empty, freeing timers and memory. */
  cleanupIfEmpty(lobby: Lobby): void {
    if (lobby.isEmpty) {
      lobby.dispose();
      this.lobbies.delete(lobby.id);
      console.log(`Destroyed empty lobby: ${lobby.id}`);
    }
  }
}
