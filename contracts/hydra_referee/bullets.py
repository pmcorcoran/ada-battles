"""
Ada Battles — BULLETS validator.

Spends a player's Bullets UTxO; owner-only writer. Now validates THREE things:

  1. Cooldown + spawn legitimacy when firing (a newly-active bullet originates
     at the shooter's muzzle, owned by the shooter, with the aimed trajectory).
  2. FLIGHT: any bullet active in both old and new state advanced exactly one
     checkpoint along its (immutable) trajectory. Flight used to be peer-only;
     it is now contract-enforced so the bullet position a Hit relies on cannot
     be a favourable fabrication. This spends the L2 execution-budget headroom
     deliberately; cost is O(BULLET_COUNT) per bullets transition.
  3. Deactivation: a bullet may go active->inactive (it hit someone, or expired/
     left the map). This validator stays AGNOSTIC about *which*: a Hit is a
     bullets-spend joined to a victim HealthState spend, and the HEALTH
     validator owns the "this bullet legitimately intersects the victim" check.
     Here we only require that flight up to deactivation was valid.

The shooter's CURRENT position lives in the Position UTxO, so the muzzle point
is read from a referenced PositionState.

Entry point is `validator`.
"""

from opshin.prelude import *
from hydra_referee.shared import *


def validator(context: ScriptContext) -> None:
    purpose: ScriptPurpose = context.purpose
    assert isinstance(purpose, Spending), "bullets is a spending validator"
    spending: Spending = purpose

    datum: BulletsState = own_datum_unsafe(context)
    redeemer: ShootInput = context.redeemer
    tx_info: TxInfo = context.transaction

    own_in: TxOut = own_spent_utxo(tx_info.inputs, spending)
    own_addr: Address = own_in.address
    new_out: TxOut = continuing_output(tx_info.outputs, own_addr)
    new_state: BulletsState = out_bullets(new_out)

    assert new_state.owner == datum.owner, "owner must not change"
    assert datum.owner in tx_info.signatories, "owning player must sign their bullets transition"

    assert len(datum.bullets) == BULLET_COUNT, "input bullet array malformed"
    assert len(new_state.bullets) == BULLET_COUNT, "output bullet array malformed"

    # ── Flight: validate every bullet active in BOTH states ─────────────
    # active->active : must advance one checkpoint along trajectory
    # inactive->active : a spawn (handled in the shooting block below)
    # active->inactive : deactivation (hit/expiry) — flight not re-checked here
    # inactive->inactive : free slot, must stay zeroed-ish (owner unchanged)
    f: int = 0
    while f < BULLET_COUNT:
        ob: Bullet = datum.bullets[f]
        nb: Bullet = new_state.bullets[f]
        if ob.is_active and nb.is_active:
            validate_flight_step(ob, nb)
        f += 1

    # ── Dead players cannot shoot (gate on referenced health) ───────────
    health_ref: HealthState = ref_health(tx_info.reference_inputs, datum.owner)
    is_dead: bool = health_ref.health <= MIN_HEALTH
    if is_dead:
        assert not redeemer.is_shooting, "dead players cannot shoot"

    if redeemer.is_shooting:
        elapsed: int = redeemer.checkpoint - datum.last_shot_checkpoint
        assert elapsed >= COOLDOWN_CHECKPOINTS, "firing before cooldown elapsed"
        assert new_state.last_shot_checkpoint == redeemer.checkpoint, "last_shot not advanced"

        pos_ref: PositionState = ref_position(tx_info.reference_inputs, datum.owner)
        muzzle_x: int = pos_ref.x + (redeemer.aim_dir_x * MUZZLE_OFFSET) // DIR_SCALE
        muzzle_y: int = pos_ref.y + (redeemer.aim_dir_y * MUZZLE_OFFSET) // DIR_SCALE

        newly_active: int = 0
        i: int = 0
        while i < BULLET_COUNT:
            old_b: Bullet = datum.bullets[i]
            new_b: Bullet = new_state.bullets[i]
            if (not old_b.is_active) and new_b.is_active:
                newly_active += 1
                assert new_b.owner == datum.owner, "spawned bullet must be owned by shooter"
                sdx: int = abs_int(new_b.x - muzzle_x)
                sdy: int = abs_int(new_b.y - muzzle_y)
                assert sdx <= SPAWN_BOX_TOLERANCE, "bullet spawned off-muzzle (x)"
                assert sdy <= SPAWN_BOX_TOLERANCE, "bullet spawned off-muzzle (y)"
                ddx: int = abs_int(new_b.dir_x - redeemer.aim_dir_x)
                ddy: int = abs_int(new_b.dir_y - redeemer.aim_dir_y)
                assert ddx <= DIR_TOLERANCE, "bullet trajectory mismatch (x)"
                assert ddy <= DIR_TOLERANCE, "bullet trajectory mismatch (y)"
            i += 1
        assert newly_active == 1, "a shot must activate exactly one bullet"
    else:
        # Flight-only advance: no new bullet may spawn, last_shot unchanged.
        assert new_state.last_shot_checkpoint == datum.last_shot_checkpoint, \
            "last_shot changed without shooting"
        j: int = 0
        while j < BULLET_COUNT:
            old_b2: Bullet = datum.bullets[j]
            new_b2: Bullet = new_state.bullets[j]
            assert not ((not old_b2.is_active) and new_b2.is_active), "bullet activated without a shot"
            j += 1