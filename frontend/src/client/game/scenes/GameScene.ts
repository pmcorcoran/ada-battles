/**
 * GameScene
 *
 * The main Scene that drives all client-side game states:
 *   menu → lobby → countdown → playing → ended
 *
 * Delegates rendering to RenderSystem, DOM overlays to HUDSystem,
 * networking to NetworkClient, and input to InputManager.
 */

import type { Scene } from '../../engine/GameLoop';
import { InputManager } from '../../engine/InputManager';
import { NetworkClient } from '../../network/NetworkClient';
import { PlayerComponent, BulletComponent } from '../components';
import {
  drawBackground,
  drawPlayer,
  drawBullet,
  drawCountdown,
  drawMenu,
  drawLobby,
  type MenuHitAreas,
  type LobbyHitAreas,
} from '../systems/RenderSystem';
import { HUDSystem } from '../systems/HUDSystem';
import type { LobbyStateDTO, LobbyStatus } from '../../../shared/types';
import {
  BULLET_MAX_DISTANCE,
  BULLET_RADIUS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  RELOAD_TIME,
} from '../../../shared/constants';
import { circleTouchesTriangle, getPlayerHitTriangle } from '../../../shared/collision';

interface ClientPlayerCombatState {
  health: number;
  isEliminated: boolean;
}

export class GameScene implements Scene {
  // ── Dependencies ────────────────────────────────────────────────────────

  private readonly input: InputManager;
  private readonly net: NetworkClient;
  private readonly hud: HUDSystem;
  private readonly canvas: HTMLCanvasElement;

  // ── Entity stores ───────────────────────────────────────────────────────

  private players = new Map<number, PlayerComponent>();
  private bullets = new Map<number, BulletComponent>();
  private inactiveBulletIds = new Set<number>();
  private clientPlayerStates = new Map<number, ClientPlayerCombatState>();

  // ── State ───────────────────────────────────────────────────────────────

  private status: LobbyStatus | 'menu' = 'menu';
  private maxPlayers  = 3;
  private countdownTime = 10;
  private isSpectator = false;
  private reviveRequested = false;

  // Weapon
  private canShoot       = true;
  private reloadStartMs  = 0;

  // Click hit-testing areas cached from last render
  private menuHitAreas:  MenuHitAreas  | null = null;
  private lobbyHitAreas: LobbyHitAreas | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.input  = new InputManager(canvas);
    this.net    = new NetworkClient();
    this.hud    = new HUDSystem();

    this.bindNetworkEvents();
    this.bindCanvasClick();
    this.bindBackToMenu();
    this.checkSpectateMode();
  }

  private checkSpectateMode(): void {
    const params = new URLSearchParams(window.location.search);
    const spectateLobby = params.get('spectate');
    if (spectateLobby) {
      this.isSpectator = true;
      this.status = 'lobby';
      this.net.joinSpectate(spectateLobby);
    }
  }

  // ── Network wiring ────────────────────────────────────────────────────

  private bindNetworkEvents(): void {
    this.net.on('player-id', (slot) => {
      this.net.localSlot = slot;
    });

    this.net.on('joined-matched-lobby', (lobbyId) => {
      this.net.lobbyId = lobbyId;
    });

    this.net.on('player-joined', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.refreshPlayerCount();
    });

    this.net.on('player-left', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.clientPlayerStates.delete(data.slot);
      this.refreshPlayerCount();
    });

    this.net.on('countdown', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.status = 'countdown';
      this.countdownTime = data.time;
      this.hud.showMessage(`Game starting in ${data.time}...`);
    });

    this.net.on('lobby-state', (state) => {
      if (state.lobbyId !== this.net.lobbyId) return;
      this.applyLobbyState(state);
    });

    this.net.on('player-hit', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.setClientPlayerState(data.targetSlot, data.health, data.health <= 0);
      this.refreshHUD();
      this.refreshPlayerCount();
    });

    this.net.on('player-eliminated', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.setClientPlayerState(data.targetSlot, 0, true);
      this.refreshHUD();
      this.refreshPlayerCount();
    });

    this.net.on('revive-available', (data) => {
      if (data.lobbyId !== this.net.lobbyId || data.slot !== this.net.localSlot) return;
      if (!this.isSpectator && !this.reviveRequested) {
        this.reviveRequested = true;
        this.net.requestRevive();
      }
    });

    this.net.on('player-revived', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.setClientPlayerState(data.slot, 1, false);
      if (data.slot === this.net.localSlot) {
        this.reviveRequested = false;
      }
      this.refreshHUD();
      this.refreshPlayerCount();
    });

    this.net.on('game-over', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.status = 'ended';
      this.showEndScreen(data.winnerSlot !== null && data.winnerSlot === this.net.localSlot);
    });

    this.net.on('lobby-reset', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.status = 'lobby';
      this.resetClientAuthorityState();
      this.hud.hideMessage();
    });
  }

  // ── State application ─────────────────────────────────────────────────

  private applyLobbyState(state: LobbyStateDTO): void {
    this.status = state.status;
    if (state.status !== 'playing') {
      this.resetClientAuthorityState();
    }

    const serverBulletIds = new Set(state.bullets.map((b) => b.id));
    for (const id of this.inactiveBulletIds) {
      if (!serverBulletIds.has(id)) this.inactiveBulletIds.delete(id);
    }

    // Sync players
    this.players.clear();
    const playerSlots = new Set<number>();
    for (const dto of state.players) {
      const player = new PlayerComponent(dto);
      playerSlots.add(dto.slot);

      const clientState = this.clientPlayerStates.get(dto.slot);
      if (state.status === 'playing' && clientState) {
        player.health = clientState.health;
        player.isEliminated = clientState.isEliminated;
      }
      this.players.set(dto.slot, player);
    }
    for (const slot of this.clientPlayerStates.keys()) {
      if (!playerSlots.has(slot)) this.clientPlayerStates.delete(slot);
    }

    // Sync bullets while preserving each client's observed spawn point.
    const nextBullets = new Map<number, BulletComponent>();
    for (const dto of state.bullets) {
      if (this.inactiveBulletIds.has(dto.id)) continue;
      const existing = this.bullets.get(dto.id);
      if (existing) {
        existing.applyDTO(dto);
        nextBullets.set(dto.id, existing);
      } else {
        nextBullets.set(dto.id, new BulletComponent(dto));
      }
    }
    this.bullets = nextBullets;

    if (state.status === 'playing') {
      this.applyClientBulletAuthority();
    }

    if (state.status === 'ended' && state.winnerSlot !== null) {
      this.showEndScreen(state.winnerSlot === this.net.localSlot);
    } else if (state.status === 'playing') {
      this.hud.hideMessage();
    }

    this.refreshPlayerCount();
    this.refreshHUD();
  }

  // ── Scene interface ───────────────────────────────────────────────────

  update(_dt: number): void {
    if (this.status !== 'playing') return;

    this.applyClientBulletAuthority();

    const local = this.players.get(this.net.localSlot);
    if (!local || !local.isAlive || this.isSpectator) return;

    // Build movement-key bitmask: bit0=Up, bit1=Down, bit2=Left, bit3=Right.
    // Server is authoritative; position is advanced in Lobby.tick().
    let keys = 0;
    if (this.input.isKeyDown('w') || this.input.isKeyDown('arrowup'))    keys |= 1;
    if (this.input.isKeyDown('s') || this.input.isKeyDown('arrowdown'))  keys |= 2;
    if (this.input.isKeyDown('a') || this.input.isKeyDown('arrowleft'))  keys |= 4;
    if (this.input.isKeyDown('d') || this.input.isKeyDown('arrowright')) keys |= 8;

    const rotation = Math.atan2(
      this.input.mouse.y - local.y,
      this.input.mouse.x - local.x,
    );

    this.net.sendInput(keys, rotation);


    // Reload progress
    if (!this.canShoot) {
      const elapsed = Date.now() - this.reloadStartMs;
      const progress = Math.min(elapsed / RELOAD_TIME, 1);
      this.hud.setReloadProgress(progress);
      if (progress >= 1) this.canShoot = true;
    }

    // Shooting
    if (this.input.mouse.down && this.canShoot) {
      this.shoot(rotation);
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    drawBackground(ctx);

    if (this.status === 'menu') {
      this.menuHitAreas = drawMenu(ctx, this.maxPlayers);
      return;
    }

    if (this.status === 'lobby') {
      this.lobbyHitAreas = drawLobby(ctx, this.maxPlayers, this.players.size, this.net.lobbyId);
    }

    // Draw entities
    this.players.forEach((p) => {
      if (p.isAlive) drawPlayer(ctx, p, p.slot === this.net.localSlot, this.input.mouse);
    });

    this.bullets.forEach((b) => drawBullet(ctx, b));

    if (this.status === 'countdown') {
      drawCountdown(ctx, this.countdownTime);
    }
  }

  // ── Shooting ──────────────────────────────────────────────────────────

  private shoot(rotation: number): void {
    this.net.sendShoot(rotation);

    this.canShoot = false;
    this.reloadStartMs = Date.now();
    this.hud.setReloadProgress(0);
  }

  // ── Client-owned combat outcomes ─────────────────────────────────────

  private applyClientBulletAuthority(): void {
    for (const bullet of [...this.bullets.values()]) {
      if (this.isBulletOutOfBounds(bullet)) {
        this.markBulletInactive(bullet.id, !this.isSpectator && bullet.ownerSlot === this.net.localSlot);
        continue;
      }

      const hitPlayer = this.findBulletHitPlayer(bullet);
      if (hitPlayer) {
        this.applyPredictedHit(bullet, hitPlayer);
      }
    }
  }

  private isBulletOutOfBounds(bullet: BulletComponent): boolean {
    const dx = bullet.x - bullet.startX;
    const dy = bullet.y - bullet.startY;

    return (
      bullet.x < -BULLET_RADIUS ||
      bullet.x > CANVAS_WIDTH + BULLET_RADIUS ||
      bullet.y < -BULLET_RADIUS ||
      bullet.y > CANVAS_HEIGHT + BULLET_RADIUS ||
      Math.hypot(dx, dy) > BULLET_MAX_DISTANCE
    );
  }

  private bulletHitsPlayer(bullet: BulletComponent, player: PlayerComponent): boolean {
    const [v0, v1, v2] = getPlayerHitTriangle(player.x, player.y, player.rotation);
    const dx = bullet.x - bullet.prevX;
    const dy = bullet.y - bullet.prevY;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(distance / BULLET_RADIUS));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = bullet.prevX + dx * t;
      const y = bullet.prevY + dy * t;
      if (circleTouchesTriangle(x, y, BULLET_RADIUS, v0, v1, v2)) return true;
    }

    return false;
  }

  private findBulletHitPlayer(bullet: BulletComponent): PlayerComponent | null {
    for (const player of this.players.values()) {
      if (!player.isAlive || player.slot === bullet.ownerSlot) continue;
      if (this.bulletHitsPlayer(bullet, player)) return player;
    }
    return null;
  }

  private applyPredictedHit(bullet: BulletComponent, target: PlayerComponent): void {
    const nextHealth = Math.max(0, target.health - 1);
    const isEliminated = nextHealth <= 0;

    this.markBulletInactive(bullet.id, false);
    this.setClientPlayerState(target.slot, nextHealth, isEliminated);

    if (!this.isSpectator && target.slot === this.net.localSlot) {
      this.net.sendSelfHit(bullet.id, nextHealth, isEliminated);
    }
    this.refreshHUD();
    this.refreshPlayerCount();
  }

  private markBulletInactive(bulletId: number, notifyServer: boolean): void {
    if (this.inactiveBulletIds.has(bulletId)) return;

    this.inactiveBulletIds.add(bulletId);
    this.bullets.delete(bulletId);

    if (notifyServer) {
      this.net.sendBulletInactive(bulletId);
    }
  }

  // ── Click handling (canvas-based menus) ───────────────────────────────

  private bindCanvasClick(): void {
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this.status === 'menu' && this.menuHitAreas) {
        this.handleMenuClick(x, y);
      } else if (this.status === 'lobby' && this.lobbyHitAreas) {
        this.handleLobbyClick(x, y);
      }
    });
  }

  private handleMenuClick(x: number, y: number): void {
    const areas = this.menuHitAreas!;

    for (const btn of areas.sizeButtons) {
      if (x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
        this.maxPlayers = btn.size;
        return;
      }
    }

    const s = areas.startButton;
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      this.status = 'lobby';
      this.refreshPlayerCount();
      this.net.joinLobby(this.maxPlayers);
    }
  }

  private handleLobbyClick(x: number, y: number): void {
    const s = this.lobbyHitAreas!.startButton;
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      if (this.players.size >= this.maxPlayers) {
        this.net.requestStart();
      }
    }
  }

  /** "Back to Home" button injected into the DOM message overlay. */
  private bindBackToMenu(): void {
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'backToMenuBtn') {
        location.reload();
      }
    });
  }

  // ── HUD helpers ───────────────────────────────────────────────────────

  private refreshPlayerCount(): void {
    const alive = [...this.players.values()].filter((p) => p.isAlive).length;
    this.hud.updatePlayerCount(alive, this.maxPlayers);
  }

  private refreshHUD(): void {
    const local = this.players.get(this.net.localSlot);
    if (local) this.hud.updateHealth(local.health, local.maxHealth);
  }

  private setClientPlayerState(slot: number, health: number, isEliminated: boolean): void {
    this.clientPlayerStates.set(slot, { health, isEliminated });

    const player = this.players.get(slot);
    if (player) {
      player.health = health;
      player.isEliminated = isEliminated;
    }
  }

  private resetClientAuthorityState(): void {
    this.reviveRequested = false;
    this.inactiveBulletIds.clear();
    this.clientPlayerStates.clear();
  }

  private showEndScreen(isWinner: boolean): void {
    const label = isWinner ? '🎉 You Win!' : '💀 Game Over';
    this.hud.showMessage(
      `${label}<br><button id="backToMenuBtn" class="game-over-btn">Back to Home</button>`,
    );
  }
}
