/**
 * HydraHeadController
 *
 * The WRITE side of the sidecar integration, split out of HydraObserver.
 * Where the observer only reduces the event stream to a status, this
 * class owns every command that drives the Head through its lifecycle:
 *
 *   - initHead()           send `Init` once the lobby fills (keys→roster→Head)
 *   - sendInitialCommits() POST a commit to EVERY party node so
 *                          Initializing → Open can complete
 *   - (Fanout)             spend the closed UTxO once contestation elapses
 *   - closeHead()          drive Close → Fanout → Finalized on shutdown
 *
 * It holds no socket of its own. It reads status from the observer
 * (`observer.status`, `observer.connected`, `observer.onStatusChange`),
 * reacts to protocol milestones via `observer.onProtocolEvent`, and
 * issues WS commands through the observer's single `send()` seam — which
 * talks to party 0 (the referee node) only. HTTP commits, by contrast,
 * must reach EVERY party: a multi-party head stays in Initializing until
 * each participant's commit lands on L1, so sendInitialCommits() fans
 * out over `partyApiUrls`.
 *
 * N+1 stance: the orchestrator now spawns one hydra-node per party
 * (party 0 = referee, parties 1..N = player slots; operator-custodial
 * hydra keys, operator-generated fuel keys). Lifecycle commands (Init /
 * Close / Fanout) still only need to be issued once, on any node — they
 * are head-level L1 actions — so driving them via the referee's WS is
 * unchanged. Commits are the one per-party obligation, hence the loop.
 *
 * Slice stance is otherwise unchanged: sends are best-effort and
 * non-fatal. The methods flagged below as "swap points" are exactly the
 * ones that grow when authority moves on-chain.
 */

import type { HydraObserver } from './HydraObserver';
import type { HydraServerOutput } from './types';

export interface HydraHeadControllerOptions {
  lobbyId: string;
  /**
   * One HTTP base URL per party node, party 0 (the referee) FIRST:
   *   ["http://hydra-<id>:4001", "http://hydra-<id>-p1:4001", ...]
   * Provided by the orchestrator via HYDRA_PARTY_API_URLS. A
   * single-element list reproduces the old single-node behaviour.
   */
  partyApiUrls: string[];
}

export class HydraHeadController {
  /** Ensures the Head is seeded at most once per lobby, even if both the
   *  auto-fill and explicit request-start paths reach the edge. */
  private headSeeded = false;
  /** Guard so the per-party Commit fan-out only fires once on
   *  HeadIsInitializing. */
  private committed = false;
  /** Guard so Close only fires once even if closeHead() is called twice. */
  private closeRequested = false;
  private nodeSynced = false;
  private pendingRoster: string[] | null = null;

  constructor(
    private readonly observer: HydraObserver,
    private readonly opts: HydraHeadControllerOptions,
  ) {
    if (opts.partyApiUrls.length === 0) {
      throw new Error('HydraHeadController: partyApiUrls must be non-empty');
    }
    // React to the milestones that used to trigger sends from inside the
    // observer's switch. The observer fires these after applying its own
    // status reduction, so `observer.status` is current here.
    this.observer.onProtocolEvent((e) => this.onProtocolEvent(e));
  }

  /**
   * Seed the Head with the player-derived participant set when the lobby
   * fills. This is the keys→roster→Head step.
   *
   * N+1 reality: the participant set is now fixed by the orchestrator at
   * spawn time (one node per party, vks exchanged as boot flags), so the
   * roster collected from browsers still cannot *become* the on-chain
   * participants of this match — the nodes are already running with
   * operator-provisioned hydra keys. What this method does today:
   *
   *   1. Log the assembled roster of player vks (it proves keys flowed
   *      browser → upgrade URL → runner → here; the day player keys
   *      replace the custodial pool, this is the data that does it).
   *   2. Send `{ tag: 'Init' }` via the referee node. Init is a
   *      head-level L1 action — one party posts it on behalf of the
   *      participant set, so issuing it once on party 0 is correct.
   *
   * Swap point: when client-held hydra keys land, sidecar spawn moves to
   * lobby-full time and this roster stops being merely logged.
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
   * needs to fire Close and wait for the terminal status. Close, like
   * Init, is a head-level action: one party posting it suffices, so the
   * referee's WS remains the single write path.
   *
   * From `initializing` the correct command is Abort, not Close — Close
   * is only valid on an open head; Abort returns any commits and lands
   * on HeadIsAborted (terminal).
   *
   * Tolerates being called from non-open states (logs and returns).
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
      if (status === 'initializing') {
        // Head never opened — unwind it instead of closing it.
        this.observer.send({ tag: 'Abort' });
        this.log('sent Abort to sidecar (head was still initializing)');
      } else {
        this.observer.send({ tag: 'Close' });
        this.log('sent Close to sidecar');
      }
    } catch (err) {
      this.log(`Close/Abort send failed: ${(err as Error).message}`);
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
        void this.sendInitialCommits();
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

  /**
   * POST a commit to EVERY party node's /commit endpoint so the
   * Initializing → Open transition can complete. In a multi-party head
   * the protocol waits for one commit per participant; a single missing
   * commit stalls the head in Initializing forever (until Abort).
   *
   * Today every party commits empty (`{}`) — each node owns its
   * cardano-signing-key, so for an empty commit it builds, signs, and
   * submits its own commit tx. Watch for one `Committed` per party,
   * then `HeadIsOpen`, on the WS stream.
   *
   * Swap point (game-state init): party 0 (the referee) is where the
   * treasury UTxO commit goes — replace its `{}` body with the funded
   * UTxO that the post-open genesis tx will split into per-player
   * Position/Bullets/Health UTxOs. Player parties keep committing empty.
   *
   * Failure stance: best-effort, guarded to fire once (parity with the
   * old single-commit behaviour). A failed party commit is logged loudly
   * — the observable symptom is waitUntilOpen() timing out, and the
   * recovery path is closeHead()'s Abort branch.
   */
  private async sendInitialCommits(): Promise<void> {
    if (this.committed) return;
    this.committed = true;

    const urls = this.opts.partyApiUrls;
    this.log(`committing for ${urls.length} part${urls.length === 1 ? 'y' : 'ies'}`);

    const results = await Promise.allSettled(
      urls.map((base, i) => this.commitParty(i, base)),
    );

    const failed = results
      .map((r, i) => (r.status === 'rejected' ? i : -1))
      .filter((i) => i >= 0);
    if (failed.length > 0) {
      this.log(
        `WARNING: commit failed for part${failed.length === 1 ? 'y' : 'ies'} ` +
        `[${failed.join(', ')}] — head will stall in Initializing; ` +
        `expect waitUntilOpen() to time out and closeHead() to Abort`,
      );
    }
  }

  /** Commit for a single party. Party 0 is the referee — see the
   *  treasury swap point in sendInitialCommits() above. */
  private async commitParty(index: number, baseUrl: string): Promise<void> {
    const url = `${stripTrailingSlash(baseUrl)}/commit`;
    this.log(`POST ${url} (party ${index}, empty commit)`);

    // Node 18+ has global fetch. If you're on 16, swap to node-fetch
    // or the built-in `http` module.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const bodyText = await res.text();
    if (!res.ok) {
      this.log(`party ${index} commit HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      throw new Error(`commit HTTP ${res.status}`);
    }
    this.log(`party ${index} commit accepted (${bodyText.length} bytes returned)`);
  }

  private log(msg: string): void {
    console.log(`[hydra:${shortId(this.opts.lobbyId)}] ${msg}`);
  }
}

function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/$/, '');
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