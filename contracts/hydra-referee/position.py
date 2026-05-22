"""
Ada Battles — POSITION validator.

Spends a player's Position UTxO; owner-only writer. Validates per-checkpoint
movement bounds, map bounds, and the dead-player gate (read from the player's
HealthState as a reference input, since health lives in a separate UTxO now).

Entry point is `validator` (opshin: one validator per file).
"""

from opshin.prelude import *
from .shared import *


def validator(context: ScriptContext) -> None:
    purpose: ScriptPurpose = context.purpose
    assert isinstance(purpose, Spending), "position is a spending validator"
    spending: Spending = purpose

    datum: PositionState = own_datum_unsafe(context)
    redeemer: MoveInput = context.redeemer
    tx_info: TxInfo = context.transaction

    own_in: TxOut = own_spent_utxo(tx_info.inputs, spending)
    own_addr: Address = own_in.address
    new_out: TxOut = continuing_output(tx_info.outputs, own_addr)
    new_state: PositionState = out_position(new_out)

    # Identity: only the owner advances their own position.
    assert new_state.owner == datum.owner, "owner must not change"
    assert datum.owner in tx_info.signatories, "owning player must sign their move"

    # Dead-player gate. Re-establish liveness against the authoritative
    # HealthState reference input so a stale alive=true cannot be ridden after
    # death, and require the position's alive flag to mirror it.
    health_ref: HealthState = ref_health(tx_info.reference_inputs, datum.owner)
    really_alive: bool = health_ref.health > MIN_HEALTH
    assert new_state.alive == really_alive, "alive flag must match referenced health"

    if not really_alive:
        # Dead players do not move via this validator. Position parking to the
        # off-canvas dead coordinate happens on the death (Hit) transition; here
        # we only forbid a dead player from changing position.
        assert new_state.x == datum.x, "dead players cannot move (x)"
        assert new_state.y == datum.y, "dead players cannot move (y)"

    # Movement bound (Manhattan, per checkpoint). Endpoint check; the per-frame
    # path is peer-enforced.
    delta_x: int = abs_int(new_state.x - datum.x)
    delta_y: int = abs_int(new_state.y - datum.y)
    assert delta_x + delta_y <= MAX_DISPLACEMENT_PER_CHECKPOINT, "moved too far this checkpoint"

    # Map bounds (box-aware endpoint check).
    assert new_state.x >= PLAYER_SIDE_SCALED, "out of bounds (x-min)"
    assert new_state.x <= CANVAS_WIDTH_SCALED - PLAYER_SIDE_SCALED, "out of bounds (x-max)"
    assert new_state.y >= PLAYER_SIDE_SCALED, "out of bounds (y-min)"
    assert new_state.y <= CANVAS_HEIGHT_SCALED - PLAYER_SIDE_SCALED, "out of bounds (y-max)"

    # Checkpoint advances forward.
    assert redeemer.checkpoint > datum.last_move_checkpoint, "checkpoint must advance"
    assert new_state.last_move_checkpoint == redeemer.checkpoint, "move checkpoint not recorded"