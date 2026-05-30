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

import { HydraSidecarClient, type StatusHandler } from './HydraSidecarClient';
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
  /** Ensures the Head is seeded at most once per lobby, even if both the
   *  auto-fill and explicit request-start paths reach the edge. */
  private headSeeded = false;
  private nodeSynced = false;
  private pendingRoster: string[] | null = null;
  private statusHandlers: StatusHandler[] = [];
  /** Guard so Close only fires once even if closeHead() is called twice. */
  private closeRequested = false;
  /** Guard so the initial Commit only fires once on HeadIsInitializing. */
  private committed = false;

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


  /**
   * Seed the Head with the player-derived participant set when the lobby
   * fills. This is the keys→roster→Head step.
   *
   * Offline/slice-1 reality: the participant set of an offline head is
   * fixed by the node's own flags (--offline-head-seed + the single
   * --hydra-signing-key), and `Init` is fundamentally an L1 action. So
   * the collected vks cannot yet *become* the on-chain participants of
   * this offline sidecar — that needs online mode and one node per key
   * (the deferred Option-A topology). What this method does today:
   *
   *   1. Log the assembled roster of player vks (the real deliverable —
   *      it proves keys flowed browser → upgrade URL → runner → here).
   *   2. Best-effort send `{ tag: 'Init' }` so the lifecycle wiring
   *      (send → HydraObserver reduction) is exercised end to end. In
   *      offline mode this may be a no-op or surface CommandFailed;
   *      either is logged and NON-fatal, consistent with slice-1's
   *      non-authoritative stance. No gameplay depends on the result.
   *
   * Slice-2 swap point: when per-player online nodes land, this method's
   * body becomes "configure peers from `roster`, then Init", and the
   * roster stops being merely logged.
   */
  initHead(roster: string[]): void {
    if (this.headSeeded) return;
    this.headSeeded = true;
    const present = roster.filter((vk) => vk.length > 0).length;
    this.log(
      `lobby full — seeding Head with ${present}/${roster.length} player vk(s)`,
    );
    roster.forEach((vk, slot) => {
      this.log(`  slot ${slot}: ${vk ? summariseVk(vk) : '<no vk presented>'}`);
    });

    if (!this.connected) {
      this.log('sidecar not connected; skipping Init (non-authoritative)');
      return;
    }
    if (!this.nodeSynced) {
    this.log('node not yet synced — queuing Init until NodeSynced fires');
    this.pendingRoster = roster;
    return;
  }
  this.fireInit(roster);
}

private fireInit(_roster: string[]): void {
  try {
    this.client.send({ tag: 'Init' });
    this.log('sent Init to sidecar');
  } catch (err) {
    this.log(`Init send failed (non-fatal): ${(err as Error).message}`);
  }
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
  

  /** POST an empty UTxO to the sidecar's /commit endpoint so the
 *  Initializing → Open transition can complete. Single-participant
 *  referee head: the sidecar owns the cardano-signing-key, so it
 *  builds, signs, and submits the commit tx on its own. */
private async sendInitialCommit(): Promise<void> {
  if (this.committed) return;
  this.committed = true;

  // Convert ws://hydra-<id>:4001/?history=no → http://hydra-<id>:4001/commit
  const httpBase = this.opts.sidecarUrl
    .replace(/^ws:/, 'http:')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '');
  const url = `${httpBase}/commit`;

  this.log(`POST ${url} (empty commit)`);
  try {
    // Node 18+ has global fetch. If you're on 16, swap to node-fetch
    // or the built-in `http` module.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const bodyText = await res.text();
    if (!res.ok) {
      this.log(`commit HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      return;
    }
    this.log(`commit accepted (${bodyText.length} bytes returned)`);
    // hydra-node 1.x: an empty commit returns a balanced+signed tx
    // that the node itself submits — there's nothing to do with the
    // response body. Watch for the `Committed` then `HeadIsOpen`
    // events on the WS stream.
  } catch (err) {
    this.log(`commit POST failed: ${(err as Error).message}`);
  }
}

  /**
 * Drive the Head to a terminal state and resolve when it gets there.
 *
 * Sequence:
 *   send Close  →  HeadIsClosed  →  (contestation deadline)
 *               →  ReadyToFanout →  send Fanout  →  HeadIsFinalized
 *
 * The Fanout send is wired into handleOutput, so this method only
 * needs to fire Close and wait for the terminal status.
 *
 * Tolerates being called from non-open states (logs and returns).
 */
async closeHead(): Promise<void> {
  if (this.closeRequested) return;
  this.closeRequested = true;

  if (!this.connected) {
    this.log('sidecar not connected; skipping closeHead');
    return;
  }
  if (this._status === 'finalized' || this._status === 'aborted') {
    this.log(`closeHead: already ${this._status}, nothing to do`);
    return;
  }
  if (this._status === 'idle' || this._status === 'connecting') {
    this.log(`closeHead: head never opened (status=${this._status}), skipping`);
    return;
  }

  this.log(`closeHead: starting close from status=${this._status}`);

  const terminal = new Promise<void>((resolve) => {
    const unsub = this.onStatusChange((next) => {
      if (next === 'finalized' || next === 'aborted' || next === 'error') {
        unsub();
        resolve();
      }
    });
  });

  try {
    this.client.send({ tag: 'Close' });
    this.log('sent Close to sidecar');
  } catch (err) {
    this.log(`Close send failed: ${(err as Error).message}`);
    return;
  }

  await terminal;
  this.log(`closeHead: done, final status=${this._status}`);
}

  /** Subscribe to status transitions. Returns an unsubscribe fn. */
  private onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      const i = this.statusHandlers.indexOf(handler);
      if (i >= 0) this.statusHandlers.splice(i, 1);
    };
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
      //case 'HeadIsInitializing': this.setStatus('initializing'); return;
      case 'Committed':          /* stays in initializing */     return;
      case 'HeadIsOpen':         this.setStatus('open');         return;
      case 'HeadIsClosed':       this.setStatus('closed');       return;
      case 'ReadyToFanout':
        // Contestation period has elapsed. Spend the closed UTxO so funds
        // (or empty L2 state, in our case) are made canonical on L1.
        try {
          this.client.send({ tag: 'Fanout' });
          this.log('sent Fanout to sidecar');
        } catch (err) {
          this.log(`Fanout send failed: ${(err as Error).message}`);
        }
        return;
      case 'HeadIsFinalized':    this.setStatus('finalized');    return;
      case 'HeadIsAborted':      this.setStatus('aborted');      return;
      case 'CommandFailed':
      case 'HeadIsInitializing':
        this.setStatus('initializing');
        // Don't await — keep the event loop free. Errors are logged inside.
        void this.sendInitialCommit();
        return;
      case 'PostTxOnChainFailed':
        // Don't change state; failed commands don't move the head.
        // Surface as a warning so failures during slice 2's tx-submit
        // path are loud enough to notice.
        this.log(`WARN: ${event.tag}: ${JSON.stringify(event)}`);
        return;
      case 'NodeSynced':
        if (!this.nodeSynced) {
          this.nodeSynced = true;
          this.log('node reached chain sync');
          // If initHead was called early, fire the Init now.
          if (this.pendingRoster) {
            const roster = this.pendingRoster;
            this.pendingRoster = null;
            this.fireInit(roster);
          }
        }
        return;
      case 'RejectedInputBecauseUnsynced': {
        const drift = (event as { drift?: number }).drift;
        const which = ((event as { clientInput?: { tag?: string } }).clientInput?.tag) ?? 'unknown';
        this.log(`WARN: ${which} rejected — node out of sync (drift=${drift}s)`);
        return;
      }
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
    for (const h of this.statusHandlers) {
      try { h(next, prev); }
      catch (err) { this.log(`status handler threw: ${(err as Error).message}`); }
    }
  }

  private log(msg: string): void {
    console.log(`[hydra:${shortId(this.opts.lobbyId)}] ${msg}`);
  }
}

function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

/** Pull a short, log-friendly fingerprint out of a vk envelope without
 *  dumping the whole JSON. Falls back to a length note if the shape is
 *  unexpected — we never throw from a logging helper. */
function summariseVk(vkEnvelope: string): string {
  try {
    const parsed = JSON.parse(vkEnvelope) as { cborHex?: string };
    const hex = parsed.cborHex ?? '';
    // Strip the 5820 CBOR prefix if present; show first/last 6 hex chars.
    const body = hex.startsWith('5820') ? hex.slice(4) : hex;
    if (body.length >= 12) return `${body.slice(0, 6)}…${body.slice(-6)}`;
    return body || '<empty cborHex>';
  } catch {
    return `<unparseable vk, ${vkEnvelope.length} chars>`;
  }
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