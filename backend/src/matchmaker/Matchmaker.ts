/**
 * Matchmaker — finds or spawns lobby-runner instances on demand.
 * Holds no game state; only knows which runners exist and roughly
 * how full they are (heartbeated via each runner's /status endpoint).
 */

import { randomUUID } from 'node:crypto';
import type { OrchestratorSPI } from './orchestrator/OrchestratorSPI';

export type LobbyStatus = 'starting' | 'lobby' | 'countdown' | 'playing' | 'ended';

export interface LobbyRecord {
  id:            string;
  maxPlayers:    number;
  containerRef:  string;
  /** Public URL given to the client (proxied through the matchmaker). */
  wsUrl:         string;
  /** Internal URL the WS proxy targets directly. */
  internalWsUrl: string;
  statusUrl:     string;
  status:        LobbyStatus;
  playerCount:   number;
  createdAt:     number;
}

export type PublicUrlFor = (lobbyId: string, internalUrl: string) => string;

export class Matchmaker {
  readonly lobbies = new Map<string, LobbyRecord>();

  constructor(
    private readonly orchestrator: OrchestratorSPI,
    private readonly publicUrlFor: PublicUrlFor,
  ) {}

  list(): LobbyRecord[] {
    return [...this.lobbies.values()].filter((l) => l.status !== 'ended');
  }

  /** Find a lobby with room, or spin up a fresh one. */
  async match(maxPlayers: number): Promise<LobbyRecord> {
    const open = [...this.lobbies.values()].find(
      (l) => l.maxPlayers === maxPlayers
         && (l.status === 'lobby' || l.status === 'starting')
         && l.playerCount < l.maxPlayers,
    );
    if (open) return open;
    return this.spawnLobby(maxPlayers);
  }

  async spawnLobby(maxPlayers: number): Promise<LobbyRecord> {
    const id = randomUUID();
    const { containerRef, wsUrl, statusUrl } = await this.orchestrator.spawn({
      lobbyId: id,
      maxPlayers,
    });

    const record: LobbyRecord = {
      id,
      maxPlayers,
      containerRef,
      wsUrl:         this.publicUrlFor(id, wsUrl),
      internalWsUrl: wsUrl,
      statusUrl,
      status:        'starting',
      playerCount:   0,
      createdAt:     Date.now(),
    };
    this.lobbies.set(id, record);

    void this.beginPolling(record);
    return record;
  }

  /** Poll the runner's /status until it dies. */
  private async beginPolling(record: LobbyRecord): Promise<void> {
    const POLL_INTERVAL = 2_000;

    while (this.lobbies.has(record.id)) {
      try {
        const res = await fetch(record.statusUrl, { signal: AbortSignal.timeout(1_500) });
        if (res.ok) {
          const body = await res.json() as { status: LobbyStatus; playerCount: number };
          record.status      = body.status;
          record.playerCount = body.playerCount;
        }
      } catch {
        // Network errors are expected during startup and shutdown.
      }
      await sleep(POLL_INTERVAL);
    }
  }

  /** Reap ended, empty, or never-came-up lobbies. Idempotent. */
  async reap(): Promise<void> {
    const now = Date.now();
    for (const record of this.lobbies.values()) {
      const ageMs = now - record.createdAt;
      const dead =
        record.status === 'ended' ||
        (record.playerCount === 0 && ageMs > 60_000) ||
        (record.status === 'starting' && ageMs > 60_000);

      if (dead) {
        console.log(`[reap] ${record.id} status=${record.status} players=${record.playerCount} age=${Math.round(ageMs / 1000)}s`);
        await this.orchestrator.stop(record.containerRef).catch(() => {});
        this.lobbies.delete(record.id);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}