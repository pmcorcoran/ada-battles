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
  RELOAD_TIME,
  SERVER_TICK_MS,
  COUNTDOWN_SECONDS,
} from '../shared/constants';
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
  lastShotAtMs: number;
}

export interface ServerBullet {
  id: number;
  ownerId: string;
  ownerSlot: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
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

function normalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  const twoPi = Math.PI * 2;
  const normalized = rotation % twoPi;
  return normalized < 0 ? normalized + twoPi : normalized;
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
      lastShotAtMs: Number.NEGATIVE_INFINITY,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: string): void {
    const leaving = this.players.get(id);

    this.grantRevivesForKiller(id);

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
      p.lastShotAtMs = Number.NEGATIVE_INFINITY;
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

    // Move bullets only. Collision, health, elimination, and active/inactive
    // bullet state are reported by clients in this refactor stage.
    this.bullets.forEach((b) => {
      b.prevX = b.x;
      b.prevY = b.y;
      b.x += Math.cos(b.rotation) * BULLET_SPEED * dt;
      b.y += Math.sin(b.rotation) * BULLET_SPEED * dt;
    });

    this.broadcastState();
    this.checkWin();
  }

  //  Player input

  setPlayerInput(playerId: string, keys: number, rotation: number): void {
    const player = this.players.get(playerId);
    if (!player || player.health <= 0 || this.status !== 'playing') return;

    player.inputKeys = keys & 0x0F;
    player.rotation = normalizeRotation(rotation);
  }

  //  Bullets 

  tryShoot(ownerId: string, rotation: number): boolean {
    const owner = this.players.get(ownerId);
    if (!owner || owner.health <= 0 || this.status !== 'playing') return false;

    const now = Date.now();
    if (now - owner.lastShotAtMs < RELOAD_TIME) return false;

    const shotRotation = normalizeRotation(rotation);
    owner.rotation = shotRotation;
    owner.lastShotAtMs = now;

    const x = owner.x + Math.cos(shotRotation) * (PLAYER_SIDE + BULLET_RADIUS);
    const y = owner.y + Math.sin(shotRotation) * (PLAYER_SIDE + BULLET_RADIUS);
    const id = this.nextBulletId;
    this.nextBulletId = (this.nextBulletId + 1) & 0xFFFF;

    this.bullets.set(id, {
      id,
      ownerId,
      ownerSlot: owner.slot,
      x,
      y,
      prevX: x,
      prevY: y,
      rotation: shotRotation,
      startX: x,
      startY: y,
    });

    return true;
  }

  deactivateOwnedBullet(ownerId: string, bulletId: number): void {
    if (!Number.isFinite(bulletId)) return;

    const id = Math.trunc(bulletId) & 0xFFFF;
    const bullet = this.bullets.get(id);
    if (!bullet || bullet.ownerId !== ownerId) return;

    this.bullets.delete(id);
  }

  applySelfHit(
    playerId: string,
    data: { bulletId: number; health: number; isEliminated: boolean },
  ): void {
    if (this.status !== 'playing') return;

    const target = this.players.get(playerId);
    if (!target || target.health <= 0) return;

    if (!Number.isFinite(data.bulletId) || !Number.isFinite(data.health)) return;
    const bulletId = Math.trunc(data.bulletId) & 0xFFFF;
    const bullet = this.bullets.get(bulletId);
    if (!bullet || bullet.ownerId === playerId) return;

    this.bullets.delete(bulletId);

    const reportedHealth = Math.max(0, Math.min(target.maxHealth, Math.floor(data.health)));
    const isEliminated = data.isEliminated || reportedHealth <= 0;

    target.health = isEliminated ? 0 : reportedHealth;
    this.emit('player-hit', { targetSlot: target.slot, health: target.health, lobbyId: this.id });

    if (isEliminated) {
      target.inputKeys = 0;
      target.eliminatedBy = bullet.ownerId;
      target.canBeRevived = false;
      this.emit('player-eliminated', {
        targetSlot: target.slot,
        killerSlot: bullet.ownerSlot,
        lobbyId: this.id,
      });
      this.grantRevivesForKiller(target.id);
    }

    this.broadcastState();
    this.checkWin();
  }

  //  Win condition 

  private checkWin(): void {
    const alive = [...this.players.values()].filter((p) => p.health > 0);
    const revivePending = [...this.players.values()].some((p) => p.health <= 0 && p.canBeRevived);
    if (alive.length > 1 || revivePending) return;

    if (alive.length === 1) {
      this.winnerSlot = alive[0].slot;
      this.emit('game-over', { winnerSlot: this.winnerSlot, lobbyId: this.id });
    }

    this.status = 'ended';
    this.clearGameLoop();
  }

  //  Revival 

  requestRevive(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || this.status !== 'playing' || player.health > 0 || !player.canBeRevived) return;

    this.revivePlayer(player, player.eliminatedBy);
    this.broadcastState();
    this.checkWin();
  }

  private grantRevivesForKiller(killerId: string): void {
    const killer = this.players.get(killerId);
    const killerSlot = killer ? killer.slot : NO_SLOT;

    this.players.forEach((p) => {
      if (p.eliminatedBy === killerId && p.health <= 0 && !p.canBeRevived) {
        p.canBeRevived = true;
        this.emit('revive-available', {
          slot: p.slot,
          killerSlot,
          lobbyId: this.id,
        });
      }
    });
  }

  private revivePlayer(player: ServerPlayer, killerId: string | null): void {
    const pos = randomPosition();
    player.x = pos.x;
    player.y = pos.y;
    player.inputKeys = 0;
    player.health = 1;
    player.eliminatedBy = null;
    player.canBeRevived = false;

    const killer = killerId ? this.players.get(killerId) : undefined;
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
      p.lastShotAtMs = Number.NEGATIVE_INFINITY;
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
      prevX: b.prevX,
      prevY: b.prevY,
      x: b.x,
      y: b.y,
      startX: b.startX,
      startY: b.startY,
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
