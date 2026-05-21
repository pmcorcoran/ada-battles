# Ada Battles

A multiplayer top-down shooter on Cardano. Players join short PvP matches, move
and shoot in real time, and the game's combat state is settled on a Cardano
**Hydra Head** — a layer-2 state channel — rather than a trusted game server.

The project is a refactor of an earlier Web2 monolith into a containerised
system built to integrate Hydra, with on-chain anti-cheat enforced by smart
contracts.

---

## What it is

- **A real-time arena shooter.** Small matches (target 3–4 players), 35 FPS
  client simulation, movement + shooting + bullet flight, health, eliminations,
  and self-revive.
- **Settled on Hydra, not on a server.** Game state transitions are validated by
  on-chain referee contracts running inside a Hydra Head, so correctness does
  not depend on trusting the operator's game server.
- **Browser-only for players.** Players connect a Cardano wallet and play in the
  browser. They do not run their own Hydra node.

## How it's put together

Two services from a single Docker image with two entrypoints:

- **Matchmaker** — one long-running instance. Authenticates players, forms
  matches, serves the client, and reverse-proxies each player's WebSocket
  connection to the right match.
- **Lobby-runner** — one ephemeral container per match. Runs a single game
  lobby and self-exits when idle. Each runner is paired with a **hydra-node
  sidecar** that hosts the match's Hydra Head.

The browser only ever talks to the matchmaker; the matchmaker spawns and proxies
to runners on demand.

## The trust model in one paragraph

A Cardano validator can only reject a *submitted* transaction, so it naturally
catches "commission" cheats (proposing an illegal move) but is blind to
"omission" cheats (refusing to apply a true fact, like ignoring a hit you took).
Ada Battles closes that gap by making **damage shooter-asserted**: the player who
fires authors the transaction that damages their target, so a victim can't hide
a hit by staying silent. The contract then verifies the hit really connects.
Player state is split across separate UTxOs (position, bullets, health) so the
common per-tick writes never contend and the only cross-player write — damage —
is isolated. See `contracts/README.md` for the full design.

## Repository layout

```
ada-battles/
├── backend/      matchmaker + lobby-runner (TypeScript)
├── frontend/     browser client
├── shared/       isomorphic TS shared by client and server
├── contracts/    on-chain referee + ticket contracts (opshin / Plutus V3)
├── Dockerfile    single multi-stage image, two entrypoints
├── docker-compose.yml    
└── ARCHITECTURE.md
```

## Status

The system is being built up to full Hydra integration in slices.

- **Done:** the containerised matchmaker/runner split, wallet authentication,
  and the first Hydra slice — each runner spawns a hydra-node sidecar, connects
  to it, and observes Head state (offline mode, not yet authoritative).
- **In progress:** making the Head authoritative — the three referee validators
  (`position`, `bullets`, `health`) are designed and compiling, and the
  remaining work is the inverted match flow, the off-chain transaction builder,
  ticket-NFT verification, and switching the sidecar from offline to online.

For the on-chain design and decisions, see **`contracts/README.md`**. For the
system architecture, see **`ARCHITECTURE.md`**.

## Tech

TypeScript (client, matchmaker, runner), Docker, Cardano, Hydra, and opshin
(Python-to-Plutus) for the contracts.