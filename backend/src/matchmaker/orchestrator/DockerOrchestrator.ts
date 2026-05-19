/**
 * Spawns lobby-runner containers as siblings of the matchmaker via the
 * host's Docker socket. Dev/local-only — production should use the
 * Kubernetes-backed implementation.
 */

import Docker from 'dockerode';
import type {
  OrchestratorSPI,
  SpawnRequest,
  SpawnResult,
} from './OrchestratorSPI';

export class DockerOrchestrator implements OrchestratorSPI {
  private readonly docker: Docker;

  constructor(
    private readonly image:        string,
    private readonly network:      string,
    private readonly internalPort: number = 3000,
  ) {
    // Defaults to /var/run/docker.sock; override with DOCKER_HOST for remote.
    this.docker = new Docker();
  }

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    const name = `runner-${req.lobbyId}`;

    const container = await this.docker.createContainer({
      Image: this.image,
      name,
      Env: [
        `LOBBY_ID=${req.lobbyId}`,
        `MAX_PLAYERS=${req.maxPlayers}`,
        `PORT=${this.internalPort}`,
        `IDLE_SHUTDOWN_MS=${5 * 60 * 1000}`,
        `AUTH_SECRET=${process.env.AUTH_SECRET}`,
      ],
      Cmd: ['node', 'dist/backend/src/runner.js'],
      HostConfig: {
        // Auto-delete on exit — runners are one-shot per match.
        AutoRemove:    true,
        NetworkMode:   this.network,
        Memory:        256 * 1024 * 1024, // 256 MB
        NanoCpus:      500_000_000,       // 0.5 vCPU
        RestartPolicy: { Name: 'no' },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.network]: { Aliases: [name] },
        },
      },
      Labels: {
        'ada-battles.role':    'lobby-runner',
        'ada-battles.lobbyId': req.lobbyId,
      },
    });

    await container.start();

    return {
      containerRef: container.id,
      wsUrl:        `ws://${name}:${this.internalPort}`,
      statusUrl:    `http://${name}:${this.internalPort}/status`,
    };
  }

  async stop(containerRef: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerRef);
      await container.stop({ t: 5 }); // SIGTERM, then SIGKILL after 5s
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/no such container|not running/i.test(msg)) throw e;
    }
  }
}