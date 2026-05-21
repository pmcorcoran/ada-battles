# Ada Battles — Referee Contracts

On-chain anti-cheat validators for Ada Battles running inside a Hydra Head.
This directory holds the Plutus V3 spending validators (compiled with opshin)
and the shared types/constants they share with the off-chain TypeScript build.

This README is the source of truth for *why* the contracts are shaped the way
they are — the **legality layer** (which game-state transitions are valid). On
that layer, the decisions below were made deliberately; several reverse earlier
assumptions in `HANDOFF.md`, and where they do, this document wins.

It is **not** the source of truth for the **settlement layer** (the Hydra Head
signing topology, snapshot signing, and close/fanout). That is owned by
`HANDOFF.md` ("The big decision") and `ARCHITECTURE.md`; §1 summarises it only to
situate the validators, and on any settlement conflict, `HANDOFF.md` wins. See §1
for why the two layers are independent.

---

## 1. The security model: contract-enforced, not peer-consensus

Earlier design notes described an N-of-N peer-consensus model where every player
holds a Hydra key, re-simulates each tick, and refuses to co-sign a transition
they disagree with. We investigated how IOG actually built Hydra Doom and chose
a different model, because the consensus story does not fit a browser-only,
PvP game.

What Hydra Doom actually does: each player's browser submits state-transition
transactions to a Hydra Head, and an on-chain validator (the contract) checks
that the transition is legal. The *legality* of a transition does not depend on
who signs the Head's snapshots — the contract is the referee either way. Doom got
away with a thin model because it is single-player: the only "opponent" is
deterministic game AI that cannot lie.

Ada Battles is PvP, so we adopt **Model B (contract-enforced)** but have to do
more work than Doom, because two humans can each benefit from misrepresenting
shared state.

### Two separate guarantees: legality and settlement

The model rests on two guarantees that are easy to conflate but must be kept
apart, because they are enforced by different mechanisms:

- **Legality — *which transitions were ever valid*.** Enforced by the
  **validators in this directory**, not by player signatures and not by the
  runner's authority. Each game-state transition is a transaction the validator
  checks; illegal transitions are rejected on submission, regardless of who
  submits them. This is the layer this README is mostly about.
- **Settlement — *which final state lands on L1*.** Enforced by the Hydra Head's
  snapshot-signing topology, *not* by the validators. A snapshot is final only
  when every Head participant has co-signed it.

The two are independent. The validators do not know or care how snapshots are
signed; the signing topology does not know or care what the validators check. A
transition can be legal but never settled (no one signs the snapshot carrying
it), and the settlement layer can carry home only states the validators already
deemed legal. **This README owns the legality layer.** The settlement layer is
specified in `HANDOFF.md` ("The big decision") and `ARCHITECTURE.md`; the summary
below is a pointer, not the source of truth — keep it in sync with `HANDOFF.md`.

### The Head topology (settlement layer — see `HANDOFF.md`)

- The Head is **(N+1)-of-(N+1)**: one server-hosted managed `hydra-node` per
  player, plus the runner's own node as the +1. Every node co-signs L2
  snapshots, so no single party — the runner included — can force the final
  fanned-out state. This is a deliberate **trustless settlement** choice over the
  simpler "runner is sole signer" model.
- **Players hold their own Hydra signing key in the browser** and sign snapshots
  via remote-signing (Option A in `HANDOFF.md`): their managed node does the
  gossip, ledger view, and L1 ops but never holds the player's key. The node can
  stall but cannot forge a player's signature.
- The **runner holds the +1 key** and is a non-authoritative sequencer: it
  builds/relays transactions and orders contention, and on the settlement side it
  drives **close/fanout liveness** (browsers disconnect and rage-quit, so the
  runner is the dependable party that drives Close, watches for a bad Close,
  Contests with the correct latest snapshot, and Fanouts). It is **not** a
  tiebreaker — Hydra has no majority/tiebreak; a snapshot is either unanimously
  signed (final) or it was never a snapshot.
- Crucially, the runner **cannot forge game state** even though it holds a key,
  because the validators reject illegal transitions regardless of who submits
  them. Its key buys settlement liveness, not legality authority.

### What a passive validator can and cannot catch

A Cardano validator is a pure function of one transaction. It only runs when a
transaction is *submitted*, and it only sees that transaction's inputs,
reference inputs, redeemer, and outputs. This splits cheats into two classes:

- **Commission** — proposing an illegal transition (teleport, fabricate a
  bullet on a target, fire through cooldown, self-heal). A transaction is
  submitted; the validator sees it and rejects it. **The contract is good at
  this.**
- **Omission** — declining to apply a true fact (ignoring a hit, never
  decrementing your own health). No illegal transaction is submitted, so there
  is nothing for any validator to reject. **A passive validator is structurally
  blind to this.**

The omitted-hit cheat is an omission cheat, and it is the central PvP problem.
See §3 for how the design converts it into a commission cheat the contract can
catch.

---

## 2. The three-UTxO split

Each player's state is split across **three separate UTxOs**, each at its own
script address, instead of one monolithic player-state UTxO. The cut follows the
*write access pattern*: separate the things different parties write at different
times, so independent writers touch independent UTxOs and contention falls.

| UTxO | Datum (`shared.py`) | Written | Writer | Contention |
|------|--------------------|---------|--------|------------|
| Position | `PositionState` (owner, x, y, alive, last_move_checkpoint) | every checkpoint | owner only | none |
| Bullets | `BulletsState` (owner, bullets[4], last_shot_checkpoint, last_flight_checkpoint) | on fire / flight | owner only | low |
| Health | `HealthState` (owner, health, eliminated_by, died_at_checkpoint) | only on hit | cross-player (shooter) | quarantined here |

Why split:

- The every-tick write (position) becomes single-writer and never contends.
- The only cross-player write (damage) is quarantined into the Health UTxO,
  which is spent rarely (only on a hit). The one contended object is also the
  least-written one.

Cost of the split — cross-field invariants must be reassembled with **CIP-31
reference inputs** (read-only, no consumption, no contention):

- Move/Shoot read the player's `HealthState` (reference input) for the
  dead-player gate, because health now lives in a different UTxO. The Position
  datum also carries a denormalised `alive` flag; the Move validator asserts the
  flag matches the referenced health so a stale `alive=true` cannot be ridden.
- Hit references both players' `PositionState` to check geometry.
- Revive references the killer's `HealthState` and the other live players'
  `PositionState`.

Reference inputs work on Hydra L2 because the Head runs the same ledger as L1
(isomorphism), and reference inputs are a ledger feature since Vasil. Verified
against the Hydra docs.

The bullet array is **one UTxO holding a fixed 4-slot array** (`BULLET_COUNT`),
not one UTxO per bullet. Per-bullet UTxOs would buy parallelism we don't need
and cost script-context size we do care about. Bullets are written together (one
fire updates the array) and read together (geometry scans the array), so they
are cut as a unit.

---

## 3. Shooter-asserted damage (the omitted-hit fix)

Damage is **shooter-asserted, not victim-asserted.** When player A's bullet hits
player B, *A* authors the transaction that decrements B's health — B never
reports their own damage.

Why this is the whole point:

- **Victim-asserted** puts the party who *loses* from a fact in control of
  whether the fact is recorded. B simply never submits the health decrement;
  nothing fires; the cheat is unfixable on-chain. This is the omitted-hit cheat.
- **Shooter-asserted** flips the incentive: the party who *benefits* from the
  fact records it, and they want it recorded. B can no longer hide the hit
  because B is not the reporter.

Shooter-assertion introduces a *symmetric* cheat — A could over-report hits that
did not land — but that is a **commission** cheat (A submits a transaction), so
the contract catches it by checking the geometry. We have converted the one
cheat class a validator is blind to (omission) into the one it is good at
(commission).

### How a hit transaction is built (Option 1a)

A single transaction, signed by the shooter:

- **spends** the shooter's own `BulletsState` — the landing bullet flips
  active → inactive (the bullet is consumed by hitting)
- **spends** the victim's `HealthState` — health decremented by exactly
  `HIT_DAMAGE`
- **references** the victim's `PositionState` (read-only) to verify the bullet
  intersects the victim within `HIT_RADIUS`
- the victim does **not** sign — the `health` validator requires
  `shooter in signatories`, not the victim

For the victim's Health UTxO to be spendable by the shooter, player-state UTxOs
sit at a script that constrains *how* state may change rather than gating on the
owner's signature (the always-spendable-script pattern from IOG's hydra-poll,
but with the referee validating the transition).

### Why flight is now contract-enforced

The hit checks the bullet's position against the victim's. For that to be sound,
the bullet's position must be trustworthy. So the `bullets` validator now
validates **flight**: any bullet active in both the old and new state must have
advanced exactly one checkpoint along its (immutable) trajectory
(`validate_flight_step`). This reverses the original contract, which removed
flight checks for execution-budget reasons and left flight to peers.

The reversal is affordable because Hydra L2 execution budgets are adjustable
per-head and can exceed L1 (verified against Hydra docs). It is the first thing
to **measure** with real constants, since it re-introduces an O(`BULLET_COUNT`)
loop per bullets transition.

### The remaining seam

The `health` validator reads the landing bullet from the shooter's *spent*
`BulletsState` (it is consumed, so it is an input, not a reference). The
`spent_bullet` helper asserts exactly one shooter-owned bullets UTxO is spent,
which forces the shooter to actually consume their bullet when asserting a hit.
Flight validity for that bullet is enforced by the `bullets` validator running
in the same transaction. So a hit is correct iff *both* validators pass — the
correctness is the conjunction, not either validator alone.

---

## 4. Revive

A player **revives themselves** (authors and signs their own revive). Legitimacy
rules, all enforced by the `health` validator on a `ReviveInput` redeemer:

- The player must currently be dead (`health <= 0`).
- The player named in their `eliminated_by` must be **currently dead**, having
  died within `REVIVE_WINDOW_CHECKPOINTS`. The killer's death is read from the
  killer's `HealthState` as a reference input.
- **Missed-window semantics are intentional:** if the killer already revived
  (so they are alive again), the dead player missed their chance and must wait
  until the killer possibly dies again. We do not keep death history; the
  killer's `died_at` is cleared on the killer's own revive. This keeps state
  small.
- The respawn point must clear every other **live** player by
  `SPAWN_MIN_DISTANCE`. The builder references exactly the N-1 other players;
  dead players are parked off-canvas and excluded by their `alive` flag.
- Revive restores `MAX_HEALTH` and clears `eliminated_by` to `ALIVE_SENTINEL`
  and `died_at_checkpoint` to 0.

### `eliminated_by` sentinel

`eliminated_by` holds the killer's real `PubKeyHash` when the player is dead, and
`ALIVE_SENTINEL` (28 zero-bytes; no real key hashes to all zeros) when alive.
One sentinel, used everywhere — live state, the revive-clear path, and the
helper constructors.

### Off-chain dependency: end-of-game

The contract has no notion of "game over." The runner's game logic must **wait
`k` ticks with one player remaining before declaring the game over**, so that a
player eliminated at the last moment still has their revive window.
`REVIVE_WINDOW_CHECKPOINTS` is the contract-side mirror of that rule.

---

## 5. Fanout rule (do not break this)

`HealthState` is the terminal state fanned out to L1 at Head close (final health,
who eliminated whom, the winner). Its validator **must stay within L1 execution
limits** even though the Head may run a fatter L2 budget mid-game.

Position and Bullets UTxOs are consumed-and-recreated throughout the game and are
never individually fanned out, so they may use the full L2 budget. Concretely:
the expensive flight loop lives in `bullets` (L2-only), and the `health`
validator should be kept lean enough to validate on L1.

---

## 6. Files

```
contracts/
  shared.py     constants, datum types, redeemers, helpers (NOT a contract)
  position.py   POSITION validator — movement, map bounds, dead-player gate
  bullets.py    BULLETS validator — cooldown, spawn legitimacy, flight
  health.py     HEALTH validator  — Hit (shooter-asserted) + Revive
  README.md     this file
```

`shared.py` has no `validator` function — it only supplies the common surface.
The three validator files each define exactly one function named `validator`
(opshin compiles one validator per file).

---

## 7. opshin notes (learned from compiling)

- **Entry point** must be a function literally named `validator`, one per file.
- **Plutus V3 signature:** `def validator(context: ScriptContext) -> None`. The
  datum and redeemer are pulled from the context (`own_datum_unsafe(context)`,
  `context.redeemer`), not passed as separate parameters. The old
  `validator(datum, redeemer, context)` form is rejected by the V3 compiler.
- **Imports:** cross-module imports must be `from contracts.shared import *`.
  opshin rejects selective imports (`from x import (a, b)`).
- **Compile:** `PYTHONPATH=<repo> opshin compile contracts/<name>.py`. All three
  currently compile to Plutus V3 UPLC (`program 1.1.0`) with opshin 0.27.2.
- A validator passes by *not failing* (assert / index error). Returning `False`
  does **not** fail the validation — never rely on a returned bool.

---

## 8. Open items / placeholders

These are pinned in `shared.py` but are not final. Several depend on the
float→int quantisation strategy, which in turn depends on the off-chain Cardano
TS library choice — so they cannot be finalised until the off-chain build
quantises to the same integer grid (`SCALE` / `DIR_SCALE`).

- `SPAWN_BOX_TOLERANCE`, `DIR_TOLERANCE` — depend on worst-case quantisation
  error.
- `BULLET_FLIGHT_PER_CHECKPOINT`, `FLIGHT_TOLERANCE` — new with contract-side
  flight; must match the off-chain flight integration exactly.
- `HIT_RADIUS_SCALED` / `HIT_RADIUS_SQ` — must equal
  `(PLAYER_SIDE/2 + BULLET_RADIUS)^2` in scaled units.
- `SPAWN_MIN_DISTANCE` / `SPAWN_MIN_DISTANCE_SQ`, `REVIVE_WINDOW_CHECKPOINTS` —
  new revive tuning.
- `DEAD_PARK_COORD` — the off-canvas park coordinate for dead players. The rule
  "only a dead player may hold off-canvas coordinates" is not yet asserted
  on-chain.

To still do:

- A test harness. opshin can `eval` a validator as plain Python against built
  `ScriptContext` fixtures — build `contracts/test/fixtures.py` and exercise each
  validator's accept/reject paths.
- Measure execution units, especially the `bullets` flight loop, against a real
  Head with a chosen L2 budget. Confirm the contended-Health-UTxO double-hit
  timing against a real node.
- The off-chain `refereeTxBuilder.ts`, which must build these exact multi-UTxO
  transactions (spend + reference sets per transition) and quantise to the same
  integer grid.
- The runner-key question is **resolved** (see §1 and `HANDOFF.md`): the runner
  holds the +1 key in an **(N+1)-of-(N+1)** Head and drives close/fanout
  liveness, but is a non-authoritative sequencer that cannot forge state because
  the validators reject illegal transitions regardless of submitter. Nothing in
  the validators depends on this — legality enforcement is signing-topology
  agnostic — but the off-chain tx builder and the close/fanout wiring do, so it
  is recorded here for the off-chain build.
```