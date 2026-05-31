/**
 * HydraObserver
 *
 * Slice-1 deliverable: subscribe to a HydraSidecarClient, reduce its
 * event stream to a coarse HydraStatus, and log transitions alongside
 * the in-memory Lobby's own status.
 *
 * This file is the READ side of the sidecar integration. After the
 * observer/controller split it does exactly two things and nothing else:
 *
 *   1. Own the sidecar WS connection lifecycle (start / stop).
 *   2. Reduce the server-output stream to a HydraStatus and notify
 *      subscribers of (a) status transitions and (b) the raw protocol
 *      events themselves.
 *
 * It performs NO sends of its own. Everything that drives the Head
 * (Init, the initial Commit, Fanout, Close) now lives in
 * HydraHeadController, which subscribes here and issues those commands
 * through the single `send()` seam below. Keeping reduction and command
 * policy apart is what lets slice 2 grow the driving logic without
 * touching the reducer — and it makes the "purely observational" claim
 * in the old header actually true again.
 *
 * Authority still lives in Lobby for slice 1; nothing here calls into
 * Lobby. The point remains to surface the integration mechanics (sidecar
 * lifecycle, WS reconnect, event-vocabulary mismatches) before slice 2
 * makes the Head authoritative.
 */

import { HydraSidecarClient, type StatusHandler } from './HydraSidecarClient';
import type { HydraStatus, HydraServerOutput, HydraClientCommand } from './types';

/** Notified for every server output, after the status reduction for that
 *  event has been applied. The HydraHeadController uses this to decide
 *  when to send commands (e.g. Fanout on ReadyToFanout). */
export type ProtocolEventHandler = (event: HydraServerOutput) => void;

export interface HydraObserverOptions {
  lobbyId: string;
  /** ws://hydra-<lobbyId>:4001/?history=no */
  sidecarUrl: string;
}

export class HydraObserver {
  private client: HydraSidecarClient;
  private _status: HydraStatus = 'connecting';
  private _connected = false;
  private statusHandlers: StatusHandler[] = [];
  private protocolHandlers: ProtocolEventHandler[] = [];

  constructor(private readonly opts: HydraObserverOptions) {
    this.client = new HydraSidecarClient({
      url:   opts.sidecarUrl,
      label: `hydra:${shortId(opts.lobbyId)}`,
    });
    this.client.on('output', (e) => this.handleOutput(e));
    this.client.on('error',  (e) => this.handleError(e));
    this.client.on('close',  ()  => this.handleClose());
  }

  get status(): HydraStatus {
    return this._status;
  }

  /** True once the initial connect() has succeeded. The controller reads
   *  this before attempting any send. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Bring up the sidecar connection. Returns on the first frame
   * received (typically Greetings). In slice 1 a failure here is
   * logged but NOT fatal — the runner continues without Hydra
   * observation, since in-memory Lobby is still the authority. In
   * slice 2 this will become fatal.
   */
  async start(): Promise<void> {
    this.log(`connecting to sidecar at ${this.opts.sidecarUrl}`);
    try {
      await this.client.connect();
      this._connected = true;
      this.log('connected to sidecar');
    } catch (err) {
      this.setStatus('error');
      this.log(`sidecar unreachable (continuing in non-authoritative mode): ${(err as Error).message}`);
    }
  }

  /**
   * Stop observation and close the sidecar WS cleanly.
   * Decision (ii): runner owns sidecar lifecycle. The Head is driven to a
   * terminal state by HydraHeadController.closeHead() BEFORE this is
   * called — see runner shutdown ordering.
   */
  async stop(): Promise<void> {
    this.log('stopping observer');
    await this.client.close();
  }

  /**
   * The single write path into the sidecar WS. The observer owns the
   * socket but performs no sends of its own; HydraHeadController calls
   * this to issue Init / Fanout / Close. May throw — callers wrap.
   */
  send(cmd: HydraClientCommand): void {
    this.client.send(cmd);
  }

  /**
   * Resolve when the Head reaches Open. Resolves immediately if already open;
   * rejects if the Head hits a terminal/failed state first, or after
   * `timeoutMs`. Safe to call more than once. The runner awaits this before
   * starting the countdown so the game only begins once the Head is open.
   */
  waitUntilOpen(timeoutMs = 180_000): Promise<void> {
    if (this._status === 'open') return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let unsub = () => {};
      let timer: NodeJS.Timeout;
      const done = () => { clearTimeout(timer); unsub(); };

      unsub = this.onStatusChange((next) => {
        if (next === 'open') {
          done();
          resolve();
        } else if (next === 'closed' || next === 'finalized' || next === 'aborted' || next === 'error') {
          done();
          reject(new Error(`Head reached ${next} before opening`));
        }
      });

      timer = setTimeout(() => {
        done();
        reject(new Error(`Head did not open within ${timeoutMs}ms (status=${this._status})`));
      }, timeoutMs);
    });
  }

  /** Subscribe to status transitions. Returns an unsubscribe fn. */
  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      const i = this.statusHandlers.indexOf(handler);
      if (i >= 0) this.statusHandlers.splice(i, 1);
    };
  }

  /** Subscribe to raw protocol events (fired after the status reduction
   *  for that event). Returns an unsubscribe fn. This is how the
   *  HydraHeadController hears about milestones like HeadIsInitializing,
   *  NodeSynced, and ReadyToFanout so it can drive the Head. */
  onProtocolEvent(handler: ProtocolEventHandler): () => void {
    this.protocolHandlers.push(handler);
    return () => {
      const i = this.protocolHandlers.indexOf(handler);
      if (i >= 0) this.protocolHandlers.splice(i, 1);
    };
  }

  // ── event reduction ────────────────────────────────────────────

  private handleOutput(event: HydraServerOutput): void {
    // Always log the raw tag for slice-1 visibility. Once the
    // vocabulary is well-understood we can dial this down.
    this.log(`recv: ${event.tag}${event.headStatus ? ` (headStatus=${event.headStatus})` : ''}`);

    // 1. Reduce to status (side-effect free apart from WARN logging).
    const next = this.reduce(event);
    if (next) this.setStatus(next);

    // 2. Notify the controller AFTER status has settled, so any command
    //    it issues sees an up-to-date `observer.status`.
    this.emitProtocol(event);
  }

  /**
   * Pure-ish reduction: map a server output to the next HydraStatus, or
   * null for "no status change". The only side effects are WARN logs for
   * events we want to surface loudly. Crucially, this sends nothing — the
   * Init/Commit/Fanout that used to live in these cases now belong to
   * HydraHeadController, triggered via onProtocolEvent.
   */
  private reduce(event: HydraServerOutput): HydraStatus | null {
    switch (event.tag) {
      case 'Greetings':
        // hydra-node's first message after WS open. `headStatus`
        // field tells us where the head currently is — in slice 1
        // (no Init has been sent), this should be 'Idle'.
        return mapHeadStatus(event.headStatus, 'idle');

      case 'Committed':          return null;  // stays in initializing
      case 'HeadIsOpen':         return 'open';
      case 'HeadIsClosed':       return 'closed';

      case 'ReadyToFanout':
        // Contestation period has elapsed. The controller spends the
        // closed UTxO (Fanout) on hearing this event — no status change.
        return null;

      case 'HeadIsFinalized':    return 'finalized';
      case 'HeadIsAborted':      return 'aborted';

      case 'CommandFailed':
      case 'HeadIsInitializing':
        // The controller sends the initial Commit on these events so the
        // Initializing → Open transition can complete.
        return 'initializing';

      case 'PostTxOnChainFailed':
        // Don't change state; failed commands don't move the head.
        // Surface as a warning so failures during slice 2's tx-submit
        // path are loud enough to notice.
        this.log(`WARN: ${event.tag}: ${JSON.stringify(event)}`);
        return null;

      case 'NodeSynced':
        // No status change; the controller tracks sync state because it
        // gates Init (a write concern).
        return null;

      case 'RejectedInputBecauseUnsynced': {
        const drift = (event as { drift?: number }).drift;
        const which = ((event as { clientInput?: { tag?: string } }).clientInput?.tag) ?? 'unknown';
        this.log(`WARN: ${which} rejected — node out of sync (drift=${drift}s)`);
        return null;
      }

      default:
        // Unrecognized — common in normal operation (PeerConnected,
        // SnapshotConfirmed, TxValid, etc.). Already logged at the top
        // of handleOutput; nothing else to do.
        return null;
    }
  }

  private handleError(err: Error): void {
    this.log(`ERR: ${err.message}`);
    if (!this._connected) return; // startup errors handled by start()
    this.setStatus('error');
  }

  private handleClose(): void {
    if (this._status === 'finalized' || this._status === 'aborted') {
      // Expected — head closed cleanly.
      return;
    }
    this.log('sidecar WS closed unexpectedly');
    this.setStatus('error');
  }

  private setStatus(next: HydraStatus): void {
    if (next === this._status) return;
    const prev = this._status;
    this._status = next;
    this.log(`status: ${prev} → ${next}`);
    for (const h of this.statusHandlers) {
      try { h(next, prev); }
      catch (err) { this.log(`status handler threw: ${(err as Error).message}`); }
    }
  }

  private emitProtocol(event: HydraServerOutput): void {
    for (const h of this.protocolHandlers) {
      try { h(event); }
      catch (err) { this.log(`protocol handler threw: ${(err as Error).message}`); }
    }
  }

  private log(msg: string): void {
    console.log(`[hydra:${shortId(this.opts.lobbyId)}] ${msg}`);
  }
}

function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

function mapHeadStatus(raw: string | undefined, fallback: HydraStatus): HydraStatus {
  // hydra-node's `headStatus` in Greetings is one of: Idle,
  // Initializing, Open, Closed, FanoutPossible, Final.
  switch (raw) {
    case 'Idle':           return 'idle';
    case 'Initializing':   return 'initializing';
    case 'Open':           return 'open';
    case 'Closed':
    case 'FanoutPossible': return 'closed';
    case 'Final':          return 'finalized';
    default:               return fallback;
  }
}