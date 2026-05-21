/**
 * Orchestrator SPI — the seam between matchmaker logic and the
 * platform that runs lobby-runner containers.
 *
 * Two implementations are envisioned:
 *   - DockerOrchestrator: dev, via /var/run/docker.sock
 *   - K8sOrchestrator:    prod, via the Kubernetes API
 *
 * Add new platforms by implementing this interface — no changes to
 * Matchmaker.ts or the HTTP/WS surface required.
 */

export interface SpawnRequest {
  lobbyId:    string;
  maxPlayers: number;
}

export interface SpawnResult {
  containerRef: string;
  wsUrl:        string; // ws://… — used internally by the WS proxy
  statusUrl:    string; // http://… — polled by the matchmaker for heartbeat
}

export interface OrchestratorSPI {
  spawn(req: SpawnRequest): Promise<SpawnResult>;
  stop(containerRef: string): Promise<void>;
}