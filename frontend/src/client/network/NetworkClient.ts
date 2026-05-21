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
} from '../../../../shared/types';
import { encode as wireEncode, decode as wireDecode } from '../../../../shared/wire';
import type { WalletSession } from '../wallet/walletAuth';
import { signChallenge } from '../wallet/walletAuth';

type SingleArg<F> = F extends (arg: infer A) => any ? A : never;
type Fn<F> = F extends (...args: any[]) => any ? F : never;


/** Where the matchmaker API lives. Defaults to same-origin (the
 *  matchmaker also serves the client bundle). For split deployments
 *  set `window.MATCHMAKER_URL` in index.html before bundle.js loads. */
const MATCHMAKER_URL =
  (window as unknown as { MATCHMAKER_URL?: string }).MATCHMAKER_URL ??
  location.origin;


export class NetworkClient {
  private readonly ws: WebSocket;
  private readonly listeners = new Map<string, Array<(data: any) => void>>();
  private readonly outbox: Uint8Array[] = [];
  private open = false;

  /** Populated once the server assigns our lobby slot (u8, 0..6). -1 = unknown. */
  localSlot = -1;

  /** The lobby room we've been assigned to. */
  lobbyId = '';


  static async match(maxPlayers: number, wallet: WalletSession): Promise<NetworkClient> {
    const res = await fetch(`${MATCHMAKER_URL}/api/lobbies/match`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ maxPlayers }),
    });

    if (!res.ok) throw new Error(`matchmaker rejected: ${res.status}`);
    const { lobbyId, wsUrl, challenge } = await res.json() as {
      lobbyId:   string;
      wsUrl:     string;
      challenge: string;
    };

    const signature = await signChallenge(wallet, challenge);

    const params = new URLSearchParams({
      address:   wallet.addressHex,
      challenge,
      sig:       JSON.stringify(signature),
    });
    const authedUrl = `${wsUrl}?${params.toString()}`;

    const net = new NetworkClient(authedUrl);
    net.lobbyId = lobbyId;
    return net;
  }


  static async spectate(lobbyId: string, wallet: WalletSession,): Promise<NetworkClient> {
  // Spectators sign too — they're consuming runner CPU. If you want
  // anonymous spectate, add a `?spectate=true` branch in the runner
  // that skips the signature check and grants read-only access.
  const res = await fetch(`${MATCHMAKER_URL}/api/lobbies/${encodeURIComponent(lobbyId)}`);
  if (!res.ok) throw new Error(`lobby not found: ${res.status}`);
  const { wsUrl, challenge } = await res.json() as { wsUrl: string; challenge: string };
  const signature = await signChallenge(wallet, challenge);
  const params = new URLSearchParams({
    address:   wallet.addressHex,
    challenge,
    sig:       JSON.stringify(signature),
  });
  const net = new NetworkClient(`${wsUrl}?${params.toString()}`);
  net.lobbyId = lobbyId;
  return net;
}

  /**
   * Direct constructor. Prefer `match()` or `spectate()` — those
   * resolve the URL through the matchmaker first. This is exposed
   * mainly for tests and for advanced use cases that already know
   * the runner URL.
   */
  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
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
      console.log('[net] recv', msg.event, 'handlers:', arr?.length ?? 0);  // ← add this
      if (!arr) return;
      for (const h of arr) h(msg.data);
    });
  }

  //  Outbound 

  requestStart(): void {
    this.send('request-start', undefined);
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
