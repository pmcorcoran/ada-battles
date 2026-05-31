/**
 * HydraHeadController
 *
 * The WRITE side of the sidecar integration, split out of HydraObserver.
 * Where the observer only reduces the event stream to a status, this
 * class owns every command that drives the Head through its lifecycle:
 *
 *   - initHead()          send `Init` once the lobby fills (keys→roster→Head)
 *   - sendInitialCommit() POST an empty commit so Initializing → Open completes
 *   - (Fanout)            spend the closed UTxO once contestation elapses
 *   - closeHead()         drive Close → Fanout → Finalized on shutdown
 *
 * It holds no socket of its own. It reads status from the observer
 * (`observer.status`, `observer.connected`, `observer.onStatusChange`),
 * reacts to protocol milestones via `observer.onProtocolEvent`, and
 * issues commands through the observer's single `send()` seam. All the
 * write-side bookkeeping (headSeeded / committed / closeRequested /
 * nodeSynced / pendingRoster) lives here, not in the reducer.
 *
 * Slice-1 stance is unchanged: sends are best-effort and non-fatal. The
 * value today is exercising the lifecycle wiring end to end; no gameplay
 * depends on the result. The methods flagged below as "slice-2 swap
 * points" are exactly the ones that grow when authority moves on-chain —
 * having them isolated here is the point of the split.
 */

import type { HydraObserver } from './HydraObserver';
import type { HydraServerOutput } from './types';

export interface HydraHeadControllerOptions {
  lobbyId: string;
  /** ws://hydra-<lobbyId>:4001/?history=no — used to derive the /commit URL. */
  sidecarUrl: string;
}

export class HydraHeadController {
  /** Ensures the Head is seeded at most once per lobby, even if both the
   *  auto-fill and explicit request-start paths reach the edge. */
  private headSeeded = false;
  /** Guard so the initial Commit only fires once on HeadIsInitializing. */
  private committed = false;
  /** Guard so Close only fires once even if closeHead() is called twice. */
  private closeRequested = false;
  private nodeSynced = false;
  private pendingRoster: string[] | null = null;

  constructor(
    private readonly observer: HydraObserver,
    private readonly opts: HydraHeadControllerOptions,
  ) {
    // React to the milestones that used to trigger sends from inside the
    // observer's switch. The observer fires these after applying its own
    // status reduction, so `observer.status` is current here.
    this.observer.onProtocolEvent((e) => this.onProtocolEvent(e));
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
    this.log(`lobby full — seeding Head with ${present}/${roster.length} player vk(s)`);
    roster.forEach((vk, slot) => {
      this.log(`  slot ${slot}: ${vk ? summariseVk(vk) : '<no vk presented>'}`);
    });

    if (!this.observer.connected) {
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

  /**
   * Drive the Head to a terminal state and resolve when it gets there.
   *
   * Sequence:
   *   send Close  →  HeadIsClosed  →  (contestation deadline)
   *               →  ReadyToFanout →  (Fanout, fired reactively below)
   *               →  HeadIsFinalized
   *
   * The Fanout send is handled by onProtocolEvent(), so this method only
   * needs to fire Close and wait for the terminal status.
   *
   * Tolerates being called from non-open states (logs and returns).
   *
   * Slice-2 note: this already matches the intended shutdown shape; what
   * changes later is that the L2 state being fanned out is real game
   * state rather than the empty offline UTxO.
   */
  async closeHead(): Promise<void> {
    if (this.closeRequested) return;
    this.closeRequested = true;

    if (!this.observer.connected) {
      this.log('sidecar not connected; skipping closeHead');
      return;
    }
    const status = this.observer.status;
    if (status === 'finalized' || status === 'aborted') {
      this.log(`closeHead: already ${status}, nothing to do`);
      return;
    }
    if (status === 'idle' || status === 'connecting') {
      this.log(`closeHead: head never opened (status=${status}), skipping`);
      return;
    }

    this.log(`closeHead: starting close from status=${status}`);

    const terminal = new Promise<void>((resolve) => {
      const unsub = this.observer.onStatusChange((next) => {
        if (next === 'finalized' || next === 'aborted' || next === 'error') {
          unsub();
          resolve();
        }
      });
    });

    try {
      this.observer.send({ tag: 'Close' });
      this.log('sent Close to sidecar');
    } catch (err) {
      this.log(`Close send failed: ${(err as Error).message}`);
      return;
    }

    await terminal;
    this.log(`closeHead: done, final status=${this.observer.status}`);
  }

  // ── reactive command sends ──────────────────────────────────────
  //
  // These mirror the cases that previously sent commands from inside
  // HydraObserver.handleOutput. They now run here, off the observer's
  // protocol-event stream, so the reducer stays send-free.

  private onProtocolEvent(event: HydraServerOutput): void {
    switch (event.tag) {
      case 'HeadIsInitializing':
      case 'CommandFailed':
        // Don't await — keep the event loop free. Errors are logged inside.
        void this.sendInitialCommit();
        return;

      case 'NodeSynced':
        if (!this.nodeSynced) {
          this.nodeSynced = true;
          this.log('node reached chain sync');
          // If initHead was called early, fire the queued Init now.
          if (this.pendingRoster) {
            const roster = this.pendingRoster;
            this.pendingRoster = null;
            this.fireInit(roster);
          }
        }
        return;

      case 'ReadyToFanout':
        this.fireFanout();
        return;

      default:
        return;
    }
  }

  private fireInit(_roster: string[]): void {
    try {
      this.observer.send({ tag: 'Init' });
      this.log('sent Init to sidecar');
    } catch (err) {
      this.log(`Init send failed (non-fatal): ${(err as Error).message}`);
    }
  }

  private fireFanout(): void {
    try {
      this.observer.send({ tag: 'Fanout' });
      this.log('sent Fanout to sidecar');
    } catch (err) {
      this.log(`Fanout send failed: ${(err as Error).message}`);
    }
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