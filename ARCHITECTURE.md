ARCHITECTURE.md
markdown# Ada Battles — Architecture

This document describes the post-refactor architecture of `ada-battles`: a
multiplayer top-down shooter on Cardano, restructured from a Web2 monolith
into a containerised two-tier system in preparation for Hydra Head integration.

## High-level model

Two services, one Docker image, two entrypoints:

- **Matchmaker** — long-running, single instance. Stateless HTTP service plus
  WebSocket reverse proxy. Spawns lobby-runner containers on demand via the
  Docker API. Also serves the static client bundle (planned split — see
  "Deferred: frontend split").
- **Lobby-runner** — ephemeral, one container per match. Single-lobby game
  server. Boots from environment variables, hosts exactly one `Lobby`
  instance, self-exits when idle.

The client only ever talks to one URL: the matchmaker's. WebSocket upgrades on
`/lobby/<id>` are reverse-proxied through the matchmaker to the appropriate
runner container.
┌──────────┐  POST /api/lobbies/match   ┌────────────────┐
│ Browser  │ ─────────────────────────► │  Matchmaker    │
│          │ ◄──── { wsUrl, challenge } │  :8080         │
└────┬─────┘                            └───────┬────────┘
│                                          │ dockerode
│  WS /lobby/<id>?address=&challenge=&sig= │
│ ───────────────────────────────────────► │ proxies upgrade
│                                          ▼
│                                  ┌────────────────┐
│                                  │ runner-<uuid>  │
│                                  │ :3000          │
│                                  │ (one Lobby)    │
│                                  └────────────────┘

## Repository layout

Three top-level directories: `backend/`, `frontend/`, `shared/`. They're
siblings — neither client nor server "owns" shared. The Docker build context
is the repo root.
ada-battles/
├── Dockerfile                          # multi-stage, single image
├── docker-compose.yml                  # dev: matchmaker only
├── .dockerignore                       # excludes node_modules, .git, .env, dist
├── .env                                # DOCKER_GID, AUTH_SECRET
├── ARCHITECTURE.md                     # this file
│
├── contracts/
│   ├── hydra_referee.py                # OpShin: client-authority referee
│   └── ticket_minting_contract.py
│
├── shared/                             # pure TS, isomorphic
│   ├── authChallenge.ts                # HMAC challenge issue/verify
│   ├── collision.ts
│   ├── constants.ts
│   ├── index.ts                        # barrel
│   ├── types.ts
│   ├── wire.ts                         # binary codec
│   └── wire.check.ts                   # codec sanity checks (not shipped)
│
├── backend/
│   ├── package.json                    # dockerode, http-proxy, ws, express,
│   │                                   # cardano-verify-datasignature, bech32
│   ├── tsconfig.json                   # rootDir: "..", module: commonjs
│   └── src/
│       ├── matchmaker/
│       │   ├── index.ts                # entry: env wiring, listens
│       │   ├── Matchmaker.ts           # class + LobbyRecord type
│       │   ├── http.ts                 # express routes + static client bundle
│       │   ├── wsProxy.ts              # WS upgrade handler
│       │   └── orchestrator/
│       │       ├── OrchestratorSPI.ts
│       │       └── DockerOrchestrator.ts
│       ├── runner.ts                   # single-lobby server entry
│       ├── Lobby.ts                    # per-match game state + tick loop
│       ├── WebSocketHub.ts             # typed ws wrapper, exposes socket.url
│       └── auth/
│           └── walletChallenge.ts      # verifyWalletChallenge
│
└── frontend/
├── package.json
├── tsconfig.json                   # rootDir: "..", module: commonjs
└── src/
├── client/
│   ├── main.ts                 # wallet first, then scene
│   └── network/
│       └── NetworkClient.ts    # match() / spectate() factories
├── wallet/
│   └── walletAuth.ts           # connectWallet + signChallenge
└── game/
└── scenes/
└── GameScene.ts        # async net, null-guarded render

### Shared layering rule

Anything in `shared/` must be pure TypeScript — no Node built-ins, no native
modules, nothing that wouldn't run in a browser. Wire formats, HMAC,
collision math, constants, types. If something needs `crypto` (Node),
`fs`, `bech32`, or `@cardano-foundation/cardano-verify-datasignature`, it
lives in `backend/`, not `shared/`. That's why `verifyWalletChallenge`
lives at `backend/src/auth/` while `issueChallenge` / `verifyChallenge`
(pure HMAC) live in `shared/authChallenge.ts`.

### Build outputs

`backend/tsconfig.json` has `rootDir: ".."` because `include` covers files
outside `backend/src/` (the shared directory). tsc's emit preserves the
relative path structure from the lowest common ancestor of all included
files, which is the repo root. So:
backend/dist/
├── backend/src/
│   ├── matchmaker/index.js
│   ├── runner.js
│   ├── Lobby.js
│   ├── WebSocketHub.js
│   └── auth/walletChallenge.js
└── shared/
├── authChallenge.js
├── wire.js
└── ...

This is reflected in the Dockerfile `CMD` (`node dist/backend/src/matchmaker/index.js`)
and the spawn override in `DockerOrchestrator` (`node dist/backend/src/runner.js`).
If you change `rootDir`, both must change too.

### Module system

Both `backend` and `frontend` use CommonJS (`module: "commonjs"`,
`moduleResolution: "node"`). ESM was tried and abandoned because Node's ESM
resolver requires explicit `.js` extensions on every relative import, which
tsc emits verbatim from source — meaning every source file would need
`from './foo.js'` even though the source file is `foo.ts`. CommonJS handles
extension resolution itself. The Hydra integration won't need ESM either;
the relevant libraries are happy as CJS.

### No path aliases

Relative imports only. `@shared/*` was tried and removed: tsc doesn't rewrite
the alias in the emitted JS, so the output `require('@shared/X')` fails at
runtime. Could be fixed with `tsconfig-paths` or `tsc-alias` but the
codebase is small enough that the alias overhead isn't worth it. Pattern is
`../../shared/X` from files in `backend/src/`, `../../../shared/X` from one
level deeper, etc.

## File-by-file

### Infrastructure

**`Dockerfile`** — multi-stage. Build stage `npm ci`s backend and frontend
separately, copies `shared/`, `backend/`, `frontend/`, then runs both
builds. Runtime stage uses `dumb-init`, creates a `docker` group with
`ARG DOCKER_GID` matching the host's GID, runs as a non-root `app` user in
that group. Copies the compiled backend (`/app/dist`), pruned backend
`node_modules`, and the frontend bundle (`/app/public`). Default CMD is
`node dist/backend/src/matchmaker/index.js`; the runner CMD is overridden
at spawn time by `DockerOrchestrator`.

**`docker-compose.yml`** — declares only the `matchmaker` service.
Bind-mounts `${XDG_RUNTIME_DIR}/docker.sock` so the matchmaker can spawn
sibling containers. Network `ada-battles-net` (bridge) is shared so
runners and matchmaker resolve each other by container name. Runners are
not declared here — they are created at runtime by the matchmaker via the
Docker API.

**`.dockerignore`** — excludes `node_modules`, `dist`, `.git`, `.env`,
Python `__pycache__/`, and editor/OS junk. Without this, `docker compose
build` sends the entire repo (potentially hundreds of MB) to the daemon.

**`.env`** — `DOCKER_GID=984` (matches the host's docker group GID),
`AUTH_SECRET=<random>` (shared between matchmaker and all runners for HMAC
challenge issue/verify).

### Backend — matchmaker

**`matchmaker/index.ts`** — entry. Reads environment, constructs the
orchestrator and matchmaker, mounts HTTP routes, attaches the WS proxy,
starts the background reaper, listens on `0.0.0.0:8080`. Thin wiring
file.

**`matchmaker/Matchmaker.ts`** — the class. Holds
`lobbies: Map<string, LobbyRecord>`. Public methods:

- `match(maxPlayers)` — finds an existing open lobby with room (status
  `'lobby'` or `'starting'`), else spawns a new one. Accepting `'starting'`
  is what stops three tabs from spawning three separate runners.
- `spawnLobby(maxPlayers)` — calls the orchestrator, builds a
  `LobbyRecord`, starts heartbeat polling.
- `beginPolling(record)` — polls each runner's `/status` every 2 seconds
  to refresh `status` and `playerCount`.
- `reap()` — removes lobbies whose runner has transitioned to `'ended'`,
  or that never came up (stuck in `'starting'` for more than 60s). Runs
  on a 10-second interval. Empty pre-match runners are kept alive
  indefinitely — see "Deferred" for warm-pool eviction policy.

Each `LobbyRecord` carries two URLs:
- `wsUrl` — public URL given to the client
  (`ws://localhost:8080/lobby/<id>`).
- `internalWsUrl` — internal URL the proxy targets
  (`ws://runner-<id>:3000`).

Collapsing these caused the matchmaker to proxy to itself during
development. They stay separate.

**`matchmaker/http.ts`** — `createApp(matchmaker, authSecret)` returns the
Express app. Routes:

- `GET  /api/lobbies` — list active lobbies.
- `POST /api/lobbies/match` — find or spawn, returns
  `{ lobbyId, wsUrl, challenge }`.
- `GET  /healthz` — liveness.
- Static client bundle plus SPA fallback for deep links.

Static files are served from `path.join(__dirname, '../../../../public')`.
`__dirname` resolves to `/app/dist/backend/src/matchmaker/` inside the
container; four `..`s lands at `/app/public/`, where the Dockerfile placed
the frontend bundle. If the build output layout changes, this path
changes.

**`matchmaker/wsProxy.ts`** — `attachWsProxy(server, matchmaker)`. Handles
`upgrade` events on `/lobby/<id>`. Looks up the record, rewrites the URL
path to `/` while preserving the query string (auth params), forwards to
`internalWsUrl` via `http-proxy` with `changeOrigin: true`. Error callback
logs failures explicitly — without it, proxy failures were silent.

**`matchmaker/orchestrator/OrchestratorSPI.ts`** — interface defining
`spawn` and `stop`. The seam where Kubernetes slots in alongside Docker
without touching anything else.

**`matchmaker/orchestrator/DockerOrchestrator.ts`** — `dockerode`-backed
implementation. Each runner is created with `AutoRemove: true`, attached
to `ada-battles-net`, given a network alias matching its container name
(`runner-<uuid>`), and passed `LOBBY_ID`, `MAX_PLAYERS`, and
`AUTH_SECRET` as environment variables. The Cmd override is
`['node', 'dist/backend/src/runner.js']`.

### Backend — runner

**`runner.ts`** — the per-match server. Reads `LOBBY_ID`, `MAX_PLAYERS`,
`PORT`, `IDLE_SHUTDOWN_MS`, `AUTH_SECRET` from the environment.
Constructs one `Lobby`. Exposes `GET /status` (matchmaker heartbeat) and
`GET /healthz`. Binds explicitly to `0.0.0.0` — without this, Node bound
IPv6-only inside Alpine and IPv4 connections from siblings on the same
Docker network were refused.

On WebSocket connection:

1. `verifyWalletChallenge(socket.url, LOBBY_ID, AUTH_SECRET)` extracts
   `address`, `challenge`, and `sig` from the query string. Verifies the
   HMAC challenge and the wallet signature. Returns null on any failure
   and the runner disconnects the socket.
2. If the lobby has room and `status === 'lobby'`: adds the player, emits
   `player-id` and `joined-matched-lobby` to the connecting socket,
   broadcasts `player-joined` to the room, calls
   `lobby.startCountdown()` if the lobby is now full.
3. Wires per-socket handlers for `player-input`, `shoot`, `self-hit`,
   `bullet-inactive`, `request-revive`, `request-start`, `request-restart`,
   and `disconnect`.


Idle shutdown: `lastNonEmptyAt` is updated on every player join. When the
lobby has been empty for `IDLE_SHUTDOWN_MS`, the process exits and
Docker's `AutoRemove` cleans up the container.

### Backend — shared infrastructure

**`auth/walletChallenge.ts`** — `verifyWalletChallenge(socketUrl, lobbyId,
authSecret)`. Combines the HMAC challenge check (delegated to
`shared/authChallenge.ts`) with wallet signature verification via
`@cardano-foundation/cardano-verify-datasignature` and address conversion
via `bech32`. Returns `{ addressHex }` on success, null otherwise. Lives
in `backend/` rather than `shared/` because its dependencies are Node-only.

**`WebSocketHub.ts`** — typed wrapper around `ws`. Captures `req.url` in
the `'connection'` handler and exposes it as `socket.url` for per-socket
auth. No `path` option is set on `WebSocketServer`, which lets it accept
upgrades on any path (the proxy rewrites to `/`).

**`Lobby.ts`** — holds the player map, bullet map, and status state
  machine. Allowed transitions:

      lobby     → countdown   (player count hits max)
      lobby     → ended       (had players, all left before countdown)
      countdown → playing     (countdown completes)
      countdown → lobby       (player leaves during countdown)
      playing   → ended       (clean win, or all but one player leaves)

  `'ended'` is terminal — runners are one-shot per match. The client
  re-matchmakes via `POST /api/lobbies/match` for a new game rather than
  resetting the existing lobby. Broadcasts state via
  `hub.to(LOBBY_ID).emit('lobby-state', ...)`.

### Shared

**`shared/authChallenge.ts`** — `issueChallenge(lobbyId, secret)` and
`verifyChallenge(token, lobbyId, secret)`. Token format is
`base64(JSON{lobbyId, nonce, expires}):hmac`. Stateless by design —
matchmaker issues, runner verifies, no shared store needed. Both
processes get `AUTH_SECRET` via environment.

**`shared/wire.ts`** — binary codec, opcode table, encode/decode functions.

**`shared/types.ts`** — wire event maps (`ClientToServerEvents`,
`ServerToClientEvents`) plus shared domain types.

**`shared/constants.ts`** — gameplay constants (canvas size, player
speed, bullet radius, tick rate, countdown duration, etc.).

**`shared/collision.ts`** — pure geometry.

**`shared/index.ts`** — barrel re-export.

**`shared/wire.check.ts`** — codec round-trip checks. Not test
infrastructure proper, but a sanity script. Currently compiles into
`dist/` alongside the real shared files; harmless but can be excluded via
`"../shared/**/*.check.ts"` in `backend/tsconfig.json` exclude.

### Frontend (client)

**`NetworkClient.ts`** — constructor takes `wsUrl: string` and opens the
WebSocket. Two static factories:

- `match(maxPlayers, wallet)` — `POST /api/lobbies/match`, signs the
  returned challenge with the wallet, appends
  `?address=&challenge=&sig=` to the WS URL, returns a `NetworkClient`.
- `spectate(lobbyId, wallet)` — same shape against
  `GET /api/lobbies/:id`.

Inbound messages decoded via `wireDecode` and dispatched to handlers in
`this.listeners`. Outbound sends buffer in `outbox` until the `open`
event fires.

**`walletAuth.ts`** — `connectWallet(walletMeta)` returning
`WalletSession { api, addressHex }`, plus `signChallenge(session,
challenge)` for per-match signing via the CIP-30 `signData` method. No
JWT, no token, no server roundtrip on page load.

**`GameScene.ts`** — constructor takes `(canvas, wallet: WalletSession)`.
`net` uses the definite-assignment assertion (`net!: NetworkClient`)
because it's only set after `NetworkClient.match()` resolves.
`bindNetworkEvents()` runs inside the `.then()` so listeners attach to
the right socket. `render()` uses `this.net?.lobbyId ?? ''` and
`this.net?.localSlot` because `status` flips to `'lobby'` synchronously
when the user clicks Start — before the WebSocket handshake completes —
so the render loop runs at least one frame in the `'lobby'` state with
`this.net` still undefined.

Public `startSpectate(id)` is called from `main.ts` when the page loads
with `?spectate=<id>`.

**`main.ts`** — connects the wallet first, then constructs `GameScene`,
starts the game loop, finally checks the URL for `?spectate=` to call
`scene.startSpectate(id)`.

## Request lifecycle

1. User loads page → matchmaker serves `index.html` and `bundle.js` from
   `/app/public/`.
2. User connects wallet → CIP-30 handshake in the browser; no server
   contact yet.
3. User clicks Start → `NetworkClient.match()` →
   `POST /api/lobbies/match`.
4. Matchmaker calls `dockerode` to create `runner-<uuid>` on
   `ada-battles-net`. Returns `{ lobbyId, wsUrl, challenge }`.
5. Client signs the challenge and opens
   `ws://localhost:8080/lobby/<id>?address=&challenge=&sig=`.
6. Matchmaker's upgrade handler matches the path, looks up the record,
   calls `proxy.ws()` with `changeOrigin: true` and target
   `http://runner-<id>:3000`.
7. Runner accepts the upgrade. `verifyWalletChallenge()` checks the HMAC
   and signature, then `lobby.addPlayer` runs and the runner emits
   `player-id`, `joined-matched-lobby`, and broadcasts `player-joined`.
8. When the lobby fills, `lobby.startCountdown()` runs, broadcasts
   `countdown`, then `lobby-state` with `status: 'playing'`. Client's
   `applyLobbyState` populates the player map and the render loop draws.
9. Game ends → broadcasts `game-over` → client shows end screen. When
   all players disconnect, the runner sits idle for `IDLE_SHUTDOWN_MS`,
   then exits. Docker's `AutoRemove` cleans the container.

## Architectural decisions

**Three sibling top-level directories.** `backend/`, `frontend/`,
`shared/` are peers. Neither client nor server "owns" shared. The Docker
build context is the repo root so all three are visible to the build.
Pre-refactor, server code lived under `frontend/src/server/` and shared
code under `frontend/src/shared/`, which falsely suggested the frontend
owned both.

**Authentication: per-connection wallet signature.** The wallet signs a
matchmaker-issued HMAC challenge on each WebSocket connect. The runner
verifies both the HMAC and the signature at upgrade time. No server-side
sessions, no JWTs. Easiest path to eventual Hydra-based auth — add a
third check in `walletChallenge.ts`: "did this wallet commit a ticket
NFT to the Head?"

**Single image, two entrypoints.** Simpler operationally than maintaining
two images. The default CMD runs the matchmaker; the runner CMD is
overridden at spawn time.

**CommonJS over ESM.** Avoids Node's strict ESM extension requirement.
Both backend and frontend use CJS.

**Relative imports over path aliases.** Aliases don't survive tsc's
emit; runtime workarounds (`tsconfig-paths`, `tsc-alias`) add tooling
debt that doesn't pay off at this codebase size.

**Pluggable orchestration.** `OrchestratorSPI` is a real seam. The
Docker implementation is one file; the K8s implementation will be a
second file in the same directory. Nothing else in the matchmaker
package depends on either implementation.

**Matchmaker as transparent reverse proxy.** Clients only know one URL
(the matchmaker's). Path-based routing `/lobby/<id>` forwards to the
correct runner. Runners don't need individual host port mappings.

**Wallet challenge verification extracted.** `verifyWalletChallenge`
lives in `backend/src/auth/` rather than inline in `runner.ts`. When
Hydra ticket verification lands, it composes here without touching the
runner's connection handler.



## Deferred
 
  ### Hydra integration (next)
 
  - Add a `hydra-node` sidecar to each runner container. The sidecar is a
    separate container (Haskell, ~100MB image) speaking the hydra-node API
    to the runner over the shared pod network. The runner doesn't need
    hydra tooling inside its own image — it talks to the sidecar over the
    hydra-node API socket. The single-image-two-entrypoints model survives.
  - New backend module: `backend/src/hydra/` — home for
    `refereeTxBuilder.ts`, `hydraProvider.ts`, and sidecar coordination.
  - Replace in-memory `Lobby` authority with the on-chain referee contract
    via the existing `txbuilder_referee.py` and `hydra_chain_context.py`.
  - Add a bullet ID counter to `BoardDatum` to prevent simultaneous-shoot
    races on-chain.
  - Add ticket-NFT verification as a third check in
    `verifyWalletChallenge`.
  - Sidecar lifecycle question: when a runner self-exits on idle (or is
    SIGTERM'd by the matchmaker after `'ended'`), what happens to the
    in-flight Hydra Head? Decide whether the runner orchestrates a clean
    Head close (init close → contestation deadline → fanout → exit) or
    whether the sidecar lifecycle is independent and an unclean exit
    leaves the Head in a contestable state.
 
  ### Frontend split (after Hydra)
 
  Split static frontend serving from the matchmaker. Plan: add a Caddy
  reverse proxy as the public-facing service. Caddy serves the static
  bundle and reverse-proxies `/api/*` and `/lobby/*` to the matchmaker.
  Matchmaker stops serving static files and stops publishing a host port
  (becomes internal-only on `ada-battles-net`).
 
  - New service in `docker-compose.yml`: `caddy` (image `caddy:2-alpine`),
    publishes :80/:443, bind-mounts `./public` and a `Caddyfile`.
  - Matchmaker change: delete the `express.static` and SPA-fallback blocks
    from `matchmaker/http.ts`. Drop the static path entirely. Drop the
    `ports:` block from compose.
  - Frontend bundle deploy: build on host (or CI), bind-mount into Caddy.
    Removes the frontend build steps from the matchmaker Dockerfile.
  - TLS: Caddy auto-provisions Let's Encrypt certs in production when
    given a named host block.
  - No frontend code changes — single origin preserved, so no CORS work.
  - Deferred until after Hydra lands. Hydra is core gameplay; this is
    infrastructure cleanup that doesn't unblock anything.
 
  ### Other
 
  - Warm-pool eviction policy. Empty runners live forever once spawned.
    No cap, no oldest-first reaping. Acceptable now since traffic is low;
    revisit if idle runners start consuming meaningful resources.
  - Countdown clock UI remnant. When a player disconnects during
    countdown, the lobby correctly reverts from `'countdown'` to `'lobby'`
    on the server, but a remnant of the countdown clock still appears on
    canvas. Minor bug, client-side render state isn't being cleared.
  - Spectate flow. `GET /api/lobbies/:id` should issue a challenge the
    same way `POST /api/lobbies/match` does. Pre-existing follow-up from
    before the refactor. Deferring spectate work in general for now.
  - Optionally make the static `public/` path an env var
    (`PUBLIC_DIR=/app/public` in compose, relative fallback for host
    dev). Obsoleted by the frontend split if/when that lands.
  - TS module resolution migration. `moduleResolution: "node"` is
    deprecated in TS 7. Migrate to `"node16"` or `"nodenext"` — requires
    adding explicit `.js` extensions to all relative imports in
    `backend/` and `shared/`. Suppressed via `ignoreDeprecations: "5.0"`
    in the meantime.
  - Possibly extract the client-authority combat logic from
    `GameScene.ts` into its own module — but defer until Hydra
    integration starts and the on-chain referee semantics are pinned
    down.

## Operational notes

**Cleaning up dangling runners after a matchmaker crash:**

```bash
docker ps --filter "label=ada-battles.role=lobby-runner" -q | xargs -r docker rm -f
```

**Verifying runner reachability from the matchmaker:**

```bash
RUNNER=$(docker ps --filter "label=ada-battles.role=lobby-runner" --format "{{.Names}}" | head -1)
docker exec ada-battles-matchmaker wget -qO- "http://$RUNNER:3000/status"
```

**Common boot-time failure modes** (resolved during the refactor,
documented here so future operators don't have to rediscover them):

- *EACCES on `/var/run/docker.sock`* — host's docker group GID does not
  match the container's. Fix: set `DOCKER_GID` in `.env` to match
  `getent group docker` on the host, then rebuild.
- *Runner spawned but unreachable, "connection refused"* — Node bound to
  IPv6 only inside the container. Fix: `server.listen(PORT, '0.0.0.0',
  …)` in `runner.ts`.
- *Proxy returns "socket hang up"* — `record.wsUrl` and the proxy target
  collapsed into the same URL, causing the matchmaker to proxy to
  itself. Fix: keep `internalWsUrl` separate from the public `wsUrl`.
- *Proxy returns "socket hang up" with `Host` header mismatch* — proxy
  forwarded the matchmaker's `Host` header to the runner. Fix:
  `changeOrigin: true` on the proxy call.
- *Runners spawn one per tab instead of converging* — `match()` filter
  rejected lobbies in `status === 'starting'`. Fix: accept both
  `'lobby'` and `'starting'`.
- *Render crashes with `Cannot read properties of undefined (reading
  'lobbyId')`* — render loop ran a frame between `status = 'lobby'` and
  `this.net` being assigned. Fix: optional chaining on `this.net?` in
  `render()`.
- *Matchmaker boots, browser gets `ENOENT: no such file or directory,
  stat '/app/dist/public/index.html'`* — static file path in
  `matchmaker/http.ts` had the wrong number of `..`s relative to the
  post-refactor `__dirname`. Fix: four `..`s
  (`../../../../public`) for the current emit layout
  (`/app/dist/backend/src/matchmaker/`).
- *`Cannot find module '/app/dist/.../DockerOrchestrator'` (no
  extension)* — backend tsconfig was set to ESM, which requires `.js`
  extensions on every relative import. Fix: switch backend to
  `module: "commonjs"` / `moduleResolution: "node"`.