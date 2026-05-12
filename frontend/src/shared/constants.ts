/**
 * Shared Constants
 *
 * Single source of truth consumed by both server and client.
 * Keeping physics, dimensions, and aesthetics here guarantees
 * the authoritative server and the predictive client always agree.
 */

//  Canvas 

export const CANVAS_WIDTH  = 900; // originally 1000
export const CANVAS_HEIGHT = 630; // originally 700

//  Player / Triangle 

export const PLAYER_BASE       = 18;   // flat edge width (px)
export const PLAYER_SIDE       = 27;   // point-to-base length (px)
export const PLAYER_SPEED      = 320;  // px / second, originally 400
export const PLAYER_MAX_HEALTH = 2;
//export const PLAYER_HIT_RADIUS = 22;   // circular hit-box approximation //originally 25
export const PLAYER_STROKE_WIDTH = 2; 

//  Weapon 

export const BULLET_SPEED        = 600;  // px / second, originally 750
export const BULLET_RADIUS       = 4;    // originally 5
export const BULLET_MAX_DISTANCE = 1500;
export const RELOAD_TIME         = 1500; // ms cooldown between shots

//  Lobby 

export const LOBBY_SIZES       = [3, 5, 7] as const;
export const COUNTDOWN_SECONDS = 5; //originally 10

//  Tick Rate 

export const SERVER_TICK_MS = 16; // ~60 Hz

//  Palette 

export const COLORS = {
  BACKGROUND: '#1a1a2e',
  GRID:       '#333333',
  SELF:       '#00ff00',
  OPPONENT:   '#ff4444',
  BULLET:     '#ffff00',
  HEALTH_OK:  '#00ff00',
  HEALTH_LOW: '#ff9900',
  WHITE:      '#ffffff',
} as const;
