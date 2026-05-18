/**
 * ada battles — Matchmaker
 *
 * Replaces the in-process LobbyManager from frontend/src/server/app.ts.
 * Holds no game state of its own. Its only jobs are:
 *
 *   1. List active lobbies   (GET  /api/lobbies)
 *   2. Find or create one    (POST /api/lobbies/match  { maxPlayers })
 *   3. Track lobby-runner containers and reap them when empty
 *
 * The client receives a runner URL and connects its game WebSocket
 * straight to that runner. The matchmaker never proxies game traffic.
 *
 *      ┌────────────┐      POST /match           ┌─────────────────┐
 *      │  Browser   │  ───────────────────────►  │   Matchmaker    │
 *      │            │  ◄───── { wsUrl } ──────── │  (this file)    │
 *      └─────┬──────┘                            └────────┬────────┘
 *            │                                            │ Docker / k8s API
 *            │  ws://runner-<id>:3000                     │
 *            └─────────────────────────────────────► ┌─────────────────┐
 *                                                    │  lobby-runner   │
 *                                                    │   container     │
 *                                                    └─────────────────┘
 *
 * Container orchestration is pluggable: `DockerOrchestrator` for local
 * dev (spawns sibling containers via /var/run/docker.sock), and a
 * `K8sOrchestrator` shape for production (not implemented here —
 * sketched in the OrchestratorSPI interface below).
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { issueChallenge } from '../shared/authChallenge';
import httpProxy from 'http-proxy';
const proxy = httpProxy.createProxyServer({ ws: true });

const AUTH_SECRET = required('AUTH_SECRET');

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}

// 
// Types — what matchmaker tracks and tells clients
// 

type LobbyStatus = 'starting' | 'lobby' | 'countdown' | 'playing' | 'ended';

// matchmakers view of one running lobby, holds no gamestate.
interface LobbyRecord {
  id:           string;
  maxPlayers:   number;
  containerRef: string;
  wsUrl:        string;       // public URL given to client
  internalWsUrl: string;      // internal URL the proxy targets
  statusUrl:    string;
  status:       LobbyStatus;
  playerCount:  number;
  createdAt:    number;
}

// ────────────────────────────────────────────────────────────────────
// Orchestrator SPI — pluggable for Docker (dev) vs Kubernetes (prod)
// ────────────────────────────────────────────────────────────────────

interface SpawnRequest {
  lobbyId:    string;
  maxPlayers: number;
}

interface SpawnResult {
  containerRef: string;
  wsUrl:        string;
  statusUrl:    string;
}

interface OrchestratorSPI {
  spawn(req: SpawnRequest): Promise<SpawnResult>; // create and start runner container for one lobby
  stop(containerRef: string): Promise<void>; // tear down container
}

// ── Docker implementation 

class DockerOrchestrator implements OrchestratorSPI {
  private readonly docker: Docker;

  constructor(
    private readonly image:    string,
    private readonly network:  string,        // shared docker network name
    private readonly internalPort = 3000,     // port the runner listens on inside its container
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
      Cmd: ['node', 'dist/server/runner.js'],
      HostConfig: {
        // Auto-delete the container when it exits — runners are
        // intentionally short-lived (one match = one container).
        AutoRemove:    true,
        NetworkMode:   this.network,
        // Resource caps — a single lobby is tiny.
        Memory:        256 * 1024 * 1024,    // 256 MB
        NanoCpus:      500_000_000,          // 0.5 vCPU
        RestartPolicy: { Name: 'no' },
      },
      // Tell other containers on the same network to reach us by name.
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

    // Inside the docker network, other containers can DNS-resolve the
    // runner by its container name. Browser clients can't — they need
    // the public URL, typically through an ingress/reverse-proxy. We
    // return the in-network URL here and let the matchmaker rewrite it
    // for public consumption in the HTTP handler.
    return {
      containerRef: container.id,
      wsUrl:        `ws://${name}:${this.internalPort}`,
      statusUrl:    `http://${name}:${this.internalPort}/status`,
    };
  }

  async stop(containerRef: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerRef);
      await container.stop({ t: 5 });   // SIGTERM, then SIGKILL after 5s
    } catch (e) {
      // Already gone — fine; AutoRemove may have beat us to it.
      const msg = (e as Error).message ?? '';
      if (!/no such container|not running/i.test(msg)) throw e;
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Matchmaker — the actual service
// ────────────────────────────────────────────────────────────────────

class Matchmaker {
  readonly lobbies = new Map<string, LobbyRecord>();

  constructor(
    private readonly orchestrator: OrchestratorSPI,
    /** What clients should connect to. For local docker-compose this is
     *  `ws://localhost:<host-port>`; in production it's typically your
     *  ingress hostname with a path-based or host-based route to the
     *  specific runner. The orchestrator returns an internal URL; this
     *  callback translates it to a publicly-reachable one. */
    private readonly publicUrlFor: (lobbyId: string, internalUrl: string) => string,
  ) {}

  list(): LobbyRecord[] {
    return [...this.lobbies.values()].filter((l) => l.status !== 'ended');
  }

  /**
   * Find a lobby with room for one more, or spin up a fresh one.
   * Matches the behaviour of the existing LobbyManager.getAvailable().
   */
  async match(maxPlayers: number): Promise<LobbyRecord> {
    const open = [...this.lobbies.values()].find(
      (l) => l.maxPlayers === maxPlayers
        && (l.status === 'lobby' || l.status === 'starting')
        && l.playerCount < l.maxPlayers,
    );
    if (open) return open;
    return this.spawnLobby(maxPlayers);
  }

  async spawnLobby(maxPlayers: number): Promise<LobbyRecord> {
    const id = randomUUID();
    const { containerRef, wsUrl, statusUrl } = await this.orchestrator.spawn({
      lobbyId:    id,
      maxPlayers,
    });

    const record: LobbyRecord = {
      id,
      maxPlayers,
      containerRef,
      wsUrl:         this.publicUrlFor(id, wsUrl),
      internalWsUrl: wsUrl,             // keep the raw ws://runner-<id>:3000
      statusUrl,
      status:        'starting',
      playerCount:   0,
      createdAt:     Date.now(),
    };
    this.lobbies.set(id, record);

    // Wait for the runner to come up, then start heartbeating it. We
    // fire-and-forget — if the runner never becomes ready, the reap
    // loop below will tear it down.
    void this.beginPolling(record);

    return record;
  }

  /** Poll the runner's /status endpoint until it dies. */
  private async beginPolling(record: LobbyRecord): Promise<void> {
    const POLL_INTERVAL = 2_000;

    while (this.lobbies.has(record.id)) {
      try {
        const res = await fetch(record.statusUrl, { signal: AbortSignal.timeout(1_500) });
        if (res.ok) {
          const body = await res.json() as { status: LobbyStatus; playerCount: number };
          record.status      = body.status;
          record.playerCount = body.playerCount;
        }
      } catch {
        // Network errors are expected during startup and shutdown;
        // the reaper will handle persistently-unreachable runners.
      }
      await sleep(POLL_INTERVAL);
    }
  }

  /**
   * Reap runners that are ended, empty, or unreachable. Run on a
   * background interval; idempotent so it can be triggered manually too.
   */
  async reap(): Promise<void> {
    const now = Date.now();
    for (const record of this.lobbies.values()) {
      const ageMs = now - record.createdAt;
      const dead =
        (record.status === 'ended' &&
        (record.playerCount === 0 || ageMs > 60_000)) ||      // empty for >1m
        (record.status === 'starting' && ageMs > 900_000);    // never came up

      if (dead) {
        await this.orchestrator.stop(record.containerRef).catch(() => {});
        this.lobbies.delete(record.id);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// HTTP surface
// ────────────────────────────────────────────────────────────────────

const PORT          = Number(process.env.PORT ?? 8080);
const RUNNER_IMAGE  = process.env.RUNNER_IMAGE  ?? 'ada-battles:latest';
const RUNNER_NETWORK = process.env.RUNNER_NETWORK ?? 'ada-battles-net';
/** Host clients connect to; injected so the matchmaker can build
 *  reachable WS URLs without knowing where it's deployed. */
const PUBLIC_WS_HOST = process.env.PUBLIC_WS_HOST ?? 'localhost';

const orchestrator = new DockerOrchestrator(RUNNER_IMAGE, RUNNER_NETWORK);
const PUBLIC_PORT = process.env.PUBLIC_PORT ?? '8080';

const matchmaker = new Matchmaker(
  orchestrator,
  // In production with an ingress, return e.g. `wss://${PUBLIC_WS_HOST}/lobby/${id}`
  // and route to the runner by lobbyId. For local docker-compose we publish
  // each runner on a host port and return that — the runner sets up its own
  // port mapping at spawn time (left as a follow-up; the dev compose file
  // uses host-network mode to sidestep this).
  (id, _internalUrl) => `ws://${PUBLIC_WS_HOST}:${PUBLIC_PORT}/lobby/${id}`,
);



const app = express();
app.use(express.json());

// wiring to client/frontend ---------------
import path from 'path';
app.use(express.static(path.join(__dirname, '../../public')));
// SPA fallback: any non-API GET serves index.html so deep links work
app.get(/^(?!\/api\/|\/lobby\/|\/healthz).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});
// -----------------------------------------

app.get('/api/lobbies', (_req, res) => {
  res.json(matchmaker.list().map((l) => ({
    id:          l.id,
    maxPlayers:  l.maxPlayers,
    playerCount: l.playerCount,
    status:      l.status,
  })));
});

app.post('/api/lobbies/match', async (req, res) => {
  const maxPlayers = Number(req.body?.maxPlayers ?? 2);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 7) {
    res.status(400).json({ error: 'maxPlayers must be an integer in [3, 5]' });
    return;
  }
  try {
    const record = await matchmaker.match(maxPlayers);
    const challenge = issueChallenge(record.id, AUTH_SECRET);
    res.json({
      lobbyId:    record.id,
      wsUrl:      record.wsUrl,
      challenge,
    });
  } catch (e) {
    console.error('match failed:', e);
    res.status(503).json({ error: 'no capacity' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Background reaper ──────────────────────────────────────────────

setInterval(() => { void matchmaker.reap(); }, 10_000);

// ── Listen ─────────────────────────────────────────────────────────

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Matchmaker listening on :${PORT}`);
  console.log(`  RUNNER_IMAGE=${RUNNER_IMAGE}`);
  console.log(`  RUNNER_NETWORK=${RUNNER_NETWORK}`);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const m = url.pathname.match(/^\/lobby\/([^/]+)$/);
  if (!m) { socket.destroy(); return; }
  const record = matchmaker.lobbies.get(m[1]);
  if (!record) { socket.destroy(); return; }

  req.url = '/' + url.search;

  proxy.ws(req, socket, head, {
    target: record.internalWsUrl.replace(/^ws:/, 'http:'),
    changeOrigin: true,
  }, (err) => {
    console.error('[proxy] ws upgrade failed:', err.message);
    socket.destroy();
  });
});

// ── Utils ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}