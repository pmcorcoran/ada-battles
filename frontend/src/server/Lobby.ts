/**
 * Lobby
 *
 * Encapsulates all state and lifecycle for a single game lobby.
 * The server manages a collection of these — one per concurrent match.
 */

import type { WebSocketHub } from './WebSocketHub';
import type { ServerToClientEvents, ClientToServerEvents, PlayerDTO, BulletDTO } from '../shared/types';
import { NO_SLOT } from '../shared/types';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PLAYER_MAX_HEALTH,
  PLAYER_SIDE,
  PLAYER_SPEED,
  BULLET_SPEED,
  BULLET_RADIUS,
  BULLET_MAX_DISTANCE,
  SERVER_TICK_MS,
  COUNTDOWN_SECONDS,
} from '../shared/constants';
import { circleTouchesTriangle, getPlayerHitTriangle } from '../shared/collision';
import type { LobbyStatus } from '../shared/types';

//  Internal entity types (never serialised directly) 

export interface ServerPlayer {
  id: string;
  slot: number;
  x: number;
  y: number;
  rotation: number;
  /** WASD bitmask: bit0=Up, bit1=Down, bit2=Left, bit3=Right. Applied in tick(). */
  inputKeys: number;
  health: number;
  maxHealth: number;
  eliminatedBy: string | null;
  canBeRevived: boolean;
}

export interface ServerBullet {
  id: number;
  ownerId: string;
  ownerSlot: number;
  x: number;
  y: number;
  rotation: number;
  startX: number;
  startY: number;
}

//  Spawn positions 

const SPAWN_POSITIONS = [
  { x: 90, y: 90 }, { x: 810, y: 90 },
  { x: 450, y: 315 }, { x: 90, y: 640 },
  { x: 810, y: 540 }, { x: 315, y: 315 },
  { x: 630, y: 315 },
];

function randomPosition(): { x: number; y: number } {
  const margin = 45;
  return {
    x: margin + Math.random() * (CANVAS_WIDTH  - 2 * margin),
    y: margin + Math.random() * (CANVAS_HEIGHT - 2 * margin),
  };
}

//  Lobby class 

export class Lobby {
  readonly id: string;
  readonly maxPlayers: number;

  status: LobbyStatus = 'lobby';
  winnerSlot: number | null = null;

  players = new Map<string, ServerPlayer>();
  bullets = new Map<number, ServerBullet>();

  private slotBitset = 0;
  private nextBulletId = 0;
  private countdownTime = COUNTDOWN_SECONDS;
  private countdownInterval: NodeJS.Timeout | null = null;
  private gameLoopInterval:  NodeJS.Timeout | null = null;

  constructor(
    id: string,
    maxPlayers: number,
    private readonly io: WebSocketHub<ClientToServerEvents, ServerToClientEvents>,
  ) {
    this.id = id;
    this.maxPlayers = maxPlayers;
  }

  //  Player management 

  addPlayer(id: string): ServerPlayer {
    const slot = this.allocateSlot();
    const player: ServerPlayer = {
      id,
      slot,
      x: 450, y: 315,
      rotation: 0,
      inputKeys: 0,
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      eliminatedBy: null,
      canBeRevived: false,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: string): void {
    const leaving = this.players.get(id);

    // Revive anyone this player had killed before removing them
    this.players.forEach((p) => {
      if (p.eliminatedBy === id && p.canBeRevived && p.health <= 0) {
        this.revivePlayer(p, id);
      }
    });

    if (leaving) this.freeSlot(leaving.slot);
    this.players.delete(id);

    if (this.status === 'playing' || this.status === 'countdown') {
      if (this.players.size < 2) {
        this.reset();
      } else {
        this.checkWin();
      }
    }

    if (this.status === 'lobby' && this.players.size >= this.maxPlayers) {
      this.startCountdown();
    }
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  /** Lowest clear bit in the slot bitset. Capped at maxPlayers (size-7). */
  private allocateSlot(): number {
    for (let i = 0; i < this.maxPlayers; i++) {
      if ((this.slotBitset & (1 << i)) === 0) {
        this.slotBitset |= (1 << i);
        return i;
      }
    }
    return this.maxPlayers - 1; // fall back; should not happen if caller respects capacity
  }

  private freeSlot(slot: number): void {
    this.slotBitset &= ~(1 << slot);
  }

  //  Countdown 

  startCountdown(): void {
    if (this.status !== 'lobby') return;

    this.status = 'countdown';
    this.countdownTime = COUNTDOWN_SECONDS;
    this.emit('countdown', { time: this.countdownTime, lobbyId: this.id });

    this.countdownInterval = setInterval(() => {
      this.countdownTime--;
      this.emit('countdown', { time: this.countdownTime, lobbyId: this.id });

      if (this.countdownTime <= 0) {
        this.clearCountdown();
        this.startGame();
      }
    }, 1000);
  }

  //  Game start 

  private startGame(): void {
    this.status = 'playing';
    this.winnerSlot = null;

    let idx = 0;
    this.players.forEach((p) => {
      const pos = SPAWN_POSITIONS[idx % SPAWN_POSITIONS.length];
      p.x = pos.x + (Math.random() - 0.5) * 45;
      p.y = pos.y + (Math.random() - 0.5) * 45;
      p.inputKeys = 0;
      p.health = PLAYER_MAX_HEALTH;
      p.maxHealth = PLAYER_MAX_HEALTH;
      p.eliminatedBy = null;
      p.canBeRevived = false;
      idx++;
    });

    this.broadcastState();
    this.startLoop();
  }

  //  Tick loop 

  private startLoop(): void {
    this.gameLoopInterval = setInterval(() => {
      if (this.status !== 'playing') return;
      this.tick();
    }, SERVER_TICK_MS);
  }

  private tick(): void {
    const dt = SERVER_TICK_MS / 1000;
    const toRemove: number[] = [];
    const hits: { bullet: ServerBullet; target: ServerPlayer }[] = [];

    // Apply movement — server is authoritative. Key bits: 0=Up, 1=Down, 2=Left, 3=Right.
    // Diagonals are normalised so they don't move √2× faster than orthogonals.
    this.players.forEach((p) => {
      if (p.health <= 0) return;
      const k = p.inputKeys;
      const dx = ((k >> 3) & 1) - ((k >> 2) & 1);
      const dy = ((k >> 1) & 1) - ( k       & 1);
      if (dx === 0 && dy === 0) return;
      const len = Math.hypot(dx, dy);
      const nx = p.x + (dx / len) * PLAYER_SPEED * dt;
      const ny = p.y + (dy / len) * PLAYER_SPEED * dt;
      p.x = Math.max(PLAYER_SIDE, Math.min(CANVAS_WIDTH  - PLAYER_SIDE, nx));
      p.y = Math.max(PLAYER_SIDE, Math.min(CANVAS_HEIGHT - PLAYER_SIDE, ny));
    });

    // Move bullets & detect collisions
    this.bullets.forEach((b) => {
      b.x += Math.cos(b.rotation) * BULLET_SPEED * dt;
      b.y += Math.sin(b.rotation) * BULLET_SPEED * dt;

      const dx = b.x - b.startX;
      const dy = b.y - b.startY;
      if (
        b.x < 0 || b.x > CANVAS_WIDTH ||
        b.y < 0 || b.y > CANVAS_HEIGHT ||
        Math.hypot(dx, dy) > BULLET_MAX_DISTANCE
      ) {
        toRemove.push(b.id);
        return;
      }

      this.players.forEach((p) => {
        if (p.id === b.ownerId || p.health <= 0) return;
        const [v0, v1, v2] = getPlayerHitTriangle(p.x, p.y, p.rotation);
        if (circleTouchesTriangle(b.x, b.y, BULLET_RADIUS, v0, v1, v2)) {
          toRemove.push(b.id);
          hits.push({ bullet: b, target: p });
        }
      });
    });

    // Process hits
    const newlyDead: string[] = [];
    for (const { bullet, target } of hits) {
      target.health--;

      this.emit('player-hit', { targetSlot: target.slot, health: target.health, lobbyId: this.id });

      if (target.health <= 0) {
        target.eliminatedBy = bullet.ownerId;
        target.canBeRevived = true;
        this.emit('player-eliminated', {
          targetSlot: target.slot,
          killerSlot: bullet.ownerSlot,
          lobbyId: this.id,
        });
        newlyDead.push(target.id);
      }
    }

    // Revival chain: if a killer just died, their victims come back
    for (const deadId of newlyDead) {
      this.players.forEach((p) => {
        if (p.eliminatedBy === deadId && p.canBeRevived && p.health <= 0) {
          this.revivePlayer(p, deadId);
        }
      });
    }

    for (const id of toRemove) this.bullets.delete(id);

    this.broadcastState();
    this.checkWin();
  }

  //  Bullets 

  addBullet(data: { x: number; y: number; rotation: number; ownerId: string }): void {
    const owner = this.players.get(data.ownerId);
    if (!owner) return;
    const id = this.nextBulletId;
    this.nextBulletId = (this.nextBulletId + 1) & 0xFFFF;
    this.bullets.set(id, {
      id,
      ownerId: data.ownerId,
      ownerSlot: owner.slot,
      x: data.x,
      y: data.y,
      rotation: data.rotation,
      startX: data.x,
      startY: data.y,
    });
  }

  //  Win condition 

  private checkWin(): void {
    const alive = [...this.players.values()].filter((p) => p.health > 0);
    if (alive.length > 1) return;

    if (alive.length === 1) {
      this.winnerSlot = alive[0].slot;
      this.emit('game-over', { winnerSlot: this.winnerSlot, lobbyId: this.id });
    }

    this.status = 'ended';
    this.clearGameLoop();
  }

  //  Revival 

  private revivePlayer(player: ServerPlayer, killerId: string): void {
    const pos = randomPosition();
    player.x = pos.x;
    player.y = pos.y;
    player.inputKeys = 0;
    player.health = 1;
    player.eliminatedBy = null;
    player.canBeRevived = false;

    const killer = this.players.get(killerId);
    this.emit('player-revived', {
      slot: player.slot,
      killerSlot: killer ? killer.slot : NO_SLOT,
      lobbyId: this.id,
    });
  }

  //  Reset 

  reset(): void {
    this.status = 'lobby';
    this.winnerSlot = null;
    this.bullets.clear();

    this.players.forEach((p) => {
      p.inputKeys = 0;
      p.health = PLAYER_MAX_HEALTH;
      p.maxHealth = PLAYER_MAX_HEALTH;
      p.eliminatedBy = null;
      p.canBeRevived = false;
    });

    this.clearGameLoop();
    this.clearCountdown();

    this.emit('lobby-reset', { lobbyId: this.id });
    this.broadcastState();
  }

  //  Broadcasting 

  broadcastState(): void {
    const players: PlayerDTO[] = [...this.players.values()].map((p) => ({
      slot: p.slot,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      health: p.health,
      maxHealth: p.maxHealth,
      isEliminated: p.health <= 0,
    }));

    const bullets: BulletDTO[] = [...this.bullets.values()].map((b) => ({
      id: b.id,
      ownerSlot: b.ownerSlot,
      x: b.x,
      y: b.y,
      rotation: b.rotation,
    }));

    this.io.to(this.id).emit('lobby-state', {
      players,
      bullets,
      status: this.status,
      winnerSlot: this.winnerSlot,
      lobbyId: this.id,
    });
  }

  //  Cleanup 

  dispose(): void {
    this.clearGameLoop();
    this.clearCountdown();
  }

  private clearGameLoop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
  }

  private clearCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  //  Typed emit helper 

  private emit<K extends keyof ServerToClientEvents>(
    event: K,
    ...args: Parameters<ServerToClientEvents[K]>
  ): void {
    (this.io.to(this.id).emit as any)(event, ...args);
  }
}
