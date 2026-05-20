/**
 * HydraObserver
 *
 * Slice-1 deliverable: subscribe to a HydraSidecarClient, reduce its
 * event stream to a coarse HydraStatus, and log transitions alongside
 * the in-memory Lobby's own status.
 *
 * Authority lives in Lobby for now. This is purely observational — no
 * Lobby methods are called from here. The point is to surface the
 * integration mechanics (sidecar lifecycle, WS reconnect, event
 * vocabulary mismatches) before slice 2 makes it authoritative.
 *
 * Why the indirection (observer wrapping client): when slice 2 lands,
 * the runner won't talk directly to the WS. It'll talk through this
 * observer, which will own the state-machine reduction and the
 * (eventual) call into Lobby. Keeping that seam in place now means
 * slice 2 is a code edit in one file rather than across the runner.
 */

import { HydraSidecarClient } from './HydraSidecarClient';
import type { HydraStatus, HydraServerOutput } from './types';

export interface HydraObserverOptions {
  lobbyId: string;
  /** ws://hydra-<lobbyId>:4001/?history=no */
  sidecarUrl: string;
}

export class HydraObserver {
  private client: HydraSidecarClient;
  private _status: HydraStatus = 'connecting';
  private connected = false;

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
      this.connected = true;
      this.log('connected to sidecar');
    } catch (err) {
      this.setStatus('error');
      this.log(`sidecar unreachable (continuing in non-authoritative mode): ${(err as Error).message}`);
    }
  }

  /**
   * Stop observation and close the sidecar WS cleanly.
   * Decision (ii): runner owns sidecar lifecycle. In slice 2 this
   * will also send a `Close` command and wait for HeadIsFinalized
   * before resolving.
   */
  async stop(): Promise<void> {
    this.log('stopping observer');
    await this.client.close();
  }

  // ── event reduction ────────────────────────────────────────────

  private handleOutput(event: HydraServerOutput): void {
    // Always log the raw tag for slice-1 visibility. Once the
    // vocabulary is well-understood we can dial this down.
    this.log(`recv: ${event.tag}${event.headStatus ? ` (headStatus=${event.headStatus})` : ''}`);

    switch (event.tag) {
      case 'Greetings':
        // hydra-node's first message after WS open. `headStatus`
        // field tells us where the head currently is — in slice 1
        // (no Init has been sent), this should be 'Idle'.
        this.setStatus(mapHeadStatus(event.headStatus, 'idle'));
        return;
      case 'HeadIsInitializing': this.setStatus('initializing'); return;
      case 'Committed':          /* stays in initializing */     return;
      case 'HeadIsOpen':         this.setStatus('open');         return;
      case 'HeadIsClosed':       this.setStatus('closed');       return;
      case 'ReadyToFanout':      /* stays in closed */           return;
      case 'HeadIsFinalized':    this.setStatus('finalized');    return;
      case 'HeadIsAborted':      this.setStatus('aborted');      return;
      case 'CommandFailed':
      case 'PostTxOnChainFailed':
        // Don't change state; failed commands don't move the head.
        // Surface as a warning so failures during slice 2's tx-submit
        // path are loud enough to notice.
        this.log(`WARN: ${event.tag}: ${JSON.stringify(event)}`);
        return;
      default:
        // Unrecognized — common in normal operation (PeerConnected,
        // SnapshotConfirmed, TxValid, etc.). Already logged at
        // the top of this method; nothing else to do.
        return;
    }
  }

  private handleError(err: Error): void {
    this.log(`ERR: ${err.message}`);
    if (!this.connected) return; // startup errors handled by start()
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