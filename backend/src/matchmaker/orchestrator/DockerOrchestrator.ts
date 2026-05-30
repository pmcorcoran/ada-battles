/**
 * Spawns lobby-runner containers as siblings of the matchmaker via the
 * host's Docker socket. Dev/local-only — production should use the
 * Kubernetes-backed implementation.
 *
 * Per match, spawns TWO containers on `ada-battles-net`:
 *
 *   runner-<lobbyId>   the game server (this codebase, port 3000)
 *   hydra-<lobbyId>    the hydra-node sidecar (upstream image, port 4001)
 *
 * The runner reaches its sidecar at ws://hydra-<lobbyId>:4001/. The
 * matchmaker tracks only the runner via SpawnResult — the sidecar is
 * an implementation-private sibling, reaped together with the runner
 * by stop(). This keeps OrchestratorSPI unchanged; K8s will use a
 * two-container Pod as the same abstraction.
 *
 * Sidecar lifecycle (decision (ii) from HANDOFF): runner.ts owns it.
 * Boot order is: spawn sidecar → spawn runner → runner connects.
 * Shutdown is reverse but driven by the runner: runner closes its
 * sidecar client and exits, then the matchmaker's stop() reaps both.
 *
 * Slice 1 runs the sidecar in offline mode (--offline-head-seed +
 * --initial-utxo) so no cardano-node is required. Slice 2 will need
 * a real cardano-node mount and per-match keys.
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

  /** Image for the hydra-node sidecar.
   *  Pinned: ghcr.io/cardano-scaling/hydra-node:2.0.0 */
  hydraImage: string;
  /** API port inside the sidecar container. */
  hydraApiPort?: number;
  /**
   * Host directory containing the dev key bundle:
   *   hydra.sk, hydra.vk, initial-utxo.json, protocol-parameters.json
   * Bind-mounted into each sidecar at /run/hydra/.
   * Slice 1 only — slice 2 will generate per-match keys.
   */
  hydraDevKeysHostPath: string;
  /** Auth secret shared with the runner. */
  authSecret: string;
}

export class DockerOrchestrator implements OrchestratorSPI {
  private readonly docker: Docker;
  private readonly runnerPort:   number;
  private readonly hydraApiPort: number;

  /**
   * Tracks sidecar container IDs by runner container ref. Reaped by
   * stop() so the sidecar doesn't outlive its runner.
   * Implementation detail — never exposed.
   */
  private readonly sidecarByRunner = new Map<string, string>();

  constructor(private readonly opts: DockerOrchestratorOptions) {
    this.docker       = new Docker();
    this.runnerPort   = opts.runnerPort   ?? 3000;
    this.hydraApiPort = opts.hydraApiPort ?? 4001;
  }

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    const runnerName = `runner-${req.lobbyId}`;
    const hydraName  = `hydra-${req.lobbyId}`;

    // 1. Spawn the sidecar FIRST so the runner can connect on boot.
    //    If runner came up first it'd hit STARTUP_RETRIES on the
    //    HydraSidecarClient, which works but wastes ~10s.
    const sidecar = await this.spawnSidecar(req.lobbyId, hydraName);

    let runnerContainer: Docker.Container;
    try {
      runnerContainer = await this.spawnRunner(req, runnerName, hydraName);
    } catch (err) {
      // Roll back the sidecar so we don't leak it.
      await this.stopContainer(sidecar.id).catch(() => {});
      throw err;
    }

    this.sidecarByRunner.set(runnerContainer.id, sidecar.id);

    return {
      containerRef: runnerContainer.id,
      wsUrl:        `ws://${runnerName}:${this.runnerPort}`,
      statusUrl:    `http://${runnerName}:${this.runnerPort}/status`,
    };
  }

  async stop(containerRef: string): Promise<void> {
    // Stop the runner first — it'll send Close to its sidecar on its
    // way out (slice 2 semantics; slice 1 is a no-op clean close).
    await this.stopContainer(containerRef);

    const sidecarId = this.sidecarByRunner.get(containerRef);
    if (sidecarId) {
      this.sidecarByRunner.delete(containerRef);
      await this.stopContainer(sidecarId);
    }
  }

  // ── internals ──────────────────────────────────────────────────

  private async spawnRunner(
    req: SpawnRequest,
    runnerName: string,
    hydraName:  string,
  ): Promise<Docker.Container> {
    const container = await this.docker.createContainer({
      Image: this.opts.runnerImage,
      name:  runnerName,
      Env: [
        `LOBBY_ID=${req.lobbyId}`,
        `MAX_PLAYERS=${req.maxPlayers}`,
        `PORT=${this.runnerPort}`,
        `IDLE_SHUTDOWN_MS=${5 * 60 * 1000}`,
        `AUTH_SECRET=${this.opts.authSecret}`,
        // NEW: where the sidecar is reachable from inside the runner
        // container. Same network, alias resolves to sidecar's IP.
        `HYDRA_SIDECAR_URL=ws://${hydraName}:${this.hydraApiPort}/?history=no`,
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

  private async spawnSidecar(
    lobbyId:   string,
    hydraName: string,
  ): Promise<Docker.Container> {
    // Offline mode flags (hydra 1.x):
    //   --offline-head-seed <hex>     32 bytes of hex; identifies the
    //                                 offline "head" deterministically
    //   --initial-utxo <file>         JSON UTxO seed; empty {} is valid
    //   --ledger-protocol-parameters  protocol params for the L2 ledger
    //   --hydra-signing-key           hydra (not cardano) signing key
    //   --api-host / --api-port       WS+HTTP API bind
    //   --persistence-dir             event log; per-container tmpfs is fine
    //
    // We deliberately do NOT pass --node-socket, --cardano-signing-key,
    // --hydra-scripts-tx-id, --peer, --testnet-magic. None of those
    // are valid when offline. Slice 2 (online) adds them all.
    //
    // Seed derivation: take 16 bytes of the lobbyId UUID (32 hex chars)
    // and zero-pad to 32 bytes. Stable per lobby, irrelevant otherwise.

    const container = await this.docker.createContainer({
      Image: this.opts.hydraImage,
      name:  hydraName,
      Cmd: [
        '--node-id', `online-${lobbyId.slice(0, 8)}`,
        // Chain backend: Blockfrost instead of --node-socket/--testnet-magic.
        // The project file's network determines the chain (preprod here).
        '--blockfrost', '/run/hydra/blockfrost-project.txt',
        // Pre-published hydra scripts for v1.2.0 on preprod. Either form works:
        //   --network preprod                          (uses bundled networks.json)
        //   --hydra-scripts-tx-id <tx1>,<tx2>,<tx3>    (explicit pin)
        '--network', 'preprod',
        // L1 fuel key. The hydra-node pays its own L1 fees from this UTxO.
        '--cardano-signing-key', '/run/hydra/cardano.sk',
        // Participant set: just our own vk for now (see "caveat" below).
        '--hydra-signing-key', '/run/hydra/hydra.sk',
        // L2 ledger config — unchanged from offline.
        '--ledger-protocol-parameters', '/run/hydra/protocol-parameters.json',
        // Short contestation period for testing. Default is 12h. 60s is fine on preprod;
        // do NOT use a short value on mainnet (see Hydra docs on the safe zone).
        '--contestation-period', '60s',
        '--unsynced-period', '300s',
        // API binding — unchanged.
        '--api-host', '0.0.0.0',
        '--api-port', String(this.hydraApiPort),
        '--persistence-dir', '/tmp/hydra-state',
      ],
      HostConfig: {
        AutoRemove:    false,
        NetworkMode:   this.opts.network,
        Memory:        512 * 1024 * 1024,  // hydra-node is heavier than the runner
        NanoCpus:      500_000_000,
        RestartPolicy: { Name: 'no' },
        Binds: [
          // Read-only key bundle. Mounted from a path on the matchmaker
          // host that compose has already validated exists.
          `${this.opts.hydraDevKeysHostPath}:/run/hydra:ro`,
        ],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.opts.network]: { Aliases: [hydraName] },
        },
      },
      Labels: {
        'ada-battles.role':    'hydra-sidecar',
        'ada-battles.lobbyId': lobbyId,
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