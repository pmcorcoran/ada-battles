# Ada Battles — Architecture

This document describes the current architecture of `ada-battles`: a
multiplayer top-down arena shooter on Cardano, restructured from a Web2
monolith into a containerised system in preparation for settling matches on a
Cardano Hydra Head. It reflects the code as it actually stands, and marks
in-progress work (the Hydra integration) as such rather than describing the
target as though it were built.

## Build state at a glance

The Hydra integration is being landed in slices.

- **Built today (slice 1):** the containerised system runs end to end. Players
  authenticate with a wallet and play; each match spawns a `hydra-node`
  sidecar alongside its runner, but the sidecar is **observed only** — the
  runner connects to it, reduces its event stream to a coarse status, and logs
  it. Authority still lives in an in-memory `Lobby` object on the runner. This
  is deliberate scaffolding.
- **The target (slice 2 onward):** authority moves to smart contracts. Game-state
  transitions become hydra transactions checked by referee validators, and
  the match settles on the L1 with all participants signing. The
  on-chain validators (`contracts/`) exist; they are not yet wired to the
  runtime.

If you see the server trusted as the source of truth in the code, that is
slice-1 scaffolding, not the intended end state.

## High-level model

One Docker image, two entrypoints, plus an external image for the Hydra node:

- **Matchmaker** — long-running, single instance. Stateless HTTP service plus
  WebSocket reverse proxy. Spawns match containers on demand via the Docker
  API. Holds no game state. Does **not** serve the frontend (see "Frontend
  serving" below).
- **Lobby-runner** — ephemeral, one container per match. Single-lobby game
  server. Boots from environment variables, hosts exactly one `Lobby`, and
  self-exits when idle. Connects to its Hydra sidecar as an observer.
- **Hydra-node sidecar** — one per runner. A stock upstream `hydra-node` image
  (`ghcr.io/cardano-scaling/hydra-node`), not built from this repo, so no
  Haskell tooling enters the project's own image. The runner reaches it over
  its WebSocket API on the shared Docker network.

The client only ever talks to one URL: the matchmaker's. WebSocket upgrades on
`/lobby/<id>` are reverse-proxied through the matchmaker to the right runner.

```
Browser ──POST /api/lobbies/match──▶ Matchmaker ──dockerode──▶ runner-<id>
        ◀──── { wsUrl, challenge } ──            spawns        │ (one Lobby)
        ──── WS /lobby/<id>?addr&challenge&sig ──▶ (proxied) ───┘
                                                     runner ──ws──▶ hydra-<id>
                                                                    (node sidecar,
                                                                     observed only)
```

## Repository layout

Four top-level source areas — `backend/`, `frontend/`, `shared/` are sibling
TypeScript trees (neither client nor server "owns" shared), plus `contracts/`
(on-chain validators) and `infra/` (dev Hydra key bundle).

```
ada-battles/
├── Dockerfile                 multi-stage, single image, two entrypoints
├── docker-compose.yml         dev: declares only the matchmaker
├── Makefile                   dev convenience (hydra-dev-keys generation)
├── README.md
├── ARCHITECTURE.md            this file
├── docs/
│   └── VISION.md              project ethos + roadmap (aspirational, out of date)
│
├── shared/                    pure isomorphic TypeScript (browser or Node)
│   ├── authChallenge.ts       HMAC challenge issue/verify (stateless)
│   ├── collision.ts           pure geometry
│   ├── constants.ts           gameplay constants
│   ├── types.ts               wire event maps + domain types
│   ├── wire.ts                binary codec + opcode table
│   ├── wire.check.ts          codec round-trip sanity script (not shipped)
│   ├── index.ts               barrel re-export
│   └── tsconfig.json
│
├── backend/
│   ├── package.json           dockerode, http-proxy, ws, express,
│   │                          cardano-verify-datasignature, bech32
│   ├── tsconfig.json          rootDir: "..", module: commonjs
│   ├── src/
│   │   ├── matchmaker/
│   │   │   ├── index.ts        entry: env wiring, listens
│   │   │   ├── Matchmaker.ts   class + LobbyRecord type
│   │   │   ├── http.ts         express routes (API only; CORS)
│   │   │   ├── wsProxy.ts      WS upgrade handler (origin check + proxy)
│   │   │   └── orchestrator/
│   │   │       ├── OrchestratorSPI.ts
│   │   │       └── DockerOrchestrator.ts   spawns runner + sidecar
│   │   ├── runner.ts           single-lobby server entry
│   │   ├── Lobby.ts            per-match game state + tick loop
│   │   ├── WebSocketHub.ts     typed ws wrapper, exposes socket.url
│   │   ├── auth/
│   │   │   └── walletChallenge.ts   verifyWalletChallenge
│   │   └── hydra/
│   │       ├── HydraObserver.ts        reduces sidecar events to status
│   │       ├── HydraSidecarClient.ts   WS client to the sidecar
│   │       ├── types.ts                narrow hydra-node API vocabulary
│   │       └── index.ts
│   └── tests/
│       ├── testBadSig.ts       WS auth rejection test
│       └── testHydraSidecar.ts slice-1 sidecar integration test
│
├── frontend/
│   ├── package.json            esbuild + tsc; bundles to public/bundle.js
│   ├── tsconfig.json
│   ├── txbuilder.py            pycardano tx-builder (Hydra/settlement work)
│   ├── public/                 web root: index.html, bundle.js, config.js
│   └── src/client/
│       ├── main.ts             entry: wallet first, then game
│       ├── engine/             GameLoop, InputManager (game-agnostic)
│       ├── game/
│       │   ├── scenes/         GameScene (menu→lobby→…→ended)
│       │   ├── systems/        RenderSystem, HUDSystem
│       │   └── components/     PlayerComponent, BulletComponent (DTO holders)
│       ├── network/            NetworkClient (match/spectate factories)
│       └── wallet/             cip30, walletAuth, walletUI
│
├── contracts/                  on-chain referee (opshin → Plutus)
│   ├── hydra-referee/          split three-UTxO validators
│   │   ├── shared.py           constants/datums/redeemers/helpers (not a contract)
│   │   ├── position.py         position validator
│   │   ├── bullets.py          bullets validator (spawn + flight + deactivation)
│   │   └── health.py           health validator (hit + revive; cross-player)
│   ├── hydra_referee.py        earlier single-file referee (superseded by split)
│   ├── ticket_minting_contract.py   match-ticket NFT policy
│   ├── tests/
│   └── requirements.txt
│
└── infra/
    └── hydra-dev-keys/         dev Hydra key bundle
```

### Shared layering rule

Anything in `shared/` must be pure TypeScript — no Node built-ins, no native
modules, nothing that wouldn't run in a browser. Wire formats, HMAC, collision
math, constants, types. Anything needing `crypto`, `fs`, `bech32`, or
`@cardano-foundation/cardano-verify-datasignature` lives in `backend/`. That is
why `issueChallenge` / `verifyChallenge` (pure HMAC) live in
`shared/authChallenge.ts` while `verifyWalletChallenge` (wallet signature +
address conversion) lives at `backend/src/auth/walletChallenge.ts`.

### Build outputs

`backend/tsconfig.json` sets `rootDir: ".."` because `include` covers files
outside `backend/src/` (the `shared/` directory). tsc preserves the relative
path structure from the lowest common ancestor of all included files — the repo
root — so the emit is:

```
backend/dist/
├── backend/src/
│   ├── matchmaker/index.js
│   ├── runner.js
│   ├── Lobby.js
│   ├── hydra/…
│   └── auth/walletChallenge.js
└── shared/
    ├── authChallenge.js
    ├── wire.js
    └── …
```

This is reflected in the Dockerfile `CMD` (`node
dist/backend/src/matchmaker/index.js`) and the runner Cmd override in
`DockerOrchestrator` (`node dist/backend/src/runner.js`). If `rootDir` changes,
both must change in lockstep. `backend/tsconfig.json` also excludes
`../shared/**/*.check.ts` so the codec sanity script doesn't ship to `dist/`.

### Module system and imports

Both backend and frontend compile as **CommonJS** (`module: "commonjs"`,
`moduleResolution: "node"`). ESM was abandoned because Node's ESM resolver
requires explicit `.js` extensions on every relative import, which tsc emits
verbatim from source. `moduleResolution: "node"` is deprecated in TS 7 and is
currently suppressed via `ignoreDeprecations: "5.0"` in `backend/tsconfig.json`;
migrating to `"node16"`/`"nodenext"` is deferred.

Relative imports only — no path aliases. `@shared/*` was tried and removed
because tsc doesn't rewrite the alias in emitted JS, so the runtime
`require('@shared/X')` fails. Pattern is `../../shared/X` from `backend/src/`,
deeper relative paths from the frontend's nested client tree.

## File-by-file

### Infrastructure

**`Dockerfile`** — multi-stage, single image. The build stage `npm ci`s the
backend, copies `shared/` and `backend/`, runs `npm run build` (tsc), and prunes
dev deps. The runtime stage uses `dumb-init`, creates a `docker` group with
`ARG DOCKER_GID` matching the host's GID, runs as non-root `app`, and copies the
compiled backend (`/app/dist`) and pruned `node_modules`. Default CMD runs the
matchmaker; the runner Cmd is overridden at spawn time by `DockerOrchestrator`.
Note: the frontend build/copy steps are commented out — **the matchmaker image
no longer contains the frontend** (it is served separately; see "Frontend
serving").

**`docker-compose.yml`** — declares only the `matchmaker` service. Bind-mounts
`${XDG_RUNTIME_DIR}/docker.sock` so the matchmaker can spawn sibling containers,
and shares the `ada-battles-net` bridge network so matchmaker, runners, and
sidecars resolve each other by container name. Runners and sidecars are **not**
declared here — they are created at runtime by the matchmaker via the Docker
API. Sets matchmaker env including `AUTH_SECRET`, `ALLOWED_ORIGINS`,
`HYDRA_NODE_IMAGE`, and `HYDRA_DEV_KEYS_HOST_PATH` (a host path, substituted from
`${PWD}` at up-time, bind-mounted into each sidecar).

**`Makefile`** — dev convenience. The `hydra-dev-keys` target generates a Hydra
keypair (via the hydra-node image), fetches the pinned zero-fee
protocol-parameters JSON, and ensures a seed `initial-utxo.json`, all into
`infra/hydra-dev-keys/`. This bundle is what the sidecar mounts in offline mode.

### Backend — matchmaker

**`matchmaker/index.ts`** — entry. Reads environment, constructs the
`DockerOrchestrator` (with runner + hydra image config), the `Matchmaker`, the
Express app, and the WS proxy; parses `ALLOWED_ORIGINS` once and passes it to
both the app and the proxy; starts the 10-second reaper; listens on
`0.0.0.0:8080`. Warns at startup if `ALLOWED_ORIGINS` is unset.

**`matchmaker/Matchmaker.ts`** — the class. Holds `lobbies: Map<string,
LobbyRecord>`. Public methods:

- `match(maxPlayers)` — finds an existing open lobby with room (status
  `'lobby'` or `'starting'`), else spawns a new one. Accepting `'starting'` is
  what stops three tabs from spawning three separate runners.
- `spawnLobby(maxPlayers)` — calls the orchestrator, builds a `LobbyRecord`,
  starts heartbeat polling.
- `beginPolling(record)` — polls each runner's `/status` every 2 seconds to
  refresh `status` and `playerCount`, until the record is removed.
- `reap()` — removes lobbies whose runner has transitioned to `'ended'`, or that
  never came up (stuck in `'starting'` for more than 60s). Runs on a 10-second
  interval. Empty pre-match runners are kept alive indefinitely so they remain
  available to accept players (see "Deferred" for the missing eviction policy).

Each `LobbyRecord` carries two URLs: `wsUrl` (public, given to the client) and
`internalWsUrl` (what the proxy targets, `ws://runner-<id>:3000`). They stay
separate; collapsing them caused the matchmaker to proxy to itself.

**`matchmaker/http.ts`** — `createApp(matchmaker, authSecret, allowedOrigins)`
returns the Express app. CORS middleware sets `Access-Control-*` headers for
origins on the allow-list (empty list → no header → fails closed cross-origin,
harmless same-origin). Routes: `GET /api/lobbies` (list), `POST
/api/lobbies/match` (find or spawn → `{ lobbyId, wsUrl, challenge }`), `GET
/healthz`. It serves **no** static files. (The file's header comment still
mentions a static bundle; that comment is stale — there is no static-serving
code.)

**`matchmaker/wsProxy.ts`** — `attachWsProxy(server, matchmaker,
allowedOrigins)`. Handles `upgrade` events on `/lobby/<id>`. First applies an
origin check (browser upgrades carry `Origin`; non-browser clients send none and
pass through; empty allow-list disables the check). Then looks up the record,
rewrites the path to `/` while preserving the query string (auth params), and
forwards to `internalWsUrl` via `http-proxy` with `changeOrigin: true`. Because
`changeOrigin` overwrites the Origin header before the hop, the origin check must
live here, not in the runner.

**`orchestrator/OrchestratorSPI.ts`** — interface defining `spawn` and `stop`.
The seam where Kubernetes slots in alongside Docker without touching anything
else in the matchmaker.

**`orchestrator/DockerOrchestrator.ts`** — `dockerode`-backed. Constructed with
an options object (`runnerImage`, `network`, `hydraImage`,
`hydraDevKeysHostPath`, `authSecret`, optional ports). **Per match it spawns two
containers** on `ada-battles-net`:

- `hydra-<lobbyId>` — the sidecar, spawned **first** so the runner can connect
  on boot. Runs the upstream hydra-node in **offline mode** (`--offline-head-seed`
  derived from the lobby UUID, `--initial-utxo`, `--ledger-protocol-parameters`,
  `--hydra-signing-key`, `--api-host/--api-port`), with the dev key bundle
  bind-mounted read-only at `/run/hydra`. No cardano-node is required in offline
  mode. 512 MB cap (heavier than the runner).
- `runner-<lobbyId>` — the game server (this codebase, port 3000). Spawned
  second, with `AutoRemove: true`, a network alias, a 256 MB / 0.5 vCPU cap, and
  env including `HYDRA_SIDECAR_URL=ws://hydra-<id>:4001/?history=no`. If the
  runner spawn fails, the sidecar is rolled back.

The matchmaker tracks only the runner via `SpawnResult`; the sidecar is an
implementation-private sibling, tracked internally (`sidecarByRunner`) and reaped
together with the runner by `stop()`. This keeps `OrchestratorSPI` unchanged —
K8s will use a two-container Pod as the same abstraction.

### Backend — runner

**`runner.ts`** — the per-match server. Reads `LOBBY_ID`, `MAX_PLAYERS`,
`PORT`, `IDLE_SHUTDOWN_MS`, `AUTH_SECRET`, and optional `HYDRA_SIDECAR_URL`.
Constructs one `Lobby`. Exposes `GET /status` (matchmaker heartbeat — includes
`hydraStatus` from the observer, or `'disabled'`) and `GET /healthz`. Binds
explicitly to `0.0.0.0` (without this, Node bound IPv6-only inside Alpine and
sibling IPv4 connections were refused).

On WebSocket connection: `verifyWalletChallenge(socket.url, LOBBY_ID,
AUTH_SECRET)` checks the HMAC challenge and wallet signature; failure
disconnects the socket. On success, if the lobby has room and `status ===
'lobby'`, the player is added and join events broadcast; if full,
`startCountdown()` runs. Otherwise the socket joins as a spectator. Per-socket
handlers are wired for `request-start`, `request-revive`, `player-input`,
`shoot`, `self-hit`, `bullet-inactive`, and `disconnect`. (There is no
`request-restart` — matches are one-shot; clients re-matchmake for a new game.)

Idle shutdown: `trackOccupancy()` starts a timer when the lobby becomes empty
and clears it when a player joins; after `IDLE_SHUTDOWN_MS` empty the process
exits and Docker's `AutoRemove` cleans up.

Hydra (slice 1): after the HTTP server is listening, if `HYDRA_SIDECAR_URL` is
set, the runner constructs a `HydraObserver` and calls `start()` — tolerant of
an unreachable sidecar (logs and continues, since `Lobby` is still authoritative).
On shutdown the observer is stopped first (so a future slice-2 `Close` has a
chance to complete) before the HTTP server closes. The runner owns the sidecar
lifecycle.

### Backend — Hydra integration (`backend/src/hydra/`)

Slice 1: stand up a Hydra node per match and watch it. Non-authoritative.

- **`HydraSidecarClient.ts`** — a thin WebSocket client to the sidecar's API
  (`ws://hydra-<id>:4001/?history=no`). Implements **startup-time reconnect**
  (up to 12 attempts, 1s apart) because Docker's `start()` returns before the
  node binds its API port; it resolves only after the first server frame
  (typically `Greetings`), not on socket open alone. `send()` exists but is
  unused in slice 1 — reserved for the commands (`Init`/`Close`/`Abort`/`Fanout`)
  that drive the Head in slice 2. `close()` is a best-effort clean close with a
  5s timeout.
- **`HydraObserver.ts`** — subscribes to the client, reduces the node's event
  stream to a coarse `HydraStatus`, and logs transitions. **Read-only**: it calls
  nothing on `Lobby`. Its `handleOutput` switch is the seam where the runner will
  later drive Head close/fanout. The observer wraps the client deliberately so
  that slice 2 is a single-file edit rather than a change across the runner.
- **`types.ts`** — a narrow internal vocabulary for node events (`Greetings`,
  `HeadIsInitializing`, `HeadIsOpen`, `HeadIsClosed`, `HeadIsFinalized`, etc.)
  and the reduced `HydraStatus`. Intentionally kept out of `shared/types.ts`:
  it's an internal vocabulary, not a wire contract with the client.

### Backend — shared infrastructure

**`auth/walletChallenge.ts`** — `verifyWalletChallenge(socketUrl, lobbyId,
authSecret)`. Combines the HMAC challenge check (delegated to
`shared/authChallenge.ts`) with wallet-signature verification via
`@cardano-foundation/cardano-verify-datasignature` and address conversion via
`bech32`. Returns `{ addressHex }` on success, null otherwise. Node-only deps, so
it lives in `backend/` rather than `shared/`. This is the composition point for
the planned ticket-NFT check.

**`WebSocketHub.ts`** — typed wrapper around `ws`. Captures `req.url` in the
`connection` handler and exposes it as `socket.url` for per-socket auth. Sets no
`path` on `WebSocketServer`, so it accepts upgrades on any path (the proxy has
already routed; the runner serves at `/`).

**`Lobby.ts`** — per-match game state and tick loop: player map, bullet map, and
the status state machine. Allowed transitions:

```
lobby     → countdown   (player count hits max)
lobby     → ended       (had players, all left before countdown)
countdown → playing     (countdown completes)
countdown → lobby       (a player leaves during countdown)
playing   → ended       (clean win, or all but one player leaves)
```

`'ended'` is terminal — runners are one-shot. The client re-matchmakes via
`POST /api/lobbies/match` for a new game rather than resetting the lobby.
Broadcasts state via `hub.to(LOBBY_ID).emit('lobby-state', …)`. **This is the
current authority** (slice-1 scaffolding — see §"Build state").

### Shared

`shared/authChallenge.ts` — `issueChallenge`/`verifyChallenge`; token format is
`base64(JSON{lobbyId, nonce, expires}):hmac`, stateless (matchmaker issues,
runner verifies, both get `AUTH_SECRET` via env). `shared/wire.ts` — binary
codec and opcode table. `shared/types.ts` — wire event maps
(`ClientToServerEvents`, `ServerToClientEvents`) plus domain types.
`shared/constants.ts` — gameplay constants. `shared/collision.ts` — pure
geometry. `shared/index.ts` — barrel. `shared/wire.check.ts` — codec round-trip
sanity script (excluded from the shipped build).

### Frontend (client)

The client is organised into an engine / game / network / wallet split:

- **`engine/`** — game-agnostic: `GameLoop` (rAF update→render driving a `Scene`
  interface) and `InputManager` (keyboard/mouse state).
- **`game/scenes/GameScene.ts`** — the main `Scene`, driving client states
  `menu → lobby → countdown → playing → ended`. Delegates drawing to
  `RenderSystem`, DOM overlays to `HUDSystem`, networking to `NetworkClient`,
  input to `InputManager`.
- **`game/systems/`** — `RenderSystem` (stateless canvas drawing) and
  `HUDSystem` (DOM overlays: health/reload bars, message popup, player count).
- **`game/components/`** — `PlayerComponent` / `BulletComponent`, plain data
  holders hydrated from `PlayerDTO` / `BulletDTO` each tick.
- **`network/NetworkClient.ts`** — wraps the browser WebSocket with the shared
  typed event maps and the binary codec. Static factories `match(maxPlayers,
  wallet)` and `spectate(lobbyId, wallet)` resolve the URL through the matchmaker
  (signing the returned challenge) before opening the socket. The matchmaker base
  URL is read at runtime from `window.MATCHMAKER_URL` (set by `config.js`),
  falling back to `location.origin`.
- **`wallet/`** — `cip30.ts` (CIP-30 wallet bridge types/helpers, no deps),
  `walletAuth.ts` (`connectWallet` → `WalletSession`, `signChallenge` for
  per-match signing), `walletUI.ts` (connect button + wallet picker).
- **`main.ts`** — connects the wallet first, then starts the scene; handles
  `?spectate=<id>` after the wallet is connected.

**`frontend/txbuilder.py`** — a pycardano transaction builder (uses Ogmios chain
context, mints/handles ticket assets). Part of the on-chain settlement work,
adjacent to the contracts; not part of the browser bundle.

### Frontend serving

The matchmaker does **not** serve the frontend. The frontend is bundled by
esbuild (`npm run build` → `tsc` for declarations + `esbuild --bundle
--format=iife --platform=browser` → `frontend/public/bundle.js`) and the
**web-servable root is `frontend/public/`** (`index.html`, `bundle.js`,
`config.js`). `frontend/dist/` is intermediate tsc output and is not served.

Locally the frontend is served by a separate static server (e.g. `npx serve -s
public -l 3000`) on a different origin from the matchmaker API (`:8080`), which
is why the matchmaker enforces `ALLOWED_ORIGINS` (CORS on the REST API, origin
check at WS upgrade). `config.js` sets `window.MATCHMAKER_URL` per environment;
keep schemes consistent (http page + http API + ws socket locally, https + wss in
production).

### Contracts (`contracts/`)

The on-chain referee, written in opshin (Python → Plutus). The current design
splits per-player state across three UTxOs, each guarded by its own spending
validator in `contracts/hydra-referee/`:

- **`shared.py`** — constants, datum types, redeemers, helpers shared by the
  three validators. Not itself a contract (no `validator` function). Carries the
  integer coordinate/scale convention that must match `shared/constants.ts`
  off-chain — all on-chain values are integers, with off-chain floats quantised
  to the same grid before building datums/redeemers.
- **`position.py`** — owner-only writer; per-checkpoint movement bounds,
  map bounds, and a dead-player gate (reading health as a reference input).
- **`bullets.py`** — owner-only writer; validates firing (cooldown + muzzle-origin
  spawn legitimacy), in-flight advancement along the immutable trajectory
  (contract-enforced so a Hit can't rely on a fabricated bullet position), and
  deactivation (agnostic about why — a Hit is a bullets-spend joined to a victim
  health-spend, and the health validator owns the intersection check).
- **`health.py`** — the only cross-player write and the terminal state fanned out
  at Head close (so it must stay within L1 execution limits). Dispatches on a
  redeemer union: `HitInput` (shooter authors and signs the damage, also spending
  their own bullet UTxO so the bullet's verified flight backs the intersection
  test) and `ReviveInput` (self-revive, legal only if the eliminator is currently
  dead, within a window, respawning clear of live players).

`contracts/hydra_referee.py` is an earlier single-file version superseded by the
split. `contracts/ticket_minting_contract.py` is the match-ticket NFT policy
(mint/burn). See `contracts/` for tests and `requirements.txt`.

The relationship between the two enforcement mechanisms is worth holding
separate: the **contracts** enforce *legality* (which transitions were ever
valid), and Hydra **signatures** enforce *settlement* (which valid final state
lands on L1). Neither substitutes for the other. The full anti-cheat rationale —
including why damage is shooter-asserted (to convert an unfixable "omission"
cheat into a catchable "commission" one) and the N-of-N settlement model — is
the project's design target; see `docs/VISION.md` for the ethos and roadmap.

## Request lifecycle (today)

1. The browser loads the page from the static frontend host (not the
   matchmaker).
2. The player connects a wallet → CIP-30 handshake in the browser; no server
   contact yet.
3. The player clicks Start → `NetworkClient.match()` → `POST
   /api/lobbies/match`.
4. The matchmaker spawns the sidecar, then the runner, on `ada-battles-net`, and
   returns `{ lobbyId, wsUrl, challenge }`.
5. The runner boots, brings up its `HydraObserver` against the sidecar (offline
   mode → status settles at `idle`), and begins serving.
6. The client signs the challenge and opens
   `ws(s)://<matchmaker>/lobby/<id>?address=&challenge=&sig=`.
7. The matchmaker's upgrade handler checks origin, looks up the record, and
   proxies the upgrade to `http://runner-<id>:3000` with `changeOrigin: true`.
8. The runner verifies the HMAC + signature, adds the player, broadcasts join
   events; when the lobby fills, countdown then play begin.
9. The match ends (`game-over`); when all players disconnect the runner idles for
   `IDLE_SHUTDOWN_MS`, then exits. Docker removes the runner; the matchmaker's
   reaper observes `'ended'` (or the stale record) and calls `stop()`, which also
   reaps the sidecar.

## Architectural decisions

**Three sibling source directories.** `backend/`, `frontend/`, `shared/` are
peers; neither client nor server owns shared. The Docker build context is the
repo root so the build sees all of them.

**Single image, two entrypoints.** Simpler operationally than two images. The
default CMD runs the matchmaker; the runner CMD is overridden at spawn time. The
frontend is no longer in this image at all.

**Two containers per match, one tracked.** The runner and its hydra-node sidecar
are spawned as a pair, but only the runner is exposed through `SpawnResult`. The
sidecar is private to `DockerOrchestrator` and reaped with the runner. This keeps
`OrchestratorSPI` a clean two-method seam and maps directly onto a future K8s
two-container Pod.

**Per-connection wallet signature.** The wallet signs a matchmaker-issued HMAC
challenge on each WS connect; the runner verifies HMAC + signature at upgrade
time. No sessions, no JWTs. The eventual ticket-NFT check composes into
`verifyWalletChallenge` without touching the runner's connection handler.

**Pluggable orchestration.** `OrchestratorSPI` is a real seam — Docker is one
file; a Kubernetes implementation is a second file in the same directory with
nothing else changed.

**Matchmaker as transparent reverse proxy.** Clients know one URL; path-based
`/lobby/<id>` routing forwards to the right runner. Runners need no individual
public ports.

**Hydra observer seam before authority.** Slice 1 wires the sidecar as a
read-only observer behind `HydraObserver`, deliberately so the integration
mechanics (sidecar lifecycle, WS startup reconnect, event vocabulary) are shaken
out before slice 2 makes the Head authoritative — at which point the change is
concentrated in `HydraObserver.handleOutput` rather than spread across the runner.

**CommonJS over ESM; relative imports over aliases.** Both avoid tsc-emit
friction (ESM extension requirement; aliases not rewritten in output).

## Deferred

### Hydra integration (next slices)

- Make the Head authoritative: drive `Init`/commit/`Close`/`Fanout` from the
  runner via `HydraSidecarClient.send()`, reduce in `HydraObserver.handleOutput`,
  and replace in-memory `Lobby` authority with on-chain referee transactions.
- Wire the `contracts/hydra-referee/` validators (position/bullets/health) into
  the runtime; build transitions off-chain (see `frontend/txbuilder.py` and the
  referee tx-building work) with the integer-grid quantisation in `shared.py`.
- Switch the sidecar from offline mode to online (real cardano-node socket,
  per-match keys, peers) — slice 2 adds the flags deliberately omitted in offline
  mode.
- Add ticket-NFT verification as a third predicate in `verifyWalletChallenge`.
- Resolve the sidecar/Head lifecycle on unclean exit: when a runner self-exits on
  idle or is SIGTERM'd after `'ended'`, decide whether it orchestrates a clean
  Head close (close → contestation deadline → fanout → exit) or accepts a
  contestable Head on unclean exit. The runner-owns-sidecar decision and the
  shutdown ordering are already in place to support the clean path.
- Settle the N-of-N stall policy (any participant can stall by not signing; the
  runner's extra key drives close/fanout but cannot sign for a player).

### Other

- Warm-pool eviction policy. Empty runners live forever once spawned — no cap, no
  oldest-first reaping. Fine at current traffic; revisit at scale.
- Countdown clock UI remnant. When a player leaves during countdown the server
  correctly reverts `countdown → lobby`, but a remnant of the countdown clock can
  still render client-side. Minor render-state cleanup.
- Spectate flow. `GET /api/lobbies/:id` should issue a challenge the same way
  `POST /api/lobbies/match` does. Spectate work is otherwise deferred.
- Frontend serving in production. Locally a static `serve` provides the bundle on
  a separate origin; production needs a deliberate static host / reverse proxy in
  front of the API. The decoupling (no static serving in the matchmaker, runtime
  `config.js`, CORS/origin allow-list) is done and host-independent.
- Stale header comment in `matchmaker/http.ts` ("static client bundle + SPA
  fallback") — no longer accurate; remove when convenient.
- TS module-resolution migration off the deprecated `"node"` value before TS 7.

## Operational notes

**Clean up dangling runners and sidecars after a matchmaker crash:**

```bash
docker ps --filter "label=ada-battles.role=lobby-runner"  -q | xargs -r docker rm -f
docker ps --filter "label=ada-battles.role=hydra-sidecar" -q | xargs -r docker rm -f
```

**Generate the dev Hydra key bundle (once, before first run):**

```bash
make hydra-dev-keys      # writes infra/hydra-dev-keys/
```

**Verify a runner is reachable from the matchmaker:**

```bash
RUNNER=$(docker ps --filter "label=ada-battles.role=lobby-runner" --format "{{.Names}}" | head -1)
docker exec ada-battles-matchmaker wget -qO- "http://$RUNNER:3000/status"
```

`/status` includes `hydraStatus`, so this also shows the observer's view of the
sidecar (`connecting` → `idle` in offline mode).

**Tests:** `backend/tests/testBadSig.ts` (WS auth rejection) and
`backend/tests/testHydraSidecar.ts` (slice-1 sidecar lifecycle: match spawns a
sidecar, `/status` `hydraStatus` progresses past `Greetings`, both reaped on
cleanup).

**Common boot-time failure modes** (resolved during the refactor; documented so
operators don't rediscover them): docker-socket GID mismatch (`EACCES` →
set `DOCKER_GID`); runner IPv6-only bind (`connection refused` →
`listen(PORT, '0.0.0.0')`); proxy self-target or `Host` mismatch (`socket hang
up` → keep `internalWsUrl` separate, `changeOrigin: true`); one-runner-per-tab
(`match()` must accept `'starting'`).