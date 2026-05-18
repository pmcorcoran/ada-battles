# Ada Battles — Architecture

This document describes the post-migration architecture of `ada-battles`: a
multiplayer top-down shooter on Cardano, restructured from a Web2 monolith
into a containerised two-tier system in preparation for Hydra Head integration.

## High-level model

Two services, one Docker image, two entrypoints:

- **Matchmaker** — long-running, single instance. Stateless HTTP service plus
  WebSocket reverse proxy. Spawns lobby-runner containers on demand via the
  Docker API. Also serves the static client bundle.
- **Lobby-runner** — ephemeral, one container per match. Single-lobby game
  server. Boots from environment variables, hosts exactly one `Lobby`
  instance, self-exits when idle.

The client only ever talks to one URL: the matchmaker's. WebSocket upgrades on
`/lobby/<id>` are reverse-proxied through the matchmaker to the appropriate
runner container.

```
┌──────────┐  POST /api/lobbies/match   ┌────────────────┐
│ Browser  │ ─────────────────────────► │  Matchmaker    │
│ (Phaser) │ ◄──── { wsUrl, challenge } │  :8080         │
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
```

## Repository layout

```
ada-battles/
├── Dockerfile                          # multi-stage, single image
├── docker-compose.yml                  # dev: matchmaker only
├── .env                                # DOCKER_GID, AUTH_SECRET
├── contracts/
│   ├── hydra_referee.py                # OpShin: client-authority referee
│   └── ticket_minting_contract.py
└── frontend/
    ├── package.json                    # +dockerode, +http-proxy
    └── src/
        ├── server/
        │   ├── matchmaker.ts           # NEW entry: orchestrator + WS proxy
        │   ├── runner.ts               # NEW entry: single-lobby server
        │   ├── Lobby.ts                # unchanged: per-match game state
        │   ├── WebSocketHub.ts         # modified: exposes socket.url
        │   ├── app.ts                  # LEGACY, scheduled for deletion
        │   ├── LobbyManager.ts         # LEGACY, scheduled for deletion
        │   └── auth/
        │       ├── authService.ts
        │       └── authRoutes.ts
        ├── client/
        │   ├── main.ts                 # modified: wallet first, then scene
        │   ├── network/
        │   │   └── NetworkClient.ts    # modified: match() / spectate() factories
        │   ├── wallet/
        │   │   └── walletAuth.ts       # modified: connectWallet + signChallenge
        │   └── game/
        │       └── scenes/
        │           └── GameScene.ts    # modified: async net, null-guarded render
        └── shared/
            ├── authChallenge.ts        # NEW: HMAC challenge issue/verify
            ├── types.ts
            ├── wire.ts                 # binary codec
            └── collision.ts
```

## File-by-file

### Infrastructure

**`Dockerfile`** — multi-stage. Build stage compiles TypeScript and bundles
the client with esbuild. Runtime stage uses `dumb-init`, creates a `docker`
group with `ARG DOCKER_GID` matching the host's group GID, adds the `app`
user to that group, runs as `app`. Default CMD launches the matchmaker; the
runner is started with a `Cmd` override at spawn time.

**`docker-compose.yml`** — declares only the `matchmaker` service.
Bind-mounts `${XDG_RUNTIME_DIR}/docker.sock` so the matchmaker can spawn
sibling containers. Network `ada-battles-net` (bridge) is pre-created so
runners and matchmaker share DNS. Runners are not declared here — they are
created at runtime by the matchmaker via the Docker API.

**`.env`** — `DOCKER_GID=984` (matches the host's docker group GID),
`AUTH_SECRET=<random>` (shared between matchmaker and all runners for HMAC
challenge issue/verify).

### Server

**`matchmaker.ts`** — the orchestrator and reverse proxy. Contains:

- `OrchestratorSPI` interface (`spawn`, `stop`) so production can swap in a
  Kubernetes-backed implementation without touching the rest of the file.
- `DockerOrchestrator` implementation using `dockerode`. Each runner is
  created with `AutoRemove: true`, attached to `ada-battles-net`, given a
  network alias matching its container name (`runner-<uuid>`), and passed
  `LOBBY_ID` / `MAX_PLAYERS` / `AUTH_SECRET` as environment variables.
- `Matchmaker` class. Holds `lobbies: Map<string, LobbyRecord>`. Public
  methods: `list()`, `match(maxPlayers)` (find existing open lobby with
  `status === 'lobby' || 'starting'` and room, else spawn), `spawnLobby()`,
  `beginPolling()` (heartbeats each runner's `/status` endpoint),
  `reap()` (removes lobbies that are ended, empty for more than 60s, or
  never came up).
- HTTP surface: `POST /api/lobbies/match`, `GET /api/lobbies`,
  `GET /api/lobbies/:id`, `GET /healthz`, plus static client bundle and SPA
  fallback for deep links.
- WebSocket upgrade handler on `/lobby/<id>` that uses `http-proxy` to
  forward to the runner's internal URL, preserving the query string so auth
  parameters reach the runner. `changeOrigin: true` is essential — without
  it the `Host` header stays as the matchmaker and some servers reject the
  upgrade. An error callback explicitly destroys the socket so failures
  aren't silent.

Each `LobbyRecord` holds two URLs:
- `wsUrl` — the public URL the client receives
  (`ws://localhost:8080/lobby/<id>`).
- `internalWsUrl` — the URL the proxy targets (`ws://runner-<id>:3000`).

Collapsing these into one field caused the proxy to loop back into itself
during development. They must remain separate.

**`runner.ts`** — the per-match server. Reads `LOBBY_ID`, `MAX_PLAYERS`,
`PORT`, `IDLE_SHUTDOWN_MS`, `AUTH_SECRET` from the environment. Constructs
one `Lobby`. Exposes `GET /status` (for the matchmaker's heartbeat) and
`GET /healthz`. Binds explicitly to `0.0.0.0` — without this, Node binds
IPv6-only inside Alpine containers and IPv4 connections from siblings on
the same Docker network are refused.

On WebSocket connection:

1. `authenticate(socket.url)` extracts `address`, `challenge`, and `sig` from
   the query string. It verifies the HMAC challenge against `AUTH_SECRET`
   and `LOBBY_ID`, then verifies the wallet signature via
   `@cardano-foundation/cardano-verify-datasignature`.
2. If the lobby has room and `status === 'lobby'`: adds the player, emits
   `player-id` and `joined-matched-lobby` to the connecting socket,
   broadcasts `player-joined` to the room, and calls `lobby.startCountdown()`
   if the lobby is now full.
3. Wires per-socket handlers for `player-input`, `shoot`, `self-hit`,
   `bullet-inactive`, `request-revive`, `request-start`, `request-restart`,
   and `disconnect`.

Idle shutdown: `lastNonEmptyAt` is updated on every player join. When the
lobby has been empty for `IDLE_SHUTDOWN_MS`, the process exits and Docker's
`AutoRemove` cleans up the container.

**`WebSocketHub.ts`** — modified during the migration to capture `req.url`
in the `'connection'` handler and pass it through to `HubSocket` as
`public readonly url`. The runner's `authenticate()` reads this property
to extract auth parameters. No `path` option is set on `WebSocketServer`,
which lets it accept upgrades on any path (the proxy rewrites the path to
`/` before forwarding).

**`Lobby.ts`** — unchanged from the monolith. Holds the player map, bullet
map, status state machine (`lobby → countdown → playing → ended`), and
broadcasts state via `hub.to(LOBBY_ID).emit('lobby-state', ...)`.

**`auth/authService.ts`, `auth/authRoutes.ts`** — kept but largely unused
in the new path. The Option 4 auth scheme is stateless, so no shared store
is needed between matchmaker and runner. These remain as scaffolding for
legacy endpoints and will be revisited when Hydra integration lands.

**`app.ts`, `LobbyManager.ts`** — legacy monolith entry and lobby manager.
Kept until the new path has a few weeks of real use, then scheduled for
deletion.

### Shared

**`authChallenge.ts`** — `issueChallenge(lobbyId, secret)` and
`verifyChallenge(token, lobbyId, secret)`. Token format is
`base64(JSON{lobbyId, nonce, expires}):hmac`. Stateless by design — the
matchmaker issues, the runner verifies, no shared store needed. Both
processes get `AUTH_SECRET` via environment.

**`wire.ts`, `types.ts`, `collision.ts`** — unchanged.

### Client

**`NetworkClient.ts`** — refactored. Constructor takes `wsUrl: string` and
opens the WebSocket. Two static factories:

- `match(maxPlayers, wallet)` — `POST /api/lobbies/match`, signs the
  returned challenge with the wallet, appends
  `?address=&challenge=&sig=` to the WS URL, returns a `NetworkClient`.
- `spectate(lobbyId, wallet)` — same shape against `GET /api/lobbies/:id`.

Inbound messages are decoded via `wireDecode` and dispatched to handlers in
`this.listeners`. Outbound sends buffer in `outbox` until the `open` event
fires.

**`walletAuth.ts`** — slimmed. Just `connectWallet(walletMeta)` returning
`WalletSession { api, addressHex }` (no JWT, no token, no server roundtrip
on page load) and `signChallenge(session, challenge)` for per-match signing
via the CIP-30 `signData` method.

**`GameScene.ts`** — constructor takes `(canvas, wallet: WalletSession)`.
`net` uses the definite-assignment assertion (`net!: NetworkClient`)
because it's only set after `NetworkClient.match()` resolves.
`bindNetworkEvents()` is called inside the `.then()` so listeners attach
to the right socket.

`render()` uses `this.net?.lobbyId ?? ''` and `this.net?.localSlot`. This
matters because `status` flips to `'lobby'` synchronously when the user
clicks Start — before the WebSocket handshake completes — so the render
loop runs at least one frame in the `'lobby'` state with `this.net` still
undefined.

Public `startSpectate(id)` is called from `main.ts` when the page loads
with `?spectate=<id>`.

**`main.ts`** — connects the wallet first, then constructs
`GameScene(canvas, session)`, starts the game loop, and finally checks
the URL for `?spectate=` to call `scene.startSpectate(id)`.

## Request lifecycle

1. User loads page → matchmaker serves `index.html` and `bundle.js`.
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
7. Runner accepts the upgrade. `authenticate()` verifies the HMAC
   challenge and wallet signature, then calls `lobby.addPlayer` and emits
   `player-id`, `joined-matched-lobby`, and broadcasts `player-joined`.
8. When the lobby fills, `lobby.startCountdown()` runs, broadcasts
   `countdown`, then `lobby-state` with `status: 'playing'`. Client's
   `applyLobbyState` populates the player map and the render loop draws.
9. Game ends → broadcasts `game-over` → client shows end screen. When all
   players disconnect, runner sits idle for `IDLE_SHUTDOWN_MS`, then
   exits. Docker's `AutoRemove` cleans the container.

## Architectural decisions

**Authentication: Option 4 — per-connection wallet signature.** The
wallet signs a matchmaker-issued HMAC challenge on each WebSocket connect.
The runner verifies both the HMAC and the signature at upgrade time. No
server-side sessions, no JWTs. Easiest path to eventual Hydra-based auth
— just add a third check: "did this wallet commit a ticket NFT to the
Head?"

**Single image, two entrypoints.** Simpler operationally than maintaining
two images. The default CMD runs the matchmaker; the runner CMD is
overridden at spawn time.

**`dockerode` for orchestration, hidden behind `OrchestratorSPI`.**
Production deployments can swap to Kubernetes by implementing the same
interface without touching `Matchmaker` or `runner.ts`.

**Matchmaker as transparent reverse proxy.** Clients only know one URL
(the matchmaker's). Path-based routing `/lobby/<id>` forwards to the
correct runner. This keeps the client deployment story simple and means
runners don't need individual host port mappings.

## Known follow-ups

- Delete `app.ts` and `LobbyManager.ts` once the new path has accumulated
  real usage.
- Rename the inner `auth` shadow in `runner.ts` (it shadows the
  `AuthService` instance) to something like `authResult`.
- Verify the spectate flow end-to-end — `GET /api/lobbies/:id` should
  issue a challenge the same way `POST /api/lobbies/match` does. Only the
  match path has been exercised so far.
- The TypeScript port of the Hydra referee contract
  (`refereeTxBuilder.ts`, `hydraProvider.ts`) is written but not yet wired
  into the client.

## Deferred: Hydra integration (step 3)

- Add a `hydra-node` sidecar to each runner container.
- Replace in-memory `Lobby` authority with the on-chain referee contract
  via the existing `txbuilder_referee.py` and `hydra_chain_context.py`.
- Add a bullet ID counter to `BoardDatum` to prevent simultaneous-shoot
  races on-chain.

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

**Common boot-time failure modes** (resolved during migration, documented
here for future operators):

- *EACCES on `/var/run/docker.sock`* — host's docker group GID does not
  match the container's. Fix: set `DOCKER_GID` in `.env` to match
  `getent group docker` on the host, then rebuild.
- *Runner spawned but unreachable, "connection refused"* — Node bound to
  IPv6 only inside the container. Fix: `server.listen(PORT, '0.0.0.0', ...)`
  in `runner.ts`.
- *Proxy returns "socket hang up"* — `record.wsUrl` and the proxy target
  collapsed into the same URL, causing the matchmaker to proxy to itself.
  Fix: keep `internalWsUrl` separate from the public `wsUrl`.
- *Runners spawn one per tab instead of converging* — `match()` filter
  rejected lobbies in `status === 'starting'`. Fix: accept both `'lobby'`
  and `'starting'`.
- *Render crashes with `Cannot read properties of undefined (reading
  'lobbyId')`* — render loop ran a frame between `status = 'lobby'` and
  `this.net` being assigned. Fix: optional chaining on `this.net?` in
  `render()`.