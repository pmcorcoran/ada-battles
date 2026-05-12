/**
 * RenderSystem
 *
 * Stateless drawing helpers. Every method takes a CanvasRenderingContext2D
 * plus the data it needs — no retained state, no side-effects beyond pixels.
 */

import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  PLAYER_BASE,
  PLAYER_SIDE,
  BULLET_RADIUS,
  COLORS,
  LOBBY_SIZES,
} from '../../../shared/constants';
import type { PlayerComponent } from '../components/PlayerComponent';
import type { BulletComponent } from '../components/BulletComponent';
import type { MouseState } from '../../engine/InputManager';

const GRID_SIZE = 50;

// ── Background ───────────────────────────────────────────────────────────────

export function drawBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLORS.BACKGROUND;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.strokeStyle = COLORS.GRID;
  ctx.lineWidth = 1;
  for (let x = 0; x <= CANVAS_WIDTH; x += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_HEIGHT; y += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_WIDTH, y);
    ctx.stroke();
  }
}

// ── Player Triangle ──────────────────────────────────────────────────────────

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  player: PlayerComponent,
  isLocal: boolean,
  mouse: MouseState,
): void {
  const color = isLocal ? COLORS.SELF : COLORS.OPPONENT;

  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.rotation);

  ctx.fillStyle = player.health < player.maxHealth ? COLORS.HEALTH_LOW : color;
  ctx.strokeStyle = COLORS.WHITE;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(PLAYER_SIDE, 0);
  ctx.lineTo(-PLAYER_BASE / 2, -PLAYER_BASE / 2);
  ctx.lineTo(-PLAYER_BASE / 2,  PLAYER_BASE / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Crosshair for local player
  if (isLocal) {
    ctx.fillStyle = COLORS.WHITE;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, BULLET_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mini health bar
  const barW = 30;
  const barH = 4;
  ctx.fillStyle = '#333';
  ctx.fillRect(player.x - barW / 2, player.y - 35, barW, barH);

  const pct = player.health / player.maxHealth;
  ctx.fillStyle = player.health >= player.maxHealth ? COLORS.HEALTH_OK : COLORS.HEALTH_LOW;
  ctx.fillRect(player.x - barW / 2, player.y - 35, barW * pct, barH);
}

// ── Bullet ───────────────────────────────────────────────────────────────────

export function drawBullet(ctx: CanvasRenderingContext2D, bullet: BulletComponent): void {
  ctx.save();
  ctx.translate(bullet.x, bullet.y);
  ctx.rotate(bullet.rotation);

  ctx.fillStyle   = COLORS.BULLET;
  ctx.strokeStyle = COLORS.WHITE;
  ctx.lineWidth   = 1;

  ctx.beginPath();
  ctx.arc(0, 0, BULLET_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ── Countdown Overlay ────────────────────────────────────────────────────────

export function drawCountdown(ctx: CanvasRenderingContext2D, seconds: number): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.fillStyle    = COLORS.WHITE;
  ctx.font         = 'bold 120px Arial';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(seconds.toString(), CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
}

// ── Menu Screen ──────────────────────────────────────────────────────────────

export interface MenuHitAreas {
  sizeButtons: { x: number; y: number; w: number; h: number; size: number }[];
  startButton: { x: number; y: number; w: number; h: number };
}

export function drawMenu(
  ctx: CanvasRenderingContext2D,
  selectedSize: number,
): MenuHitAreas {
  const BTN_W = 200;
  const BTN_H = 50;
  const BTN_Y = 320;

  ctx.fillStyle = COLORS.WHITE;
  ctx.font      = 'bold 48px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('Triangle Shooter', CANVAS_WIDTH / 2, 150);

  ctx.font = '24px Arial';
  ctx.fillText('Multiplayer Battle Royale', CANVAS_WIDTH / 2, 200);

  const sizeButtons: MenuHitAreas['sizeButtons'] = [];

  LOBBY_SIZES.forEach((size, i) => {
    const x = CANVAS_WIDTH / 2 - 350 + i * 250;
    const isSelected = selectedSize === size;

    ctx.fillStyle = isSelected ? '#4CAF50' : '#555';
    ctx.fillRect(x, BTN_Y, BTN_W, BTN_H);
    ctx.strokeStyle = COLORS.WHITE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, BTN_Y, BTN_W, BTN_H);

    ctx.fillStyle = COLORS.WHITE;
    ctx.font = '20px Arial';
    ctx.fillText(`${size} Players`, x + BTN_W / 2, BTN_Y + BTN_H / 2 + 7);

    sizeButtons.push({ x, y: BTN_Y, w: BTN_W, h: BTN_H, size });
  });

  const startX = CANVAS_WIDTH / 2 - 100;
  ctx.fillStyle = '#2196F3';
  ctx.fillRect(startX, 420, 200, 60);
  ctx.strokeStyle = COLORS.WHITE;
  ctx.strokeRect(startX, 420, 200, 60);

  ctx.fillStyle = COLORS.WHITE;
  ctx.font = 'bold 24px Arial';
  ctx.fillText('START', CANVAS_WIDTH / 2, 458);

  ctx.fillStyle = '#aaa';
  ctx.font = '16px Arial';
  ctx.fillText('WASD/Arrows to move | Mouse to aim | Click to shoot', CANVAS_WIDTH / 2, 550);

  return {
    sizeButtons,
    startButton: { x: startX, y: 420, w: 200, h: 60 },
  };
}

// ── Lobby Waiting Screen ─────────────────────────────────────────────────────

export interface LobbyHitAreas {
  startButton: { x: number; y: number; w: number; h: number };
}

export function drawLobby(
  ctx: CanvasRenderingContext2D,
  maxPlayers: number,
  currentCount: number,
  lobbyId?: string,
): LobbyHitAreas {
  ctx.fillStyle = COLORS.WHITE;
  ctx.font      = 'bold 36px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(`Lobby (${maxPlayers} Players)`, CANVAS_WIDTH / 2, 100);

  ctx.font = '20px Arial';
  ctx.fillText(`Waiting for players... (${currentCount}/${maxPlayers})`, CANVAS_WIDTH / 2, 150);

  if (lobbyId) {
    ctx.fillStyle = '#aaa';
    ctx.font = '14px Arial';
    ctx.fillText(`Lobby ID: ${lobbyId}`, CANVAS_WIDTH / 2, 175);
    ctx.fillStyle = '#888';
    ctx.fillText(`SDK: ws://localhost:3000  Lobby: ${lobbyId}`, CANVAS_WIDTH / 2, 195);
  }

  const startX = CANVAS_WIDTH / 2 - 75;
  const canStart = currentCount >= maxPlayers;

  ctx.fillStyle = canStart ? '#4CAF50' : '#555';
  ctx.fillRect(startX, 200, 150, 50);
  ctx.strokeStyle = COLORS.WHITE;
  ctx.lineWidth = 2;
  ctx.strokeRect(startX, 200, 150, 50);

  ctx.fillStyle = COLORS.WHITE;
  ctx.font = '20px Arial';
  ctx.fillText(
    canStart ? 'Start Game' : `Need ${maxPlayers - currentCount} more`,
    CANVAS_WIDTH / 2,
    235,
  );

  return { startButton: { x: startX, y: 200, w: 150, h: 50 } };
}
