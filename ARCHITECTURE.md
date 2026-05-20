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
- **Lobby-runner** —  ephemeral, one container per match. Single-lobby game
  server. Boots from environment variables, hosts exactly one Lobby
  instance, self-exits when idle. Each runner is paired with a hydra-node
  sidecar container (see "Hydra sidecar" below).
- **Hydra-node sidecar** — ephemeral, one per runner. A stock upstream
  hydra-node image (not built from this repo). The runner talks to it
  over its WebSocket API on the shared Docker network. In slice 1 it runs
  in offline mode and is observed but not authoritative.

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
│                                  │ :3000          │      ws (offline API)
│                                  │ (one Lobby)    │ ───────────────────┐
│                                  └────────────────┘                    │
│                                                                        ▼
│                                                          ┌──────────────────────┐
│                                                          │ hydra-<uuid>         │
│                                                          │ :4001 (hydra-node)   │
│                                                          │ offline; observed    │
│                                                          └──────────────────────┘

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
│   ├── hydra_referee.py                # OpShin: anti-griefing referee (INCOMPLETE sketch)
│   └── ticket_minting_contract.py
│
├── infra/
│   └── hydra-dev-keys/                 # slice-1 throwaway Hydra key bundle
│       ├── hydra.sk / hydra.vk         # generated; not for any real network
│       ├── initial-utxo.json           # offline-mode L2 seed UTxO
│       └── protocol-parameters.json    # Hydra zero-fee params
│
├── Makefile                            # `make hydra-dev-keys` regenerates the bundle
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
│       ├── runner.ts                   # single-lobby server entry (boots Hydra observer)
│       ├── Lobby.ts                    # per-match game state + tick loop
│       ├── WebSocketHub.ts             # typed ws wrapper, exposes socket.url
│       ├── hydra/                       # Hydra sidecar integration (slice 1: observe-only)
│       │   ├── HydraSidecarClient.ts   # ws client to hydra-node API
│       │   ├── HydraObserver.ts        # event→status reduction; consensus-peer seam
│       │   ├── types.ts                # narrow event/status vocabulary
│       │   └── index.ts                # barrel
│       └── auth/
│           └── walletChallenge.ts      # verifyWalletChallenge (+ticket-NFT TODO)
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
implementation. Takes an options object
(`{ runnerImage, network, hydraImage, hydraDevKeysHostPath, authSecret, … }`)
— note this changed from the original positional `(image, network, port)`
signature when the sidecar was added.
`spawn()` creates two containers per match: the sidecar
(`hydra-<uuid>`) first so the runner can connect on boot, then the runner
(`runner-<uuid>`). If the runner fails to start, the sidecar is rolled
back. Both are `AutoRemove: true`, attached to `ada-battles-net` with
name-matching aliases. The runner gets `LOBBY_ID`, `MAX_PLAYERS`,
`AUTH_SECRET`, and `HYDRA_SIDECAR_URL`
(`ws://hydra-<uuid>:4001/?history=no`). The Cmd override is
`['node', 'dist/backend/src/runner.js']`.
The sidecar is an implementation-private sibling: `OrchestratorSPI`
and `SpawnResult` are unchanged, the matchmaker tracks only the runner,
and `DockerOrchestrator` maps runner→sidecar internally so `stop()` reaps
both. The sidecar launches in offline mode (`--offline-head-seed`,
`--initial-utxo`, `--ledger-protocol-parameters`, `--hydra-signing-key`)
with the `infra/hydra-dev-keys/` bundle bind-mounted read-only at
`/run/hydra`. The bind source is `hydraDevKeysHostPath`, which is a host
path resolved by the Docker daemon, not a path inside the matchmaker
container.

### Backend — runner

**`runner.ts`** the per-match server. Reads `LOBBY_ID`, `MAX_PLAYERS`,
`PORT`, `IDLE_SHUTDOWN_MS`, `AUTH_SECRET`, and `HYDRA_SIDECAR_URL` from the
environment. Constructs one `Lobby`. Exposes `GET /status` (matchmaker
heartbeat, now including a `hydraStatus` field) and `GET /healthz`. Binds
explicitly to `0.0.0.0` — without this, Node bound IPv6-only inside Alpine
and IPv4 connections from siblings on the same Docker network were refused.
After the HTTP server is listening, the runner boots a `HydraObserver`
(from `backend/src/hydra/`) pointed at `HYDRA_SIDECAR_URL`. In slice 1 the
observer is non-authoritative — it logs Head state alongside the
in-memory `Lobby` but does not affect gameplay, and a sidecar that fails
to come up is logged-and-ignored rather than fatal. The runner owns the
sidecar lifecycle (decision (ii)): `shutdown()` awaits
`observer.stop()` before closing the HTTP server. If `HYDRA_SIDECAR_URL`
is unset the observer is disabled entirely (e.g. for a runner spawned
outside the orchestrator).

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



### Backend — Hydra sidecar (backend/src/hydra/)

Slice-1 scope: stand up the sidecar, talk to it, observe it. No
authority moves on-chain yet. Three small files plus a barrel.
`HydraSidecarClient.ts` — a thin ws client to the sidecar's API at
`ws://hydra-<uuid>:4001/?history=no`. Has startup-time reconnect (~12×1s)
because Docker `start()` returns before the hydra-node process binds its
port. Clean close on a 5s budget. No mid-session reconnect yet. Surface:
`connect()`, `on('output'|'error'|'close', …)`, `send(cmd)`, `close()`.
send() exists but is unused in slice 1 — reserved for slice-2 commands
(Init / Commit / SafeClose / Fanout).
`HydraObserver.ts` — subscribes to the client and reduces the
hydra-node event stream to a coarse `HydraStatus`
(`connecting → idle/initializing/open/closed/finalized/aborted/error`),
logging each transition. In offline mode the head is born `Open`, so
`idle` is effectively unreachable until slice 2's online mode introduces a
real `idle → initializing → open` progression. This is the authority
seam for slice 2 — the `handleOutput` switch is where on-chain referee
calls into `Lobby` will live.
`types.ts` — narrow event-tag and status vocabulary, deliberately kept
out of `shared/types.ts`. These are backend-internal until clients need to
react to Head state (slice 2+), at which point the relevant subset gets
promoted to `shared/`.
The sidecar runs a stock upstream `hydra-node` image
(`ghcr.io/cardano-scaling/hydra-node:1.2.0`); no Haskell tooling enters
the runner image. This preserves the single-image-two-entrypoints model:
the matchmaker and runner are still the same image, and the sidecar is a
third, external image pulled at runtime.



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

**Hydra sidecar as implementation-private sibling.** Each runner is paired
with a hydra-node sidecar, but `OrchestratorSPI` and `SpawnResult` are
unchanged — the sidecar is hidden inside `DockerOrchestrator`, which reaps
the pair together. The matchmaker only ever knows about the runner. This
keeps the orchestration seam clean: a future K8s implementation models the
pair as a two-container Pod behind the same interface, with nothing else
in the matchmaker package aware of the sidecar.

**Sidecar lifecycle owned by the runner (option ii).** When a runner
exits, it first closes its sidecar (slice 1: a clean WS close; slice 2:
SafeClose → Fanout → HeadIsFinalized → exit) before closing its own HTTP
server. The alternative — an independent sidecar lifecycle — was rejected
because an unclean exit with an open Hydra Head leaves it in a contestable
state. This is why `runner.ts` `shutdown()` is async and awaits the
observer.

**Security model: N-of-N consensus, not server authority.** Slice 1's
Lobby is a trusted single authority — this is scaffolding, not the
target. In slice 2, every checkpoint state transition is signed by all N
players; no server or client is trusted to assert game state. A cheating
proposal (omitting a hit taken, fabricating damage) is one the honest
peers' deterministic simulations disagree with, so they refuse to sign and
it cannot advance the head. Combat correctness — hit detection, damage,
elimination, bullet flight physics — is enforced by peer consensus, not by
the runner and not by the referee contract. The referee contract is
anti-griefing / O(1) bounds-checking only: it makes certain cheats
impossible to even propose in a locally-valid-looking way (notably bullet
spawn position and initial direction), giving honest peers a cheap
rejection criterion. This mirrors the IOG Hydra Doom approach. State
checkpoints are signed every k frames (k=7 to start), not every 35 FPS
frame, to keep L2 throughput sane for 3–4 player tables.




## Deferred
 
  **Slice 1 (DONE):** non-authoritative sidecar. Each runner spawns a
  hydra-node sidecar in offline mode, connects to its WS API, and logs Head
  state alongside the in-memory `Lobby`. See "Backend — Hydra sidecar" and
  `HANDOFF.md`.
  
  **Slice 2 (NEXT): consensus-enforced gameplay.** Replace the in-memory
  single authority with Hydra N-of-N consensus (see "Security model" in
  Architectural decisions). In rough dependency order:


  
  - **Invert the match flow.** A real Head needs all participants' keys at
    node-launch time, so the matchmaker must collect N authenticated wallets
    in a pre-match waiting room *before* spawning the runner+sidecar. This is
    the biggest structural change — design it before coding. Touches
    `Matchmaker.match()`, `http.ts`, and the client match flow.
  - **Pick a Cardano TS library** (Lucid Evolution / Mesh / `@cardano-sdk`)
    for `refereeTxBuilder.ts`. Deferred in slice 1; now blocking.
  - **Make the runner a consensus peer.** `HydraObserver.handleOutput` stops
    logging and starts tracking `SnapshotConfirmed`; the runner builds,
    validates, and co-signs checkpoint transitions. Combat correctness is
    enforced by peers refusing to sign bad transitions, not by the runner.
    New files `backend/src/hydra/refereeTxBuilder.ts` and `hydraProvider.ts`.
    - **Add ticket-NFT verification** as a third predicate in
    `walletChallenge.ts`.
  - **Switch sidecar offline → online:** real preprod cardano-node,
    per-match keys generated at runner startup (into tmpfs), real Commits
    replacing `--initial-utxo`, fresh protocol params. Retire
    `infra/hydra-dev-keys/`.
  - **Implement the clean Head close** in `runner.ts shutdown()` (SafeClose →
    ReadyToFanout → Fanout → HeadIsFinalized → exit), reconciled with
    `IDLE_SHUTDOWN_MS` and `AutoRemove`.
  
  **Referee contract scope** (`contracts/hydra_referee.py`). An incomplete
  sketch, scope deliberately narrowed to O(1) per-checkpoint checks — do
  not reintroduce per-bullet physics. Checkpoints are signed every k=7
  frames (players simulate at 35 FPS locally; a signed script transition
  happens every 7 frames — ~5/sec, ~15–20 signed L2 txs/sec across the
  table). Target table size 3–4 players. The contract's `current_frame`
  is a checkpoint counter, not a frame counter.
  The contract validates, per checkpoint:

  Bullet spawn position — a bullet created since the last checkpoint
  originates within a bounding box around the muzzle point
  `shooter_pos + (cos rot, sin rot)·(PLAYER_SIDE + BULLET_RADIUS)` (the
  formula `Lobby.tryShoot` uses today). The box must absorb worst-case
  float→int and rotation-quantization error. This is the core anti-cheat:
  stops a player fabricating a bullet on top of a target.
  Bullet initial direction — a newly-fired bullet's `dir_x/dir_y`
  matches the shooter's aim at fire time (`aim_dir_x/aim_dir_y`).
  Movement bound — per-checkpoint displacement within the k-frame
  budget. The sketch's `MAX_SPEED` is per-frame; the checkpoint bound is
  `per_frame_speed × k` (+tolerance). Introduce an explicit constant
  (e.g. `MAX_DISPLACEMENT_PER_CHECKPOINT`) so k lives in one place.
  Shot cooldown — `COOLDOWN_FRAMES` between shots.
  Dead-player gate — health ≤ 0 ⇒ no move, no shoot.

  Peers validate off-chain and enforce by signing / refusing to sign:
  bullet flight physics (`BULLET_SPEED` along the established
  trajectory) and collision/hit resolution; bullet-array integrity is
  likely peer-owned (open).
  Dropped from the sketch: the `for i in range(4)` per-bullet physics
  loop, the flight-position asserts, and the triplicated state-extraction
  blocks. Sketch bugs to fix on rewrite: no-op address check (use
  `own_address_unsafe`), triplicated extraction, duplicated speed/cooldown
  asserts, re-assigned validator params. Open decisions: exact spawn-box
  tolerance (depends on the on-chain coordinate float→int strategy), whether
  bullet-array integrity is contract- or peer-enforced, and confirming the
  k=7 / 3–4-player throughput against a real head before building on it. See
  `HANDOFF.md`.
 
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
  - Possibly extract the local combat-simulation logic from
    `GameScene.ts` into its own module — it will be reused as the
    deterministic per-peer simulation that drives consensus signing. Defer
    until the referee/checkpoint semantics are pinned down.

## Operational notes

**Cleaning up dangling runners after a matchmaker crash:**

```bash
docker ps --filter "label=ada-battles.role=lobby-runner"  -q | xargs -r docker rm -f
docker ps --filter "label=ada-battles.role=hydra-sidecar" -q | xargs -r docker rm -f
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
- *Sidecar exits immediately, runner logs "sidecar unreachable"* — usually
  a bad offline-mode flag or a missing/!malformed file in
  `infra/hydra-dev-keys/`. Check `docker logs hydra-<id>`. Regenerate the
  bundle with `make hydra-dev-keys`.
- *`make hydra-dev-keys` fails with "executable file not found: hydra-node"*
  — don't pass `--entrypoint hydra-node`; the image entrypoint already is
  the binary. Pass `gen-hydra-key …` as arguments only.