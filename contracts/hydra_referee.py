"""
Ada Battles — Hydra referee validator (anti-griefing bounds-checker)

SCOPE
-----
This contract does NOT enforce combat correctness. In the Hydra head, every
checkpoint state transition is signed N-of-N by all players; honest peers run
the same deterministic simulation and refuse to sign a transition whose bullet
flight or collision results disagree with their own. Hit detection, damage,
elimination, and bullet flight physics are therefore enforced by *consensus*,
not here.

This validator's only job is to make a narrow class of cheats impossible to
*propose* in a way that looks locally valid to a peer who hasn't fully
re-simulated — giving honest peers a cheap, unambiguous rejection criterion.
It runs on each player's own per-checkpoint state transition and checks O(1)
bounds:

  1. Movement: displacement since last checkpoint within the k-frame budget.
  2. Shot cooldown: no shot before COOLDOWN_FRAMES have elapsed.
  3. Dead-player gate: health <= 0 cannot move or shoot.
  4. Bullet spawn position: a bullet that became active THIS checkpoint must
     originate inside a bounding box around the shooter's muzzle point.
  5. Bullet spawn direction: that bullet's trajectory must match the shooter's
     aim at fire time.

It deliberately does NOT iterate bullet flight physics (that was removed — it
blows the execution budget and is peer-enforced anyway).

CHECKPOINT MODEL
----------------
Players simulate at 35 FPS locally. A signed script transition (a "checkpoint")
happens every CHECKPOINT_FRAMES frames (k). `PlayerInput.frame` is a checkpoint
counter, NOT a per-frame counter. Movement and cooldown budgets are expressed
per checkpoint.

COORDINATE CONVENTION  (MUST MATCH OFF-CHAIN)
---------------------------------------------
All positions, directions, and tolerances are INTEGERS. There are no floats
on-chain. The off-chain TS simulation MUST quantise to the same integer grid
before building the datum/redeemer, using the same SCALE factor below.
Directions are integer-scaled unit vectors: a unit direction (cos, sin) is
stored as round(cos * DIR_SCALE), round(sin * DIR_SCALE).

OPEN DECISIONS (see HANDOFF.md):
  - SPAWN_BOX_TOLERANCE and DIR_TOLERANCE depend on the chosen SCALE and the
    worst-case quantisation error; the values below are PLACEHOLDERS to be
    tuned against the real off-chain rounding.
  - Whether bullet-array length is a contract invariant or peer-enforced. Here
    it is enforced as a structural invariant (BULLET_COUNT) because reading the
    arrays at fixed indices requires it; revisit if peers should own this.

This file is still pre-production: the parameters need tuning and it needs an
on-chain test suite (opshin supports running the validator as plain Python).

PLUTUS V3 SIGNATURE
-------------------
Current OpShin (>= ~0.27, prelude api_v3) compiles to Plutus V3, where a
spending validator takes ONLY the ScriptContext on-chain:

    def validator(context: ScriptContext) -> None

The datum and redeemer are pulled OUT of the context (own_datum_unsafe(context)
and context.redeemer), NOT passed as separate parameters. The old
`validator(datum, redeemer, context)` form (V1/V2, and most older tutorials)
is rejected by the V3 compiler with "expects only the ScriptContext". The
test harness in contracts/test/fixtures.py builds contexts accordingly.
"""

from opshin.prelude import *

# ──────────────────────────────────────────────────────────────────────
# Constants  (keep in sync with shared/constants.ts via the off-chain build)
# ──────────────────────────────────────────────────────────────────────

# Integer scale: off-chain floats are multiplied by SCALE and rounded before
# being placed in the datum. e.g. SCALE = 1000 → millis of a game unit.
SCALE: int = 1000

# Direction vectors are stored as integers scaled by DIR_SCALE. A unit vector
# component in [-1, 1] becomes an int in [-DIR_SCALE, DIR_SCALE].
DIR_SCALE: int = 1000

# Checkpoint cadence (k). Signed transition every k frames at 35 FPS.
CHECKPOINT_FRAMES: int = 7

# Per-FRAME movement cap in scaled units. This is PLAYER_SPEED * SCALE * dt,
# precomputed off-chain and pinned here. Placeholder.
MAX_DISPLACEMENT_PER_FRAME: int = 6 * SCALE

# Per-CHECKPOINT movement cap. Manhattan budget over k frames, plus slack for
# quantisation. The check uses Manhattan distance for cheap on-chain math.
MAX_DISPLACEMENT_PER_CHECKPOINT: int = MAX_DISPLACEMENT_PER_FRAME * CHECKPOINT_FRAMES

# Shot cooldown, expressed in CHECKPOINTS (not frames). COOLDOWN_FRAMES / k,
# rounded down, pinned here. Placeholder: 49 frames / 7 = 7 checkpoints.
COOLDOWN_CHECKPOINTS: int = 7

# Muzzle offset: bullets spawn at player + unit_aim * (PLAYER_SIDE + BULLET_RADIUS).
# This is (PLAYER_SIDE + BULLET_RADIUS) * SCALE, pinned off-chain. Placeholder.
MUZZLE_OFFSET: int = 50 * SCALE

# Tolerances (PLACEHOLDERS — tune against real off-chain quantisation error).
SPAWN_BOX_TOLERANCE: int = 2 * SCALE     # half-width of the spawn bounding box
DIR_TOLERANCE: int = DIR_SCALE // 50     # allowed error per direction component

# Health bounds.
MIN_HEALTH: int = 0
MAX_HEALTH: int = 2

# Structural invariant: every player carries exactly this many bullet slots.
BULLET_COUNT: int = 4


# ──────────────────────────────────────────────────────────────────────
# Datum / redeemer types
# ──────────────────────────────────────────────────────────────────────

@dataclass()
class Bullet(PlutusData):
    CONSTR_ID = 0
    # Owner of the bullet — used by peers off-chain for kill attribution.
    # Carried on-chain but not validated by the referee (slice-2 consumers).
    owner: PubKeyHash
    # True if the bullet is in flight, False if it's a free slot ready to fire.
    is_active: bool
    x: int
    y: int
    # Integer-scaled unit trajectory (see DIR_SCALE).
    dir_x: int
    dir_y: int


@dataclass()
class PlayerState(PlutusData):
    """The datum locked at this player's referee UTxO."""
    CONSTR_ID = 0
    owner: PubKeyHash
    x: int
    y: int
    health: int
    # Checkpoint index at which this player last fired. Used for cooldown.
    last_shot_checkpoint: int
    bullets: List[Bullet]


@dataclass()
class PlayerInput(PlutusData):
    """The redeemer: one player's batched intent for this checkpoint."""
    CONSTR_ID = 0
    is_shooting: bool
    # Aim direction at fire time, integer-scaled unit vector.
    aim_dir_x: int
    aim_dir_y: int
    # The checkpoint index this transition represents (monotonic counter).
    checkpoint: int


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def abs_int(v: int) -> int:
    if v < 0:
        return -v
    return v


def continuing_output(outputs: List[TxOut], own_addr: Address) -> TxOut:
    """The single output that returns state to this script address.

    Exactly one is required: a checkpoint advances one player's state to a new
    UTxO at the same address. More than one (or none) is rejected.
    """
    result: TxOut = outputs[0]  # placeholder init; reassigned below
    count: int = 0
    for o in outputs:
        if o.address == own_addr:
            result = o
            count += 1
    assert count == 1, "must produce exactly one continuing state output"
    return result


def output_player_state(o: TxOut) -> PlayerState:
    """Read the inline PlayerState datum from a continuing output.

    V3 prelude: the output datum is an OutputDatum union; an inline datum is
    a SomeOutputDatum carrying the PlutusData. We assert it's inline and bind
    the inner datum to the PlayerState type (OpShin infers the cast).
    """
    d: OutputDatum = o.datum
    assert isinstance(d, SomeOutputDatum), "continuing output must carry an inline datum"
    inner: PlayerState = d.datum
    return inner


# ──────────────────────────────────────────────────────────────────────
# Validator
# ──────────────────────────────────────────────────────────────────────

def validator(context: ScriptContext) -> None:
    # PlutusV3: the validator takes ONLY the ScriptContext on-chain. The datum
    # of the UTxO being spent and the redeemer are pulled out of the context,
    # not passed as separate parameters (that was the V1/V2 / older-OpShin
    # signature, and is rejected by the V3 compiler).
    purpose: ScriptPurpose = context.purpose
    assert isinstance(purpose, Spending), "referee is a spending validator"
    spending: Spending = purpose

    datum: PlayerState = own_datum_unsafe(context)
    redeemer: PlayerInput = context.redeemer

    tx_info: TxInfo = context.transaction

    # Resolve our own address from the UTxO we're spending, then find the single
    # continuing output that carries the player's NEW state. own_spent_utxo is
    # provided by the prelude.
    own_in: TxOut = own_spent_utxo(tx_info.inputs, spending)
    own_addr: Address = own_in.address
    new_out: TxOut = continuing_output(tx_info.outputs, own_addr)
    new_state: PlayerState = output_player_state(new_out)

    # ── Identity: a player can only advance their own state ─────────────
    assert new_state.owner == datum.owner, "owner must not change across checkpoint"
    assert datum.owner in tx_info.signatories, "owning player must sign their transition"

    # ── Structural invariant: bullet array length is fixed ──────────────
    assert len(datum.bullets) == BULLET_COUNT, "input bullet array malformed"
    assert len(new_state.bullets) == BULLET_COUNT, "output bullet array malformed"

    # ── Health bounds (cannot go out of range; cannot self-heal here) ───
    assert new_state.health >= MIN_HEALTH, "health below minimum"
    assert new_state.health <= MAX_HEALTH, "health above maximum"
    # Health increases are a revive, which is a peer-validated event, not a
    # self-asserted one. The referee forbids a player raising their own health
    # in their own transition; revives are applied in a different transition.
    assert new_state.health <= datum.health, "cannot increase own health in own transition"

    # ── Dead-player gate ────────────────────────────────────────────────
    is_dead: bool = datum.health <= MIN_HEALTH
    if is_dead:
        assert new_state.x == datum.x, "dead players cannot move (x)"
        assert new_state.y == datum.y, "dead players cannot move (y)"
        assert not redeemer.is_shooting, "dead players cannot shoot"

    # ── Movement bound (Manhattan, per checkpoint) ──────────────────────
    # Cheap O(1) anti-teleport. Flight/collision are peer-enforced.
    delta_x: int = abs_int(new_state.x - datum.x)
    delta_y: int = abs_int(new_state.y - datum.y)
    assert delta_x + delta_y <= MAX_DISPLACEMENT_PER_CHECKPOINT, "moved too far this checkpoint"

    # ── Checkpoint monotonicity ─────────────────────────────────────────
    assert redeemer.checkpoint > datum.last_shot_checkpoint or not redeemer.is_shooting, \
        "shot checkpoint must be after last shot"

    # ── Shooting: cooldown + spawn legitimacy ───────────────────────────
    if redeemer.is_shooting:
        # Cooldown, in checkpoints.
        elapsed: int = redeemer.checkpoint - datum.last_shot_checkpoint
        assert elapsed >= COOLDOWN_CHECKPOINTS, "firing before cooldown elapsed"
        # The new state must record this checkpoint as the last shot.
        assert new_state.last_shot_checkpoint == redeemer.checkpoint, \
            "last_shot_checkpoint not advanced to this shot"

        # Exactly one bullet must transition inactive → active this checkpoint,
        # and it must spawn at the muzzle with the aimed trajectory. We locate
        # it by index parity between old and new arrays.
        newly_active: int = 0
        i: int = 0
        # Expected muzzle point: player position + aim_unit * MUZZLE_OFFSET.
        # aim is DIR_SCALE-scaled, MUZZLE_OFFSET is SCALE-scaled, so divide.
        muzzle_x: int = datum.x + (redeemer.aim_dir_x * MUZZLE_OFFSET) // DIR_SCALE
        muzzle_y: int = datum.y + (redeemer.aim_dir_y * MUZZLE_OFFSET) // DIR_SCALE
        while i < BULLET_COUNT:
            old_b: Bullet = datum.bullets[i]
            new_b: Bullet = new_state.bullets[i]
            if (not old_b.is_active) and new_b.is_active:
                newly_active += 1
                # Spawn position inside the muzzle bounding box.
                sdx: int = abs_int(new_b.x - muzzle_x)
                sdy: int = abs_int(new_b.y - muzzle_y)
                assert sdx <= SPAWN_BOX_TOLERANCE, "bullet spawned off-muzzle (x)"
                assert sdy <= SPAWN_BOX_TOLERANCE, "bullet spawned off-muzzle (y)"
                # Spawn direction matches aim.
                ddx: int = abs_int(new_b.dir_x - redeemer.aim_dir_x)
                ddy: int = abs_int(new_b.dir_y - redeemer.aim_dir_y)
                assert ddx <= DIR_TOLERANCE, "bullet trajectory mismatch (x)"
                assert ddy <= DIR_TOLERANCE, "bullet trajectory mismatch (y)"
            i += 1
        assert newly_active == 1, "a shot must activate exactly one bullet"
    else:
        # Not shooting: no bullet may transition inactive → active, and the
        # last-shot marker is unchanged.
        assert new_state.last_shot_checkpoint == datum.last_shot_checkpoint, \
            "last_shot_checkpoint changed without shooting"
        j: int = 0
        while j < BULLET_COUNT:
            old_b2: Bullet = datum.bullets[j]
            new_b2: Bullet = new_state.bullets[j]
            assert not ((not old_b2.is_active) and new_b2.is_active), \
                "bullet activated without a shot"
            j += 1

    # NOTE: bullet FLIGHT (position/velocity of already-active bullets) is NOT
    # checked here. Peers validate it off-chain and refuse to sign transitions
    # whose flight integration is wrong. Re-adding per-bullet flight asserts
    # here would blow the execution budget and duplicate consensus work.