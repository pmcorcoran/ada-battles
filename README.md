# Ada Battles

A multiplayer top-down shooter with Cardano wallet authentication. Players
connect a wallet, get matched into a lobby, and play last-one-standing
matches. Each match runs in its own isolated, short-lived server process.

> **Status:** active development. The codebase has been refactored from a
> monolith into a containerised **matchmaker + per-match runner**
> architecture. Hydra (Cardano L2) integration is in early scaffolding —
> sidecar wiring exists in the orchestration layer but on-chain authority
> is not yet active; matches currently run on in-memory server authority.

---

## How it works

There is **one Docker image with two entrypoints**:

- **Matchmaker** — one long-running instance. Serves the REST API, reverse-
  proxies WebSocket connections, and spawns runner containers on demand via
  the Docker API. Holds no game state.
- **Runner** — one container per match, spawned by the matchmaker. Owns a
  single `Lobby` and the players in it. Exits when the match ends.

The browser only ever talks to the matchmaker's host/port. WebSocket
upgrades on `/lobby/<id>` are proxied internally to the runner that owns
that lobby. The browser never addresses a runner directly.

```
Browser
  │  POST /api/lobbies/match        →  matchmaker returns { lobbyId, wsUrl, challenge }
  │  WS  /lobby/<id>?address&challenge&sig
  ▼
Matchmaker  ──spawns──▶  runner-<id>   (one per match, on ada-battles-net)
  (API + WS proxy)        (owns one Lobby, serves WS at :3000 internally)
```

### Match lifecycle

A runner's lobby is a one-way state machine:

```
lobby     → countdown   (player count hits max)
lobby     → ended       (had players, all left before countdown)
countdown → playing     (countdown completes)
countdown → lobby       (a player leaves during countdown)
playing   → ended       (someone wins, or all but one player leaves)
```

`ended` is terminal — runners are one-shot. To play again, the client
re-matchmakes (`POST /api/lobbies/match`) and is routed to a fresh runner.
The matchmaker reaps runners that reach `ended` (and runners stuck in
`starting` for over 60s). Empty pre-match runners are kept alive so they
can accept players.

### Authentication

Per-connection, no sessions. The matchmaker issues an HMAC-signed
challenge with each match response. The client signs it with the connected
wallet (CIP-30). The runner verifies both the HMAC and the wallet
signature at WebSocket upgrade time before admitting the player.

### Wire format

Client and server exchange a compact binary codec (1-byte opcode + packed
payload) over WebSocket binary frames, defined in `shared/wire.ts`. A
round-trip self-test lives in `shared/wire.check.ts`.

---

## Repository layout

```
backend/      Node + TypeScript. Matchmaker, runner, lobby logic.
  src/
    matchmaker/        Matchmaker entrypoint, HTTP app, WS proxy
      orchestrator/    OrchestratorSPI + DockerOrchestrator
    runner.ts          Runner entrypoint (one lobby per process)
    Lobby.ts           Game state and lifecycle
    WebSocketHub.ts    Typed ws wrapper (socket.io-like surface)
    auth/              Wallet challenge verification
frontend/     Browser client. TypeScript, bundled with esbuild.
  public/            Web root: index.html, bundle.js, config.js
  src/client/        Client source (NetworkClient, GameScene, wallet, ...)
shared/       Pure TypeScript shared by both sides (types, constants, wire codec).
infra/        Dev infra (e.g. hydra-dev-keys). [TODO: confirm contents]
```

Backend and shared compile as CommonJS via `tsc`. The frontend is bundled
to a browser IIFE by esbuild (`--platform=browser`), so its CommonJS
sources run in the browser. The **web-servable root is `frontend/public/`**
— `frontend/dist/` is intermediate `tsc` output and is not served to the
browser.

---

## Running locally

### Prerequisites

- Docker + Docker Compose
- Node.js (for building the frontend bundle)
- A Cardano wallet browser extension (CIP-30) for the full play flow

### 1. Build and start the matchmaker

```bash
docker compose up -d --build
```

This builds the `ada-battles:latest` image and starts the matchmaker on
`:8080`. The matchmaker spawns runner containers on demand; you do not
start runners yourself.

The compose file binds the host Docker socket so the matchmaker can spawn
sibling containers. This is **development-only** — it grants root-equivalent
power on the host. Production would use a Kubernetes ServiceAccount with
pod-create permissions instead (see `OrchestratorSPI` — Docker is one
implementation of a swappable seam).

### 2. Serve the frontend

The matchmaker does **not** serve the frontend. Build the bundle and serve
`frontend/public/`:

```bash
cd frontend
npm install
npm run build                    # tsc + esbuild → public/bundle.js
npx serve -s public -l 3000
```

`config.js` in `public/` sets where the client looks for the matchmaker:

```js
// frontend/public/config.js
window.MATCHMAKER_URL = 'http://localhost:8080';
```

### 3. Play

Open `http://localhost:3000`, connect a wallet, and start a match. Open
multiple tabs to fill a lobby (matches need 3–5 players depending on the
requested size).

### Environment variables

Set on the matchmaker service in `docker-compose.yml`:

| Variable            | Purpose                                              |
|---------------------|------------------------------------------------------|
| `AUTH_SECRET`       | HMAC secret for issuing/verifying challenges (req'd) |
| `PORT`              | Matchmaker listen port (default 8080)                |
| `PUBLIC_WS_HOST`    | Host used to build the `wsUrl` returned to clients   |
| `PUBLIC_PORT`       | Port used to build the `wsUrl` (default 8080)        |
| `RUNNER_IMAGE`      | Image to spawn for runners (`ada-battles:latest`)    |
| `RUNNER_NETWORK`    | Docker network for runners (`ada-battles-net`)       |
| `ALLOWED_ORIGINS`   | Comma-separated CORS / WS origin allow-list          |

Hydra-related variables (`HYDRA_NODE_IMAGE`, `HYDRA_DEV_KEYS_HOST_PATH`)
exist in compose for the in-progress sidecar work.

> The frontend is served from a different origin (`:3000`) than the API
> (`:8080`), so `ALLOWED_ORIGINS` must include the frontend origin (e.g.
> `http://localhost:3000`) or browser requests will be blocked. Keep schemes
> consistent locally: http page, http API, ws WebSocket — all plain (no TLS
> on the matchmaker in dev).

---

## Building

```bash
# Backend (compiles to backend/dist/)
cd backend && npm install && npm run build

# Frontend (bundles to frontend/public/bundle.js)
cd frontend && npm install && npm run build
```

The Docker image build runs both as part of its multi-stage build; you only
need the manual builds for local non-container work (e.g. serving the
frontend with `serve`).

---

## Operational notes

Clean up dangling runner / sidecar containers after a matchmaker crash:

```bash
docker ps --filter "label=ada-battles.role=lobby-runner"  -q | xargs -r docker rm -f
docker ps --filter "label=ada-battles.role=hydra-sidecar" -q | xargs -r docker rm -f
```

Tail a runner's logs:

```bash
docker logs -f $(docker ps --filter "label=ada-battles.role=lobby-runner" --format "{{.ID}}" | head -1)
```

Quick health checks:

```bash
curl -s http://localhost:8080/healthz        # matchmaker
curl -s http://localhost:8080/api/lobbies     # active lobbies
```

---

## Project documentation

- `ARCHITECTURE.md` — detailed design, component responsibilities, and
  deferred work.

## License

[TODO: add license]