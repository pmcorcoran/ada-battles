"""
Ada Battles — shared types, constants, and helpers for the referee validators.

Imported by position.py, bullets.py, and health.py. Each of those is a separate
opshin contract whose entry point is a function literally named `validator`
(opshin compiles one `validator` per file). This module is NOT a contract — it
has no `validator` function; it only supplies the common surface.

See the three-UTxO split notes in each validator file and ARCHITECTURE.md.

COORDINATE / SCALE CONVENTION  (MUST MATCH OFF-CHAIN shared/constants.ts)
All positions, directions, distances, tolerances are INTEGERS. Off-chain floats
are quantised to the same integer grid (SCALE / DIR_SCALE) before building any
datum or redeemer. Directions are integer-scaled unit vectors.
"""

from opshin.prelude import *

# ──────────────────────────────────────────────────────────────────────
# Constants  (keep in sync with shared/constants.ts via the off-chain build)
# ──────────────────────────────────────────────────────────────────────

SCALE: int = 1000
DIR_SCALE: int = 1000
CHECKPOINT_FRAMES: int = 7

MAX_DISPLACEMENT_PER_FRAME: int = 6 * SCALE
MAX_DISPLACEMENT_PER_CHECKPOINT: int = MAX_DISPLACEMENT_PER_FRAME * CHECKPOINT_FRAMES

COOLDOWN_CHECKPOINTS: int = 7

MUZZLE_OFFSET: int = 50 * SCALE
SPAWN_BOX_TOLERANCE: int = 2 * SCALE          # PLACEHOLDER — tune vs quantisation
DIR_TOLERANCE: int = DIR_SCALE // 50          # PLACEHOLDER

MIN_HEALTH: int = 0
MAX_HEALTH: int = 2

BULLET_COUNT: int = 4

CANVAS_WIDTH_SCALED:  int = 900 * SCALE
CANVAS_HEIGHT_SCALED: int = 630 * SCALE
PLAYER_SIDE_SCALED:   int = 27 * SCALE

# Bullet flight: scaled distance an active bullet travels per CHECKPOINT along
# its unit trajectory. BULLET_SPEED * SCALE * dt * CHECKPOINT_FRAMES, pinned
# off-chain. PLACEHOLDER. Flight is now contract-enforced (see bullets.py).
BULLET_FLIGHT_PER_CHECKPOINT: int = 30 * SCALE
# Allowed per-component error when checking a flight step (quantisation slack).
FLIGHT_TOLERANCE: int = 2 * SCALE             # PLACEHOLDER

# Hit geometry: squared radius for bullet-centre-vs-player-centre intersection
# (squared to avoid an on-chain sqrt). PLACEHOLDER — must equal
# (PLAYER_SIDE/2 + BULLET_RADIUS)^2 in scaled units, matching off-chain.
HIT_RADIUS_SCALED: int = 20 * SCALE
HIT_RADIUS_SQ: int = HIT_RADIUS_SCALED * HIT_RADIUS_SCALED

# Damage dealt by a single hit.
HIT_DAMAGE: int = 1

# Revive: window (in checkpoints) after the killer's death during which the
# victim may revive, and minimum respawn distance from any other LIVE player.
REVIVE_WINDOW_CHECKPOINTS: int = 7
SPAWN_MIN_DISTANCE: int = 80 * SCALE
SPAWN_MIN_DISTANCE_SQ: int = SPAWN_MIN_DISTANCE * SPAWN_MIN_DISTANCE

# Sentinel PubKeyHash meaning "this player is alive / not eliminated". A
# PubKeyHash is a 28-byte blake2b-224 hash; no real key hashes to all zeros, so
# this is a safe non-colliding sentinel. eliminated_by holds the killer's real
# PubKeyHash when dead, and ALIVE_SENTINEL otherwise.
ALIVE_SENTINEL: PubKeyHash = PubKeyHash(
    b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
)

# Off-canvas coordinate convention for dead players. A dead player's position is
# parked far outside the canvas; only a dead player may hold such coordinates
# (enforced off-chain / future contract work — not asserted here yet).
DEAD_PARK_COORD: int = 1000000 * SCALE


# ──────────────────────────────────────────────────────────────────────
# Datum types
# ──────────────────────────────────────────────────────────────────────

@dataclass()
class Bullet(PlutusData):
    CONSTR_ID = 0
    owner: PubKeyHash
    is_active: bool
    x: int
    y: int
    dir_x: int
    dir_y: int


@dataclass()
class PositionState(PlutusData):
    """Datum at the player's POSITION UTxO. Owner-only writer."""
    CONSTR_ID = 0
    owner: PubKeyHash
    x: int
    y: int
    alive: bool
    last_move_checkpoint: int


@dataclass()
class BulletsState(PlutusData):
    """Datum at the player's BULLETS UTxO. Owner-only writer."""
    CONSTR_ID = 0
    owner: PubKeyHash
    bullets: List[Bullet]
    last_shot_checkpoint: int
    # The checkpoint at which flight was last advanced — flight steps are
    # validated relative to this so a single missed/double step is caught.
    last_flight_checkpoint: int


@dataclass()
class HealthState(PlutusData):
    """Datum at the player's HEALTH UTxO. Cross-player writer (shooter on Hit).

    Terminal state fanned out at Head close — keep its validator L1-affordable.
    """
    CONSTR_ID = 0
    owner: PubKeyHash
    health: int
    # Killer's PubKeyHash when eliminated; ALIVE_SENTINEL when alive.
    eliminated_by: PubKeyHash
    # Checkpoint of elimination (health hit 0); 0 when alive.
    died_at_checkpoint: int


# ──────────────────────────────────────────────────────────────────────
# Redeemers
# ──────────────────────────────────────────────────────────────────────

@dataclass()
class MoveInput(PlutusData):
    """Redeemer for the POSITION validator."""
    CONSTR_ID = 0
    checkpoint: int


@dataclass()
class ShootInput(PlutusData):
    """Redeemer for the BULLETS validator (covers both shoot and flight-only).

    is_shooting=False is a flight-only advance (active bullets move, no new
    bullet spawns). is_shooting=True additionally spawns one bullet.
    """
    CONSTR_ID = 0
    is_shooting: bool
    aim_dir_x: int
    aim_dir_y: int
    checkpoint: int


@dataclass()
class HitInput(PlutusData):
    """Shooter-asserted damage. Spends the victim's HealthState; the shooter
    also spends their own BulletsState in the same tx to consume the bullet."""
    CONSTR_ID = 0
    bullet_index: int
    shooter: PubKeyHash
    checkpoint: int


@dataclass()
class ReviveInput(PlutusData):
    """Self-revive. Spends the owner's own HealthState."""
    CONSTR_ID = 1
    respawn_x: int
    respawn_y: int
    checkpoint: int


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def abs_int(v: int) -> int:
    if v < 0:
        return -v
    return v


def dist_sq(ax: int, ay: int, bx: int, by: int) -> int:
    """Squared Euclidean distance — avoids an on-chain sqrt."""
    dx: int = ax - bx
    dy: int = ay - by
    return dx * dx + dy * dy


def continuing_output(outputs: List[TxOut], own_addr: Address) -> TxOut:
    """The single output returning state to this script address."""
    result: TxOut = outputs[0]
    count: int = 0
    for o in outputs:
        if o.address == own_addr:
            result = o
            count += 1
    assert count == 1, "must produce exactly one continuing state output"
    return result


def out_position(o: TxOut) -> PositionState:
    d: OutputDatum = o.datum
    assert isinstance(d, SomeOutputDatum), "output must carry an inline datum"
    inner: PositionState = d.datum
    return inner


def out_bullets(o: TxOut) -> BulletsState:
    d: OutputDatum = o.datum
    assert isinstance(d, SomeOutputDatum), "output must carry an inline datum"
    inner: BulletsState = d.datum
    return inner


def out_health(o: TxOut) -> HealthState:
    d: OutputDatum = o.datum
    assert isinstance(d, SomeOutputDatum), "output must carry an inline datum"
    inner: HealthState = d.datum
    return inner


def ref_position(reference_inputs: List[TxInInfo], owner: PubKeyHash) -> PositionState:
    """Read exactly one player's PositionState from the reference inputs."""
    found: int = 0
    result: PositionState = PositionState(owner, 0, 0, False, 0)
    for ti in reference_inputs:
        od: OutputDatum = ti.resolved.datum
        if isinstance(od, SomeOutputDatum):
            ps: PositionState = od.datum
            if ps.owner == owner:
                result = ps
                found += 1
    assert found == 1, "expected exactly one referenced position for owner"
    return result


def ref_health(reference_inputs: List[TxInInfo], owner: PubKeyHash) -> HealthState:
    """Read exactly one player's HealthState from the reference inputs."""
    found: int = 0
    result: HealthState = HealthState(owner, 0, owner, 0)
    for ti in reference_inputs:
        od: OutputDatum = ti.resolved.datum
        if isinstance(od, SomeOutputDatum):
            hs: HealthState = od.datum
            if hs.owner == owner:
                result = hs
                found += 1
    assert found == 1, "expected exactly one referenced health for owner"
    return result


def ref_bullet(reference_inputs: List[TxInInfo], owner: PubKeyHash, index: int) -> Bullet:
    """Read bullets[index] from `owner`'s referenced BulletsState."""
    found: int = 0
    result: Bullet = Bullet(owner, False, 0, 0, 0, 0)
    for ti in reference_inputs:
        od: OutputDatum = ti.resolved.datum
        if isinstance(od, SomeOutputDatum):
            bs: BulletsState = od.datum
            if bs.owner == owner:
                assert len(bs.bullets) == BULLET_COUNT, "referenced bullets malformed"
                result = bs.bullets[index]
                found += 1
    assert found == 1, "expected exactly one referenced bullets-state for owner"
    return result


def validate_flight_step(old_b: Bullet, new_b: Bullet) -> None:
    """Assert an active bullet advanced one checkpoint along its trajectory.

    Trajectory is immutable while in flight; position advances by
    BULLET_FLIGHT_PER_CHECKPOINT along the unit direction, within tolerance.
    Called for bullets active in BOTH old and new state (still flying).
    """
    assert new_b.dir_x == old_b.dir_x, "in-flight trajectory changed (x)"
    assert new_b.dir_y == old_b.dir_y, "in-flight trajectory changed (y)"
    exp_x: int = old_b.x + (old_b.dir_x * BULLET_FLIGHT_PER_CHECKPOINT) // DIR_SCALE
    exp_y: int = old_b.y + (old_b.dir_y * BULLET_FLIGHT_PER_CHECKPOINT) // DIR_SCALE
    assert abs_int(new_b.x - exp_x) <= FLIGHT_TOLERANCE, "flight step off-trajectory (x)"
    assert abs_int(new_b.y - exp_y) <= FLIGHT_TOLERANCE, "flight step off-trajectory (y)"