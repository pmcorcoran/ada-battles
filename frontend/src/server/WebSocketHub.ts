/**
 * WebSocketHub
 *
 * Thin typed wrapper around the `ws` library that mirrors just enough of the
 * socket.io API to let `app.ts`, `Lobby.ts`, and `LobbyManager.ts` treat the
 * transport as: per-connection sockets with `.id`, `.on`, `.emit`, `.join`,
 * `.leave`, plus a room-broadcast helper `hub.to(room).emit(event, data)`.
 *
 * Wire format is the binary codec defined in `src/shared/wire.ts`: a 1-byte
 * opcode followed by a packed payload, sent as a WebSocket binary frame.
 */

import { randomUUID } from 'crypto';
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { encode as wireEncode, decode as wireDecode } from '../shared/wire';

type SingleArg<F> = F extends (arg: infer A) => any ? A : never;
type Fn<F> = F extends (...args: any[]) => any ? F : never;

type ConnectionListener<C2S, S2C> = (socket: HubSocket<C2S, S2C>) => void;

export class WebSocketHub<C2S, S2C> {
  private readonly wss: WebSocketServer;
  private readonly sockets = new Map<string, HubSocket<C2S, S2C>>();
  private readonly rooms   = new Map<string, Set<string>>();
  private connectionListener: ConnectionListener<C2S, S2C> | null = null;

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  /** Mirrors `io.on('connection', …)`. Only one listener is supported. */
  on(event: 'connection', listener: ConnectionListener<C2S, S2C>): void {
    if (event !== 'connection') return;
    this.connectionListener = listener;
  }

  /** Broadcast helper: `hub.to(room).emit(event, data)` — inclusive of sender. */
  to(room: string) {
    return {
      emit: <K extends keyof S2C & string>(event: K, data: SingleArg<S2C[K]>): void => {
        const ids = this.rooms.get(room);
        if (!ids || ids.size === 0) return;
        const payload = wireEncode(event, data);
        for (const id of ids) {
          this.sockets.get(id)?.sendRaw(payload);
        }
      },
    };
  }

  //  Internal API used by HubSocket 

  _join(room: string, id: string): void {
    let set = this.rooms.get(room);
    if (!set) {
      set = new Set();
      this.rooms.set(room, set);
    }
    set.add(id);
  }

  _leave(room: string, id: string): void {
    const set = this.rooms.get(room);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.rooms.delete(room);
  }

  //  Connection handling 

  private handleConnection(ws: WebSocket): void {
    const id = randomUUID();
    const socket = new HubSocket<C2S, S2C>(id, ws, this);
    this.sockets.set(id, socket);

    ws.on('message', (raw) => {
      // `ws` delivers Buffer for binary frames; normalise to Uint8Array for the codec.
      const bytes = Buffer.isBuffer(raw)
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : Array.isArray(raw)
            ? new Uint8Array(Buffer.concat(raw))
            : null;
      if (!bytes) return;
      const msg = wireDecode(bytes);
      if (!msg) return;
      socket.dispatch(msg.event, msg.data);
    });

    ws.on('close', () => {
      for (const set of this.rooms.values()) set.delete(id);
      this.sockets.delete(id);
      socket.dispatch('disconnect', undefined);
    });

    ws.on('error', () => {
      try { ws.close(); } catch { /* already closed */ }
    });

    this.connectionListener?.(socket);
  }
}

export class HubSocket<C2S, S2C> {
  private readonly listeners = new Map<string, Array<(data: any) => void>>();

  constructor(
    public readonly id: string,
    private readonly ws: WebSocket,
    private readonly hub: WebSocketHub<C2S, S2C>,
  ) {}

  on<K extends keyof C2S & string>(event: K, handler: Fn<C2S[K]>): void;
  on(event: 'disconnect', handler: () => void): void;
  on(event: string, handler: (data: any) => void): void {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(handler);
  }

  emit<K extends keyof S2C & string>(event: K, data: SingleArg<S2C[K]>): void {
    this.sendRaw(wireEncode(event, data));
  }

  join(room: string): void  { this.hub._join(room, this.id); }
  leave(room: string): void { this.hub._leave(room, this.id); }

  disconnect(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }

  sendRaw(payload: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(payload);
  }

  dispatch(event: string, data: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const h of arr) h(data);
  }
}
