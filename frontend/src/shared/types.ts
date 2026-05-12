/**
 * Shared Type Definitions
 *
 * Strongly-typed contract between server payloads and client consumers.
 * Every WebSocket message conforms to one of the event maps below,
 * preventing silent deserialization bugs.
 */

//  Primitives 

export interface Vector2 {
  x: number;
  y: number;
}

/** Sentinel for "no slot / null winner" in u8 slot fields. Slots 0–6 are valid. */
export const NO_SLOT = 0xFF;

//  Network DTOs (Data Transfer Objects) 

/** Player snapshot sent over the wire (no socket refs, no server internals). */
export interface PlayerDTO {
  slot: number;
  x: number;
  y: number;
  rotation: number;
  health: number;
  maxHealth: number;
  isEliminated: boolean;
}

/** Bullet snapshot sent over the wire. */
export interface BulletDTO {
  id: number;
  ownerSlot: number;
  x: number;
  y: number;
  rotation: number;
}

export type LobbyStatus = 'lobby' | 'countdown' | 'playing' | 'ended';

/** Full lobby snapshot broadcast every tick. */
export interface LobbyStateDTO {
  players: PlayerDTO[];
  bullets: BulletDTO[];
  status: LobbyStatus;
  winnerSlot: number | null;
  lobbyId: string;
}

//  WebSocket Event Maps 

/** Events emitted by the server, received by clients. */
export interface ServerToClientEvents {
  'player-id':          (slot: number) => void;
  'joined-matched-lobby': (lobbyId: string) => void;
  'player-joined':      (data: { slot: number; playerCount: number; lobbyId: string }) => void;
  'player-left':        (data: { slot: number; playerCount: number; lobbyId: string }) => void;
  'countdown':          (data: { time: number; lobbyId: string }) => void;
  'lobby-state':        (state: LobbyStateDTO) => void;
  'player-hit':         (data: { targetSlot: number; health: number; lobbyId: string }) => void;
  'player-eliminated':  (data: { targetSlot: number; killerSlot: number; lobbyId: string }) => void;
  'player-revived':     (data: { slot: number; killerSlot: number; lobbyId: string }) => void;
  'game-over':          (data: { winnerSlot: number | null; lobbyId: string }) => void;
  'lobby-reset':        (data: { lobbyId: string }) => void;
}

/** Events emitted by clients, received by the server. */
export interface ClientToServerEvents {
  'join-lobby':      (targetSize: number) => void;
  'join-spectate':   (lobbyId: string) => void;
  'request-start':   () => void;
  'request-restart': () => void;
  'player-input':    (data: { keys: number; rotation: number }) => void;
  'shoot':           (data: { rotation: number }) => void;
}
