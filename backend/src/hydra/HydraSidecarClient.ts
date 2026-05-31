/**
 * HydraSidecarClient
 *
 * Thin WebSocket client to a per-runner hydra-node sidecar. Talks to
 * the sidecar's API at ws://hydra-<lobbyId>:4001/?history=no, where
 * the sidecar exposes its server-output stream and accepts client
 * commands.
 *
 * Scope (slice 1): emit server outputs to a single subscriber, accept
 * client commands. No reconnect after the initial connect succeeds —
 * if the WS drops mid-session, callers see an 'error' state and act
 * on it (in slice 1 this just logs; later it should trigger a Head
 * close).
 *
 * Startup-time reconnect IS implemented because Docker's `start()`
 * returns before the process inside the container is necessarily
 * listening on the API port. Up to STARTUP_RETRIES with backoff.
 *
 * Lifecycle: construct → connect() → on('output', …) → close().
 * Decision (ii) from HANDOFF: this client is owned by the runner;
 * the runner closes it before exiting.
 */

import WebSocket from 'ws';
import type { HydraServerOutput, HydraClientCommand, HydraStatus} from './types';

export type StatusHandler = (next: HydraStatus, prev: HydraStatus) => void;

const STARTUP_RETRIES = 15;     // 12 × 1s ≈ 12s, comfortable for cold start
const STARTUP_RETRY_DELAY_MS = 12_000;
const CLOSE_TIMEOUT_MS = 5_000;

type OutputHandler = (event: HydraServerOutput) => void;
type ErrorHandler  = (err: Error) => void;
type CloseHandler  = () => void;

export interface HydraSidecarClientOptions {
  /** Full WS URL, e.g. ws://hydra-<id>:4001/?history=no */
  url: string;
  /** Tag for log lines so multi-runner logs stay legible. */
  label?: string;
}

export class HydraSidecarClient {
  private ws: WebSocket | null = null;
  private outputHandler: OutputHandler | null = null;
  private errorHandler:  ErrorHandler  | null = null;
  private closeHandler:  CloseHandler  | null = null;
  private closed = false;

  constructor(private readonly opts: HydraSidecarClientOptions) {}

  /**
   * Resolves once the WS is open and the sidecar has answered with
   * at least one frame (typically the `Greetings` server output).
   * Rejects after STARTUP_RETRIES if the sidecar never came up.
   */
  async connect(): Promise<void> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= STARTUP_RETRIES; attempt++) {
      if (this.closed) throw new Error('closed before connect succeeded');
      try {
        await this.tryConnect();
        return;
      } catch (err) {
        lastErr = err as Error;
        this.log(`connect attempt ${attempt}/${STARTUP_RETRIES} failed: ${lastErr.message}`);
        if (attempt < STARTUP_RETRIES) await sleep(STARTUP_RETRY_DELAY_MS);
      }
    }
    throw new Error(`hydra sidecar unreachable after ${STARTUP_RETRIES} attempts: ${lastErr?.message}`);
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      ws.once('open', () => {
        // Don't resolve on open alone — the sidecar may close
        // immediately if e.g. a flag is wrong. Wait for the first
        // server output (Greetings) to confirm it's actually alive.
      });

      ws.once('message', (data) => {
        this.ws = ws;
        // Deliver this first message AND wire up handlers for subsequent.
        this.dispatchMessage(data);
        ws.on('message', (d) => this.dispatchMessage(d));
        ws.on('close',   () => this.handleClose());
        ws.on('error',   (e) => this.handleRuntimeError(e));
        settle(resolve);
      });

      ws.once('error', (err) => {
        settle(() => reject(err as Error));
        try { ws.close(); } catch { /* already closed */ }
      });

      ws.once('close', () => {
        settle(() => reject(new Error('WS closed during connect')));
      });
    });
  }

  /** Register the single output handler. Calling twice replaces. */
  on(event: 'output', handler: OutputHandler): void;
  on(event: 'error',  handler: ErrorHandler):  void;
  on(event: 'close',  handler: CloseHandler):  void;
  on(event: 'output' | 'error' | 'close', handler: any): void {
    if (event === 'output') this.outputHandler = handler;
    else if (event === 'error') this.errorHandler = handler;
    else this.closeHandler = handler;
  }

  /** Send a client command (Init/Close/Abort/Fanout/…). Slice 1
   *  doesn't use this; reserved for slice 2. */
  send(cmd: HydraClientCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('hydra sidecar not connected');
    }
    this.ws.send(JSON.stringify(cmd));
  }

  /** Best-effort clean close. Resolves when the socket has closed
   *  or after CLOSE_TIMEOUT_MS, whichever comes first. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log('close timeout, terminating socket');
        try { ws.terminate(); } catch { /* */ }
        resolve();
      }, CLOSE_TIMEOUT_MS);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try { ws.close(); } catch { resolve(); }
    });
  }

  // ── internals ──────────────────────────────────────────────────

  private dispatchMessage(data: WebSocket.RawData): void {
    let event: HydraServerOutput;
    try {
      // hydra-node always sends JSON text; binary is not used on
      // the server output stream.
      event = JSON.parse(data.toString()) as HydraServerOutput;
    } catch (err) {
      this.log(`malformed frame: ${(err as Error).message}`);
      return;
    }
    if (typeof event.tag !== 'string') {
      this.log('frame missing "tag" field, ignoring');
      return;
    }
    this.outputHandler?.(event);
  }

  private handleClose(): void {
    if (this.closed) return; // expected
    this.closed = true;
    this.log('WS closed unexpectedly');
    this.closeHandler?.();
  }

  private handleRuntimeError(err: Error): void {
    if (this.closed) return;
    this.log(`WS error: ${err.message}`);
    this.errorHandler?.(err);
  }

  private log(msg: string): void {
    const tag = this.opts.label ?? 'hydra';
    console.log(`[${tag}] ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}