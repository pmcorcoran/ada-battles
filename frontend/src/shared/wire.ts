/**
 * Binary wire codec.
 *
 * Format: 1-byte opcode + packed payload, sent as a WebSocket binary frame.
 * All multi-byte integers are little-endian.
 *
 * Encoding rules (see plan file for full spec):
 *   - positions (x, y):  i16 fixed-point, x * 10 (0.1 px precision, ±3276.7 range)
 *   - rotation:          u16, normalised to [0, 2π) then scaled to [0, 65535]
 *   - health, status, bool, countdown, playerCount, targetSize: u8
 *   - player refs:       u8 slot (lobby-local, 0..6 for size-7 lobbies)
 *   - bullet ids:        u16 LE (server-assigned counter, wraps at 65536)
 *   - nullable slot:     u8, 0xFF == null (valid slots are 0..6)
 *   - strings (lobbyId): u8 length prefix + UTF-8 bytes (max 255 bytes)
 */

import type {
  LobbyStateDTO,
  LobbyStatus,
} from './types';
import { NO_SLOT } from './types';

export const OP = {
  'player-id':            0x01,
  'joined-matched-lobby': 0x02,
  'player-joined':        0x03,
  'player-left':          0x04,
  'countdown':            0x05,
  'lobby-state':          0x06,
  'player-hit':           0x07,
  'player-eliminated':    0x08,
  'player-revived':       0x09,
  'game-over':            0x0A,
  'lobby-reset':          0x0B,
  'revive-available':     0x0C,
  'join-lobby':           0x20,
  'join-spectate':        0x21,
  'request-start':        0x22,
  'request-restart':      0x23,
  'player-input':         0x26,
  'shoot':                0x27,
  'self-hit':             0x28,
  'bullet-inactive':      0x29,
  'request-revive':       0x2A,
} as const;

const EVENT_BY_OP: Record<number, string> = Object.fromEntries(
  Object.entries(OP).map(([k, v]) => [v, k]),
);

const STATUS_TO_U8: Record<LobbyStatus, number> = {
  lobby: 0, countdown: 1, playing: 2, ended: 3,
};
const U8_TO_STATUS: LobbyStatus[] = ['lobby', 'countdown', 'playing', 'ended'];

const POS_SCALE = 10;                         // 0.1 px precision
const TWO_PI    = Math.PI * 2;
const ROT_SCALE = 65535 / TWO_PI;             // [0, 2π) → [0, 65535]

const enc = new TextEncoder();
const dec = new TextDecoder();

//  Writer 

class Writer {
  readonly buf: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(size: number) {
    this.buf  = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number):  void { this.buf[this.pos++] = v & 0xff; }
  u16(v: number): void { this.view.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  i16(v: number): void { this.view.setInt16(this.pos,  v,          true); this.pos += 2; }

  pos16(v: number): void { this.i16(Math.round(v * POS_SCALE)); }
  rot16(v: number): void {
    let r = v % TWO_PI;
    if (r < 0) r += TWO_PI;
    this.u16(Math.round(r * ROT_SCALE));
  }

  bool(v: boolean): void { this.u8(v ? 1 : 0); }

  /** u8 slot with 0xFF as null sentinel. */
  slotOrNone(v: number | null): void {
    this.u8(v === null ? NO_SLOT : v);
  }

  str(s: string): void {
    const bytes = enc.encode(s);
    if (bytes.length > 255) {
      throw new Error(`wire: string too long (${bytes.length} > 255)`);
    }
    this.u8(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  view0(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

//  Reader 

class Reader {
  readonly buf: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(input: ArrayBuffer | Uint8Array) {
    if (input instanceof Uint8Array) {
      this.buf  = input;
      this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    } else {
      this.buf  = new Uint8Array(input);
      this.view = new DataView(input);
    }
  }

  remaining(): number { return this.buf.length - this.pos; }

  u8():  number { return this.buf[this.pos++]; }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos,  true); this.pos += 2; return v; }

  pos16(): number { return this.i16() / POS_SCALE; }
  rot16(): number { return this.u16() / ROT_SCALE; }

  bool(): boolean { return this.u8() !== 0; }

  /** u8 slot with 0xFF as null sentinel. */
  slotOrNone(): number | null {
    const v = this.u8();
    return v === NO_SLOT ? null : v;
  }

  str(): string {
    const len   = this.u8();
    const bytes = this.buf.subarray(this.pos, this.pos + len);
    this.pos   += len;
    return dec.decode(bytes);
  }
}

//  Size helpers (exact, for pre-allocation) 

const strSize = (s: string) => 1 + enc.encode(s).length;

const PLAYER_SIZE = 1 + 2 + 2 + 2 + 1 + 1 + 1;   // slot + x + y + rot + hp + maxHp + elim
const BULLET_SIZE = 2 + 1 + 2 + 2 + 2 + 2 + 2 + 2 + 2; // id + ownerSlot + prev x/y + x/y + start x/y + rot

//  Encode 

type EmitterMap = { [K: string]: (w: Writer, data: any) => void };
type SizerMap   = { [K: string]: (data: any) => number };

const sizes: SizerMap = {
  'player-id':            ()       => 1,
  'joined-matched-lobby': (d: string) => strSize(d),
  'player-joined':        (d: { slot: number; playerCount: number; lobbyId: string }) =>
    1 + 1 + strSize(d.lobbyId),
  'player-left':          (d: { slot: number; playerCount: number; lobbyId: string }) =>
    1 + 1 + strSize(d.lobbyId),
  'countdown':            (d: { time: number; lobbyId: string }) =>
    1 + strSize(d.lobbyId),
  'lobby-state':          (d: LobbyStateDTO) =>
    1 + d.players.length * PLAYER_SIZE +
    1 + d.bullets.length * BULLET_SIZE +
    1 + 1 + strSize(d.lobbyId),
  'player-hit':           (d: { targetSlot: number; health: number; lobbyId: string }) =>
    1 + 1 + strSize(d.lobbyId),
  'player-eliminated':    (d: { targetSlot: number; killerSlot: number; lobbyId: string }) =>
    1 + 1 + strSize(d.lobbyId),
  'revive-available':     (d: { slot: number; killerSlot: number; lobbyId: string }) =>
    1 + 1 + strSize(d.lobbyId),
  'player-revived':       (d: { slot: number; killerSlot: number; lobbyId: string }) =>
    1 + 1 + strSize(d.lobbyId),
  'game-over':            (d: { winnerSlot: number | null; lobbyId: string }) =>
    1 + strSize(d.lobbyId),
  'lobby-reset':          (d: { lobbyId: string }) => strSize(d.lobbyId),

  'join-lobby':           ()       => 1,
  'join-spectate':        (d: string) => strSize(d),
  'request-start':        ()       => 0,
  'request-restart':      ()       => 0,
  'player-input':         ()       => 1 + 2,
  'shoot':                ()       => 2,
  'self-hit':             ()       => 2 + 1 + 1,
  'bullet-inactive':      ()       => 2,
  'request-revive':       ()       => 0,
};

const emitters: EmitterMap = {
  'player-id':            (w, d: number) => w.u8(d),
  'joined-matched-lobby': (w, d: string) => w.str(d),
  'player-joined':        (w, d) => { w.u8(d.slot); w.u8(d.playerCount); w.str(d.lobbyId); },
  'player-left':          (w, d) => { w.u8(d.slot); w.u8(d.playerCount); w.str(d.lobbyId); },
  'countdown':            (w, d) => { w.u8(d.time); w.str(d.lobbyId); },
  'lobby-state':          (w, d: LobbyStateDTO) => {
    w.u8(d.players.length);
    for (const p of d.players) {
      w.u8(p.slot);
      w.pos16(p.x);
      w.pos16(p.y);
      w.rot16(p.rotation);
      w.u8(p.health);
      w.u8(p.maxHealth);
      w.bool(p.isEliminated);
    }
    w.u8(d.bullets.length);
    for (const b of d.bullets) {
      w.u16(b.id);
      w.u8(b.ownerSlot);
      w.pos16(b.prevX);
      w.pos16(b.prevY);
      w.pos16(b.x);
      w.pos16(b.y);
      w.pos16(b.startX);
      w.pos16(b.startY);
      w.rot16(b.rotation);
    }
    w.u8(STATUS_TO_U8[d.status]);
    w.slotOrNone(d.winnerSlot);
    w.str(d.lobbyId);
  },
  'player-hit':           (w, d) => { w.u8(d.targetSlot); w.u8(d.health); w.str(d.lobbyId); },
  'player-eliminated':    (w, d) => { w.u8(d.targetSlot); w.u8(d.killerSlot); w.str(d.lobbyId); },
  'revive-available':     (w, d) => { w.u8(d.slot); w.u8(d.killerSlot); w.str(d.lobbyId); },
  'player-revived':       (w, d) => { w.u8(d.slot); w.u8(d.killerSlot); w.str(d.lobbyId); },
  'game-over':            (w, d) => { w.slotOrNone(d.winnerSlot); w.str(d.lobbyId); },
  'lobby-reset':          (w, d) => { w.str(d.lobbyId); },

  'join-lobby':           (w, d: number) => w.u8(d),
  'join-spectate':        (w, d: string) => w.str(d),
  'request-start':        ()       => { /* empty */ },
  'request-restart':      ()       => { /* empty */ },
  'player-input':         (w, d)   => { w.u8(d.keys & 0x0F); w.rot16(d.rotation); },
  'shoot':                (w, d)   => { w.rot16(d.rotation); },
  'self-hit':             (w, d)   => { w.u16(d.bulletId); w.u8(d.health); w.bool(d.isEliminated); },
  'bullet-inactive':      (w, d)   => { w.u16(d.bulletId); },
  'request-revive':       ()       => { /* empty */ },
};

export function encode(event: string, data: unknown): Uint8Array {
  const op = (OP as Record<string, number>)[event];
  if (op === undefined) throw new Error(`wire.encode: unknown event "${event}"`);
  const payloadSize = sizes[event](data);
  const w = new Writer(1 + payloadSize);
  w.u8(op);
  emitters[event](w, data);
  return w.view0();
}

//  Decode 

type DecodedMessage = { event: string; data: unknown };
type DecoderMap = { [K: string]: (r: Reader) => unknown };

const decoders: DecoderMap = {
  'player-id':            (r) => r.u8(),
  'joined-matched-lobby': (r) => r.str(),
  'player-joined':        (r) => ({ slot: r.u8(), playerCount: r.u8(), lobbyId: r.str() }),
  'player-left':          (r) => ({ slot: r.u8(), playerCount: r.u8(), lobbyId: r.str() }),
  'countdown':            (r) => ({ time: r.u8(), lobbyId: r.str() }),
  'lobby-state':          (r): LobbyStateDTO => {
    const playerCount = r.u8();
    const players: LobbyStateDTO['players'] = [];
    for (let i = 0; i < playerCount; i++) {
      players.push({
        slot:          r.u8(),
        x:             r.pos16(),
        y:             r.pos16(),
        rotation:      r.rot16(),
        health:        r.u8(),
        maxHealth:     r.u8(),
        isEliminated:  r.bool(),
      });
    }
    const bulletCount = r.u8();
    const bullets: LobbyStateDTO['bullets'] = [];
    for (let i = 0; i < bulletCount; i++) {
      bullets.push({
        id:        r.u16(),
        ownerSlot: r.u8(),
        prevX:     r.pos16(),
        prevY:     r.pos16(),
        x:         r.pos16(),
        y:         r.pos16(),
        startX:    r.pos16(),
        startY:    r.pos16(),
        rotation:  r.rot16(),
      });
    }
    const status = U8_TO_STATUS[r.u8()];
    const winnerSlot = r.slotOrNone();
    const lobbyId = r.str();
    return { players, bullets, status, winnerSlot, lobbyId };
  },
  'player-hit':           (r) => ({ targetSlot: r.u8(), health: r.u8(), lobbyId: r.str() }),
  'player-eliminated':    (r) => ({ targetSlot: r.u8(), killerSlot: r.u8(), lobbyId: r.str() }),
  'revive-available':     (r) => ({ slot: r.u8(), killerSlot: r.u8(), lobbyId: r.str() }),
  'player-revived':       (r) => ({ slot: r.u8(), killerSlot: r.u8(), lobbyId: r.str() }),
  'game-over':            (r) => ({ winnerSlot: r.slotOrNone(), lobbyId: r.str() }),
  'lobby-reset':          (r) => ({ lobbyId: r.str() }),

  'join-lobby':           (r) => r.u8(),
  'join-spectate':        (r) => r.str(),
  'request-start':        ()  => undefined,
  'request-restart':      ()  => undefined,
  'player-input':         (r) => ({ keys: r.u8() & 0x0F, rotation: r.rot16() }),
  'shoot':                (r) => ({ rotation: r.rot16() }),
  'self-hit':             (r) => ({ bulletId: r.u16(), health: r.u8(), isEliminated: r.bool() }),
  'bullet-inactive':      (r) => ({ bulletId: r.u16() }),
  'request-revive':       ()  => undefined,
};

/** Returns null if the buffer is empty, the opcode is unknown, or parsing throws. */
export function decode(input: ArrayBuffer | Uint8Array): DecodedMessage | null {
  if ((input instanceof Uint8Array ? input.length : input.byteLength) === 0) return null;
  const r = new Reader(input);
  const op = r.u8();
  const event = EVENT_BY_OP[op];
  if (!event) return null;
  try {
    const data = decoders[event](r);
    return { event, data };
  } catch {
    return null;
  }
}
