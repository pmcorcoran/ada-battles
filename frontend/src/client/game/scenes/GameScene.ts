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
import { RELOAD_TIME } from '../../../shared/constants';

export class GameScene implements Scene {
  // ── Dependencies ────────────────────────────────────────────────────────

  private readonly input: InputManager;
  private readonly net: NetworkClient;
  private readonly hud: HUDSystem;
  private readonly canvas: HTMLCanvasElement;

  // ── Entity stores ───────────────────────────────────────────────────────

  private players = new Map<number, PlayerComponent>();
  private bullets = new Map<number, BulletComponent>();

  // ── State ───────────────────────────────────────────────────────────────

  private status: LobbyStatus | 'menu' = 'menu';
  private maxPlayers  = 3;
  private countdownTime = 10;
  private isSpectator = false;

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
      this.refreshHUD();
    });

    this.net.on('player-eliminated', (_data) => { /* could add death FX */ });
    this.net.on('player-revived', (_data) => { /* could add revival FX */ });

    this.net.on('game-over', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.status = 'ended';
      this.showEndScreen(data.winnerSlot !== null && data.winnerSlot === this.net.localSlot);
    });

    this.net.on('lobby-reset', (data) => {
      if (data.lobbyId !== this.net.lobbyId) return;
      this.status = 'lobby';
      this.hud.hideMessage();
    });
  }

  // ── State application ─────────────────────────────────────────────────

  private applyLobbyState(state: LobbyStateDTO): void {
    this.status = state.status;

    // Sync players
    this.players.clear();
    for (const dto of state.players) {
      this.players.set(dto.slot, new PlayerComponent(dto));
    }

    // Sync bullets
    this.bullets.clear();
    for (const dto of state.bullets) {
      this.bullets.set(dto.id, new BulletComponent(dto));
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

  private showEndScreen(isWinner: boolean): void {
    const label = isWinner ? '🎉 You Win!' : '💀 Game Over';
    this.hud.showMessage(
      `${label}<br><button id="backToMenuBtn" class="game-over-btn">Back to Home</button>`,
    );
  }
}
