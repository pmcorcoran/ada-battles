/**
 * NetworkClient
 *
 * Thin typed wrapper around the browser's native WebSocket.
 * Emits / listens using the shared event maps so callers get
 * compile-time safety on every payload shape. Wire format is the
 * binary codec defined in `src/shared/wire.ts`.
 */

import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from '../../shared/types';
import { encode as wireEncode, decode as wireDecode } from '../../shared/wire';

type SingleArg<F> = F extends (arg: infer A) => any ? A : never;
type Fn<F> = F extends (...args: any[]) => any ? F : never;

export class NetworkClient {
  private readonly ws: WebSocket;
  private readonly listeners = new Map<string, Array<(data: any) => void>>();
  private readonly outbox: Uint8Array[] = [];
  private open = false;

  /** Populated once the server assigns our lobby slot (u8, 0..6). -1 = unknown. */
  localSlot = -1;

  /** The lobby room we've been assigned to. */
  lobbyId = '';

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this.open = true;
      for (const msg of this.outbox) this.ws.send(msg.buffer as ArrayBuffer);
      this.outbox.length = 0;
    });

    this.ws.addEventListener('message', (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const msg = wireDecode(new Uint8Array(ev.data));
      if (!msg) return;
      const arr = this.listeners.get(msg.event);
      if (!arr) return;
      for (const h of arr) h(msg.data);
    });
  }

  //  Outbound 

  joinLobby(size: number): void {
    this.send('join-lobby', size);
  }

  joinSpectate(lobbyId: string): void {
    this.send('join-spectate', lobbyId);
  }

  requestStart(): void {
    this.send('request-start', undefined);
  }

  requestRestart(): void {
    this.send('request-restart', undefined);
  }

  sendInput(keys: number, rotation: number): void {
    this.send('player-input', { keys, rotation });
  }

  sendShoot(rotation: number): void {
    this.send('shoot', { rotation });
  }

  sendSelfHit(bulletId: number, health: number, isEliminated: boolean): void {
    this.send('self-hit', { bulletId, health, isEliminated });
  }

  sendBulletInactive(bulletId: number): void {
    this.send('bullet-inactive', { bulletId });
  }

  requestRevive(): void {
    this.send('request-revive', undefined);
  }

  //  Inbound 

  on<K extends keyof ServerToClientEvents>(
    event: K,
    handler: Fn<ServerToClientEvents[K]>,
  ): void {
    let arr = this.listeners.get(event as string);
    if (!arr) {
      arr = [];
      this.listeners.set(event as string, arr);
    }
    arr.push(handler as (data: any) => void);
  }

  disconnect(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }

  //  Internals 

  private send<K extends keyof ClientToServerEvents>(
    event: K,
    data: SingleArg<ClientToServerEvents[K]> | undefined,
  ): void {
    const payload = wireEncode(event as string, data);
    if (this.open) {
      this.ws.send(payload.buffer as ArrayBuffer);
    } else {
      this.outbox.push(payload);
    }
  }
}
