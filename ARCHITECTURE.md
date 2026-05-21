# Ada Battles — Architecture (Orientation)

A self-contained tour of the `ada-battles` repository for someone coming to it
fresh: what the system is, how the pieces fit together, and the security model it
is being built toward. Where the current code is scaffolding for a later target,
this doc says so inline rather than pretending the target is already built.

---

## 1. What it is

Ada Battles is a multiplayer top-down arena shooter on Cardano. Players connect a
wallet, join a short PvP match (target 3–4 players), and move/shoot in real time
at 35 FPS. The distinguishing goal: combat is settled on a Cardano **Hydra Head**
— a layer-2 state channel — with anti-cheat enforced by smart contracts, rather
than by trusting a game server.

The project was refactored from an earlier Web2 monolith into a containerised
two-tier system specifically to make that Hydra integration possible.

### Build state at a glance

The Hydra integration is being landed in slices.

- **Built today (slice 1):** the containerised system runs, players authenticate
  with their wallet and play, and each match spins up a Hydra node alongside it —
  but the node is *observed only*. Authority currently lives in an in-memory game
  object on the server (`Lobby`). This is deliberate scaffolding.
- **The target:** authority moves off the server. Game-state transitions become
  on-chain transactions checked by referee validators, and the match's final
  state is settled on the Hydra Head by all participants. §5 explains this in
  full.

If you see the server trusted as the source of truth in the code, that is slice-1
scaffolding, not the intended end state.

---

## 2. The two services

The system is **one Docker image with two entrypoints**, plus a third external
image for the Hydra node.

- **Matchmaker** — one long-running instance. A stateless HTTP service plus a
  WebSocket reverse proxy. It authenticates players, decides which match a player
  joins, spawns match containers on demand via the Docker API, and serves the
  client bundle. The browser only ever talks to this one URL.
- **Lobby-runner** — one ephemeral container per match. A single-match game
  server: it boots from environment variables, hosts exactly one match, and
  self-exits when idle (Docker's `AutoRemove` then cleans it up).
- **Hydra-node sidecar** — one per runner. A stock upstream `hydra-node` image
  (`ghcr.io/cardano-scaling/hydra-node`), not built from this repo, so no Haskell
  tooling enters the project's own image. The runner talks to it over its
  WebSocket API on a shared Docker network.

The client connects to `ws://<matchmaker>/lobby/<id>`; the matchmaker proxies that
WebSocket upgrade through to the right runner container. Runners never need
individual public ports.

```
Browser ──POST /api/lobbies/match──▶ Matchmaker ──dockerode──▶ runner-<id>
        ◀──── { wsUrl, challenge } ──            spawns        │ (one match)
        ──── WS /lobby/<id>?addr&sig ──▶ (proxied) ────────────┘
                                                     runner ──ws──▶ hydra-<id>
                                                                    (node sidecar)
```

---

## 3. Repository layout

Three sibling top-level source directories — neither client nor server "owns"
shared — plus contracts and infra.

```
ada-battles/
├── Dockerfile                 multi-stage, single image, two entrypoints
├── docker-compose.yml         dev: declares only the matchmaker
├── shared/                    pure isomorphic TypeScript (runs in browser or Node)
├── backend/                   matchmaker + lobby-runner + Hydra integration
├── frontend/                  browser client
├── contracts/                 on-chain validators (opshin / Plutus V3)
└── infra/                     dev Hydra key bundle + parameters
```

A hard rule worth knowing up front: **anything in `shared/` must be pure
TypeScript** — no Node built-ins, no native modules, nothing that wouldn't run in
a browser. Wire formats, HMAC, collision math, constants, and types live there.
Anything needing `crypto`, `fs`, `bech32`, or Cardano verification libraries lives
in `backend/`. That is why HMAC challenge issue/verify is in
`shared/authChallenge.ts` while wallet-signature verification is in
`backend/src/auth/`.

Both backend and frontend compile as **CommonJS** with relative imports (no path
aliases) — chosen because TypeScript's emit doesn't rewrite path aliases and
Node's ESM resolver would require `.js` extensions on every relative import.

---

## 4. Per-area walkthrough

### Matchmaker (`backend/src/matchmaker/`)

The front door. Key pieces:

- `index.ts` — entry: wires environment, constructs the orchestrator and
  matchmaker, mounts HTTP routes, attaches the WS proxy, starts a background
  reaper, listens on `:8080`.
- `Matchmaker.ts` — holds the map of active matches. Finds an open match with
  room or spawns a new one (accepting an already-"starting" match is what stops
  three browser tabs from each spawning a separate runner), polls each runner's
  `/status` to track liveness, and reaps matches that have ended or never came
  up.
- `http.ts` — the Express app: list matches, the match endpoint, health check,
  and serving the static client bundle.
- `wsProxy.ts` — handles WebSocket `upgrade` events on `/lobby/<id>`, looks up the
  match, and forwards the connection (with its auth query string intact) to the
  runner.
- `orchestrator/` — `OrchestratorSPI.ts` is the interface (spawn/stop); 
  `DockerOrchestrator.ts` is the `dockerode`-backed implementation that creates
  containers. The interface is a real seam: a Kubernetes implementation would be
  a second file here without touching anything else.

### Lobby-runner (`backend/src/`)

The per-match server.

- `runner.ts` — entry. Reads its match config from the environment, constructs one
  `Lobby`, exposes `/status` (matchmaker heartbeat) and `/healthz`, and on each
  WebSocket connection verifies the wallet challenge before admitting the player.
  After the HTTP server is up it boots a `HydraObserver` pointed at its sidecar.
- `Lobby.ts` — the per-match game state and tick loop: player map, bullet map, and
  a status state machine (`lobby → countdown → playing → ended`). `ended` is
  terminal — runners are one-shot; the client re-matchmakes for a new game. **This
  is the current authority** (slice-1 scaffolding; see §5).
- `WebSocketHub.ts` — a typed wrapper around `ws` that exposes each socket's URL
  for per-connection auth.

### Hydra integration (`backend/src/hydra/`)

Today this stands up a Hydra node per match and watches it.

- `HydraSidecarClient.ts` — a thin WebSocket client to the node's API. Has
  startup-time reconnect because the container's `start()` returns before the
  node binds its API port. Its `send()` exists but is unused so far — reserved for
  the commands that drive the Head later.
- `HydraObserver.ts` — subscribes to the node's event stream, reduces it to a
  coarse status (connecting → open → closed → finalized, etc.), and logs
  transitions. Today it is **read-only**: it calls nothing on `Lobby`. Its
  `handleOutput` switch is the seam where the runner will later drive the Head's
  close/fanout.
- `types.ts` — a narrow internal vocabulary for node events and status, kept out
  of `shared/` until the client needs to react to Head state.

### Shared (`shared/`)

Isomorphic TypeScript used by both sides: `wire.ts` (binary codec + opcode table),
`types.ts` (wire event maps + domain types), `constants.ts` (gameplay constants:
canvas size, speeds, tick rate), `collision.ts` (pure geometry), and
`authChallenge.ts` (stateless HMAC challenge issue/verify — the matchmaker issues,
the runner verifies, no shared store needed).

### Frontend (`frontend/src/`)

- `wallet/walletAuth.ts` — connects a CIP-30 wallet in the browser and signs the
  matchmaker's challenge; no server roundtrip on page load.
- `client/network/NetworkClient.ts` — calls the match endpoint, signs the returned
  challenge, opens the authenticated WebSocket, and dispatches decoded messages.
- `game/scenes/GameScene.ts` — the render loop and game scene, wired to network
  events once the connection resolves.
- `client/main.ts` — connects the wallet first, then starts the scene.

### Contracts (`contracts/`)

The on-chain referee, written in opshin (Python → Plutus V3). Three spending
validators over a split player state, plus shared definitions:

- `shared.py` — constants, datum types, redeemers, helpers (not itself a
  contract).
- `position.py`, `bullets.py`, `health.py` — one validator each.
- `ticket_minting_contract.py` — match-ticket NFT policy.

See `contracts/README.md` for the full on-chain design. §6 below summarises how
they enforce anti-cheat.

### Infra (`infra/`)

A throwaway Hydra key bundle and protocol-parameters file used to bring the node
up self-contained in development (offline mode). Not for any real network.

---

## 5. The security model (target)

This is the heart of the project, and it is mostly *not yet wired in* — slice 1
runs with the server-side `Lobby` as a trusted authority. Here is what it is being
replaced by.

### Why the server can't stay the authority

A trusted game server is the thing a blockchain game is supposed to remove. The
target moves authority off the server and onto two mechanisms working together:
on-chain validators that decide which moves are *legal*, and Hydra signatures that
decide which final state *settles*.

### Contract-enforced legality

The match runs inside a Hydra Head — a private layer-2 ledger shared by the
match's participants, running the same ledger rules as Cardano L1. Players submit
their game-state transitions as transactions into the Head, and **referee
validators check each one**. An illegal transition (teleporting, firing through
cooldown, fabricating a bullet on a target) is a transaction the validator sees
and rejects.

There is a catch a validator can't escape: it only runs on a transaction that is
*submitted*. So it naturally catches "commission" cheats (proposing something
illegal) but is blind to "omission" cheats (declining to do something true) — most
importantly, a player who is hit simply never submitting the transaction that
lowers their own health. No transaction, nothing to reject.

### Shooter-asserted damage

The fix is to flip who reports damage. When player A hits player B, **A authors
the transaction that lowers B's health** — B is never the reporter, so B can't
hide a hit by staying silent. The contract then verifies the hit genuinely
connects (the bullet's path intersects B's position). This converts the
unfixable omission cheat into a commission cheat (A over-reporting a hit) that the
contract *can* catch. Player state is split across separate UTxOs (position,
bullets, health) so that the constant per-tick writes never collide and the only
cross-player write — damage — is isolated. Details are in `contracts/README.md`.

### (N+1)-of-(N+1) settlement

A Hydra Head finalises by having its participants sign snapshots of the agreed
state; the protocol requires *all* participants to sign. The target makes the
match an **(N+1)-of-(N+1)** Head: one server-hosted managed Hydra node per player,
plus one for the runner.

- **Players hold their own signing key in the browser.** A browser can't be a
  full Head participant on its own (it can't maintain the ledger view or join the
  node gossip), so each player gets a server-hosted *managed* node that does the
  protocol work but holds **no key**. When a snapshot needs signing, the node
  forwards it to the browser, which signs it (a small Ed25519 signature, easy in
  the browser) and returns it. The player's key never leaves their machine; the
  node can stall but can't forge their signature.
- **No single party can force the final state** — not even the runner — because
  every snapshot needs everyone's signature. This is what makes settlement
  trustless.
- **The runner's extra key is for liveness, not authority.** Browsers disconnect
  and rage-quit; the runner is the dependable party that drives the Head's close
  and fanout, watches for a bad close, and disputes it with the correct latest
  snapshot. Hydra has no majority/tiebreak mechanism — a snapshot is either signed
  by everyone (final) or it isn't — so the runner cannot overrule players; it just
  guarantees *someone* carries the agreed state home.

### The two guarantees, kept separate

It's worth holding these apart: the **contracts** enforce *legality* (which
transitions were ever valid), and the **signatures** enforce *settlement* (which
valid final state lands on L1). Neither substitutes for the other.

### A known hard problem

Because every participant must sign, any one of them — a player on a bad
connection, or a deliberate griefer — can stall in-game progress by not signing.
The runner's extra key helps drive close/fanout but cannot sign on a player's
behalf. A stall policy (how long before the runner closes on the last agreed
state, what the stalled player sees) is an open design problem, not a solved one.

---

## 6. How the referee contract enforces anti-cheat

Summarised from `contracts/README.md`. Players simulate locally at 35 FPS, but a
signed on-chain transition (a "checkpoint") happens every k frames (k=7 to start,
~5 per second) to keep layer-2 throughput sane. All on-chain values are integers;
the off-chain code quantises floats to a fixed integer grid before building
transactions.

State is split into three UTxOs per player, each guarded by its own validator:

- **Position** (`position.py`) — written every checkpoint by the owner only.
  Enforces per-checkpoint movement bounds (anti-teleport), map bounds, and the
  dead-player gate (a dead player can't move).
- **Bullets** (`bullets.py`) — written by the owner when firing. Enforces shot
  cooldown, that a newly-fired bullet spawns at the shooter's muzzle with the
  aimed trajectory (the core "no fabricating a bullet on a target" check), and
  bullet **flight** (an in-flight bullet advances correctly along its path).
- **Health** (`health.py`) — the only cross-player write. Handles shooter-asserted
  hits (verifying the asserting shooter's bullet really intersects the victim) and
  self-revive (a player may revive only if the player who eliminated them is
  currently dead, within a window, respawning clear of other live players).

Cross-field checks that span UTxOs (e.g. "am I alive?" when moving) are satisfied
by reading the other UTxOs as read-only reference inputs, which avoids contention.

One settlement constraint shapes the contract: the health UTxOs are the state
fanned out to L1 when the Head closes, so their validator must stay within L1's
execution limits, even though mid-game transitions can use the Head's higher
layer-2 execution budget.

---

## 7. Request lifecycle (today)

1. Browser loads the page; the matchmaker serves the client bundle.
2. The player connects a wallet (CIP-30 handshake in the browser; no server
   contact yet).
3. The player starts a match → `POST /api/lobbies/match`.
4. The matchmaker spawns a runner (and its Hydra node sidecar) and returns a
   WebSocket URL plus an auth challenge.
5. The browser signs the challenge and opens the WebSocket; the matchmaker proxies
   the upgrade to the runner.
6. The runner verifies the challenge + wallet signature, adds the player, and
   broadcasts join events; when the match fills, the countdown and then play
   begin.
7. The game ends; when all players disconnect the runner idles, then exits, and
   Docker removes the container.

Authentication is per-connection: the wallet signs a matchmaker-issued HMAC
challenge on each connect, and the runner verifies both the HMAC and the
signature at upgrade time — no server-side sessions or tokens. The match-ticket
NFT check is intended to compose into this same verification step.

---

## 8. Operational notes

- The matchmaker bind-mounts the Docker socket so it can spawn sibling containers;
  all containers share the `ada-battles-net` bridge network and resolve each other
  by container name.
- The single image carries both entrypoints; the matchmaker is the default
  command, and the runner command is overridden by the orchestrator at spawn time.
- The Hydra node runs as a separate upstream image pulled at runtime, keeping the
  project's own image free of Haskell tooling.
- In development the Hydra node runs in offline mode with the `infra/` key bundle;
  the target switches it to online mode against a real Cardano testnet node.