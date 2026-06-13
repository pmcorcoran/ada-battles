/**
 * Spawns lobby-runner containers as siblings of the matchmaker via the
 * host's Docker socket. Dev/local-only — production should use the
 * Kubernetes-backed implementation.
 *
 * Per match, spawns 1 + (maxPlayers + 1) containers on `ada-battles-net`:
 *
 *   runner-<lobbyId>        the game server (this codebase, port 3000)
 *   hydra-<lobbyId>         party 0 — the REFEREE hydra-node
 *   hydra-<lobbyId>-p1..pN  parties 1..N — one hydra-node per player slot
 *
 * MULTI-PARTY TOPOLOGY (N+1)
 * --------------------------
 * One hydra-node hosts exactly one head party, so N+1 participants means
 * N+1 node containers, fully meshed via --peer on the match network.
 * Party 0 keeps the old `hydra-<lobbyId>` alias so the runner's
 * HYDRA_SIDECAR_URL wiring is unchanged; the runner additionally gets
 * HYDRA_PARTY_API_URLS (comma-separated, party 0 first) because with
 * multiple parties EVERY node must receive a commit for the head to
 * open — HydraHeadController.sendInitialCommit() must loop these URLs
 * (referee commits the treasury UTxO, players commit empty `{}`).
 *
 * CUSTODIAL CAVEAT (read this twice)
 * ----------------------------------
 * Party keys are pre-provisioned on the matchmaker host and mounted into
 * operator-run containers, i.e. the operator holds every party's
 * hydra.sk. That exercises the real multi-party machinery (N-of-N
 * snapshot signing, per-party contest rights at close) but provides NO
 * adversarial protection for players — whoever holds the signing key
 * owns the contest right. True player parties require client-held keys
 * and (eventually) player-run nodes; at that point sidecar spawn must
 * move from match-creation time to lobby-full time, because peer vks are
 * boot-time CLI flags.
 *
 * EXPECTED KEY LAYOUT under `hydraDevKeysHostPath` (was: flat bundle):
 *
 *   <root>/
 *   ├── shared/
 *   │   ├── protocol-parameters.json   zero-fee L2 ledger params
 *   │   └── blockfrost-project.txt     preprod project id
 *   └── parties/
 *       ├── p0/   hydra.sk hydra.vk cardano.sk cardano.vk   (referee)
 *       ├── p1/   …                                          (player slot 1)
 *       └── pK/   …  — provision at least MAX_PLAYERS + 1 dirs
 *
 * Every party's cardano.sk address MUST hold fuel ada on preprod: each
 * node pays its own L1 fees (Init/Commit/Close/Contest/Fanout) from it.
 * Recycle a pre-funded pool of party dirs across matches rather than
 * faucet-per-match.
 *
 * PROTOCOL INVARIANTS the loop below must keep identical across parties,
 * or Init is ignored / nodes diverge: --contestation-period, the ledger
 * protocol-parameters file, --network, and the hydra-node image version.
 *
 *
 * Sidecar lifecycle (decision (ii) from HANDOFF): runner.ts owns it.
 * Boot order: spawn all parties → spawn runner → runner connects.
 * Shutdown is reverse but driven by the runner: runner drives the Head
 * to a terminal state and exits, then the matchmaker's stop() reaps the
 * runner and ALL party containers.
 */

import Docker from 'dockerode';
import type {
  OrchestratorSPI,
  SpawnRequest,
  SpawnResult,
} from './OrchestratorSPI';

export interface DockerOrchestratorOptions {
  /** Image for the lobby-runner (this codebase). */
  runnerImage: string;
  /** Docker network shared by matchmaker, runners, and sidecars. */
  network: string;
  /** Port the runner listens on inside the container. */
  runnerPort?: number;

  /** Image for the hydra-node sidecars.
   *  Pinned: ghcr.io/cardano-scaling/hydra-node:2.0.0
   *  Must be the SAME image for every party in a head. */
  hydraImage: string;
  /** API port inside each sidecar container (WS + HTTP). */
  hydraApiPort?: number;
  /** Hydra network (peer/etcd) port inside each sidecar container. */
  hydraNetworkPort?: number;
  /** Memory cap per hydra-node container, in bytes. Default 512 MiB. */
  hydraMemoryBytes?: number;
  /**
   * Host directory containing the party key pool + shared config in the
   * layout documented in the header comment. Bind-mounted READ-ONLY into
   * every sidecar at /run/hydra/ — note this means every node can read
   * every party's signing key, which is acceptable only while all
   * parties are operator-hosted (see CUSTODIAL CAVEAT above).
   */
  hydraDevKeysHostPath: string;
  /** Auth secret shared with the runner. */
  authSecret: string;
}

export class DockerOrchestrator implements OrchestratorSPI {
  private readonly docker: Docker;
  private readonly runnerPort:       number;
  private readonly hydraApiPort:     number;
  private readonly hydraNetworkPort: number;
  private readonly hydraMemoryBytes: number;

  /**
   * Tracks ALL party container IDs by runner container ref (party 0
   * first). Reaped by stop() so no sidecar outlives its runner.
   * Implementation detail — never exposed.
   */
  private readonly sidecarsByRunner = new Map<string, string[]>();

  constructor(private readonly opts: DockerOrchestratorOptions) {
    this.docker           = new Docker();
    this.runnerPort       = opts.runnerPort       ?? 3000;
    this.hydraApiPort     = opts.hydraApiPort     ?? 4001;
    this.hydraNetworkPort = opts.hydraNetworkPort ?? 5001;
    this.hydraMemoryBytes = opts.hydraMemoryBytes ?? 512 * 1024 * 1024;
  }

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    const runnerName = `runner-${req.lobbyId}`;
    // Party 0 (referee) keeps the legacy alias; players get -p<i>.
    const partyCount = req.maxPlayers + 1;
    const partyAliases = Array.from({ length: partyCount }, (_, i) =>
      i === 0 ? `hydra-${req.lobbyId}` : `hydra-${req.lobbyId}-p${i}`,
    );

    // 1. Spawn ALL party nodes FIRST so the runner can connect on boot,
    //    and so the full mesh is resolvable the moment any node tries to
    //    reach a peer. If any spawn fails, roll back the ones already up.
    const sidecars: Docker.Container[] = [];
    try {
      for (let i = 0; i < partyCount; i++) {
        sidecars.push(
          await this.spawnPartyNode(req.lobbyId, i, partyAliases),
        );
      }
    } catch (err) {
      await Promise.all(
        sidecars.map((c) => this.stopContainer(c.id).catch(() => {})),
      );
      throw err;
    }

    let runnerContainer: Docker.Container;
    try {
      runnerContainer = await this.spawnRunner(req, runnerName, partyAliases);
    } catch (err) {
      // Roll back every party node so we don't leak the mesh.
      await Promise.all(
        sidecars.map((c) => this.stopContainer(c.id).catch(() => {})),
      );
      throw err;
    }

    this.sidecarsByRunner.set(
      runnerContainer.id,
      sidecars.map((c) => c.id),
    );

    return {
      containerRef: runnerContainer.id,
      wsUrl:        `ws://${runnerName}:${this.runnerPort}`,
      statusUrl:    `http://${runnerName}:${this.runnerPort}/status`,
    };
  }

  async stop(containerRef: string): Promise<void> {
    // Stop the runner first — it drives Close → Fanout on its way out,
    // which needs the party nodes still up. Only then reap the mesh.
    await this.stopContainer(containerRef);

    const sidecarIds = this.sidecarsByRunner.get(containerRef);
    if (sidecarIds) {
      this.sidecarsByRunner.delete(containerRef);
      await Promise.all(sidecarIds.map((id) => this.stopContainer(id)));
    }
  }

  // ── internals ──────────────────────────────────────────────────

  private async spawnRunner(
    req: SpawnRequest,
    runnerName: string,
    partyAliases: string[],
  ): Promise<Docker.Container> {
    const refereeAlias = partyAliases[0];
    // http://<alias>:4001 per party, party 0 (referee) first. The
    // HydraHeadController uses these to POST /commit to EVERY party —
    // a multi-party head will not reach Open until each node has
    // committed (players commit empty).
    const partyApiUrls = partyAliases
      .map((a) => `http://${a}:${this.hydraApiPort}`)
      .join(',');

    const container = await this.docker.createContainer({
      Image: this.opts.runnerImage,
      name:  runnerName,
      Env: [
        `LOBBY_ID=${req.lobbyId}`,
        `MAX_PLAYERS=${req.maxPlayers}`,
        `PORT=${this.runnerPort}`,
        `IDLE_SHUTDOWN_MS=${5 * 60 * 1000}`,
        `AUTH_SECRET=${this.opts.authSecret}`,
        // Observer/controller WS target — unchanged: the referee node.
        `HYDRA_SIDECAR_URL=ws://${refereeAlias}:${this.hydraApiPort}/?history=no`,
        // NEW: full party roster for per-party commit driving.
        `HYDRA_PARTY_API_URLS=${partyApiUrls}`,
        `HYDRA_PARTY_COUNT=${partyAliases.length}`,
      ],
      Cmd: ['node', 'dist/backend/src/runner.js'],
      HostConfig: {
        AutoRemove:    true,
        NetworkMode:   this.opts.network,
        Memory:        256 * 1024 * 1024,
        NanoCpus:      500_000_000,
        RestartPolicy: { Name: 'no' },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.opts.network]: { Aliases: [runnerName] },
        },
      },
      Labels: {
        'ada-battles.role':    'lobby-runner',
        'ada-battles.lobbyId': req.lobbyId,
      },
    });
    await container.start();
    return container;
  }

  /**
   * Spawn hydra-node party <index> of the match's N+1 mesh.
   *
   * Online/preprod flags, per party:
   *   --hydra-signing-key / --cardano-signing-key   OWN keys (parties/p<i>/)
   *   --peer + --hydra-verification-key
   *          + --cardano-verification-key           one triple PER OTHER party,
   *                                                 in the same order on every
   *                                                 node (j ascending, j ≠ i)
   *   --host / --port                               peer (etcd) listener; the
   *                                                 alias:port other nodes dial
   *   --contestation-period / ledger params         MUST match across parties
   *
   * What we deliberately do NOT do: generate keys here. Key dirs are a
   * pre-provisioned, pre-FUNDED pool (see header). A missing parties/p<i>
   * dir fails fast at node boot with a clear file-not-found.
   */
  private async spawnPartyNode(
    lobbyId:      string,
    index:        number,
    partyAliases: string[],
  ): Promise<Docker.Container> {
    const alias = partyAliases[index];
    const me    = `/run/hydra/parties/p${index}`;

    // Fully meshed peer wiring: one (--peer, hydra-vk, cardano-vk)
    // triple per OTHER party. Deterministic order so every node sees an
    // identical participant set — the head ID derives from it.
    const peerArgs = partyAliases.flatMap((peerAlias, j) => {
      if (j === index) return [];
      return [
        '--peer', `${peerAlias}:${this.hydraNetworkPort}`,
        '--hydra-verification-key',   `/run/hydra/parties/p${j}/hydra.vk`,
        '--cardano-verification-key', `/run/hydra/parties/p${j}/cardano.vk`,
      ];
    });

    const container = await this.docker.createContainer({
      Image: this.opts.hydraImage,
      name:  alias,
      Cmd: [
        '--node-id', `p${index}-${lobbyId.slice(0, 8)}`,
        // Chain backend: Blockfrost; the project file's network must be
        // preprod to match --network below.
        '--blockfrost', '/run/hydra/shared/blockfrost-project.txt',
        // Pre-published hydra scripts for the pinned node version.
        '--network', 'preprod',
        // OWN identity. The cardano key pays this party's L1 fees
        // (Init/Commit/Close/Contest/Fanout) — it must hold fuel.
        '--cardano-signing-key', `${me}/cardano.sk`,
        '--hydra-signing-key',   `${me}/hydra.sk`,
        // The rest of the mesh.
        ...peerArgs,
        // Peer/etcd listener this node binds; peers dial alias:port.
        '--host', '0.0.0.0',
        '--port', String(this.hydraNetworkPort),
        // L2 ledger config — identical file for every party.
        '--ledger-protocol-parameters', '/run/hydra/shared/protocol-parameters.json',
        // Identical on all parties or Init is ignored. 60s is fine on
        // preprod; do NOT use a short value on mainnet (safe zone).
        '--contestation-period', '60s',
        '--unsynced-period', '300s',
        // API binding — every party exposes WS+HTTP on the same port;
        // the runner talks WS only to party 0 but POSTs /commit to all.
        '--api-host', '0.0.0.0',
        '--api-port', String(this.hydraApiPort),
        '--persistence-dir', '/tmp/hydra-state',
      ],
      HostConfig: {
        AutoRemove:    false,
        NetworkMode:   this.opts.network,
        Memory:        this.hydraMemoryBytes,
        NanoCpus:      500_000_000,
        RestartPolicy: { Name: 'no' },
        Binds: [
          // Whole key pool, read-only, into every node. Acceptable ONLY
          // while all parties are operator-hosted — see header caveat.
          `${this.opts.hydraDevKeysHostPath}:/run/hydra:ro`,
        ],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.opts.network]: { Aliases: [alias] },
        },
      },
      Labels: {
        'ada-battles.role':       'hydra-sidecar',
        'ada-battles.lobbyId':    lobbyId,
        'ada-battles.hydraParty': String(index),
      },
    });
    await container.start();
    return container;
  }

  private async stopContainer(containerRef: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerRef);
      await container.stop({ t: 5 }); // SIGTERM, then SIGKILL after 5s
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/no such container|not running/i.test(msg)) throw e;
    }
  }
}